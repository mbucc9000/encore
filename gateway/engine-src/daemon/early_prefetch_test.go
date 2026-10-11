//go:build test_unit

package daemon

import (
	"context"
	"testing"
	"time"
	"weak"

	librespot "github.com/devgianlu/go-librespot"
	"github.com/devgianlu/go-librespot/player"
	connectpb "github.com/devgianlu/go-librespot/proto/spotify/connectstate"
	metadatapb "github.com/devgianlu/go-librespot/proto/spotify/metadata"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"
)

// Encore patch 7: early prefetch.

// testStream is a stream for uri as a load or a prefetch would have built it,
// 200 s long. Nothing in it is ever read.
func testStream(t *testing.T, uri string) *player.Stream {
	t.Helper()
	return testStreamLasting(t, uri, 200000)
}

// testStreamLasting is testStream, ms long.
func testStreamLasting(t *testing.T, uri string, ms int32) *player.Stream {
	t.Helper()

	id, err := librespot.SpotifyIdFromUri(uri)
	require.NoError(t, err)

	return &player.Stream{
		RequestedId: *id,
		Source:      librespot.NewMockAudioSource(t),
		Media: librespot.NewMediaFromTrack(&metadatapb.Track{
			Gid:      id.Id(),
			Name:     proto.String("Song"),
			Duration: proto.Int32(ms),
		}),
	}
}

// onAir plays the state's current track: a stream for it is the primary, and
// playback is not paused. The state around it is left as it is.
func onAir(t *testing.T, p *AppPlayer) *player.Stream {
	t.Helper()

	stream := testStream(t, p.state.player.Track.GetUri())
	p.primaryStream = stream
	p.state.player.IsPlaying = true
	p.state.setPaused(false)
	return stream
}

// fires reports whether timer fires within d.
func fires(timer *time.Timer, d time.Duration) bool {
	select {
	case <-timer.C:
		return true
	case <-time.After(d):
		return false
	}
}

// startNextJob takes the job at the head of the lane's queue as the lane would
// start it, and returns it with its context. Finish it with finishJob.
func startNextJob(t *testing.T, p *AppPlayer) (loaderJob, context.Context) {
	t.Helper()

	job, ctx, _, ok := p.loader.next()
	require.True(t, ok)
	return job, ctx
}

// finishJob ends a job started with startNextJob the way the lane does, and
// applies the result it came back with.
func finishJob(p *AppPlayer, job loaderJob, res loaderResult) {
	p.loader.mu.Lock()
	p.loader.running.cancel()
	p.loader.running = nil
	p.loader.mu.Unlock()

	res.name, res.gen, res.class, res.reply = job.name, job.gen, job.class, job.reply
	p.applyLoaderResult(res)
}

// prefetched is the result of a prefetch job that built stream.
func prefetched(stream *player.Stream) loaderResult {
	return loaderResult{
		discard: func() { closeSource(stream.Source) },
		commit: func(p *AppPlayer, err error) {
			if err == nil {
				p.commitPrefetch(stream, stream.Source)
			}
		},
	}
}

// earlyPrefetchPlayer is queueEditPlayer (u0 playing, then q1 q2 | u1 ...)
// with u0 on air and early prefetch set to a second. It returns the uri of
// what plays next, q1.
func earlyPrefetchPlayer(t *testing.T) (*AppPlayer, string) {
	t.Helper()

	p := queueEditPlayer(t)
	onAir(t, p)
	p.loadInFlight = false // u0's load has landed: queueEditPlayer never ran it
	p.earlyPrefetch = time.Second
	p.loader.keptGrace = time.Hour

	return p, p.state.player.NextTracks[0].GetUri()
}

// prefetchEarly runs an early prefetch up to its fetch: the timer fires, and
// the peek finds the next track and queues its prefetch.
func prefetchEarly(t *testing.T, p *AppPlayer, next string) {
	t.Helper()

	p.schedulePrefetchNext()
	require.True(t, p.prefetchArmedEarly)
	p.prefetchTimerFired()
	require.Equal(t, []string{"peek next"}, queuedNames(p.loader))
	runQueuedJob(t, p)
	require.Equal(t, []string{"prefetch " + next}, queuedNames(p.loader))
}

// stepWhilePrefetching runs an early prefetch up to its fetch, starts that,
// and takes a step forward while it runs: the step keeps it, and waits behind
// it on the lane. It returns the running prefetch job and its context.
func stepWhilePrefetching(t *testing.T, p *AppPlayer, next string) (loaderJob, context.Context) {
	t.Helper()

	prefetchEarly(t, p, next)
	job, ctx := startNextJob(t, p)

	p.advanceNext(true, true, 0, func(bool, error) {}) // next
	require.NoError(t, ctx.Err(), "kept")
	require.Equal(t, []string{"advance"}, queuedNames(p.loader))
	require.True(t, p.keptStep, "the loop knows the step waits")
	return job, ctx
}

func TestEarlyPrefetchDelay(t *testing.T) {
	p := newTestAppPlayer(t)
	first := playingTrack(t, p, jamTrackUri, "u0")
	p.earlyPrefetch = 5 * time.Second

	d, ok := p.earlyPrefetchDelay(2 * time.Minute)
	require.True(t, ok)
	require.Equal(t, 5*time.Second, d)

	_, ok = p.earlyPrefetchDelay(5 * time.Second)
	require.False(t, ok, "upstream's time is no later")

	_, ok = p.earlyPrefetchDelay(earlyPrefetchMaxLead + time.Second)
	require.False(t, ok, "too long before the track plays")

	p.state.player.Options.RepeatingTrack = true
	_, ok = p.earlyPrefetchDelay(2 * time.Minute)
	require.False(t, ok, "repeating the track: what plays next is this one")
	p.state.player.Options.RepeatingTrack = false

	p.prefetchFiredFor = weak.Make(first)
	_, ok = p.earlyPrefetchDelay(2 * time.Minute)
	require.False(t, ok, "once per track")

	playingTrack(t, p, queuedUri, "q0")
	_, ok = p.earlyPrefetchDelay(2 * time.Minute)
	require.True(t, ok, "the next track gets its own")

	p.earlyPrefetch = 0
	_, ok = p.earlyPrefetchDelay(2 * time.Minute)
	require.False(t, ok, "off")
}

// The timer is set for early_prefetch_ms after the track starts playing,
// rather than 30 s before it ends.
func TestEarlyPrefetchTimerFiresSoonAfterTheTrackStarts(t *testing.T) {
	p := newTestAppPlayer(t)
	playingTrack(t, p, jamTrackUri, "u0") // 175.6 s long, at 0: upstream's time is 145.6 s away
	p.earlyPrefetch = 20 * time.Millisecond

	p.schedulePrefetchNext()
	require.True(t, p.prefetchArmedEarly)
	require.True(t, fires(p.prefetchTimer, 5*time.Second))

	// Paused, nothing is fetched at all, as upstream.
	p.state.setPaused(true)
	p.schedulePrefetchNext()
	require.False(t, p.prefetchArmedEarly)
	require.False(t, fires(p.prefetchTimer, 100*time.Millisecond))

	// Played again, it counts from then.
	p.state.setPaused(false)
	p.schedulePrefetchNext()
	require.True(t, p.prefetchArmedEarly)
	require.True(t, fires(p.prefetchTimer, 5*time.Second))
}

// Off, the timer keeps upstream's time.
func TestEarlyPrefetchOffKeepsUpstreamsTime(t *testing.T) {
	p := newTestAppPlayer(t)
	playingTrack(t, p, jamTrackUri, "u0")

	p.schedulePrefetchNext()
	require.False(t, p.prefetchArmedEarly)
	require.False(t, fires(p.prefetchTimer, 100*time.Millisecond))
}

// The timer fires early once per track. Afterwards it is set for upstream's
// time, whatever re-arms it: the early fire, a seek, a pause and a play, or a
// change to what plays next.
func TestEarlyPrefetchFiresOncePerTrack(t *testing.T) {
	p := newTestAppPlayer(t)
	playingTrack(t, p, jamTrackUri, "u0")
	p.earlyPrefetch = 20 * time.Millisecond

	p.schedulePrefetchNext()
	require.True(t, fires(p.prefetchTimer, 5*time.Second))
	p.prefetchTimerFired()

	require.False(t, p.prefetchArmedEarly)
	require.False(t, fires(p.prefetchTimer, 100*time.Millisecond))
	require.True(t, p.prefetchTimer.Stop(), "re-armed for upstream's time, so a failed prefetch is tried again then")

	p.schedulePrefetchNext()
	require.False(t, p.prefetchArmedEarly)
	p.invalidateUpcoming()
	p.schedulePrefetchNext()
	require.False(t, p.prefetchArmedEarly)

	// The next track is another stream, which gets its own.
	playingTrack(t, p, queuedUri, "q0")
	p.schedulePrefetchNext()
	require.True(t, p.prefetchArmedEarly)
}

// One prefetch of the next track at a time: a fire while one is queued or
// running leaves it alone, and only a change to what plays next replaces it.
func TestEarlyPrefetchKeepsOnePrefetchInFlight(t *testing.T) {
	p, next := earlyPrefetchPlayer(t)

	p.schedulePrefetchNext()
	p.prefetchTimerFired()
	require.Equal(t, []string{"peek next"}, queuedNames(p.loader))

	p.prefetchTimerFired() // upstream's time, or any other fire
	require.Equal(t, []string{"peek next"}, queuedNames(p.loader))

	runQueuedJob(t, p) // the peek queues the prefetch of the track it found
	require.Equal(t, []string{"prefetch " + next}, queuedNames(p.loader))
	job := p.loader.queue[0]
	require.True(t, job.opensStream)
	require.Equal(t, p.prefetchGen, job.gen)

	p.prefetchTimerFired()
	require.Equal(t, []string{"prefetch " + next}, queuedNames(p.loader), "not twice while queued")

	job, ctx := startNextJob(t, p)
	p.prefetchTimerFired()
	require.Empty(t, queuedNames(p.loader), "nor while running")
	require.NoError(t, ctx.Err())

	// What plays next changed: the running prefetch is stale, and the next
	// fire replaces it.
	p.invalidateUpcoming()
	p.prefetchTimerFired()
	require.Equal(t, []string{"peek next"}, queuedNames(p.loader))
	require.ErrorIs(t, ctx.Err(), context.Canceled, "the stale prefetch is cancelled")
	finishJob(p, job, loaderResult{err: ctx.Err()})
	require.Nil(t, p.secondaryStream)
}

// The listener skips while the early prefetch is still fetching: the skip
// waits for it rather than cancel it, and plays what it fetched. Cancelled,
// the load would ask for the same audio key again.
func TestSkipDuringTheEarlyPrefetchPlaysIt(t *testing.T) {
	p, next := earlyPrefetchPlayer(t)
	prefetchEarly(t, p, next)
	job, ctx := startNextJob(t, p)

	p.advanceNext(true, true, 0, func(bool, error) {}) // next
	require.NoError(t, ctx.Err(), "the prefetch in flight is left to finish")
	require.Equal(t, []string{"advance"}, queuedNames(p.loader))

	// It finishes first (the lane is serialized and its results come back in
	// order), and becomes the secondary.
	stream := testStream(t, next)
	finishJob(p, job, prefetched(stream))
	require.Same(t, stream, p.secondaryStream)

	dropStreamForLoad(p)
	runQueuedJob(t, p) // the step
	require.Equal(t, next, p.state.player.Track.GetUri())
	require.Nil(t, p.secondaryStream, "taken by the load")
	require.Equal(t, []string{"load " + next}, queuedNames(p.loader))

	// The load hands the prefetched stream straight to the player, which in
	// the harness is closed. Building a new stream instead would need the
	// session the harness does not have.
	load := p.loader.queue[0]
	var res loaderResult
	require.NotPanics(t, func() { res = load.run(t.Context()) })
	require.ErrorIs(t, res.err, player.ErrPlayerClosed)
}

// A step that is not the next track cancels the prefetch in flight, as
// upstream: going back, or a step behind another one.
func TestOtherStepsCancelTheEarlyPrefetch(t *testing.T) {
	t.Run("a second step", func(t *testing.T) {
		p, next := earlyPrefetchPlayer(t)
		prefetchEarly(t, p, next)
		_, ctx := startNextJob(t, p)

		p.advanceNext(true, true, 0, func(bool, error) {})
		require.NoError(t, ctx.Err())
		p.advanceNext(true, true, 0, func(bool, error) {})
		require.ErrorIs(t, ctx.Err(), context.Canceled, "two steps on, it is not the destination")
	})

	t.Run("repeating the track", func(t *testing.T) {
		p, next := earlyPrefetchPlayer(t)
		prefetchEarly(t, p, next)
		_, ctx := startNextJob(t, p)

		p.state.player.Options.RepeatingTrack = true
		p.advanceNext(true, true, 0, func(bool, error) {})
		require.ErrorIs(t, ctx.Err(), context.Canceled)
	})

	t.Run("early prefetch off", func(t *testing.T) {
		p, next := earlyPrefetchPlayer(t)
		prefetchEarly(t, p, next)
		_, ctx := startNextJob(t, p)

		p.earlyPrefetch = 0
		p.advanceNext(true, true, 0, func(bool, error) {})
		require.ErrorIs(t, ctx.Err(), context.Canceled, "upstream cancels it")
	})

	t.Run("a stale prefetch", func(t *testing.T) {
		p, next := earlyPrefetchPlayer(t)
		prefetchEarly(t, p, next)
		_, ctx := startNextJob(t, p)

		p.invalidateUpcoming()
		p.advanceNext(true, true, 0, func(bool, error) {})
		require.ErrorIs(t, ctx.Err(), context.Canceled)
	})
}

// A change to what plays next throws the early prefetch away, and the timer
// is not set early again for the same track: the prefetch that replaces it
// waits for upstream's time.
func TestChangesToWhatPlaysNextDropTheEarlyPrefetch(t *testing.T) {
	for _, tt := range []struct {
		name   string
		change func(t *testing.T, p *AppPlayer)
	}{
		{"add to queue", func(t *testing.T, p *AppPlayer) {
			p.addToQueue(&connectpb.ContextTrack{Uri: trackUri(0x30)})
			runQueuedJob(t, p)
		}},
		{"queue edit", func(t *testing.T, p *AppPlayer) {
			data, err := queueEditCall(t, p, ApiRequestTypeQueueRemove, "q1", "")
			requireEdited(t, p, data, err)
		}},
		{"repeat", func(t *testing.T, p *AppPlayer) {
			p.setOptions(nil, pointer(true), nil)
		}},
		{"shuffle", func(t *testing.T, p *AppPlayer) {
			p.setOptions(nil, nil, pointer(true))
			runQueuedJob(t, p)
		}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			p, next := earlyPrefetchPlayer(t)
			prefetchEarly(t, p, next)
			job, _ := startNextJob(t, p)
			finishJob(p, job, prefetched(testStream(t, next)))
			require.NotNil(t, p.secondaryStream)
			gen := p.prefetchGen

			tt.change(t, p)

			require.Nil(t, p.secondaryStream)
			require.Greater(t, p.prefetchGen, gen)
			require.False(t, p.prefetchArmedEarly, "upstream's time for the replacement")
		})
	}
}

// A Jam edit arrives as a transfer that continues the playing track: what was
// prefetched under the old queue is thrown away, and its replacement waits for
// upstream's time.
func TestJamEditDropsTheEarlyPrefetch(t *testing.T) {
	p := newTestAppPlayer(t)
	inJam(t, p)
	p.earlyPrefetch = time.Second
	p.loader.keptGrace = time.Hour
	next := p.state.player.NextTracks[0].GetUri()

	prefetchEarly(t, p, next)
	job, _ := startNextJob(t, p)
	finishJob(p, job, prefetched(testStream(t, next)))
	require.NotNil(t, p.secondaryStream)
	gen := p.prefetchGen

	require.NoError(t, p.handlePlayerCommand(jamEdit(t, &connectpb.ContextTrack{Uri: jamTrackUri, Uid: "u0"}, "retain_original")))
	runQueuedJob(t, p)

	require.Nil(t, p.secondaryStream)
	require.Greater(t, p.prefetchGen, gen)
	require.False(t, p.prefetchArmedEarly)
}

// Off, a fire does what upstream's does, even with a prefetch queued.
func TestEarlyPrefetchOffFiresAsUpstream(t *testing.T) {
	p, _ := earlyPrefetchPlayer(t)
	p.earlyPrefetch = 0

	p.prefetchTimerFired()
	p.prefetchTimerFired()
	require.Equal(t, []string{"peek next"}, queuedNames(p.loader), "the second replaced the first")
	require.False(t, p.prefetchFiredFor == weak.Make(p.primaryStream), "nothing is recorded")
}

func TestLoaderStepForwardKeepsOnlyTheRightPrefetch(t *testing.T) {
	step := func(gen uint64) loaderJob {
		job := idleJob("advance", classNav, noReply)
		job.keepPrefetch, job.prefetchGen = true, gen
		return job
	}
	fetching := runningJob{class: classPrefetch, gen: 4, opensStream: true}

	for _, tt := range []struct {
		name    string
		running runningJob
		queued  []loaderJob
		job     loaderJob
		kept    bool
	}{
		{"a step forward", fetching, nil, step(4), true},
		{"a stale prefetch", runningJob{class: classPrefetch, gen: 3, opensStream: true}, nil, step(4), false},
		{"a peek", runningJob{class: classPrefetch, gen: 4}, nil, step(4), false},
		{"a step back", fetching, nil, idleJob("skip previous", classNav, noReply), false},
		{"a load", fetching, nil, idleJob("load", classLoad, noReply), false},
		{"a second step", fetching, []loaderJob{step(4)}, step(4), false},
		{"a load in flight", runningJob{class: classLoad, gen: 4}, nil, step(4), false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			l := newTestLoaderLane()
			l.keptGrace = time.Hour

			ctx, cancel := context.WithCancel(context.Background())
			t.Cleanup(cancel)
			running := tt.running
			running.cancel = cancel
			l.running = &running
			l.queue = tt.queued

			job := tt.job
			var told bool
			job.kept = func() { told = true }
			l.submit(job)

			require.Equal(t, tt.kept, told, "the player loop is told when the step waits for the prefetch")
			if tt.kept {
				require.NoError(t, ctx.Err())
			} else {
				require.ErrorIs(t, ctx.Err(), context.Canceled)
			}
			require.Equal(t, tt.job.name, queuedNames(l)[len(queuedNames(l))-1])
		})
	}
}

// With the lane running: the step waits for the prefetch it kept, whose result
// comes back first.
func TestLoaderStepForwardRunsAfterTheKeptPrefetch(t *testing.T) {
	l := newLoaderLane(&librespot.NullLogger{})
	t.Cleanup(l.close)

	started := make(chan struct{})
	release := make(chan struct{})
	l.submit(loaderJob{
		name:        "prefetch a",
		class:       classPrefetch,
		gen:         4,
		opensStream: true,
		run: func(ctx context.Context) loaderResult {
			close(started)
			select {
			case <-release:
				return loaderResult{}
			case <-ctx.Done():
				return loaderResult{err: ctx.Err()}
			}
		},
	})
	<-started

	step := idleJob("advance", classNav, noReply)
	step.keepPrefetch, step.prefetchGen = true, 4
	l.submit(step)
	close(release)

	for _, want := range []string{"prefetch a", "advance"} {
		select {
		case res := <-l.results:
			require.Equal(t, want, res.name)
			require.NoError(t, res.err)
		case <-time.After(5 * time.Second):
			t.Fatalf("%s never came back", want)
		}
	}
}

// A kept prefetch that does not finish in its grace is cancelled after all,
// and the step goes ahead.
func TestLoaderKeptPrefetchIsCancelledAfterItsGrace(t *testing.T) {
	l := newLoaderLane(&librespot.NullLogger{})
	l.keptGrace = 20 * time.Millisecond
	t.Cleanup(l.close)

	started := make(chan struct{})
	l.submit(loaderJob{
		name:        "prefetch a",
		class:       classPrefetch,
		gen:         4,
		opensStream: true,
		run: func(ctx context.Context) loaderResult {
			close(started)
			<-ctx.Done()
			return loaderResult{err: ctx.Err()}
		},
	})
	<-started

	step := idleJob("advance", classNav, noReply)
	step.keepPrefetch, step.prefetchGen = true, 4
	l.submit(step)

	for _, want := range []string{"prefetch a", "advance"} {
		select {
		case res := <-l.results:
			require.Equal(t, want, res.name)
			if want == "prefetch a" {
				require.ErrorIs(t, res.err, context.Canceled)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("%s never came back", want)
		}
	}
}

func TestLoaderHasPrefetch(t *testing.T) {
	l := newTestLoaderLane()
	require.False(t, l.hasPrefetch(2))

	peek := idleJob("peek next", classPrefetch, noReply)
	peek.gen = 2
	l.submit(peek)
	require.True(t, l.hasPrefetch(2), "queued")
	require.False(t, l.hasPrefetch(3), "another generation")

	job, _, _, ok := l.next()
	require.True(t, ok)
	require.Equal(t, uint64(2), l.running.gen)
	require.True(t, l.hasPrefetch(2), "running")
	l.execute(job, t.Context())
	require.False(t, l.hasPrefetch(2), "done")

	l.running = &runningJob{class: classLoad, gen: 2, cancel: func() {}}
	require.False(t, l.hasPrefetch(2), "a load is not a prefetch")
}

// The lane remembers what keepsRunningPrefetch needs of the job it starts.
func TestLoaderRunningJobKeepsGenAndStream(t *testing.T) {
	l := newTestLoaderLane()

	job := idleJob("prefetch a", classPrefetch, noReply)
	job.gen, job.opensStream = 5, true
	l.submit(job)

	_, _, _, ok := l.next()
	require.True(t, ok)
	require.Equal(t, uint64(5), l.running.gen)
	require.True(t, l.running.opensStream)
}

// The track being left runs out while the step forward waits for the prefetch
// it kept. Its end is held, as during a load, rather than taken for a second
// step: that would cancel the kept prefetch (its audio key spent), land on the
// track after the one it fetched and fetch that from scratch.
func TestTheEndOfTheTrackLeftWhileTheStepWaitsIsHeld(t *testing.T) {
	p, next := earlyPrefetchPlayer(t)
	job, ctx := stepWhilePrefetching(t, p, next)

	end := player.Event{Type: player.EventTypeNotPlaying, StreamGen: p.player.StreamGen()}
	require.True(t, p.deferPlayerEvent(end), "held")

	require.NoError(t, ctx.Err(), "the kept prefetch runs on")
	finishJob(p, job, prefetched(testStream(t, next)))
	dropStreamForLoad(p)
	runQueuedJob(t, p) // the step

	require.Equal(t, next, p.state.player.Track.GetUri(), "one step: onto the track the prefetch fetched")
	require.Equal(t, []string{"load " + next}, queuedNames(p.loader))
	require.Nil(t, p.secondaryStream, "taken by the load")
	require.False(t, p.keptStep)
	require.True(t, p.loadInFlight)
	require.Equal(t, []player.Event{end}, p.pendingPlayerEvents, "still held, for the load")

	// The load lands with the next stream, and forgets the old one's end.
	p.forgetReplacedStreamEvents(end.StreamGen + 1)
	require.Empty(t, p.pendingPlayerEvents)
}

// A play or pause while the step forward waits is for the track it lands on.
// Applied to the track being left, the step's own commit would start the new
// one playing over a pause. A pause that came before the step is left to the
// step, as upstream: a skip plays (the bridge pauses again itself).
func TestPlayAndPauseWhileTheStepWaitsAreForTheTrackItLandsOn(t *testing.T) {
	for _, tt := range []struct {
		name   string
		before func(p *AppPlayer)
		during func(t *testing.T, p *AppPlayer) error
		paused bool
	}{
		{"nothing", nil, nil, false},
		{"a pause", nil, func(_ *testing.T, p *AppPlayer) error { return p.pause() }, true},
		{"a pause, then a play", nil, func(t *testing.T, p *AppPlayer) error {
			require.NoError(t, p.pause())
			return p.play()
		}, false},
		{"paused before the step", func(p *AppPlayer) { p.state.setPaused(true) }, nil, false},
		{"paused before the step, and a pause", func(p *AppPlayer) { p.state.setPaused(true) },
			func(_ *testing.T, p *AppPlayer) error { return p.pause() }, true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			p, next := earlyPrefetchPlayer(t)
			prefetchEarly(t, p, next)
			job, ctx := startNextJob(t, p)
			if tt.before != nil {
				tt.before(p) // the bridge's pause: the prefetch runs on
			}
			p.advanceNext(true, true, 0, func(bool, error) {})
			require.NoError(t, ctx.Err())
			require.True(t, p.keptStep)

			if tt.during != nil {
				require.NoError(t, tt.during(t, p), "recorded")
				require.Equal(t, tt.paused, p.state.player.IsPaused, "and reported at once")
			}

			finishJob(p, job, prefetched(testStream(t, next)))
			dropStreamForLoad(p)
			runQueuedJob(t, p) // the step

			require.Equal(t, next, p.state.player.Track.GetUri())
			require.Equal(t, tt.paused, p.state.player.IsPaused, "the load applies it when it lands (commitLoad)")
			require.Equal(t, []string{"load " + next}, queuedNames(p.loader))
			require.Nil(t, p.keptStepPaused)
		})
	}
}

// A prev while the step forward waits is a second press, as during a load: the
// track before, rather than a restart of the track being left (which the step
// would then leave anyway).
func TestAPrevWhileTheStepWaitsGoesBack(t *testing.T) {
	p, next := earlyPrefetchPlayer(t)
	require.True(t, p.prevMayRestart(true), "a prev more than 3 s in restarts the track")
	require.False(t, p.prevMayRestart(false))

	job, _ := stepWhilePrefetching(t, p, next)
	require.False(t, p.prevMayRestart(true), "the track before, whatever the position")

	finishJob(p, job, prefetched(testStream(t, next)))
	dropStreamForLoad(p)
	runQueuedJob(t, p)
	require.False(t, p.prevMayRestart(true), "then the load is in flight, as upstream")
}

// Something newer (a prev, a play, a transfer) supersedes the step forward
// while it waits: the wait is over, and the end of the track being left, held
// meanwhile, is forgotten as the load replacing it would forget it, rather
// than taken for a step forward on top of what superseded the step.
func TestASupersededStepForgetsTheEndItHeld(t *testing.T) {
	p, next := earlyPrefetchPlayer(t)
	job, _ := stepWhilePrefetching(t, p, next)
	require.True(t, p.deferPlayerEvent(player.Event{Type: player.EventTypeNotPlaying, StreamGen: p.player.StreamGen()}))

	p.loadGen++ // what each of them does first
	finishJob(p, job, prefetched(testStream(t, next)))
	// Handled, the end would reach for the session the harness does not have.
	require.NotPanics(t, func() { runQueuedJob(t, p) }, "the step's result, thrown away")

	require.False(t, p.keptStep)
	require.Empty(t, p.pendingPlayerEvents)
	require.Equal(t, "u0", p.state.player.Track.GetUid(), "the step never landed")
	require.False(t, p.deferPlayerEvent(player.Event{Type: player.EventTypePause}), "nothing is held any more")
}

// A stop while the step forward waits ends the wait, with the load it drops.
func TestAStopEndsTheStepsWait(t *testing.T) {
	p, next := earlyPrefetchPlayer(t)
	p.app.cfg = &Config{}
	stepWhilePrefetching(t, p, next)
	require.True(t, p.deferPlayerEvent(player.Event{Type: player.EventTypeNotPlaying, StreamGen: p.player.StreamGen()}))

	p.stopPlayback()

	require.False(t, p.keptStep)
	require.Empty(t, p.pendingPlayerEvents)
	require.False(t, p.deferPlayerEvent(player.Event{Type: player.EventTypeStop}))
}

// Armed with 40-45 s left, the early fire comes when upstream's time has come
// too (under 40 s left): it was upstream's prefetch at once, and the timer is
// not armed again. Armed again, it would fire straight away, and could run a
// second peek, and a second prefetch of the same track, before the first
// peek's result was read.
func TestTheEarlyFireWithUnder40sLeftIsUpstreamsPrefetch(t *testing.T) {
	p, next := earlyPrefetchPlayer(t)
	p.primaryStream = testStreamLasting(t, p.state.player.Track.GetUri(), 45000)

	p.schedulePrefetchNext()
	require.True(t, p.prefetchArmedEarly, "15 s before upstream's time")

	// 7 s on (the harness's player stays at 0, so the track is made shorter).
	p.primaryStream.Media = librespot.NewMediaFromTrack(&metadatapb.Track{
		Gid: p.primaryStream.RequestedId.Id(), Name: proto.String("Song"), Duration: proto.Int32(38000),
	})
	p.prefetchTimerFired()
	require.Equal(t, []string{"peek next"}, queuedNames(p.loader))
	require.False(t, fires(p.prefetchTimer, 200*time.Millisecond), "not armed again")
	require.False(t, p.prefetchArmedEarly)

	// The prefetch it started goes ahead as before.
	runQueuedJob(t, p)
	require.Equal(t, []string{"prefetch " + next}, queuedNames(p.loader))
}

// A stream fetched early waits as long as the track before it is paused, and
// the CDN address its later chunks come from is never renewed. Past
// earlyPrefetchMaxLead it is thrown away where it would start to play: a play
// (the track's end would switch to it; it is fetched again at upstream's
// time), and the skip that would play it, which fetches the track afresh. A
// track that played to its end keeps it: the player has switched to it.
func TestAnEarlyPrefetchAgedByAPauseIsFetchedAgain(t *testing.T) {
	aged := func(t *testing.T) (*AppPlayer, string) {
		p, next := earlyPrefetchPlayer(t)
		prefetchEarly(t, p, next)
		job, _ := startNextJob(t, p)
		finishJob(p, job, prefetched(testStream(t, next)))
		require.NotNil(t, p.secondaryStream)
		require.False(t, p.earlyPrefetchAt.IsZero(), "stamped: fetched early")

		p.earlyPrefetchAt = time.Now().Add(-earlyPrefetchMaxLead - time.Minute) // a long pause
		p.state.setPaused(true)
		return p, next
	}

	t.Run("a play", func(t *testing.T) {
		p, _ := aged(t)
		gen := p.prefetchGen

		_ = p.play() // the harness's player is closed: the play itself fails
		require.Nil(t, p.secondaryStream)
		require.Greater(t, p.prefetchGen, gen)
		require.True(t, p.earlyPrefetchAt.IsZero())
	})

	t.Run("a skip", func(t *testing.T) {
		p, next := aged(t)
		dropStreamForLoad(p)
		p.advanceNext(true, true, 0, func(bool, error) {})
		runQueuedJob(t, p)
		require.Nil(t, p.secondaryStream)
		require.Equal(t, []string{"load " + next}, queuedNames(p.loader))

		// Fetched afresh: the load builds a stream, reaching for the session
		// the harness does not have.
		load := p.loader.queue[0]
		require.Panics(t, func() { load.run(t.Context()) })
	})

	t.Run("the track's end", func(t *testing.T) {
		p, next := aged(t)
		dropStreamForLoad(p)
		p.advanceNext(false, false, 0, func(bool, error) {}) // what EventTypeNotPlaying does
		runQueuedJob(t, p)
		require.Equal(t, []string{"load " + next}, queuedNames(p.loader))

		load := p.loader.queue[0]
		var res loaderResult
		require.NotPanics(t, func() { res = load.run(t.Context()) })
		require.ErrorIs(t, res.err, player.ErrPlayerClosed, "the prefetched stream, handed to the player")
	})

	t.Run("fresh", func(t *testing.T) {
		p, _ := aged(t)
		p.earlyPrefetchAt = time.Now()
		require.False(t, p.dropAgedPrefetch())
		require.NotNil(t, p.secondaryStream)
	})
}

// Only a stream fetched ahead of upstream's time is stamped: one fetched at
// it is held as long as upstream would hold it, and early prefetch off stamps
// nothing.
func TestOnlyAnEarlyPrefetchIsStamped(t *testing.T) {
	p, next := earlyPrefetchPlayer(t)
	stream := testStream(t, next)

	p.commitPrefetch(stream, stream.Source)
	require.False(t, p.earlyPrefetchAt.IsZero(), "200 s left")

	p.primaryStream = testStreamLasting(t, p.state.player.Track.GetUri(), 35000)
	p.commitPrefetch(stream, stream.Source)
	require.True(t, p.earlyPrefetchAt.IsZero(), "under 40 s left: upstream's time")
	require.False(t, p.dropAgedPrefetch())

	p.primaryStream = testStream(t, p.state.player.Track.GetUri())
	p.earlyPrefetch = 0
	p.commitPrefetch(stream, stream.Source)
	require.True(t, p.earlyPrefetchAt.IsZero(), "off")
}

// The Jam's end, taken while a step forward waits, ends the wait with the load
// it drops.
func TestAJamEndEndsTheStepsWait(t *testing.T) {
	p := newTestAppPlayer(t)
	inJam(t, p)
	p.stepKept(p.loadGen)

	require.NoError(t, p.handlePlayerCommand(jamEnd(t, jamListUri)))
	require.False(t, p.keptStep)
	require.False(t, p.deferPlayerEvent(player.Event{Type: player.EventTypeStop}))
}
