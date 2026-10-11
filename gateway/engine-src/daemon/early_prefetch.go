package daemon

import (
	"time"
	"weak"
)

// Encore patch 7: early prefetch (ENCORE_PATCH.md).
//
// Upstream fetches what plays next 30 s before the current track ends, so a
// skip before then loads the next track from scratch: an audio key, a storage
// resolve and the first chunks, 0.3-1.3 s before it is heard. With
// early_prefetch_ms set, the next track is prefetched that long after the
// current one starts playing instead, and a skip finds it ready the way the end
// of a track does.
//
// While the listener goes forward, the number of streams opened stays the
// same: the stream fetched early is the one the skip, or the track's end,
// plays. Only moving anywhere else (back, to another context or track, or a
// change to what plays next) throws it away, and that costs at most one stream
// per track: once the timer has fired for a track, every later prefetch for it
// waits for upstream's time, which upstream would have spent anyway.

const (
	// earlyPrefetchMaxLead is how far ahead of upstream's own time an early
	// prefetch may run, and how long a stream fetched early may wait to be
	// played (dropAgedPrefetch). The CDN address the storage resolve hands out
	// is never renewed, so a stream built long before it plays risks having its
	// later chunks refused.
	earlyPrefetchMaxLead = 15 * time.Minute

	// keptPrefetchGrace is how long a step forward waits for the prefetch it
	// lets finish (see loaderLane.keepsRunningPrefetch) before cancelling it
	// after all. A prefetch takes 0.3-1.3 s; one that takes longer is stuck,
	// and the step loads from scratch rather than wait out the job's timeout.
	keptPrefetchGrace = 3 * time.Second
)

// earlyPrefetchDelay reports how long from now the prefetch of what plays next
// is due, when that is before upstream's time, untilUpstream from now.
func (p *AppPlayer) earlyPrefetchDelay(untilUpstream time.Duration) (time.Duration, bool) {
	early := p.earlyPrefetch

	switch {
	case early <= 0:
		return 0, false
	case untilUpstream <= early || untilUpstream > earlyPrefetchMaxLead:
		return 0, false
	case p.state.player.Options.GetRepeatingTrack():
		// What plays next is this very track again, while a skip goes on to
		// another one: upstream's time is soon enough for the track's end.
		return 0, false
	case p.prefetchFiredFor == weak.Make(p.primaryStream):
		// The timer has fired for this track already. Whatever it fetched may
		// have been thrown away since, and fetching it again is left to
		// upstream's time.
		return 0, false
	}

	return early, true
}

// prefetchTimerFired is the prefetch timer firing. Upstream calls prefetchNext
// straight from the loop, which is what happens here with early prefetch off.
func (p *AppPlayer) prefetchTimerFired() {
	if p.earlyPrefetch <= 0 {
		p.prefetchNext()
		return
	}

	early := p.prefetchArmedEarly
	p.prefetchArmedEarly = false
	p.prefetchFiredFor = weak.Make(p.primaryStream)

	// A prefetch of this generation still queued or running fetches the same
	// track: a second one would cancel it, and ask for that track's audio key
	// again.
	if p.loader.hasPrefetch(p.prefetchGen) {
		p.app.log.Debugf("next track prefetch already in flight")
	} else {
		p.prefetchNext()
	}

	// An early fire stands in for none of upstream's: upstream's time is armed
	// again, so a prefetch that failed is tried again then, as upstream would
	// have tried it. One that worked is found there and nothing is fetched.
	//
	// Unless upstream's time has come by now (under 40 s left): then this fire
	// was upstream's prefetch at once. Armed again, the timer would fire
	// straight away, possibly after the peek just queued has finished but
	// before its result is read, which hasPrefetch cannot see, and the same
	// track would be fetched twice.
	if early && !p.upstreamPrefetchDue() {
		p.schedulePrefetchNext()
	}
}

// upstreamPrefetchDue reports whether upstream's time for the prefetch has
// come, as schedulePrefetchNext reckons it: under 40 s of the track left, when
// it prefetches at once.
func (p *AppPlayer) upstreamPrefetchDue() bool {
	if p.primaryStream == nil {
		return false
	}

	untilTrackEnd := time.Duration(p.primaryStream.Media.Duration()-int32(p.player.PositionMs())) * time.Millisecond
	return untilTrackEnd-30*time.Second < 10*time.Second
}

// noteEarlyPrefetch stamps the stream commitPrefetch has just made the next
// track when it was fetched ahead of upstream's time, so that dropAgedPrefetch
// can tell how long it has waited. One fetched at upstream's time is left
// unstamped: upstream would hold it just as long.
func (p *AppPlayer) noteEarlyPrefetch() {
	p.earlyPrefetchAt = time.Time{}
	if p.earlyPrefetch > 0 && p.primaryStream != nil && !p.upstreamPrefetchDue() {
		p.earlyPrefetchAt = time.Now()
	}
}

// dropAgedPrefetch throws away the stream waiting as the next track when it was
// fetched early and has waited longer than earlyPrefetchMaxLead, which only a
// pause makes possible: the CDN address its later chunks come from is never
// renewed. It is called where that stream would start to play: a play (the
// track's end would switch to it), after which it is fetched again at
// upstream's time, and the load a skip ends in, which then fetches the track
// afresh. Either way that is the one extra stream per track this patch allows:
// the early one, thrown away. Reports whether it did.
func (p *AppPlayer) dropAgedPrefetch() bool {
	if p.secondaryStream == nil || p.earlyPrefetchAt.IsZero() || time.Since(p.earlyPrefetchAt) <= earlyPrefetchMaxLead {
		return false
	}

	p.app.log.Debugf("next track was prefetched %s ago, fetching it again", time.Since(p.earlyPrefetchAt).Round(time.Second))
	p.earlyPrefetchAt = time.Time{}
	p.invalidateUpcoming()
	return true
}

// forwardStep marks the job of a step forward (advanceNext) to let a prefetch
// of the current generation that is already running finish rather than cancel
// it. That prefetch is fetching the track the step lands on, and has asked for
// its audio key already. Its result reaches the loop before the step's own
// (the lane is serialized and its results come back in order), so the load the
// step ends in finds it prefetched. Cancelled, it would leave that load to ask
// for the same key a second time.
//
// While the step waits, the loop is told (stepKept), and treats the wait as a
// load in flight until the step's result is back (stepLanded).
func (p *AppPlayer) forwardStep() func(*loaderJob) {
	keep := p.earlyPrefetch > 0 && !p.state.player.Options.GetRepeatingTrack()
	gen := p.prefetchGen

	return func(job *loaderJob) {
		job.keepPrefetch = keep
		job.prefetchGen = gen

		step := job.gen
		job.kept = func() { p.stepKept(step) }
	}
}

// stepKept records that the step forward of generation gen waits on the loader
// lane for the prefetch it kept. Upstream's step leaves the loop with the track
// it moves away from as the current one for a few milliseconds; this wait can
// last up to keptPrefetchGrace. So until the step's result is back the loop
// handles it as a load in flight, and everything that arrives meanwhile takes
// the path it takes during a load:
//
//   - the player's events are held (deferPlayerEvent): the end of the track
//     being left is not taken for a second step forward, which would cancel
//     the kept prefetch and skip the track it fetched;
//   - a play or pause is recorded (play, pause) and applied to the track the
//     step lands on (stepLanded), rather than to the one being left, which the
//     step's own commit would then override;
//   - a prev is a second press (skipPrev): the track before, not a restart of
//     the one being left.
func (p *AppPlayer) stepKept(gen uint64) {
	p.keptStep, p.keptStepGen, p.keptStepPaused = true, gen, nil
}

// stepLanded ends the wait stepKept began, once the step's result has been
// applied: committed, which loaded the track it landed on, or superseded by a
// newer load or step.
func (p *AppPlayer) stepLanded(committed bool) {
	paused := p.keptStepPaused
	p.keptStep, p.keptStepPaused = false, nil

	if committed {
		// The step set the pause state afresh (advanceNext, advanceTo): a play
		// or pause asked for while it waited is applied now, as one that
		// arrives during the load it started.
		if paused != nil {
			if *paused {
				_ = p.pause()
			} else {
				_ = p.play()
			}
		}
	} else {
		// What superseded the step decides what plays: the end of the track
		// being left must not advance once more on top of it, as it would not
		// once the load that replaces it lands (forgetReplacedStreamEvents).
		p.forgetReplacedStreamEvents(p.player.StreamGen() + 1)
	}

	if !p.loadInFlight {
		p.drainPendingPlayerEvents()
	}
}

// recordPlayback is a play or a pause while a step forward waits for the
// prefetch it kept: recorded, as one asked for during a load is, and applied
// to the track the step lands on.
func (p *AppPlayer) recordPlayback(paused bool) error {
	p.keptStepPaused = &paused
	p.state.setPaused(paused)
	p.updateState()
	return nil
}
