//go:build test_unit

package daemon

import (
	"context"
	"errors"
	"fmt"
	"hash/fnv"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/devgianlu/go-librespot/dealer"
	"github.com/devgianlu/go-librespot/player"
	connectpb "github.com/devgianlu/go-librespot/proto/spotify/connectstate"
	"github.com/stretchr/testify/require"
)

// fnvHex is a queue revision worked out by hand: FNV-1a 64 of the rows' keys.
func fnvHex(s string) string {
	h := fnv.New64a()
	_, _ = h.Write([]byte(s))
	return fmt.Sprintf("%016x", h.Sum64())
}

// queueEditPlayer plays a playlist of two pages, inline so that loading it
// never reaches the network: u0 to u3, then u4, u5 and an autoplay tail of a6
// and a7. u0 plays, and q1 and q2 are queued. What it publishes next is
//
//	q1 q2 | u1 u2 u3 u4 u5 | a6 a7
func queueEditPlayer(t *testing.T) *AppPlayer {
	t.Helper()

	entry := func(i byte, autoplay bool) *connectpb.ContextTrack {
		track := &connectpb.ContextTrack{Uri: trackUri(0x40 + i), Uid: fmt.Sprintf("u%d", i)}
		if autoplay {
			track.Uid = fmt.Sprintf("a%d", i)
			track.Metadata = map[string]string{"autoplay.is_autoplay": "true"}
		}
		return track
	}

	p := newShuffleTestPlayer(t)
	p.loadContext(&connectpb.Context{Uri: playlistUri, Pages: []*connectpb.ContextPage{
		{Tracks: []*connectpb.ContextTrack{entry(0, false), entry(1, false), entry(2, false), entry(3, false)}},
		{Tracks: []*connectpb.ContextTrack{entry(4, false), entry(5, false), entry(6, true), entry(7, true)}},
	}}, nil, false, true, func(error) {})
	runQueuedJob(t, p)
	p.loader.queue = nil // the first track need not load

	for i := range 2 {
		p.addToQueue(&connectpb.ContextTrack{Uri: trackUri(0x20 + byte(i))})
		runQueuedJob(t, p)
	}

	require.Equal(t, "u0", p.state.player.Track.GetUid())
	requireNext(t, p, "q1 q2 | u1 u2 u3 u4 u5 | a6 a7")
	return p
}

// nextLayout writes what the state publishes next by uid, sections apart.
func nextLayout(next []*connectpb.ProvidedTrack) string {
	var b strings.Builder
	last := ""
	for i, track := range next {
		if i > 0 {
			b.WriteString(" ")
			if track.Provider != last {
				b.WriteString("| ")
			}
		}
		b.WriteString(track.Uid)
		last = track.Provider
	}
	return b.String()
}

func requireNext(t *testing.T, p *AppPlayer, want string) {
	t.Helper()
	require.Equal(t, want, nextLayout(p.state.player.NextTracks))
}

// listLayout is what the list itself would publish next, walked afresh.
func listLayout(t *testing.T, p *AppPlayer) string {
	t.Helper()
	return nextLayout(p.state.tracks.Snapshot(t.Context(), nil).Next)
}

// queueEditCall makes an edit as the API does, running its list job as the
// lane and the player loop would, and returns its answer.
func queueEditCall(t *testing.T, p *AppPlayer, typ ApiRequestType, uid, before string) (any, error) {
	t.Helper()

	req, wait := NewApiRequest(typ, ApiRequestDataQueueEdit{Rev: p.queueRev(), Uid: uid, Before: before})
	data, err := p.handleApiRequest(req)
	if !errors.Is(err, errReplyDeferred) {
		require.Empty(t, p.loader.queue, "a refused edit queues nothing")
		return data, err
	}

	require.Len(t, p.loader.queue, 1)
	require.Equal(t, classMutate, p.loader.queue[0].class, "an edit is a mutation: never dropped, cancelling nothing")
	runQueuedJob(t, p)

	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	return wait(ctx)
}

// queueEditLines is what the edits logged.
func queueEditLines(log *recordingLogger) []string {
	var out []string
	for _, line := range log.lines() {
		if strings.HasPrefix(line, "queue edit ") {
			out = append(out, line)
		}
	}
	return out
}

func requireEdited(t *testing.T, p *AppPlayer, data any, err error) {
	t.Helper()

	require.NoError(t, err)
	require.Equal(t, &ApiQueueRevision{Rev: p.queueRev()}, data, "the answer is the new revision")
}

// The revision follows the rows and the song, and nothing else.
func TestQueueRevision(t *testing.T) {
	p := queueEditPlayer(t)

	rev := p.queueRev()
	require.Regexp(t, `^[0-9a-f]{16}$`, rev)
	require.Equal(t, fnvHex("u0\nq1\nq2\nu1\nu2\nu3\nu4\nu5\na6\na7"), rev)
	require.Equal(t, rev, p.playerQueue().Rev)

	// Metadata arriving changes nothing.
	p.state.player.NextTracks[2].Metadata = map[string]string{"title": "Follow You"}
	p.state.player.Track.Metadata = map[string]string{"title": "Fall"}
	require.Equal(t, rev, p.queueRev())

	p.addToQueue(&connectpb.ContextTrack{Uri: trackUri(0x22)})
	runQueuedJob(t, p)
	added := p.queueRev()
	require.NotEqual(t, rev, added, "a row added")

	data, err := queueEditCall(t, p, ApiRequestTypeQueueRemove, "q3", "")
	requireEdited(t, p, data, err)
	require.Equal(t, rev, p.queueRev(), "the same rows again")

	data, err = queueEditCall(t, p, ApiRequestTypeQueueMove, "u2", "u1")
	requireEdited(t, p, data, err)
	moved := p.queueRev()
	require.NotEqual(t, rev, moved, "a row moved")

	p.state.player.Track = &connectpb.ProvidedTrack{Uri: trackUri(0x41), Uid: "u1x"}
	require.NotEqual(t, moved, p.queueRev(), "the song changed")

	// A row without a uid counts by its uri.
	p.state.player.NextTracks[0].Uid = ""
	require.Equal(t, fnvHex("u1x\n"+p.state.player.NextTracks[0].Uri+"\nq2\nu2\nu1\nu3\nu4\nu5\na6\na7"), p.queueRev())
}

// A queued row goes through SetQueue, as a controller's set_queue: what is
// published next and what plays next agree, and the change is pushed and
// announced like any.
func TestQueueEditRemovesAQueuedRow(t *testing.T) {
	p := queueEditPlayer(t)
	log := &recordingLogger{}
	p.app.log = log
	drain(p.statePush)
	p.statePutScheduled, p.lastStatePut = false, time.Time{} // the next push goes at once
	p.queueEventPending = false

	data, err := queueEditCall(t, p, ApiRequestTypeQueueRemove, "q1", "")
	requireEdited(t, p, data, err)

	requireNext(t, p, "q2 | u1 u2 u3 u4 u5 | a6 a7")
	require.Equal(t, "q2 | u1 u2 u3 u4 u5 | a6 a7", nextLayout(lastPushedState(t, p).NextTracks), "pushed")
	require.True(t, p.queueEventPending, "the queue event follows")

	require.Equal(t, "q2", p.state.tracks.PeekNext(t.Context()).GetUid())
	require.True(t, p.state.tracks.GoNext(t.Context()))
	require.Equal(t, "q2", p.state.tracks.CurrentTrack().GetUid())

	require.Equal(t, []string{"queue edit remove queue -> 200"}, queueEditLines(log))
}

func TestQueueEditMovesAQueuedRow(t *testing.T) {
	p := queueEditPlayer(t)

	data, err := queueEditCall(t, p, ApiRequestTypeQueueMove, "q2", "q1")
	requireEdited(t, p, data, err)
	requireNext(t, p, "q2 q1 | u1 u2 u3 u4 u5 | a6 a7")
	require.Equal(t, "q2", p.state.tracks.PeekNext(t.Context()).GetUid())

	// To the end of the queue.
	data, err = queueEditCall(t, p, ApiRequestTypeQueueMove, "q2", "")
	requireEdited(t, p, data, err)
	requireNext(t, p, "q1 q2 | u1 u2 u3 u4 u5 | a6 a7")
	require.Equal(t, listLayout(t, p), nextLayout(p.state.player.NextTracks))

	for _, uid := range []string{"q1", "q2", "u1"} {
		require.True(t, p.state.tracks.GoNext(t.Context()))
		require.Equal(t, uid, p.state.tracks.CurrentTrack().GetUid())
	}
}

// A row of the context itself is taken out of the list: not only out of what
// is published once, but out of what plays and what every later publish shows.
func TestQueueEditRemovesAContextRow(t *testing.T) {
	p := queueEditPlayer(t)

	data, err := queueEditCall(t, p, ApiRequestTypeQueueRemove, "u1", "")
	requireEdited(t, p, data, err)
	requireNext(t, p, "q1 q2 | u2 u3 u4 u5 | a6 a7")

	list := p.state.tracks
	for _, uid := range []string{"q1", "q2"} {
		require.True(t, list.GoNext(t.Context()))
		require.Equal(t, uid, list.CurrentTrack().GetUid())
	}
	require.Equal(t, "u2", list.PeekNext(t.Context()).GetUid(), "the prefetch skips it")
	require.True(t, list.GoNext(t.Context()))
	require.Equal(t, "u2", list.CurrentTrack().GetUid(), "and so does playback")

	// A later publish, after that skip, does not bring it back.
	snap := list.Snapshot(t.Context(), nil)
	require.Equal(t, "u3 u4 u5 | a6 a7", nextLayout(snap.Next))
	require.Equal(t, []string{trackUri(0x40)}, trackUris(snap.Prev))
	require.Equal(t, &connectpb.ContextIndex{Page: 0, Track: 2}, snap.Index, "each entry keeps its place in its page")
}

// A moved context row keeps its new place through playback and every publish;
// to the end of the section is after the last context row shown, before the
// autoplay tail.
func TestQueueEditMovesAContextRow(t *testing.T) {
	p := queueEditPlayer(t)

	data, err := queueEditCall(t, p, ApiRequestTypeQueueMove, "u4", "u2")
	requireEdited(t, p, data, err)
	requireNext(t, p, "q1 q2 | u1 u4 u2 u3 u5 | a6 a7")

	data, err = queueEditCall(t, p, ApiRequestTypeQueueMove, "u1", "")
	requireEdited(t, p, data, err)
	requireNext(t, p, "q1 q2 | u4 u2 u3 u5 u1 | a6 a7")
	require.Equal(t, nextLayout(p.state.player.NextTracks), listLayout(t, p), "a republish shows the same")

	list := p.state.tracks
	for _, uid := range []string{"q1", "q2", "u4", "u2", "u3", "u5", "u1", "a6"} {
		require.True(t, list.GoNext(t.Context()))
		require.Equal(t, uid, list.CurrentTrack().GetUid())
	}
	require.Equal(t, &connectpb.ContextIndex{Page: 1, Track: 2}, list.Index())
}

// The next row's stream may be prefetched already: an edit that changes the
// next song throws it away, as set_queue does, rather than play or fade into
// it. Encore patch 9: the next song's stream is then prefetched no sooner than
// editPrefetchHold after the edit, and each edit of a burst holds it again.
func TestQueueEditDropsThePrefetchedStreamWhenTheNextSongChanged(t *testing.T) {
	p := queueEditPlayer(t)
	p.primaryStream = testStreamLasting(t, p.state.player.Track.GetUri(), 35000) // upstream's time has come
	p.state.player.IsPlaying = true
	p.state.setPaused(false)
	p.secondaryStream = &player.Stream{}
	gen := p.prefetchGen

	data, err := queueEditCall(t, p, ApiRequestTypeQueueRemove, "q1", "")
	requireEdited(t, p, data, err)

	require.Nil(t, p.secondaryStream)
	require.Equal(t, gen+1, p.prefetchGen, "a prefetch still running is thrown away when it lands")

	time.Sleep(editPrefetchHold / 2)
	data, err = queueEditCall(t, p, ApiRequestTypeQueueRemove, "q2", "")
	requireEdited(t, p, data, err)
	require.Equal(t, gen+2, p.prefetchGen)

	require.False(t, fires(p.prefetchTimer, editPrefetchHold-500*time.Millisecond), "held after the last edit of the burst")
	require.True(t, fires(p.prefetchTimer, time.Second), "then fetched once")
}

// Encore patch 9: an edit that leaves the next song as it was keeps its
// stream, and a prefetch of it still running: a burst of edits further down
// opens no stream at all.
func TestQueueEditKeepsThePrefetchedStreamWhenTheNextSongStays(t *testing.T) {
	p := queueEditPlayer(t)
	onAir(t, p)
	stream := &player.Stream{}
	p.secondaryStream = stream
	gen := p.prefetchGen

	for _, edit := range []struct {
		typ         ApiRequestType
		uid, before string
	}{
		{ApiRequestTypeQueueRemove, "q2", ""},
		{ApiRequestTypeQueueRemove, "u3", ""},
		{ApiRequestTypeQueueMove, "u5", "u1"},
		{ApiRequestTypeQueueTop, "q1", ""}, // first already
	} {
		data, err := queueEditCall(t, p, edit.typ, edit.uid, edit.before)
		require.NoError(t, err)
		require.NotNil(t, data)
	}

	requireNext(t, p, "q1 | u5 u1 u2 u4 | a6 a7")
	require.Same(t, stream, p.secondaryStream)
	require.Equal(t, gen, p.prefetchGen)
	require.False(t, fires(p.prefetchTimer, 100*time.Millisecond), "nothing scheduled")
}

// Rows shown in a controller's order need not have begun with the song the
// list plays next, which is what was prefetched: after one, an edit drops the
// stream even when the first row stays. With the track on repeat the stream
// is this same track again, whatever the edit.
func TestQueueEditPrefetchAfterAControllersOrderAndOnRepeat(t *testing.T) {
	p := queueEditPlayer(t)
	controllerSetQueue(t, p, "q1 q2 u3 u1 u2 u4 u5", "q1", "q2")
	stream := &player.Stream{}
	p.secondaryStream = stream
	gen := p.prefetchGen

	data, err := queueEditCall(t, p, ApiRequestTypeQueueRemove, "q2", "")
	requireEdited(t, p, data, err)
	requireNext(t, p, "q1 | u1 u2 u3 u4 u5 | a6 a7")
	require.Nil(t, p.secondaryStream, "a controller's order before")
	require.Equal(t, gen+1, p.prefetchGen)

	p.secondaryStream = stream
	data, err = queueEditCall(t, p, ApiRequestTypeQueueRemove, "u5", "")
	requireEdited(t, p, data, err)
	require.Same(t, stream, p.secondaryStream, "the list's own order before, and q1 first still")
	require.Equal(t, gen+1, p.prefetchGen)

	p.state.player.Options.RepeatingTrack = true
	data, err = queueEditCall(t, p, ApiRequestTypeQueueRemove, "q1", "")
	requireEdited(t, p, data, err)
	requireNext(t, p, "u1 u2 u3 u4 | a6 a7")
	require.Same(t, stream, p.secondaryStream, "on repeat")
	require.Equal(t, gen+1, p.prefetchGen)
}

// editRows edits a copy of the queued rows: the first of two alike, the end
// being after the first span-1 others.
func TestEditRows(t *testing.T) {
	rows := []*connectpb.ContextTrack{{Uid: "a"}, {Uid: "b"}, {Uid: "c"}, {Uid: "b"}, {Uid: "d"}}
	uids := func(rows []*connectpb.ContextTrack) string {
		var out []string
		for _, row := range rows {
			out = append(out, row.Uid)
		}
		return strings.Join(out, " ")
	}

	for _, tt := range []struct {
		move        bool
		uid, before string
		span        int
		want        string
	}{
		{false, "b", "", 5, "a c b d"},
		{false, "d", "", 5, "a b c b"},
		{true, "d", "a", 5, "d a b c b"},
		{true, "a", "d", 5, "b c b a d"},
		{true, "a", "", 5, "b c b d a"},
		{true, "a", "", 2, "b a c b d"},
		{true, "a", "", 1, "a b c b d"},
		{true, "c", "b", 5, "a c b b d"},
	} {
		got, err := editRows(rows, tt.move, tt.uid, tt.before, tt.span)
		require.NoError(t, err)
		require.Equal(t, tt.want, uids(got), "%+v", tt)
	}
	require.Equal(t, "a b c b d", uids(rows), "the rows given are left as they are")

	_, err := editRows(rows, false, "x", "", 5)
	require.ErrorIs(t, err, errQueueRowGone)
	_, err = editRows(rows, true, "a", "x", 5)
	require.ErrorIs(t, err, errQueueRowGone)
}

// What the rows shown say can be refused at once, unsent to the lane; each
// refusal is logged with no uid.
func TestQueueEditRefusals(t *testing.T) {
	for _, tt := range []struct {
		name   string
		typ    ApiRequestType
		uid    string
		before string
		rev    string
		kind   error
		line   string
	}{
		{name: "stale rev", typ: ApiRequestTypeQueueRemove, uid: "q1", rev: "0123456789abcdef", kind: ErrConflict, line: "queue edit remove queue -> 409"},
		{name: "not upcoming", typ: ApiRequestTypeQueueRemove, uid: "u9", kind: ErrConflict, line: "queue edit remove none -> 409"},
		{name: "the current row", typ: ApiRequestTypeQueueMove, uid: "u0", kind: ErrConflict, line: "queue edit move none -> 409"},
		{name: "autoplay", typ: ApiRequestTypeQueueRemove, uid: "a6", kind: ErrBadRequest, line: "queue edit remove autoplay -> 400"},
		{name: "autoplay move", typ: ApiRequestTypeQueueMove, uid: "a7", before: "a6", kind: ErrBadRequest, line: "queue edit move autoplay -> 400"},
		{name: "into the queue", typ: ApiRequestTypeQueueMove, uid: "u2", before: "q1", kind: ErrBadRequest, line: "queue edit move context -> 400"},
		{name: "into autoplay", typ: ApiRequestTypeQueueMove, uid: "q1", before: "a6", kind: ErrBadRequest, line: "queue edit move queue -> 400"},
		{name: "before itself", typ: ApiRequestTypeQueueMove, uid: "u2", before: "u2", kind: ErrBadRequest, line: "queue edit move context -> 400"},
		{name: "before a row gone", typ: ApiRequestTypeQueueMove, uid: "u2", before: "u9", kind: ErrConflict, line: "queue edit move context -> 409"},
		{name: "top stale rev", typ: ApiRequestTypeQueueTop, uid: "u2", rev: "0123456789abcdef", kind: ErrConflict, line: "queue edit top context -> 409"},
		{name: "top not upcoming", typ: ApiRequestTypeQueueTop, uid: "u9", kind: ErrConflict, line: "queue edit top none -> 409"},
		{name: "top of the current row", typ: ApiRequestTypeQueueTop, uid: "u0", kind: ErrConflict, line: "queue edit top none -> 409"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			p := queueEditPlayer(t)
			log := &recordingLogger{}
			p.app.log = log
			before := nextLayout(p.state.player.NextTracks)
			queueID := p.state.queueID

			rev := tt.rev
			if rev == "" {
				rev = p.queueRev()
			}
			req, _ := NewApiRequest(tt.typ, ApiRequestDataQueueEdit{Rev: rev, Uid: tt.uid, Before: tt.before})
			_, err := p.handleApiRequest(req)

			require.ErrorIs(t, err, tt.kind)
			require.Empty(t, p.loader.queue)
			require.Equal(t, before, nextLayout(p.state.player.NextTracks))
			require.Equal(t, []string{tt.line}, queueEditLines(log))
			require.Equal(t, queueID, p.state.queueID, "no uid reserved")
		})
	}
}

// A queued row can still be edited while the context is shuffled.
func TestQueueEditOfTheQueueWhileShuffled(t *testing.T) {
	p := queueEditPlayer(t)
	p.state.player.Options.ShufflingContext = true

	data, err := queueEditCall(t, p, ApiRequestTypeQueueRemove, "q2", "")
	requireEdited(t, p, data, err)
	requireNext(t, p, "q1 | u1 u2 u3 u4 u5 | a6 a7")
}

// Encore patch 9: the context's rows are edited while it is shuffled too:
// removed, moved and played next. Turning shuffle off then restores the
// context's own order, without the rows removed or played next, and the row
// played next stays queued.
func TestQueueEditOfAShuffledList(t *testing.T) {
	p := queueEditPlayer(t)
	p.setOptions(nil, nil, pointer(true))
	runQueuedJob(t, p)
	require.True(t, p.state.player.Options.ShufflingContext)

	var shuffled []string
	for _, track := range p.state.player.NextTracks {
		if track.Provider == queueSectionContext {
			shuffled = append(shuffled, track.Uid)
		}
	}
	require.Len(t, shuffled, 5)

	data, err := queueEditCall(t, p, ApiRequestTypeQueueRemove, shuffled[0], "")
	requireEdited(t, p, data, err)
	data, err = queueEditCall(t, p, ApiRequestTypeQueueMove, shuffled[3], shuffled[1])
	requireEdited(t, p, data, err)
	data, err = queueEditCall(t, p, ApiRequestTypeQueueTop, shuffled[2], "")
	require.NoError(t, err)
	require.Equal(t, "q3", data.(*ApiQueueTopResult).Uid)
	require.Equal(t, nextLayout(p.state.player.NextTracks), listLayout(t, p), "what is published is what plays")

	p.setOptions(nil, nil, pointer(false))
	runQueuedJob(t, p)

	var rest []string
	for _, uid := range []string{"u1", "u2", "u3", "u4", "u5"} {
		if uid != shuffled[0] && uid != shuffled[2] {
			rest = append(rest, uid)
		}
	}
	want := "q3 q1 q2 | " + strings.Join(rest, " ") + " | a6 a7"
	requireNext(t, p, want)
	require.Equal(t, want, listLayout(t, p))
	require.Equal(t, "u0", p.state.player.Track.GetUid())
}

// Rows edited from elsewhere between the check and the job: the job finds its
// row gone and changes nothing, and the list's own rows are published before
// the 409, so that the client's refetch shows what the next edit applies to.
func TestQueueEditOfARowGoneWhenItRuns(t *testing.T) {
	for _, tt := range []struct {
		name string
		uid  string
		gone func(t *testing.T, p *AppPlayer)
		want string
	}{
		{"context", "u3", func(t *testing.T, p *AppPlayer) {
			require.NoError(t, p.state.tracks.RemoveAhead("u3"))
		}, "q1 q2 | u1 u2 u4 u5 | a6 a7"},
		{"queue", "q1", func(t *testing.T, p *AppPlayer) {
			p.state.tracks.SetQueue(nil, p.state.tracks.UpcomingQueue()[1:])
		}, "q2 | u1 u2 u3 u4 u5 | a6 a7"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			p := queueEditPlayer(t)
			log := &recordingLogger{}
			p.app.log = log
			drain(p.statePush)
			p.statePutScheduled, p.lastStatePut = false, time.Time{} // the next push goes at once
			rev := p.queueRev()

			req, wait := NewApiRequest(ApiRequestTypeQueueRemove, ApiRequestDataQueueEdit{Rev: rev, Uid: tt.uid})
			_, err := p.handleApiRequest(req)
			require.ErrorIs(t, err, errReplyDeferred)

			tt.gone(t, p) // meanwhile, and not published
			list := listLayout(t, p)
			runQueuedJob(t, p)

			_, err = wait(t.Context())
			require.ErrorIs(t, err, ErrConflict)
			require.Equal(t, list, listLayout(t, p), "the job changed nothing")
			requireNext(t, p, tt.want)
			require.Equal(t, tt.want, nextLayout(lastPushedState(t, p).NextTracks), "pushed")
			require.NotEqual(t, rev, p.queueRev())

			// Asked again, of the rows now shown, the row is not there.
			_, err = queueEditCall(t, p, ApiRequestTypeQueueRemove, tt.uid, "")
			require.ErrorIs(t, err, ErrConflict)
			require.Equal(t, []string{"queue edit remove " + tt.name + " -> 409", "queue edit remove none -> 409"}, queueEditLines(log))
		})
	}
}

func TestQueueEditWithNothingLoaded(t *testing.T) {
	p := newTestAppPlayer(t)

	req, _ := NewApiRequest(ApiRequestTypeQueueMove, ApiRequestDataQueueEdit{Rev: p.queueRev(), Uid: "u1"})
	_, err := p.handleApiRequest(req)
	require.ErrorIs(t, err, ErrNoSession)
	require.Empty(t, p.loader.queue)
}

// A lane that is shut answers the edit, which would otherwise wait for good.
func TestQueueEditAnsweredByAClosedLane(t *testing.T) {
	p := queueEditPlayer(t)
	p.loader.closed = true

	req, wait := NewApiRequest(ApiRequestTypeQueueRemove, ApiRequestDataQueueEdit{Rev: p.queueRev(), Uid: "q1"})
	_, err := p.handleApiRequest(req)
	require.ErrorIs(t, err, errReplyDeferred)

	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	_, err = wait(ctx)
	require.ErrorIs(t, err, ErrNoSession)
}

// runNextJob runs the job at the head of the lane's queue, as the lane and the
// player loop would.
func runNextJob(t *testing.T, p *AppPlayer) {
	t.Helper()

	require.NotEmpty(t, p.loader.queue)
	job := p.loader.queue[0]
	p.loader.queue = p.loader.queue[1:]
	p.applyLoaderResult(p.loader.execute(job, t.Context()))
}

// A transfer queued before the edit replaces the list first: the edit, made on
// the list it was checked against, is superseded and changes nothing.
func TestQueueEditSupersededByATransfer(t *testing.T) {
	p := newTestAppPlayer(t)
	inJam(t, p)
	requireNext(t, p, "q0 | u1")

	require.NoError(t, p.handlePlayerCommand(jamEdit(t, &connectpb.ContextTrack{Uri: jamTrackUri, Uid: "u0"}, "retain_original")))
	require.Len(t, p.loader.queue, 1)

	req, wait := NewApiRequest(ApiRequestTypeQueueRemove, ApiRequestDataQueueEdit{Rev: p.queueRev(), Uid: "u1"})
	_, err := p.handleApiRequest(req)
	require.ErrorIs(t, err, errReplyDeferred)
	require.Len(t, p.loader.queue, 2)

	runNextJob(t, p) // the transfer
	runNextJob(t, p) // the edit

	_, err = wait(t.Context())
	require.ErrorIs(t, err, ErrConflict)
	requireNext(t, p, "q0 | u1")
	require.Equal(t, "q0 | u1", listLayout(t, p))
}

// What undoes an edit: in a Jam, social-connect's next transfer of the whole
// Jam (a guest's add, say) builds the list from its own copy, and the removed
// row is back. Documented, not fixed: L1 records whether that happens.
func TestQueueEditUndoneByTheNextJamTransfer(t *testing.T) {
	p := newTestAppPlayer(t)
	inJam(t, p)

	data, err := queueEditCall(t, p, ApiRequestTypeQueueRemove, "u1", "")
	requireEdited(t, p, data, err)
	requireNext(t, p, "q0")

	require.NoError(t, p.handlePlayerCommand(jamEdit(t, &connectpb.ContextTrack{Uri: jamTrackUri, Uid: "u0"}, "retain_original")))
	runQueuedJob(t, p)
	requireNext(t, p, "q0 | u1")
}

// controllerSetQueue makes a controller's set_queue of the published rows, in
// order (uids, space-separated), those in queued flagged as queued, and runs
// it.
func controllerSetQueue(t *testing.T, p *AppPlayer, order string, queued ...string) {
	t.Helper()
	runSetQueue(t, p, controllerRows(t, p, order, queued...))
}

// controllerRows are the rows of controllerSetQueue's set_queue.
func controllerRows(t *testing.T, p *AppPlayer, order string, queued ...string) []*connectpb.ContextTrack {
	t.Helper()

	var rows []*connectpb.ContextTrack
	for _, uid := range strings.Fields(order) {
		track := &connectpb.ContextTrack{Uid: uid, Metadata: map[string]string{}}
		for _, published := range p.state.player.NextTracks {
			if published.Uid == uid {
				track.Uri = published.Uri
			}
		}
		require.NotEmpty(t, track.Uri, uid)
		if slices.Contains(queued, uid) {
			track.Metadata["is_queued"] = "true"
		}
		rows = append(rows, track)
	}
	return rows
}

// runSetQueue makes a controller's set_queue of next, and runs it.
func runSetQueue(t *testing.T, p *AppPlayer, next []*connectpb.ContextTrack) {
	t.Helper()

	var req dealer.RequestPayload
	req.Command.Endpoint = "set_queue"
	req.Command.NextTracks = next
	require.NoError(t, p.handlePlayerCommand(req))
	runQueuedJob(t, p)
}

// A controller's set_queue is left as upstream has it: its order of the
// context's rows is a hint for the one publish it makes, while the list keeps
// its own order.
func TestControllerSetQueueOfTheContextIsAHint(t *testing.T) {
	p := queueEditPlayer(t)

	controllerSetQueue(t, p, "q2 q1 u3 u1 u2 u4 u5", "q2", "q1")
	requireNext(t, p, "q2 q1 | u3 u1 u2 u4 u5")
	require.Equal(t, "q2 q1 | u1 u2 u3 u4 u5 | a6 a7", listLayout(t, p))
}

// So an edit of the context's rows is not made against a controller's order
// of them: the list's own rows are published (and pushed) and the edit is
// refused. Made again against those, the client's refetch, it goes through.
func TestQueueEditOfTheContextInAControllersOrder(t *testing.T) {
	p := queueEditPlayer(t)
	log := &recordingLogger{}
	p.app.log = log
	controllerSetQueue(t, p, "q1 q2 u3 u1 u2 u4 u5", "q1", "q2")
	requireNext(t, p, "q1 q2 | u3 u1 u2 u4 u5")
	drain(p.statePush)
	p.statePutScheduled, p.lastStatePut = false, time.Time{} // the next push goes at once
	gen := p.prefetchGen
	rev := p.queueRev()

	_, err := queueEditCall(t, p, ApiRequestTypeQueueMove, "u5", "u1")
	require.ErrorIs(t, err, ErrConflict)
	require.ErrorIs(t, err, errQueueHinted)
	requireNext(t, p, "q1 q2 | u1 u2 u3 u4 u5 | a6 a7")
	require.Equal(t, "q1 q2 | u1 u2 u3 u4 u5 | a6 a7", nextLayout(lastPushedState(t, p).NextTracks), "pushed")
	require.Equal(t, "q1 q2 | u1 u2 u3 u4 u5 | a6 a7", listLayout(t, p), "nothing moved")
	require.NotEqual(t, rev, p.queueRev())
	require.Equal(t, gen, p.prefetchGen, "what plays next did not change")

	data, err := queueEditCall(t, p, ApiRequestTypeQueueMove, "u5", "u1")
	requireEdited(t, p, data, err)
	requireNext(t, p, "q1 q2 | u5 u1 u2 u3 u4 | a6 a7")

	require.Equal(t, []string{"queue edit move context -> 409", "queue edit move context -> 200"}, queueEditLines(log))
}

// Queued rows are the list's own whatever order the rest is shown in, so they
// are edited at once; that publish is the list's own, after which the
// context's rows can be edited too.
func TestQueueEditOfTheQueueInAControllersOrder(t *testing.T) {
	p := queueEditPlayer(t)
	controllerSetQueue(t, p, "q1 q2 u3 u1 u2 u4 u5", "q1", "q2")

	data, err := queueEditCall(t, p, ApiRequestTypeQueueMove, "q2", "q1")
	requireEdited(t, p, data, err)
	requireNext(t, p, "q2 q1 | u1 u2 u3 u4 u5 | a6 a7")

	data, err = queueEditCall(t, p, ApiRequestTypeQueueRemove, "u3", "")
	requireEdited(t, p, data, err)
	requireNext(t, p, "q2 q1 | u1 u2 u4 u5 | a6 a7")
}

// A row a controller moved from the queue to below it leaves the queue, but
// is published as a context row the list does not have. Removing it is
// refused once, with the list's own rows published; it is not among them, so
// it is not asked for again.
func TestQueueEditOfARowOnlyAControllerShowed(t *testing.T) {
	p := queueEditPlayer(t)
	log := &recordingLogger{}
	p.app.log = log
	controllerSetQueue(t, p, "q2 u1 q1 u2 u3 u4 u5", "q2")
	requireNext(t, p, "q2 | u1 q1 u2 u3 u4 u5")
	rev := p.queueRev()

	_, err := queueEditCall(t, p, ApiRequestTypeQueueRemove, "q1", "")
	require.ErrorIs(t, err, ErrConflict)
	requireNext(t, p, "q2 | u1 u2 u3 u4 u5 | a6 a7")
	require.NotEqual(t, rev, p.queueRev())

	_, err = queueEditCall(t, p, ApiRequestTypeQueueRemove, "q1", "")
	require.ErrorIs(t, err, ErrConflict)
	require.Equal(t, []string{"queue edit remove context -> 409", "queue edit remove none -> 409"}, queueEditLines(log))
}

// A controller that changes only the queue, or sends fewer rows, lists the
// context's rows as the device published them: in the list's own order, so an
// edit of them goes through the first time, with the end of their section the
// end of the rows shown.
func TestQueueEditOfTheContextInItsOwnOrderAfterASetQueue(t *testing.T) {
	for _, tt := range []struct {
		name   string
		order  string
		queued []string
		shown  string
		want   string
	}{
		{"the queue reordered", "q2 q1 u1 u2 u3 u4 u5", []string{"q2", "q1"},
			"q2 q1 | u1 u2 u3 u4 u5", "q2 q1 | u2 u3 u4 u5 u1 | a6 a7"},
		{"a queued row removed", "q2 u1 u2 u3 u4 u5", []string{"q2"},
			"q2 | u1 u2 u3 u4 u5", "q2 | u2 u3 u4 u5 u1 | a6 a7"},
		{"fewer rows sent", "q1 q2 u1 u2 u3", []string{"q1", "q2"},
			"q1 q2 | u1 u2 u3", "q1 q2 | u2 u3 u1 u4 u5 | a6 a7"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			p := queueEditPlayer(t)
			log := &recordingLogger{}
			p.app.log = log
			controllerSetQueue(t, p, tt.order, tt.queued...)
			requireNext(t, p, tt.shown)
			require.True(t, p.nextHinted)

			data, err := queueEditCall(t, p, ApiRequestTypeQueueMove, "u1", "")
			requireEdited(t, p, data, err)
			requireNext(t, p, tt.want)
			require.Equal(t, tt.want, listLayout(t, p))
			require.False(t, p.nextHinted, "the list's own rows are published")
			require.Equal(t, []string{"queue edit move context -> 200"}, queueEditLines(log))
		})
	}
}

// The same rows in other sections are another order: autoplay rows a
// controller sent back without their flag are shown among the context's, and
// the end of that section is not the list's.
func TestQueueEditOfTheContextShownInAnotherSection(t *testing.T) {
	p := queueEditPlayer(t)
	controllerSetQueue(t, p, "q1 q2 u1 u2 u3 u4 u5 a6 a7", "q1", "q2")
	requireNext(t, p, "q1 q2 | u1 u2 u3 u4 u5 a6 a7")

	_, err := queueEditCall(t, p, ApiRequestTypeQueueMove, "u1", "")
	require.ErrorIs(t, err, errQueueHinted)
	requireNext(t, p, "q1 q2 | u1 u2 u3 u4 u5 | a6 a7")
}

// Nor is an order the list's own when it goes on past the list's rows: a
// queued row a controller moved below everything else is shown as the last of
// the context's, where the list has none.
func TestQueueEditOfTheContextShownWithARowPastIt(t *testing.T) {
	p := queueEditPlayer(t)
	rows := controllerRows(t, p, "q2 u1 u2 u3 u4 u5 a6 a7 q1", "q2")
	for _, row := range rows[6:8] {
		row.Metadata["autoplay.is_autoplay"] = "true"
	}
	runSetQueue(t, p, rows)
	requireNext(t, p, "q2 | u1 u2 u3 u4 u5 | a6 a7 | q1")

	_, err := queueEditCall(t, p, ApiRequestTypeQueueMove, "u1", "")
	require.ErrorIs(t, err, errQueueHinted)
	requireNext(t, p, "q2 | u1 u2 u3 u4 u5 | a6 a7")
}

// Mutations queued on the lane before a new context is started are made
// before the load reads the queue it carries over: an add is kept, and a
// removal answered 200 stays removed.
func TestQueueEditsAheadOfANewContextCarryOver(t *testing.T) {
	p := queueEditPlayer(t)

	p.addToQueue(&connectpb.ContextTrack{Uri: trackUri(0x22)})
	req, wait := NewApiRequest(ApiRequestTypeQueueRemove, ApiRequestDataQueueEdit{Rev: p.queueRev(), Uid: "q1"})
	_, err := p.handleApiRequest(req)
	require.ErrorIs(t, err, errReplyDeferred)

	p.loadContext(&connectpb.Context{Uri: "spotify:playlist:37i9dQZF1DXcBWIGoYBM5M", Pages: []*connectpb.ContextPage{
		{Tracks: []*connectpb.ContextTrack{{Uri: trackUri(0x70), Uid: "n0"}, {Uri: trackUri(0x71), Uid: "n1"}}},
	}}, nil, false, true, func(error) {})
	require.Len(t, p.loader.queue, 3, "the load drops neither")

	runNextJob(t, p) // the add
	runNextJob(t, p) // the edit
	data, err := wait(t.Context())
	require.NoError(t, err)
	require.IsType(t, &ApiQueueRevision{}, data)

	runNextJob(t, p) // the load
	require.Equal(t, "n0", p.state.player.Track.GetUid())
	requireNext(t, p, "q2 q3 | n1")
}

// What a new context carries over is the queue the state showed. A step the
// load supersedes runs on the list first (navigation is never dropped), but
// nothing it stepped onto was published or played, so it stays queued; the row
// the state said was playing has been jumped away from, and goes.
func TestANewContextCarriesTheQueueTheStateShowed(t *testing.T) {
	step := func(t *testing.T, p *AppPlayer) {
		p.advanceNext(true, true, 0, func(bool, error) {})
	}
	stepped := func(t *testing.T, p *AppPlayer) { // and published, playing q1
		step(t, p)
		runQueuedJob(t, p)
		require.Equal(t, "q1", p.state.player.Track.GetUid())
		p.loader.queue = nil // the track need not load
	}
	newContext := func(t *testing.T, p *AppPlayer) {
		p.loadContext(&connectpb.Context{Uri: "spotify:playlist:37i9dQZF1DXcBWIGoYBM5M", Pages: []*connectpb.ContextPage{
			{Tracks: []*connectpb.ContextTrack{{Uri: trackUri(0x70), Uid: "n0"}, {Uri: trackUri(0x71), Uid: "n1"}}},
		}}, nil, false, true, func(error) {})
	}

	for _, tt := range []struct {
		name  string
		steps []func(t *testing.T, p *AppPlayer)
		jobs  int
		want  string
	}{
		{"a Next it supersedes", []func(*testing.T, *AppPlayer){step, newContext}, 2, "q1 q2 | n1"},
		{"a Next from a queued row it supersedes", []func(*testing.T, *AppPlayer){stepped, step, newContext}, 2, "q2 | n1"},
		{"a queued row playing", []func(*testing.T, *AppPlayer){stepped, newContext}, 1, "q2 | n1"},
		{"a second context while the first loads", []func(*testing.T, *AppPlayer){stepped, newContext, newContext}, 1, "q2 | n1"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			p := queueEditPlayer(t)
			for _, s := range tt.steps {
				s(t, p)
			}
			require.Len(t, p.loader.queue, tt.jobs)

			for range tt.jobs {
				runNextJob(t, p)
			}
			require.Equal(t, "n0", p.state.player.Track.GetUid())
			requireNext(t, p, tt.want)
		})
	}
}

// carriedQueue leaves out the entry the state said was playing, and only it,
// whatever the list says plays: a step onto the queue or back from it that was
// never published changes nothing. Entries are told apart by uid, and by uri
// only without one.
func TestCarriedQueue(t *testing.T) {
	p := queueEditPlayer(t)
	list := p.state.tracks
	q1Uri, q2Uri := p.state.player.NextTracks[0].Uri, p.state.player.NextTracks[1].Uri

	// Each entry by its uid, or by its uri without one.
	keys := func(queued []*connectpb.ContextTrack) string {
		var out []string
		for _, track := range queued {
			key := track.Uid
			if key == "" {
				key = track.Uri
			}
			out = append(out, key)
		}
		return strings.Join(out, " ")
	}
	queued := func(uri, uid string) *connectpb.ContextTrack {
		return &connectpb.ContextTrack{Uri: uri, Uid: uid, Metadata: map[string]string{"is_queued": "true"}}
	}

	require.Nil(t, carriedQueue(nil, "q1", q1Uri))
	require.Equal(t, "q1 q2", keys(carriedQueue(list, "", "")), "a context entry played")

	list.SetPlayingQueue(true) // a step onto q1
	require.Equal(t, "q1 q2", keys(carriedQueue(list, "", "")), "never published")
	require.Equal(t, "q2", keys(carriedQueue(list, "q1", q1Uri)), "published")
	require.Equal(t, "q1 q2", keys(carriedQueue(list, "q2", q2Uri)), "only the head can have played")

	list.GoPrev() // and back from it
	require.Equal(t, "q2", keys(carriedQueue(list, "q1", q1Uri)), "q1 played")
	require.Equal(t, "q1 q2", keys(carriedQueue(list, "", "")))

	// The same song queued again is another entry.
	list.SetQueue(nil, []*connectpb.ContextTrack{queued(q1Uri, "q3")})
	require.Equal(t, "q3", keys(carriedQueue(list, "q1", q1Uri)))

	list.SetQueue(nil, []*connectpb.ContextTrack{queued(q1Uri, ""), queued(q2Uri, "")})
	require.Equal(t, q2Uri, keys(carriedQueue(list, "", q1Uri)), "by uri")
	require.Equal(t, q1Uri+" "+q2Uri, keys(carriedQueue(list, "", q2Uri)))
	require.Equal(t, q1Uri+" "+q2Uri, keys(carriedQueue(list, "q1", q1Uri)), "a uid names an entry that has one")
}

// queueTopCall makes a Play Next as the API does (queueEditCall), and checks
// its answer carries the new revision.
func queueTopCall(t *testing.T, p *AppPlayer, uid string) (*ApiQueueTopResult, error) {
	t.Helper()

	data, err := queueEditCall(t, p, ApiRequestTypeQueueTop, uid, "")
	if err != nil {
		return nil, err
	}

	res, ok := data.(*ApiQueueTopResult)
	require.True(t, ok, "%T", data)
	require.Equal(t, p.queueRev(), res.Rev, "the answer is the new revision")
	return res, nil
}

// queueTopPlayer is queueEditPlayer with a Jam's "added by" on u3 and a6. It
// returns the context's entries too, by uid.
//
//	q1 q2 | u1 u2 u3 u4 u5 | a6 a7
func queueTopPlayer(t *testing.T) (*AppPlayer, map[string]*connectpb.ContextTrack) {
	t.Helper()

	entries := map[string]*connectpb.ContextTrack{}
	entry := func(i byte, autoplay bool) *connectpb.ContextTrack {
		track := &connectpb.ContextTrack{Uri: trackUri(0x40 + i), Uid: fmt.Sprintf("u%d", i)}
		if autoplay {
			track.Uid = fmt.Sprintf("a%d", i)
			track.Metadata = map[string]string{"autoplay.is_autoplay": "true"}
		}
		if i == 3 || i == 6 {
			if track.Metadata == nil {
				track.Metadata = map[string]string{}
			}
			track.Metadata["added_by"] = "spotify:user:jake"
		}
		entries[track.Uid] = track
		return track
	}

	p := newShuffleTestPlayer(t)
	p.loadContext(&connectpb.Context{Uri: playlistUri, Pages: []*connectpb.ContextPage{
		{Tracks: []*connectpb.ContextTrack{entry(0, false), entry(1, false), entry(2, false), entry(3, false)}},
		{Tracks: []*connectpb.ContextTrack{entry(4, false), entry(5, false), entry(6, true), entry(7, true)}},
	}}, nil, false, true, func(error) {})
	runQueuedJob(t, p)
	p.loader.queue = nil // the first track need not load

	for i := range 2 {
		p.addToQueue(&connectpb.ContextTrack{Uri: trackUri(0x20 + byte(i))})
		runQueuedJob(t, p)
	}

	requireNext(t, p, "q1 q2 | u1 u2 u3 u4 u5 | a6 a7")
	return p, entries
}

// Encore patch 9, Play Next of a queued row: it moves to the head of the
// queue and keeps its uid, in one edit.
func TestQueueTopOfAQueuedRow(t *testing.T) {
	p := queueEditPlayer(t)
	log := &recordingLogger{}
	p.app.log = log
	p.addToQueue(&connectpb.ContextTrack{Uri: trackUri(0x22)})
	runQueuedJob(t, p)
	requireNext(t, p, "q1 q2 q3 | u1 u2 u3 u4 u5 | a6 a7")
	queueID := p.state.queueID

	res, err := queueTopCall(t, p, "q3")
	require.NoError(t, err)
	require.Equal(t, "q3", res.Uid)
	requireNext(t, p, "q3 q1 q2 | u1 u2 u3 u4 u5 | a6 a7")
	require.Equal(t, listLayout(t, p), nextLayout(p.state.player.NextTracks))
	require.Equal(t, queueID, p.state.queueID, "no new uid")
	require.Equal(t, "q3", p.state.tracks.PeekNext(t.Context()).GetUid(), "it plays next")
	require.Equal(t, []string{"queue edit top queue -> 200"}, queueEditLines(log))
}

// A queued row first already is left where it is: answered 200 with its uid,
// with nothing changed, published or pushed.
func TestQueueTopOfTheFirstQueuedRow(t *testing.T) {
	p := queueEditPlayer(t)
	drain(p.statePush)
	p.statePutScheduled, p.lastStatePut = false, time.Time{} // a push would go at once
	p.queueEventPending = false
	rev := p.queueRev()
	next := p.state.player.NextTracks

	res, err := queueTopCall(t, p, "q1")
	require.NoError(t, err)
	require.Equal(t, &ApiQueueTopResult{Rev: rev, Uid: "q1"}, res)
	require.True(t, &next[0] == &p.state.player.NextTracks[0], "nothing published")
	require.False(t, p.queueEventPending)
	require.Empty(t, drain(p.statePush), "nothing pushed")
}

// A row of the context leaves its place for good and is queued first as a new
// entry, with a uid of its own: its metadata kept (a Jam's "added by"), and
// flagged as queued. The context's own entry is left as it was: a refetch of
// its page hands it out again.
func TestQueueTopOfAContextRow(t *testing.T) {
	p, entries := queueTopPlayer(t)
	log := &recordingLogger{}
	p.app.log = log

	res, err := queueTopCall(t, p, "u3")
	require.NoError(t, err)
	require.Equal(t, "q3", res.Uid)
	require.Equal(t, uint64(3), p.state.queueID)
	requireNext(t, p, "q3 q1 q2 | u1 u2 u4 u5 | a6 a7")
	require.Equal(t, listLayout(t, p), nextLayout(p.state.player.NextTracks))

	top := p.state.player.NextTracks[0]
	require.Equal(t, queueSectionQueue, top.Provider)
	require.Equal(t, trackUri(0x43), top.Uri)
	require.Equal(t, map[string]string{"added_by": "spotify:user:jake", "is_queued": "true"}, top.Metadata)

	require.Equal(t, "u3", entries["u3"].Uid, "the context's entry is untouched")
	require.Equal(t, map[string]string{"added_by": "spotify:user:jake"}, entries["u3"].Metadata)

	list := p.state.tracks
	for _, uid := range []string{"q3", "q1", "q2", "u1", "u2", "u4"} {
		require.True(t, list.GoNext(t.Context()))
		require.Equal(t, uid, list.CurrentTrack().GetUid())
	}
	require.Equal(t, []string{"queue edit top context -> 200"}, queueEditLines(log))
}

// An autoplay row is queued first the same way, and is autoplay's no more.
func TestQueueTopOfAnAutoplayRow(t *testing.T) {
	p, entries := queueTopPlayer(t)

	res, err := queueTopCall(t, p, "a6")
	require.NoError(t, err)
	require.Equal(t, "q3", res.Uid)
	requireNext(t, p, "q3 q1 q2 | u1 u2 u3 u4 u5 | a7")

	top := p.state.player.NextTracks[0]
	require.Equal(t, queueSectionQueue, top.Provider)
	require.Equal(t, map[string]string{"added_by": "spotify:user:jake", "is_queued": "true"}, top.Metadata)
	require.Equal(t, "true", entries["a6"].Metadata["autoplay.is_autoplay"], "the context's entry is untouched")
}

// Play Next while a queued row plays: the new row goes after it, first of what
// is still to play.
func TestQueueTopWhileAQueuedRowPlays(t *testing.T) {
	p := queueEditPlayer(t)
	p.advanceNext(true, true, 0, func(bool, error) {})
	runQueuedJob(t, p)
	p.loader.queue = nil // the track need not load
	require.Equal(t, "q1", p.state.player.Track.GetUid())
	requireNext(t, p, "q2 | u1 u2 u3 u4 u5 | a6 a7")

	res, err := queueTopCall(t, p, "u4")
	require.NoError(t, err)
	requireNext(t, p, res.Uid+" q2 | u1 u2 u3 u5 | a6 a7")
	require.Equal(t, "q1", p.state.tracks.CurrentTrack().GetUid(), "the queued row playing stays")
}

// A queued entry that does not say it is queued: SetQueue would drop it and
// what follows, so nothing changes, and the list's own rows are published
// before the 409.
func TestQueueTopWithAnUnflaggedQueue(t *testing.T) {
	p := queueEditPlayer(t)
	p.state.tracks.Queue()[1].Metadata["is_queued"] = "no" // q2

	_, err := queueTopCall(t, p, "u3")
	require.ErrorIs(t, err, ErrConflict)
	require.ErrorIs(t, err, errQueueUnflagged)
	requireNext(t, p, "q1 | q2 u1 u2 u3 u4 u5 | a6 a7") // q2 shows as the list has it now
	require.Equal(t, "q1 | q2 u1 u2 u3 u4 u5 | a6 a7", listLayout(t, p), "nothing changed")
}

// Rows shown in a controller's order: Play Next of one of the context's is
// refused once, with the list's own rows published, then made.
func TestQueueTopOfTheContextInAControllersOrder(t *testing.T) {
	p := queueEditPlayer(t)
	controllerSetQueue(t, p, "q1 q2 u3 u1 u2 u4 u5", "q1", "q2")

	_, err := queueTopCall(t, p, "u4")
	require.ErrorIs(t, err, errQueueHinted)
	requireNext(t, p, "q1 q2 | u1 u2 u3 u4 u5 | a6 a7")

	res, err := queueTopCall(t, p, "u4")
	require.NoError(t, err)
	requireNext(t, p, res.Uid+" q1 q2 | u1 u2 u3 u5 | a6 a7")
}

// A transfer queued before Play Next replaces the list first: the edit is
// superseded and changes nothing.
func TestQueueTopSupersededByATransfer(t *testing.T) {
	p := newTestAppPlayer(t)
	inJam(t, p)
	requireNext(t, p, "q0 | u1")

	require.NoError(t, p.handlePlayerCommand(jamEdit(t, &connectpb.ContextTrack{Uri: jamTrackUri, Uid: "u0"}, "retain_original")))
	req, wait := NewApiRequest(ApiRequestTypeQueueTop, ApiRequestDataQueueEdit{Rev: p.queueRev(), Uid: "u1"})
	_, err := p.handleApiRequest(req)
	require.ErrorIs(t, err, errReplyDeferred)
	require.Len(t, p.loader.queue, 2)

	runNextJob(t, p) // the transfer
	runNextJob(t, p) // Play Next

	_, err = wait(t.Context())
	require.ErrorIs(t, err, ErrConflict)
	requireNext(t, p, "q0 | u1")
}

func TestQueueTopWithNothingLoaded(t *testing.T) {
	p := newTestAppPlayer(t)

	req, _ := NewApiRequest(ApiRequestTypeQueueTop, ApiRequestDataQueueEdit{Rev: p.queueRev(), Uid: "u1"})
	_, err := p.handleApiRequest(req)
	require.ErrorIs(t, err, ErrNoSession)
	require.Empty(t, p.loader.queue)
}
