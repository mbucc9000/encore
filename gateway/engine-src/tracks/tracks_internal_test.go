//go:build test_unit

package tracks

import (
	"context"
	"fmt"
	"io"
	"slices"
	"strings"
	"testing"

	librespot "github.com/devgianlu/go-librespot"
	connectpb "github.com/devgianlu/go-librespot/proto/spotify/connectstate"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/suite"
)

const stationUri = "spotify:station:track:test"

func trackUri(i int) string { return fmt.Sprintf("spotify:track:%06d", i) }

type TrackListInternalSuite struct {
	suite.Suite

	resolver *MockContextResolver
	list     *List
}

func (suite *TrackListInternalSuite) SetupTest() {
	suite.resolver = NewMockContextResolver(suite.T())

	// Identity is read whenever a track is described or a message logged, which
	// is incidental to what these tests assert.
	suite.resolver.EXPECT().Type().Return(librespot.SpotifyIdTypeTrack).Maybe()
	suite.resolver.EXPECT().Uri().Return(stationUri).Maybe()

	suite.list = newTrackList(&librespot.NullLogger{}, suite.resolver)
}

// expectEndlessPages models a station: every page yields more tracks and there
// is always another page, exactly the shape that makes an unbounded seek run
// forever.
func (suite *TrackListInternalSuite) expectEndlessPages() {
	const perPage = 5

	suite.resolver.EXPECT().Page(mock.Anything, mock.Anything).
		RunAndReturn(func(_ context.Context, idx int) ([]*connectpb.ContextTrack, error) {
			tracks := make([]*connectpb.ContextTrack, perPage)
			for i := range tracks {
				tracks[i] = &connectpb.ContextTrack{Uri: trackUri(idx*perPage + i)}
			}
			return tracks, nil
		})
}

// TestSeekStopsAtPageCap covers the core of issue #288: a station's pagination
// never reports an end, so a seek for a track it does not serve has to give up
// on its own rather than fetch pages until the caller's deadline expires.
func (suite *TrackListInternalSuite) TestSeekStopsAtPageCap() {
	suite.expectEndlessPages()

	err := suite.list.Seek(context.Background(), func(*connectpb.ContextTrack) bool { return false })
	suite.Error(err)
	suite.Contains(err.Error(), "gave up seeking")

	// Every page up to and including the cap is fetched, and not one more.
	suite.resolver.AssertNumberOfCalls(suite.T(), "Page", seekMaxPages+1)
	suite.resolver.AssertCalled(suite.T(), "Page", mock.Anything, seekMaxPages)
	suite.resolver.AssertNotCalled(suite.T(), "Page", mock.Anything, seekMaxPages+1)
}

// TestSeekFindsTrackWithinCap makes sure the bound does not get in the way of
// an ordinary seek.
func (suite *TrackListInternalSuite) TestSeekFindsTrackWithinCap() {
	suite.expectEndlessPages()

	target := &connectpb.ContextTrack{Uri: trackUri(42)}
	suite.NoError(suite.list.TrySeekTo(context.Background(), target))

	suite.Equal(trackUri(42), suite.list.CurrentTrack().Uri)
	suite.Equal(&connectpb.ContextIndex{Page: 8, Track: 2}, suite.list.Index())
}

// TestTrySeekToPlaysUnfoundTrack locks in the behaviour that matters to the
// user on a transfer: when the track cannot be located, it is played anyway
// instead of the context silently starting over on some other song.
func (suite *TrackListInternalSuite) TestTrySeekToPlaysUnfoundTrack() {
	suite.expectEndlessPages()

	target := &connectpb.ContextTrack{Uri: "spotify:track:notinthiscontext"}
	suite.NoError(suite.list.TrySeekTo(context.Background(), target))

	suite.Equal("spotify:track:notinthiscontext", suite.list.CurrentTrack().Uri)

	// The track is not part of the context, so it has no index in it.
	suite.Equal(&connectpb.ContextIndex{}, suite.list.Index())

	// Nothing precedes it, and playback carries on into the context from its
	// first track.
	suite.Empty(suite.list.PrevTracks())
	suite.True(suite.list.GoNext(context.Background()))
	suite.Equal(trackUri(0), suite.list.CurrentTrack().Uri)
}

// TestTrySeekToInjectsOnFetchFailure covers the failure actually seen in the
// wild: the walk dies part-way with a deadline exceeded. The requested track
// must still play.
func (suite *TrackListInternalSuite) TestTrySeekToInjectsOnFetchFailure() {
	suite.resolver.EXPECT().Page(mock.Anything, mock.Anything).Return(nil, context.DeadlineExceeded)

	target := &connectpb.ContextTrack{Uri: trackUri(7)}
	suite.NoError(suite.list.TrySeekTo(context.Background(), target))

	suite.Equal(trackUri(7), suite.list.CurrentTrack().Uri)
	suite.Equal(1, suite.list.tracks.len())

	// The injected track must not have consumed page 0: once the context is
	// reachable again, playback continues into it from the beginning.
	suite.Equal(-1, suite.list.tracks.list[suite.list.tracks.len()-1].pageIdx)
}

// TestTrySeekToOnFiniteContext checks the ordinary miss, where the context
// simply ends without holding the track.
func (suite *TrackListInternalSuite) TestTrySeekToOnFiniteContext() {
	suite.resolver.EXPECT().Page(mock.Anything, 0).
		Return([]*connectpb.ContextTrack{{Uri: trackUri(0)}, {Uri: trackUri(1)}}, nil).Once()
	suite.resolver.EXPECT().Page(mock.Anything, 1).Return(nil, io.EOF).Once()

	target := &connectpb.ContextTrack{Uri: trackUri(99)}
	suite.NoError(suite.list.TrySeekTo(context.Background(), target))

	suite.Equal(trackUri(99), suite.list.CurrentTrack().Uri)
	suite.True(suite.list.GoNext(context.Background()))
	suite.Equal(trackUri(0), suite.list.CurrentTrack().Uri)
}

// TestShuffleStopsAtPageCap makes sure shuffling an endless context terminates
// too: it fetches "all" tracks up front, which has the same unbounded walk.
func (suite *TrackListInternalSuite) TestShuffleStopsAtPageCap() {
	suite.expectEndlessPages()

	suite.NoError(suite.list.TrySeekTo(context.Background(), &connectpb.ContextTrack{Uri: trackUri(0)}))
	suite.NoError(suite.list.ToggleShuffle(context.Background(), true))

	suite.resolver.AssertNumberOfCalls(suite.T(), "Page", seekMaxPages+1)
}

// playingContext sets the list up the way production always hands it to a
// jump: a finite context of n tracks with the cursor resting on the first one.
func (suite *TrackListInternalSuite) playingContext(n int) {
	tracks := make([]*connectpb.ContextTrack, n)
	for i := range tracks {
		tracks[i] = &connectpb.ContextTrack{Uri: trackUri(i), Uid: fmt.Sprintf("c%d", i)}
	}

	suite.resolver.EXPECT().Page(mock.Anything, 0).Return(tracks, nil).Maybe()
	suite.resolver.EXPECT().Page(mock.Anything, mock.Anything).Return(nil, io.EOF).Maybe()

	suite.Require().NoError(suite.list.TrySeekTo(context.Background(), tracks[0]))
}

func queued(uid, uri string) *connectpb.ContextTrack {
	return &connectpb.ContextTrack{Uri: uri, Uid: uid, Metadata: map[string]string{"is_queued": "true"}}
}

// TestSeekToContextTrackWhileQueuePlaying is issue #218: with a manually queued
// track playing, jumping to a track in the context moved the context cursor but
// left the queue in charge, so the queued track simply restarted.
func (suite *TrackListInternalSuite) TestSeekToContextTrackWhileQueuePlaying() {
	suite.playingContext(5)

	suite.list.AddToQueue(queued("q1", "spotify:track:queued1"))
	suite.list.SetPlayingQueue(true)
	suite.Require().Equal("spotify:track:queued1", suite.list.CurrentTrack().Uri)

	// Jump to a track from the context.
	suite.NoError(suite.list.TrySeekTo(context.Background(), &connectpb.ContextTrack{Uri: trackUri(3), Uid: "c3"}))

	suite.Equal(trackUri(3), suite.list.CurrentTrack().Uri)
	suite.Equal(&connectpb.ContextIndex{Page: 0, Track: 3}, suite.list.Index())

	// The queued track was jumped away from, so advancing carries on into the
	// context rather than playing it a second time.
	suite.True(suite.list.GoNext(context.Background()))
	suite.Equal(trackUri(4), suite.list.CurrentTrack().Uri)
}

// TestSeekToQueuedTrack covers the second half of the issue: jumping to another
// queued track must play it and consume the ones skipped over, rather than
// leave it sitting in the queue.
func (suite *TrackListInternalSuite) TestSeekToQueuedTrack() {
	suite.playingContext(5)

	suite.list.AddToQueue(queued("q1", "spotify:track:queued1"))
	suite.list.AddToQueue(queued("q2", "spotify:track:queued2"))
	suite.list.AddToQueue(queued("q3", "spotify:track:queued3"))
	suite.list.SetPlayingQueue(true)

	suite.NoError(suite.list.TrySeekTo(context.Background(), queued("q3", "spotify:track:queued3")))

	suite.Equal("spotify:track:queued3", suite.list.CurrentTrack().Uri)

	// q1 and q2 were skipped past and q3 is playing rather than pending, so
	// nothing queued is upcoming any more.
	next := suite.list.NextTracks(context.Background(), nil)
	suite.Require().NotEmpty(next)
	suite.Equal(trackUri(1), next[0].Uri)

	// Once it ends, playback continues into the context.
	suite.True(suite.list.GoNext(context.Background()))
	suite.Equal(trackUri(1), suite.list.CurrentTrack().Uri)
}

// TestSeekToContextTrackPrefersContextCopy guards the uid disambiguation: a
// song can sit in the queue and in the context at once, and clicking the
// context copy must not hijack the queued one.
func (suite *TrackListInternalSuite) TestSeekToContextTrackPrefersContextCopy() {
	suite.playingContext(5)

	suite.list.AddToQueue(queued("q1", trackUri(3)))

	suite.NoError(suite.list.TrySeekTo(context.Background(), &connectpb.ContextTrack{Uri: trackUri(3), Uid: "c3"}))

	suite.Equal(trackUri(3), suite.list.CurrentTrack().Uri)
	suite.Equal(&connectpb.ContextIndex{Page: 0, Track: 3}, suite.list.Index())

	// The queued copy was not consumed and still plays next.
	suite.True(suite.list.GoNext(context.Background()))
	suite.Equal(&connectpb.ContextIndex{}, suite.list.Index())
	suite.Equal(trackUri(3), suite.list.CurrentTrack().Uri)
}

// TestSeekToQueuedTrackWithoutUid covers the API path, which names a track by
// uri alone.
func (suite *TrackListInternalSuite) TestSeekToQueuedTrackWithoutUid() {
	suite.playingContext(5)

	suite.list.AddToQueue(queued("q1", "spotify:track:queued1"))
	suite.list.AddToQueue(queued("q2", "spotify:track:queued2"))

	suite.NoError(suite.list.TrySeekTo(context.Background(), &connectpb.ContextTrack{Uri: "spotify:track:queued2"}))

	suite.Equal("spotify:track:queued2", suite.list.CurrentTrack().Uri)
}

// A snapshot leaves the list behind: it is read from another goroutine while
// the list carries on being queued into and walked, so it must share nothing —
// least of all the metadata map ContextTrackToProvidedTrack hands straight over.
func (suite *TrackListInternalSuite) TestSnapshotSharesNothingWithTheList() {
	suite.resolver.EXPECT().Metadata().Return(map[string]string{"context_description": "Test"}).Maybe()
	suite.playingContext(5)
	suite.list.AddToQueue(queued("q1", "spotify:track:queued1"))

	snap := suite.list.Snapshot(context.Background(), nil)
	suite.Require().Equal(trackUri(0), snap.Current.Uri)
	suite.Require().Equal("spotify:track:queued1", snap.Next[0].Uri)
	suite.Require().Equal("true", snap.Next[0].Metadata["is_queued"])

	// What the list still hands out aliases its own tracks, so writing through
	// it reaches anything that kept a reference.
	live := suite.list.NextTracks(context.Background(), nil)
	live[0].Metadata["is_queued"] = "rewritten"
	snap.Metadata["context_description"] = "Mutated"

	suite.Equal("true", snap.Next[0].Metadata["is_queued"], "the snapshot kept its own copy")
	suite.Equal("Test", suite.list.Metadata()["context_description"])
}

// AllTracks seeds an autoplay station, and is reached by having run out of
// context: anything not already loaded is by definition not recently played, so
// it must never turn into a fetch.
func (suite *TrackListInternalSuite) TestAllTracksIsResidentAndBounded() {
	suite.expectEndlessPages()
	suite.Require().NoError(suite.list.TrySeek(context.Background(), func(t *connectpb.ContextTrack) bool {
		return t.Uri == trackUri(20)
	}))

	loaded := suite.list.tracks.len()
	suite.Require().Greater(loaded, 3)

	all := suite.list.AllTracks(3)
	suite.Len(all, 3)
	suite.Equal(trackUri(loaded-1), all[2].Uri, "the most recent tracks are the ones kept")

	suite.Len(suite.list.AllTracks(0), loaded, "no bound keeps everything resident")
	suite.Equal(loaded, suite.list.tracks.len(), "nothing was fetched")
}

// pagedContext serves the given pages of context entries, each only once, and
// io.EOF after the last as often as asked. The entries are named by uid; an
// "a" first makes one autoplay's.
func (suite *TrackListInternalSuite) pagedContext(pages ...[]string) map[string]*connectpb.ContextTrack {
	byUid := map[string]*connectpb.ContextTrack{}
	n := 0
	for idx, page := range pages {
		tracks := make([]*connectpb.ContextTrack, 0, len(page))
		for _, uid := range page {
			track := &connectpb.ContextTrack{Uri: trackUri(n), Uid: uid}
			if uid[0] == 'a' {
				track.Metadata = map[string]string{"autoplay.is_autoplay": "true"}
			}
			tracks = append(tracks, track)
			byUid[uid] = track
			n++
		}
		suite.resolver.EXPECT().Page(mock.Anything, idx).Return(tracks, nil).Once()
	}
	suite.resolver.EXPECT().Page(mock.Anything, len(pages)).Return(nil, io.EOF).Maybe()
	return byUid
}

// uidsAhead is what the list would publish next, by uid.
func (suite *TrackListInternalSuite) uidsAhead() []string {
	var uids []string
	for _, track := range suite.list.NextTracks(context.Background(), nil) {
		uids = append(uids, track.Uid)
	}
	return uids
}

// walkOn plays the list to its end, returning the uids played.
func (suite *TrackListInternalSuite) walkOn() []string {
	var uids []string
	for suite.list.GoNext(context.Background()) {
		uids = append(uids, suite.list.CurrentTrack().Uid)
	}
	return uids
}

// A removed entry is out of the list: neither published nor played again.
// Removing the last entry loaded must not make the next fetch ask for a page
// already loaded, which put the removed entry back (and duplicated the rest).
func (suite *TrackListInternalSuite) TestRemoveAheadOfTheLastLoadedEntry() {
	suite.pagedContext([]string{"c0", "c1", "c2"}, []string{"d0"})
	suite.Require().True(suite.list.GoStart(context.Background()))
	suite.Equal([]string{"c1", "c2", "d0"}, suite.uidsAhead())

	suite.NoError(suite.list.RemoveAhead("d0"))
	suite.Equal([]string{"c1", "c2"}, suite.uidsAhead())
	suite.Equal([]string{"c1", "c2"}, suite.walkOn())
	suite.resolver.AssertNumberOfCalls(suite.T(), "Page", 5) // 0 and 1 once each, then the end each time it is reached
}

// The next entry removed is what the prefetch skips too.
func (suite *TrackListInternalSuite) TestRemoveAheadOfTheNextEntry() {
	suite.pagedContext([]string{"c0", "c1", "c2", "c3"})
	suite.Require().True(suite.list.GoStart(context.Background()))

	suite.NoError(suite.list.RemoveAhead("c1"))
	suite.Equal("c2", suite.list.PeekNext(context.Background()).Uid)
	suite.True(suite.list.GoNext(context.Background()))
	suite.Equal("c2", suite.list.CurrentTrack().Uid)
	suite.Equal(&connectpb.ContextIndex{Page: 0, Track: 2}, suite.list.Index(), "its place in its page is its own")
	suite.Equal([]string{"c0"}, func() []string {
		var uids []string
		for _, track := range suite.list.PrevTracks() {
			uids = append(uids, track.Uid)
		}
		return uids
	}())
}

// Moved to the end of what was shown, across a page: the order holds through
// publishing and playing, and the next fetch is the page after the last one
// fetched, not the moved entry's page's next.
func (suite *TrackListInternalSuite) TestMoveAheadToTheEnd() {
	suite.pagedContext([]string{"c0", "c1", "c2"}, []string{"d0", "d1"})
	suite.Require().True(suite.list.GoStart(context.Background()))
	suite.Equal([]string{"c1", "c2", "d0", "d1"}, suite.uidsAhead())

	suite.NoError(suite.list.MoveAhead("c1", "", 4))
	suite.Equal([]string{"c2", "d0", "d1", "c1"}, suite.uidsAhead())
	suite.Equal([]string{"c2", "d0", "d1", "c1"}, suite.walkOn())
	suite.Equal(&connectpb.ContextIndex{Page: 0, Track: 1}, suite.list.Index())
	suite.resolver.AssertNumberOfCalls(suite.T(), "Page", 5)
}

// The end of what was shown is after the span-1 other context entries that
// come first: before the autoplay tail, and before what the client was not
// shown.
func (suite *TrackListInternalSuite) TestMoveAheadToTheEndOfWhatWasShown() {
	suite.pagedContext([]string{"c0", "c1", "c2", "c3", "a4", "a5", "c6"})
	suite.Require().True(suite.list.GoStart(context.Background()))

	suite.NoError(suite.list.MoveAhead("c1", "", 3))
	suite.Equal([]string{"c2", "c3", "c1", "a4", "a5", "c6"}, suite.uidsAhead())

	suite.NoError(suite.list.MoveAhead("c2", "", 2))
	suite.Equal([]string{"c3", "c2", "c1", "a4", "a5", "c6"}, suite.uidsAhead())

	// Alone in what was shown, it is at its end already.
	suite.NoError(suite.list.MoveAhead("c3", "", 1))
	suite.Equal([]string{"c3", "c2", "c1", "a4", "a5", "c6"}, suite.uidsAhead())
}

func (suite *TrackListInternalSuite) TestMoveAheadBefore() {
	suite.pagedContext([]string{"c0", "c1", "c2"}, []string{"d0", "d1"})
	suite.Require().True(suite.list.GoStart(context.Background()))
	suite.uidsAhead()

	suite.NoError(suite.list.MoveAhead("d1", "c2", 4))
	suite.Equal([]string{"c1", "d1", "c2", "d0"}, suite.uidsAhead())

	suite.NoError(suite.list.MoveAhead("d0", "c1", 4))
	suite.Equal("d0", suite.list.PeekNext(context.Background()).Uid)
	suite.Equal([]string{"d0", "c1", "d1", "c2"}, suite.walkOn())
}

// Only the context's own entries ahead of the current one can be edited, the
// first of two alike. Encore patch 9: a shuffled list edits too.
func (suite *TrackListInternalSuite) TestEditsAheadRefused() {
	suite.pagedContext([]string{"c0", "c1", "x", "x", "a4"})
	suite.Require().True(suite.list.GoStart(context.Background()))
	suite.list.AddToQueue(queued("q1", "spotify:track:queued1"))
	suite.Require().True(suite.list.GoNext(context.Background())) // q1
	suite.Require().True(suite.list.GoNext(context.Background())) // c1
	suite.Require().Equal("c1", suite.list.CurrentTrack().Uid)

	for _, uid := range []string{"c0", "c1", "q1", "a4", "nope"} {
		suite.ErrorIs(suite.list.RemoveAhead(uid), ErrNotAhead, uid)
		suite.ErrorIs(suite.list.MoveAhead(uid, "", 3), ErrNotAhead, uid)
	}
	suite.ErrorIs(suite.list.MoveAhead("x", "a4", 3), ErrNotAhead, "autoplay is not the context's")
	suite.ErrorIs(suite.list.MoveAhead("x", "c0", 3), ErrNotAhead, "played")

	suite.NoError(suite.list.RemoveAhead("x"))
	suite.Equal(trackUri(3), suite.list.PeekNext(context.Background()).Uri, "the first of the two went")

	suite.NoError(suite.list.ToggleShuffle(context.Background(), true))
	suite.False(suite.list.shuffleEdited)
	suite.NoError(suite.list.MoveAhead("x", "", 3))
	suite.True(suite.list.shuffleEdited, "edited while shuffled")
	suite.NoError(suite.list.RemoveAhead("x"))
	suite.ErrorIs(suite.list.RemoveAhead("x"), ErrNotAhead)
	suite.ErrorIs(suite.list.RemoveAhead("a4"), ErrNotAhead, "autoplay is not the context's")
	suite.ErrorIs(suite.list.RemoveAhead(""), ErrNotAhead, "an entry is named by a uid")
}

// A failed in-order refetch on unshuffling puts the list back as it was, and
// with it the page the next fetch asks for: left at "none fetched", that
// fetch loaded the first page again behind the rest.
func (suite *TrackListInternalSuite) TestFailedUnshuffleKeepsTheNextPage() {
	n := 0
	tracks := func(uids ...string) []*connectpb.ContextTrack {
		var out []*connectpb.ContextTrack
		for _, uid := range uids {
			out = append(out, &connectpb.ContextTrack{Uri: trackUri(n), Uid: uid})
			n++
		}
		return out
	}

	suite.resolver.EXPECT().Page(mock.Anything, 0).Return(tracks("c0", "c1", "c2"), nil).Once()
	suite.resolver.EXPECT().Page(mock.Anything, 1).Return(tracks("d0"), nil).Once()
	suite.resolver.EXPECT().Page(mock.Anything, 2).Return(nil, fmt.Errorf("page 2 failed")).Once()
	suite.resolver.EXPECT().Page(mock.Anything, 2).Return(tracks("e0"), nil).Once()
	suite.resolver.EXPECT().Page(mock.Anything, 0).Return(nil, fmt.Errorf("page 0 failed")).Once()
	suite.resolver.EXPECT().Page(mock.Anything, 3).Return(nil, io.EOF).Maybe()

	suite.Require().True(suite.list.GoStart(context.Background()))
	suite.Require().NoError(suite.list.ToggleShuffle(context.Background(), true)) // stops at page 2's failure
	suite.Require().Len(suite.uidsAhead(), 4, "page 2 loads now: the length changed since the shuffle")

	suite.Error(suite.list.ToggleShuffle(context.Background(), false), "the in-order refetch fails")
	suite.Len(suite.uidsAhead(), 4, "nothing loaded twice")
	suite.resolver.AssertNumberOfCalls(suite.T(), "Page", 7)
}

// pageCalls counts the pages asked of the resolver so far.
func (suite *TrackListInternalSuite) pageCalls() int {
	n := 0
	for _, call := range suite.resolver.Calls {
		if call.Method == "Page" {
			n++
		}
	}
	return n
}

// residentUids is every entry the list holds, by uid, in its order.
func (suite *TrackListInternalSuite) residentUids() []string {
	var uids []string
	for _, item := range suite.list.tracks.list {
		uids = append(uids, item.item.Uid)
	}
	return uids
}

// without is uids less the ones named.
func without(uids []string, gone ...string) []string {
	return slices.DeleteFunc(slices.Clone(uids), func(uid string) bool { return slices.Contains(gone, uid) })
}

// Encore patch 9, P5/P6: entries removed, moved and taken while the list is
// shuffled. Turning shuffle off then gives the context's own order, without
// the entries removed or taken (they used to come back), the current entry
// kept, and fetches nothing.
func (suite *TrackListInternalSuite) TestShuffledEditsThenShuffleOff() {
	inOrder := []string{"c0", "c1", "c2", "c3", "c4", "c5", "d0", "d1", "d2", "d3", "d4", "d5"}
	suite.pagedContext(inOrder[:6], inOrder[6:])
	suite.Require().True(suite.list.GoStart(context.Background()))
	suite.Require().NoError(suite.list.ToggleShuffle(context.Background(), true))
	suite.Require().True(suite.list.GoNext(context.Background()))
	suite.Require().True(suite.list.GoNext(context.Background()))

	ahead := suite.uidsAhead()
	suite.Require().Len(ahead, 9)
	suite.NoError(suite.list.RemoveAhead(ahead[0]))
	suite.NoError(suite.list.MoveAhead(ahead[5], ahead[1], 9))
	taken, err := suite.list.TakeAhead(ahead[2])
	suite.Require().NoError(err)
	suite.Equal(ahead[2], taken.Uid)
	suite.Equal([]string{ahead[1], ahead[3], ahead[4], ahead[6], ahead[7], ahead[8]}, without(suite.uidsAhead(), ahead[5]))
	suite.True(suite.list.shuffleEdited)

	current := suite.list.CurrentTrack().Uid
	pages := suite.pageCalls()
	suite.NoError(suite.list.ToggleShuffle(context.Background(), false))

	suite.False(suite.list.shuffled)
	suite.False(suite.list.shuffleEdited)
	suite.Equal(pages, suite.pageCalls(), "nothing fetched")
	want := without(inOrder, ahead[0], ahead[2])
	suite.Equal(want, suite.residentUids(), "the context's order, without what was removed or taken")
	suite.Equal(current, suite.list.CurrentTrack().Uid, "the current entry kept")
	suite.Equal(want[slices.Index(want, current)+1:], suite.uidsAhead())
	at := slices.Index(inOrder, current)
	suite.Equal(&connectpb.ContextIndex{Page: uint32(at / 6), Track: uint32(at % 6)}, suite.list.Index())
}

// Without an edit, shuffle off is upstream's: the shuffle replayed, fetching
// nothing, even after a jump.
func (suite *TrackListInternalSuite) TestShuffleOffWithoutEditsReplaysTheSeed() {
	inOrder := []string{"c0", "c1", "c2", "c3", "c4", "c5", "c6", "c7"}
	suite.pagedContext(inOrder)
	suite.Require().True(suite.list.GoStart(context.Background()))
	suite.Require().NoError(suite.list.ToggleShuffle(context.Background(), true))
	suite.Require().NoError(suite.list.JumpAhead(suite.uidsAhead()[3]))
	current := suite.list.CurrentTrack().Uid

	pages := suite.pageCalls()
	suite.NoError(suite.list.ToggleShuffle(context.Background(), false))
	suite.Equal(pages, suite.pageCalls())
	suite.Equal(inOrder, suite.residentUids())
	suite.Equal(current, suite.list.CurrentTrack().Uid)
}

// TakeAhead takes an entry of the context or autoplay ahead of the current
// one, never a queued one or one behind; the first of two alike.
func (suite *TrackListInternalSuite) TestTakeAhead() {
	suite.pagedContext([]string{"c0", "c1", "c2", "a3", "c4", "x", "x"})
	suite.Require().True(suite.list.GoStart(context.Background()))
	suite.list.AddToQueue(queued("q1", "spotify:track:queued1"))
	suite.Require().Equal([]string{"q1", "c1", "c2", "a3", "c4", "x", "x"}, suite.uidsAhead())

	for _, uid := range []string{"q1", "c0", "nope", ""} {
		_, err := suite.list.TakeAhead(uid)
		suite.ErrorIs(err, ErrNotAhead, uid)
	}

	taken, err := suite.list.TakeAhead("a3")
	suite.Require().NoError(err)
	suite.Equal("true", taken.Metadata["autoplay.is_autoplay"], "the list's own entry")
	taken, err = suite.list.TakeAhead("c2")
	suite.Require().NoError(err)
	suite.Equal(trackUri(2), taken.Uri)
	taken, err = suite.list.TakeAhead("x")
	suite.Require().NoError(err)
	suite.Equal(trackUri(5), taken.Uri, "the first of the two")

	suite.Equal([]string{"q1", "c1", "c4", "x"}, suite.uidsAhead())
	suite.False(suite.list.shuffleEdited, "not shuffled")
	suite.Equal([]string{"q1", "c1", "c4", "x"}, suite.walkOn())
}

// listOf is a context of one page, each entry a uid and a uri.
func (suite *TrackListInternalSuite) listOf(entries ...[2]string) {
	tracks := make([]*connectpb.ContextTrack, 0, len(entries))
	for _, entry := range entries {
		tracks = append(tracks, &connectpb.ContextTrack{Uid: entry[0], Uri: entry[1]})
	}
	suite.resolver.EXPECT().Page(mock.Anything, 0).Return(tracks, nil).Once()
	suite.resolver.EXPECT().Page(mock.Anything, 1).Return(nil, io.EOF).Maybe()
	suite.Require().True(suite.list.GoStart(context.Background()))
}

// prevUids is what the list would publish as played, by uid.
func (suite *TrackListInternalSuite) prevUids() []string {
	var uids []string
	for _, track := range suite.list.PrevTracks() {
		uids = append(uids, track.Uid)
	}
	return uids
}

// P1: the same song twice. Naming the later entry's uid lands on it, never on
// the earlier one in the history, which TrySeekTo's walk from the start did.
func (suite *TrackListInternalSuite) TestJumpAheadNeverGoesBack() {
	a := trackUri(100)
	suite.listOf([2]string{"c0", a}, [2]string{"c1", trackUri(101)}, [2]string{"c2", a}, [2]string{"c3", trackUri(103)})
	suite.Require().True(suite.list.GoNext(context.Background()))

	suite.NoError(suite.list.JumpAhead("c2"))
	suite.Equal("c2", suite.list.CurrentTrack().Uid)
	suite.Equal(&connectpb.ContextIndex{Page: 0, Track: 2}, suite.list.Index())
	suite.Equal([]string{"c0", "c1"}, suite.prevUids())
	suite.Equal([]string{"c3"}, suite.uidsAhead())
}

// P3 and P4: a context entry whose song is queued too. Its uid names the
// context's entry, not the queued copy, and the queue stays, playing next.
func (suite *TrackListInternalSuite) TestJumpAheadToTheContextKeepsTheQueue() {
	suite.playingContext(5)
	suite.list.AddToQueue(queued("q1", "spotify:track:queued1"))
	suite.list.AddToQueue(queued("q2", trackUri(2)))

	suite.NoError(suite.list.JumpAhead("c2"))
	suite.Equal("c2", suite.list.CurrentTrack().Uid)
	suite.Equal(&connectpb.ContextIndex{Page: 0, Track: 2}, suite.list.Index())
	suite.Equal([]string{"q1", "q2", "c3", "c4"}, suite.uidsAhead())
	suite.Equal([]string{"c0", "c1"}, suite.prevUids(), "skipped, they are the history")
	suite.Equal([]string{"q1", "q2", "c3", "c4"}, suite.walkOn())
}

// A queued entry: the queued ones before it are dropped, the context stays.
func (suite *TrackListInternalSuite) TestJumpAheadToAQueuedEntry() {
	suite.playingContext(5)
	for _, uid := range []string{"q1", "q2", "q3"} {
		suite.list.AddToQueue(queued(uid, "spotify:track:"+uid))
	}

	suite.NoError(suite.list.JumpAhead("q2"))
	suite.Equal("q2", suite.list.CurrentTrack().Uid)
	suite.Equal([]string{"q3", "c1", "c2", "c3", "c4"}, suite.uidsAhead())
	suite.Equal([]string{"q3", "c1", "c2", "c3", "c4"}, suite.walkOn())
}

// A queued entry playing is dropped by a jump into the context; the rest of
// the queue stays. The one playing is not ahead of itself.
func (suite *TrackListInternalSuite) TestJumpAheadFromAQueuedEntry() {
	suite.playingContext(5)
	suite.list.AddToQueue(queued("q1", "spotify:track:queued1"))
	suite.list.AddToQueue(queued("q2", "spotify:track:queued2"))
	suite.list.SetPlayingQueue(true)

	suite.ErrorIs(suite.list.JumpAhead("q1"), ErrNotAhead, "the one playing")
	suite.Equal("q1", suite.list.CurrentTrack().Uid)

	suite.NoError(suite.list.JumpAhead("c3"))
	suite.Equal("c3", suite.list.CurrentTrack().Uid)
	suite.Equal([]string{"q2", "c4"}, suite.uidsAhead())
}

// A row not ahead leaves the list as it was.
func (suite *TrackListInternalSuite) TestJumpAheadNotFound() {
	suite.playingContext(5)
	suite.list.AddToQueue(queued("q1", "spotify:track:queued1"))
	suite.Require().True(suite.list.GoNext(context.Background())) // q1
	suite.Require().True(suite.list.GoNext(context.Background())) // c1
	ahead := suite.uidsAhead()

	for _, uid := range []string{"c0", "c1", "q1", "nope", ""} {
		suite.ErrorIs(suite.list.JumpAhead(uid), ErrNotAhead, uid)
		suite.Equal("c1", suite.list.CurrentTrack().Uid)
		suite.Equal(ahead, suite.uidsAhead())
	}
}

// P2: a shuffled list of 60. A jump to the 20th row ahead lands there, and the
// window of 32 is full again: the rows after it, then more of the shuffled
// order, all already in memory.
func (suite *TrackListInternalSuite) TestJumpAheadRefillsTheWindow() {
	var uids []string
	for i := range 60 {
		uids = append(uids, fmt.Sprintf("s%d", i))
	}
	suite.pagedContext(uids[:20], uids[20:40], uids[40:])
	suite.Require().True(suite.list.GoStart(context.Background()))
	suite.Require().NoError(suite.list.ToggleShuffle(context.Background(), true))

	before := suite.uidsAhead()
	suite.Require().Len(before, MaxTracksInContext)
	pages := suite.pageCalls()

	suite.NoError(suite.list.JumpAhead(before[19]))
	suite.Equal(before[19], suite.list.CurrentTrack().Uid)
	after := suite.uidsAhead()
	suite.Len(after, MaxTracksInContext)
	suite.Equal(before[20:], after[:12])
	suite.Equal(pages, suite.pageCalls(), "nothing fetched")
	suite.Len(suite.list.PrevTracks(), 20)
}

// Encore patch 9: an entry the context gives no uid gets one made from its
// song, its page and the copies of that song before it in the page, the same
// every time it is loaded; a uid it gave is kept, and the context's own
// entries are left as they are.
func (suite *TrackListInternalSuite) TestEntriesWithoutUidGetOne() {
	page0 := []*connectpb.ContextTrack{{Uri: trackUri(0)}, {Uri: trackUri(1), Uid: "sp1"}, {Uri: trackUri(2)}, {Uri: trackUri(0)}}
	page1 := []*connectpb.ContextTrack{{Uri: trackUri(3)}}
	suite.resolver.EXPECT().Page(mock.Anything, 0).Return(page0, nil)
	suite.resolver.EXPECT().Page(mock.Anything, 1).Return(page1, nil)
	suite.resolver.EXPECT().Page(mock.Anything, 2).Return(nil, io.EOF)

	walk := func() []string {
		suite.Require().True(suite.list.GoStart(context.Background()))
		uids := []string{suite.list.CurrentTrack().Uid}
		return append(uids, suite.uidsAhead()...)
	}

	want := []string{contextUid(0, trackUri(0), 0), "sp1", contextUid(0, trackUri(2), 0), contextUid(0, trackUri(0), 1), contextUid(1, trackUri(3), 0)}
	suite.Equal(want, walk())
	suite.Len(slices.Compact(slices.Sorted(slices.Values(want))), len(want), "unique, a song listed twice too")
	for _, uid := range want {
		if uid != "sp1" {
			suite.True(strings.HasPrefix(uid, "enc-"), uid)
			suite.Empty(SpotifyUid(uid), "never told to Spotify")
		}
	}
	suite.Equal("sp1", SpotifyUid("sp1"), "Spotify's own uid is")
	suite.Same(page0[1], suite.list.tracks.list[1].item, "an entry with a uid is handed on")
	suite.Empty(page0[0].Uid, "the context's own entry is left alone")
	suite.Empty(page1[0].Uid)

	suite.list.tracks.clear()
	suite.Equal(want, walk(), "the same once fetched again")

	suite.NoError(suite.list.JumpAhead(want[2]))
	suite.Equal(trackUri(2), suite.list.CurrentTrack().Uri)
}

// Encore patch 9: a made-up uid names its song, not a place. The context is
// resolved again with an entry put first (a song liked goes to the top of
// Liked Songs): a seek by the uid and uri the engine published, as a transfer
// back to it makes, lands on the same song, never on the entry now in its
// old place; so does a seek by that uid alone (a session's current uid).
func (suite *TrackListInternalSuite) TestMadeUpUidsFollowTheirSong() {
	resolved := func(page []*connectpb.ContextTrack) *List {
		r := NewMockContextResolver(suite.T())
		r.EXPECT().Type().Return(librespot.SpotifyIdTypeTrack).Maybe()
		r.EXPECT().Uri().Return(stationUri).Maybe()
		r.EXPECT().Page(mock.Anything, 0).Return(page, nil).Maybe()
		r.EXPECT().Page(mock.Anything, 1).Return(nil, io.EOF).Maybe()
		return newTrackList(&librespot.NullLogger{}, r)
	}
	ctx := context.Background()

	first := resolved([]*connectpb.ContextTrack{{Uri: trackUri(0)}, {Uri: trackUri(1)}, {Uri: trackUri(2)}})
	suite.Require().NoError(first.TrySeekTo(ctx, &connectpb.ContextTrack{Uri: trackUri(2)}))
	played := first.CurrentTrack()
	suite.Require().NotEmpty(played.Uid)

	liked := func() []*connectpb.ContextTrack {
		return []*connectpb.ContextTrack{{Uri: trackUri(9)}, {Uri: trackUri(0)}, {Uri: trackUri(1)}, {Uri: trackUri(2)}}
	}

	again := resolved(liked())
	suite.NoError(again.TrySeekTo(ctx, &connectpb.ContextTrack{Uid: played.Uid, Uri: played.Uri}))
	suite.Equal(trackUri(2), again.CurrentTrack().Uri)
	suite.Equal(played.Uid, again.CurrentTrack().Uid, "the same song, the same uid")
	suite.Equal(&connectpb.ContextIndex{Page: 0, Track: 3}, again.Index())

	byUid := resolved(liked())
	suite.NoError(byUid.Seek(ctx, ContextTrackComparator(librespot.SpotifyIdTypeTrack, &connectpb.ContextTrack{Uid: played.Uid})))
	suite.Equal(trackUri(2), byUid.CurrentTrack().Uri)
}

func TestTrackListInternalSuite(t *testing.T) {
	suite.Run(t, new(TrackListInternalSuite))
}
