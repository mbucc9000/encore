//go:build test_unit

package daemon

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	connectpb "github.com/devgianlu/go-librespot/proto/spotify/connectstate"
	"github.com/stretchr/testify/require"
)

// Encore patch 9: a tap on a row of Up Next plays it (queue_jump.go).

// jumpPlayer is queueEditPlayer with u0's load landed, and the config a skip
// reads:
//
//	u0 | q1 q2 | u1 u2 u3 u4 u5 | a6 a7
func jumpPlayer(t *testing.T) *AppPlayer {
	t.Helper()

	p := queueEditPlayer(t)
	p.app.cfg = &Config{}
	p.loadInFlight = false // queueEditPlayer never ran u0's load
	return p
}

// queueJumpRequest hands the loop a jump as the API does, and returns its
// wait. A refused one is answered at once.
func queueJumpRequest(t *testing.T, p *AppPlayer, uid string) (func(context.Context) (any, error), error) {
	t.Helper()

	req, wait := NewApiRequest(ApiRequestTypeQueueJump, ApiRequestDataQueueJump{Uid: uid})
	_, err := p.handleApiRequest(req)
	if !errors.Is(err, errReplyDeferred) {
		return nil, err
	}
	return wait, nil
}

// queueJumpCall makes a jump as the API does, running its list job as the
// lane and the player loop would, and returns its answer.
func queueJumpCall(t *testing.T, p *AppPlayer, uid string) (any, error) {
	t.Helper()

	gen := p.loadGen
	wait, err := queueJumpRequest(t, p, uid)
	if err != nil {
		require.Empty(t, p.loader.queue, "a refused jump queues nothing")
		require.Equal(t, gen, p.loadGen, "and supersedes nothing")
		return nil, err
	}

	require.Len(t, p.loader.queue, 1)
	require.Equal(t, classLoad, p.loader.queue[0].class, "a jump is a load: it supersedes what was out")
	runNextJob(t, p)

	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	return wait(ctx)
}

// queueJumpLines is what the jumps logged.
func queueJumpLines(log *recordingLogger) []string {
	var out []string
	for _, line := range log.lines() {
		if strings.HasPrefix(line, "queue jump ") {
			out = append(out, line)
		}
	}
	return out
}

func prevUids(p *AppPlayer) []string {
	var uids []string
	for _, track := range p.state.player.PrevTracks {
		uids = append(uids, track.Uid)
	}
	return uids
}

// A row of the context: the rows above it become the history, the queue
// stays and plays after it, and it loads from its start, once. The answer is
// the new revision, before the track has loaded.
func TestQueueJumpToAContextRow(t *testing.T) {
	p := jumpPlayer(t)
	log := &recordingLogger{}
	p.app.log = log
	drain(p.statePush)
	p.statePutScheduled, p.lastStatePut = false, time.Time{} // the next push goes at once
	p.state.player.PositionAsOfTimestamp = 42000

	data, err := queueJumpCall(t, p, "u3")
	require.NoError(t, err)
	require.Equal(t, &ApiQueueRevision{Rev: p.queueRev()}, data)

	require.Equal(t, "u3", p.state.player.Track.GetUid())
	require.Equal(t, [2]uint32{0, 3}, [2]uint32{p.state.player.Index.GetPage(), p.state.player.Index.GetTrack()})
	requireNext(t, p, "q1 q2 | u4 u5 | a6 a7")
	require.Equal(t, []string{"u0", "u1", "u2"}, prevUids(p))
	require.Equal(t, "q1 q2 | u4 u5 | a6 a7", nextLayout(lastPushedState(t, p).NextTracks), "pushed")

	require.Equal(t, []string{"load " + trackUri(0x43)}, queuedNames(p.loader), "one load")
	require.True(t, p.loadInFlight)
	require.Zero(t, p.state.player.PositionAsOfTimestamp, "from its start")
	require.Equal(t, []string{"queue jump context -> 200"}, queueJumpLines(log))
}

// A queued row: the queued rows above it are dropped, the context stays.
func TestQueueJumpToAQueuedRow(t *testing.T) {
	p := jumpPlayer(t)

	data, err := queueJumpCall(t, p, "q2")
	require.NoError(t, err)
	require.IsType(t, &ApiQueueRevision{}, data)

	require.Equal(t, "q2", p.state.player.Track.GetUid())
	require.Equal(t, queueSectionQueue, p.state.player.Track.GetProvider())
	require.Same(t, p.state.player.Track, p.playingQueued)
	requireNext(t, p, "u1 u2 u3 u4 u5 | a6 a7")
	require.Equal(t, []string{"load " + trackUri(0x21)}, queuedNames(p.loader))
}

// An autoplay row is jumped to as the context's are.
func TestQueueJumpToAnAutoplayRow(t *testing.T) {
	p := jumpPlayer(t)

	_, err := queueJumpCall(t, p, "a6")
	require.NoError(t, err)
	require.Equal(t, "a6", p.state.player.Track.GetUid())
	requireNext(t, p, "q1 q2 | a7")
}

// The window is walked again from the new position: a shuffled list of 60, a
// jump to the 20th row, and 32 rows again, the rest of the old ones first.
func TestQueueJumpRefillsTheWindow(t *testing.T) {
	p := newShuffleTestPlayer(t)
	p.app.cfg = &Config{}
	spotCtx, _ := shuffleTestContext("spotify:playlist:37i9dQZF1DX8vwRmUsEIMT", 0x01, 60)
	p.setPlayShuffle(pointer(true))
	p.loadContext(spotCtx, nil, false, true, func(error) {})
	runQueuedJob(t, p)
	p.loader.queue = nil // the first track need not load
	p.loadInFlight = false

	before := nextLayout(p.state.player.NextTracks)
	rows := strings.Fields(before)
	require.Len(t, rows, 32)

	_, err := queueJumpCall(t, p, rows[19])
	require.NoError(t, err)
	require.Equal(t, rows[19], p.state.player.Track.GetUid())
	after := strings.Fields(nextLayout(p.state.player.NextTracks))
	require.Len(t, after, 32, "refilled")
	require.Equal(t, rows[20:], after[:12])
	require.Len(t, p.state.player.PrevTracks, 20)
}

// What the rows shown say is refused at once: nothing is queued or
// superseded, and the music plays on.
func TestQueueJumpRefusals(t *testing.T) {
	for _, tt := range []struct {
		name string
		uid  string
	}{
		{"the current row", "u0"},
		{"not upcoming", "u9"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			p := jumpPlayer(t)
			log := &recordingLogger{}
			p.app.log = log
			before := nextLayout(p.state.player.NextTracks)

			_, err := queueJumpCall(t, p, tt.uid)
			require.ErrorIs(t, err, ErrConflict)
			require.Equal(t, "u0", p.state.player.Track.GetUid())
			require.Equal(t, before, nextLayout(p.state.player.NextTracks))
			require.Equal(t, []string{"queue jump none -> 409"}, queueJumpLines(log))
		})
	}

	t.Run("nothing loaded", func(t *testing.T) {
		p := newTestAppPlayer(t)
		_, err := queueJumpCall(t, p, "u1")
		require.ErrorIs(t, err, ErrNoSession)
	})
}

// The row gone when the job runs (removed from elsewhere meanwhile): nothing
// changes, the list's own rows are published, and the answer is 409. Nothing
// loads: the track playing is the one the state says.
func TestQueueJumpToARowGoneWhenItRuns(t *testing.T) {
	p := jumpPlayer(t)
	log := &recordingLogger{}
	p.app.log = log

	wait, err := queueJumpRequest(t, p, "u3")
	require.NoError(t, err)
	require.NoError(t, p.state.tracks.RemoveAhead("u3")) // meanwhile, and not published
	runNextJob(t, p)

	_, err = wait(t.Context())
	require.ErrorIs(t, err, ErrConflict)
	require.Equal(t, "u0", p.state.player.Track.GetUid())
	requireNext(t, p, "q1 q2 | u1 u2 u4 u5 | a6 a7")
	require.Empty(t, p.loader.queue, "nothing loads")
	require.False(t, p.narrationJumped)
	require.Equal(t, []string{"queue jump context -> 409"}, queueJumpLines(log))
}

// A row of the context shown in a controller's set_queue order that is not the
// list's own (nextHinted): the jump goes by the list's order, and would pass
// over a row shown below the one tapped (u2 here). It is refused once the
// list's own rows are published, with nothing loaded; tapped again on those,
// it goes through. A queued row is the list's own in any order shown.
func TestQueueJumpInAControllersOrder(t *testing.T) {
	t.Run("a row of the context", func(t *testing.T) {
		p := jumpPlayer(t)
		log := &recordingLogger{}
		p.app.log = log
		controllerSetQueue(t, p, "q1 q2 u1 u3 u2 u4 u5", "q1", "q2")
		requireNext(t, p, "q1 q2 | u1 u3 u2 u4 u5")

		_, err := queueJumpCall(t, p, "u3")
		require.ErrorIs(t, err, ErrConflict)
		require.ErrorIs(t, err, errQueueHinted)
		require.Equal(t, "u0", p.state.player.Track.GetUid())
		requireNext(t, p, "q1 q2 | u1 u2 u3 u4 u5 | a6 a7")
		require.False(t, p.nextHinted, "the list's own rows are published")
		require.Empty(t, p.loader.queue, "nothing loads")
		require.False(t, p.narrationJumped)

		_, err = queueJumpCall(t, p, "u3")
		require.NoError(t, err)
		require.Equal(t, "u3", p.state.player.Track.GetUid())
		require.Equal(t, []string{"u0", "u1", "u2"}, prevUids(p))
		requireNext(t, p, "q1 q2 | u4 u5 | a6 a7")
		require.Equal(t, []string{"queue jump context -> 409", "queue jump context -> 200"}, queueJumpLines(log))
	})

	t.Run("a queued row", func(t *testing.T) {
		p := jumpPlayer(t)
		controllerSetQueue(t, p, "q2 q1 u3 u1 u2 u4 u5", "q2", "q1")

		_, err := queueJumpCall(t, p, "q1")
		require.NoError(t, err)
		require.Equal(t, "q1", p.state.player.Track.GetUid())
		requireNext(t, p, "u1 u2 u3 u4 u5 | a6 a7")
	})
}

// A jump refused on the lane still superseded what was out before it, and what
// that would have done is done: a step forward that ran onto the row tapped
// is published and its track loaded (the 409 then names the row playing, which
// a client restarts); a load of the track playing is made again.
func TestQueueJumpRefusedAfterWhatItSuperseded(t *testing.T) {
	t.Run("a step forward onto the row", func(t *testing.T) {
		p := jumpPlayer(t)
		p.advanceNext(true, true, 0, func(bool, error) {}) // the track ended
		wait, err := queueJumpRequest(t, p, "q1")
		require.NoError(t, err)
		require.Equal(t, []string{"advance", "queue jump"}, queuedNames(p.loader), "a step is never dropped")

		runNextJob(t, p) // the step: superseded
		require.Equal(t, "u0", p.state.player.Track.GetUid())
		runNextJob(t, p) // the jump

		_, err = wait(t.Context())
		require.ErrorIs(t, err, ErrConflict)
		require.Equal(t, "q1", p.state.player.Track.GetUid(), "where the list is")
		requireNext(t, p, "q2 | u1 u2 u3 u4 u5 | a6 a7")
		require.Equal(t, []string{"load " + trackUri(0x20)}, queuedNames(p.loader))
		require.Zero(t, p.state.player.PositionAsOfTimestamp)
	})

	t.Run("a load of the track playing", func(t *testing.T) {
		p := queueEditPlayer(t) // u0's load is out
		p.app.cfg = &Config{}
		require.True(t, p.loadInFlight)
		p.state.player.PositionAsOfTimestamp = 1500

		wait, err := queueJumpRequest(t, p, "u3")
		require.NoError(t, err)
		require.NoError(t, p.state.tracks.RemoveAhead("u3"))
		runNextJob(t, p)

		_, err = wait(t.Context())
		require.ErrorIs(t, err, ErrConflict)
		require.Equal(t, "u0", p.state.player.Track.GetUid())
		require.Equal(t, []string{"load " + trackUri(0x40)}, queuedNames(p.loader), "loaded again")
		require.Equal(t, int64(1500), p.state.player.PositionAsOfTimestamp, "where it was")
	})
}

// A newer load supersedes a jump still queued: it is answered 409 at once,
// and the newer one plays.
func TestQueueJumpSupersededByANewerOne(t *testing.T) {
	p := jumpPlayer(t)

	first, err := queueJumpRequest(t, p, "u3")
	require.NoError(t, err)
	second, err := queueJumpRequest(t, p, "u4")
	require.NoError(t, err)

	_, err = first(t.Context())
	require.ErrorIs(t, err, ErrSuperseded)
	require.Equal(t, []string{"queue jump"}, queuedNames(p.loader), "dropped unrun")

	runNextJob(t, p)
	data, err := second(t.Context())
	require.NoError(t, err)
	require.IsType(t, &ApiQueueRevision{}, data)
	require.Equal(t, "u4", p.state.player.Track.GetUid())
	requireNext(t, p, "q1 q2 | u5 | a6 a7")
}

// A transfer that arrives while the jump waits on the lane replaces the list
// the row was in: the jump is superseded, and the transfer plays.
func TestQueueJumpSupersededByATransfer(t *testing.T) {
	p := newTestAppPlayer(t)
	p.app.cfg = &Config{}
	inJam(t, p)
	requireNext(t, p, "q0 | u1")

	wait, err := queueJumpRequest(t, p, "u1")
	require.NoError(t, err)
	require.NoError(t, p.handlePlayerCommand(jamEdit(t, &connectpb.ContextTrack{Uri: jamTrackUri, Uid: "u0"}, "retain_original")))

	_, err = wait(t.Context())
	require.ErrorIs(t, err, ErrSuperseded)
	runQueuedJob(t, p) // the transfer
	require.Equal(t, "u0", p.state.player.Track.GetUid())
	requireNext(t, p, "q0 | u1")
}
