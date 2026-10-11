package daemon

import "time"

// The position published to Spotify Connect is taken from the decoder. That is
// what the listener hears when the output is a sound card, whose own small delay
// the player already accounts for. It is not when the output is a pipe read by
// a streaming server, which can hold tens of seconds of audio between decoding
// and the listener's ears: track changes then show up in the Spotify app that
// much early. /player/output_delay tells the player how far ahead it runs, and
// the published position follows the listener instead:
//
//   - while a track plays, a published position that has drifted from the
//     decoder's less the delay is corrected (setOutputDelay);
//   - a track reached by playing the previous one to its end is published as
//     starting once the delay has played out (commitLoad, naturalAdvanceAt).
//
// A listener who has not reached the current track yet is published with a
// Timestamp in the future and PositionAsOfTimestamp 0. So trackPosition and
// updateTimestamp take a Timestamp in the future as "not started", play keeps
// the decoder and the published position as they are while playing, and
// activation timestamps, which can be handed back this device's own, are never
// far in the future (activationTimestampAt).

// outputDelayTolerance is how far the published position may be from what the
// listener hears before it is published again. Corrections smaller than this
// would only churn the connect state.
const outputDelayTolerance = 750 * time.Millisecond

// naturalAdvanceWindow bounds how long after a track played to its end the load
// of the next one counts as reaching it naturally.
const naturalAdvanceWindow = 5 * time.Second

// activationClockSkew is how far ahead of this device's clock another device's
// may run. A state timestamp up to this far in the future is taken as theirs.
const activationClockSkew = 3 * time.Second

// activationTimestampAt is the activation timestamp (see State) for the state
// of the device that held the session, as a transfer or the cluster carries it.
// That is its own timestamp, so a stale update repeating that state is never
// newer (#107), even from a device whose clock runs a little ahead. Only one
// further in the future is taken as now: it can only be this device's own,
// published while a track has not reached the listener yet, and gating on it
// would ignore a real transfer away until then.
func activationTimestampAt(ts int64, now time.Time) int64 {
	if nowMs := now.UnixMilli(); ts > nowMs+activationClockSkew.Milliseconds() {
		return nowMs
	}
	return ts
}

// setOutputDelay records the output delay and, while a track is playing,
// corrects the published position to what the listener hears. Runs on the
// player loop.
func (p *AppPlayer) setOutputDelay(delay time.Duration) *ApiOutputDelayResult {
	p.outputDelay = delay

	// Only a loaded track that is playing has a decoder position to go by. A
	// load in flight, or the advance into the next track, sets its own.
	playing := p.primaryStream != nil && !p.loadInFlight && !p.naturalAdvancePending() &&
		p.state.player.IsPlaying && !p.state.player.IsPaused && !p.state.player.IsBuffering

	republished := playing && p.state.applyOutputDelay(p.player.PositionMs(), delay, time.Now())
	if republished {
		p.updateState()
	}

	return &ApiOutputDelayResult{
		DelayMs:     delay.Milliseconds(),
		Republished: republished,
		PositionMs:  p.state.trackPosition(),
	}
}

// naturalAdvancePending reports whether a track played to its end within
// naturalAdvanceWindow and no load has landed since.
func (p *AppPlayer) naturalAdvancePending() bool {
	return !p.naturalAdvanceAt.IsZero() && time.Since(p.naturalAdvanceAt) < naturalAdvanceWindow
}

// applyOutputDelay publishes what the listener hears, the decoder position less
// the delay, if the published position is outputDelayTolerance or more away
// from it. A negative position means the listener has not reached the track
// yet: it is published as starting that much later. Reports whether the state
// changed. Only for a track that is playing.
func (s *State) applyOutputDelay(decoderPos int64, delay time.Duration, now time.Time) bool {
	target := decoderPos - delay.Milliseconds()

	// Extrapolated without clamping: negative while Timestamp is in the future.
	nowMs := now.UnixMilli()
	cur := s.player.PositionAsOfTimestamp + (nowMs - s.player.Timestamp)
	if abs(target-cur) < outputDelayTolerance.Milliseconds() {
		return false
	}

	if target >= 0 {
		s.player.Timestamp = nowMs
		s.player.PositionAsOfTimestamp = target
	} else {
		s.player.Timestamp = nowMs - target
		s.player.PositionAsOfTimestamp = 0
	}
	return true
}
