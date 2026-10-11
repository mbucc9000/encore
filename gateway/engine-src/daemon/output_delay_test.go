//go:build test_unit

package daemon

import (
	"testing"
	"time"

	librespot "github.com/devgianlu/go-librespot"
	"github.com/devgianlu/go-librespot/player"
	connectpb "github.com/devgianlu/go-librespot/proto/spotify/connectstate"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"
)

func TestApplyOutputDelay(t *testing.T) {
	now := time.UnixMilli(1790000000000)

	// Timestamps are relative to now.
	for _, tt := range []struct {
		name                   string
		timestamp, position    int64
		decoder                int64
		delay                  time.Duration
		changed                bool
		wantTimestamp, wantPos int64
	}{
		{name: "drifted ahead of the listener", timestamp: -10000, position: 5000, decoder: 30000, delay: 10 * time.Second,
			changed: true, wantTimestamp: 0, wantPos: 20000},
		{name: "within tolerance", timestamp: -10000, position: 5000, decoder: 25500, delay: 10 * time.Second,
			changed: false, wantTimestamp: -10000, wantPos: 5000},
		{name: "track not reached yet", timestamp: 0, position: 2000, decoder: 2000, delay: 10 * time.Second,
			changed: true, wantTimestamp: 8000, wantPos: 0},
		{name: "already published as not reached", timestamp: 8000, position: 0, decoder: 2200, delay: 10 * time.Second,
			changed: false, wantTimestamp: 8000, wantPos: 0},
		{name: "reached after all", timestamp: 8000, position: 0, decoder: 9000, delay: 5 * time.Second,
			changed: true, wantTimestamp: 0, wantPos: 4000},
	} {
		t.Run(tt.name, func(t *testing.T) {
			s := &State{player: &connectpb.PlayerState{
				Timestamp:             now.UnixMilli() + tt.timestamp,
				PositionAsOfTimestamp: tt.position,
			}}

			require.Equal(t, tt.changed, s.applyOutputDelay(tt.decoder, tt.delay, now))
			require.Equal(t, now.UnixMilli()+tt.wantTimestamp, s.player.Timestamp)
			require.Equal(t, tt.wantPos, s.player.PositionAsOfTimestamp)
		})
	}
}

func outputDelayRequest(ms int64) ApiRequest {
	return ApiRequest{Type: ApiRequestTypeOutputDelay, Data: ApiOutputDelay{DelayMs: ms}}
}

// The closed player reports the decoder at zero, so with any delay the listener
// has not reached the playing track yet.
func TestOutputDelayRepublishesAPlayingTrack(t *testing.T) {
	p := newTestAppPlayer(t)
	playingTrack(t, p, jamTrackUri, "u0")
	p.state.player.Timestamp = time.Now().UnixMilli()
	p.state.player.PositionAsOfTimestamp = 0

	before := time.Now().UnixMilli()
	resp, err := p.handleApiRequest(outputDelayRequest(3000))
	require.NoError(t, err)

	require.Equal(t, &ApiOutputDelayResult{DelayMs: 3000, Republished: true, PositionMs: 0}, resp)
	require.Equal(t, 3*time.Second, p.outputDelay)
	require.GreaterOrEqual(t, p.state.player.Timestamp, before+3000)
	require.Zero(t, p.state.player.PositionAsOfTimestamp)
	require.Zero(t, p.state.trackPosition(), "a track not reached yet is at its start, never before it")

	state := lastPushedState(t, p)
	require.Equal(t, p.state.player.Timestamp, state.Timestamp)
	require.Zero(t, state.PositionAsOfTimestamp)
}

// The delay is recorded whatever the player is doing, but only a loaded track
// that is playing has a position worth correcting.
func TestOutputDelayLeavesTheStateAloneUnlessPlaying(t *testing.T) {
	for _, tt := range []struct {
		name  string
		setup func(p *AppPlayer)
	}{
		{name: "nothing loaded", setup: func(p *AppPlayer) { p.primaryStream = nil }},
		{name: "paused", setup: func(p *AppPlayer) { p.state.setPaused(true) }},
		{name: "loading", setup: func(p *AppPlayer) { p.loadInFlight = true }},
		{name: "buffering", setup: func(p *AppPlayer) { p.state.player.IsBuffering = true }},
		{name: "advancing past a finished track", setup: func(p *AppPlayer) { p.naturalAdvanceAt = time.Now() }},
	} {
		t.Run(tt.name, func(t *testing.T) {
			p := newTestAppPlayer(t)
			playingTrack(t, p, jamTrackUri, "u0")
			p.state.player.Timestamp = time.Now().UnixMilli()
			p.state.player.PositionAsOfTimestamp = 5000
			tt.setup(p)
			published := proto.Clone(p.state.player)

			resp, err := p.handleApiRequest(outputDelayRequest(8000))
			require.NoError(t, err)

			require.False(t, resp.(*ApiOutputDelayResult).Republished)
			require.Equal(t, 8*time.Second, p.outputDelay)
			require.True(t, proto.Equal(published, p.state.player), "the published state is unchanged")
		})
	}
}

func nextTrackStream(t *testing.T, p *AppPlayer) *player.Stream {
	t.Helper()

	id, err := librespot.SpotifyIdFromUri(queuedUri)
	require.NoError(t, err)

	p.app.cfg = &Config{}
	p.prodInfo = &ProductInfo{}
	p.state.player.Track = &connectpb.ProvidedTrack{Uri: queuedUri}
	return &player.Stream{RequestedId: *id, Media: mediaFixture("next")}
}

// The decoder reaches the next track as soon as the previous one runs out, the
// listener only once the output delay has played out: the Spotify app shows
// the new track at its start until then.
func TestNaturalAdvancePublishesTheNextTrackOnceHeard(t *testing.T) {
	p := newTestAppPlayer(t)
	stream := nextTrackStream(t, p)
	p.outputDelay = 8 * time.Second
	p.naturalAdvanceAt = time.Now()

	before := time.Now().UnixMilli()
	p.commitLoad(stream, queuedUri, false, 0, true)

	require.GreaterOrEqual(t, p.state.player.Timestamp, before+8000)
	require.Zero(t, p.state.player.PositionAsOfTimestamp)
	require.Zero(t, p.state.trackPosition())
	require.True(t, p.naturalAdvanceAt.IsZero(), "honoured once")
}

func TestOnlyANaturalAdvanceIsPublishedLater(t *testing.T) {
	for _, tt := range []struct {
		name  string
		setup func(p *AppPlayer)
	}{
		{name: "no track ended", setup: func(p *AppPlayer) {}},
		{name: "track ended too long ago", setup: func(p *AppPlayer) { p.naturalAdvanceAt = time.Now().Add(-naturalAdvanceWindow) }},
		{name: "load dropping the output", setup: func(p *AppPlayer) {
			p.naturalAdvanceAt = time.Now()
			p.loadCurrentTrack(false, true, false, 0, func(error) {})
		}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			p := newTestAppPlayer(t)
			stream := nextTrackStream(t, p)
			p.outputDelay = 8 * time.Second
			tt.setup(p)

			p.commitLoad(stream, queuedUri, false, 0, false)

			require.LessOrEqual(t, p.state.player.Timestamp, time.Now().UnixMilli())
			require.True(t, p.naturalAdvanceAt.IsZero())
		})
	}
}

// Folding the time since a future timestamp into the position would make it
// negative: a track not reached yet has not advanced at all.
func TestUpdateTimestampDoesNotRewindAFutureTimestamp(t *testing.T) {
	s := &State{player: &connectpb.PlayerState{
		Timestamp:     time.Now().UnixMilli() + 5000,
		PlaybackSpeed: 1,
	}}

	s.updateTimestamp()

	require.Zero(t, s.player.PositionAsOfTimestamp)
	require.LessOrEqual(t, s.player.Timestamp, time.Now().UnixMilli())
}

// A transfer can hand this device back its own state, timestamped in the
// future while a track has not reached the listener yet. Gating on that would
// ignore another device taking over in the meantime.
func TestTransferOfAFutureTimestampDoesNotHoldOffATransferAway(t *testing.T) {
	p := newTestAppPlayer(t)
	p.app.cfg = &Config{}
	p.app.deviceId = thisDevice

	require.NoError(t, p.handlePlayerCommand(transferCommand(t, &connectpb.TransferState{
		CurrentSession: &connectpb.Session{},
		Playback: &connectpb.Playback{
			Timestamp:    time.Now().UnixMilli() + 20000,
			CurrentTrack: &connectpb.ContextTrack{Uri: jamTrackUri},
		},
	})))
	require.True(t, p.state.active)

	// A moment later.
	require.NoError(t, p.handleDealerMessage(clusterMessage(t, otherDevice, time.Now().UnixMilli()+1)))

	require.False(t, p.state.active)
}

func TestActivationTimestampAt(t *testing.T) {
	now := time.UnixMilli(1790000000000)

	// Timestamps are relative to now.
	for _, tt := range []struct {
		name     string
		ts, want int64
	}{
		{name: "in the past", ts: -60000, want: -60000},
		{name: "another device's clock a little ahead", ts: 400, want: 400},
		{name: "as far ahead as a clock may run", ts: 3000, want: 3000},
		{name: "this device's own, for a track not reached yet", ts: 20000, want: 0},
	} {
		t.Run(tt.name, func(t *testing.T) {
			require.Equal(t, now.UnixMilli()+tt.want, activationTimestampAt(now.UnixMilli()+tt.ts, now))
		})
	}
}

// A device whose clock runs a little ahead of this one's hands over a state
// timestamped in the future too. The stale update repeating that state is
// still no transfer away (#107).
func TestTransferFromAClockAheadIsNotUndoneByItsStaleState(t *testing.T) {
	p := newTestAppPlayer(t)
	p.app.cfg = &Config{}
	p.app.deviceId = thisDevice

	sent := time.Now().UnixMilli() + 400
	require.NoError(t, p.handlePlayerCommand(transferCommand(t, &connectpb.TransferState{
		CurrentSession: &connectpb.Session{},
		Playback: &connectpb.Playback{
			Timestamp:    sent,
			CurrentTrack: &connectpb.ContextTrack{Uri: jamTrackUri},
		},
	})))
	require.True(t, p.state.active)

	require.NoError(t, p.handleDealerMessage(clusterMessage(t, otherDevice, sent)))

	require.True(t, p.state.active, "the old device repeating its state is no transfer away")
}

// idlePlayer is a player with nothing loaded: it seeks and plays at once, and
// its decoder is at zero.
func idlePlayer(t *testing.T) *player.Player {
	t.Helper()

	pl, err := player.NewPlayer(&player.Options{Log: &librespot.NullLogger{}})
	require.NoError(t, err)
	t.Cleanup(pl.Close)
	return pl
}

// A resume while playing, as a stale controller sends, must not publish the
// decoder's position: that would drop what the listener hears, here a track not
// reached yet, until the next output delay arrives.
func TestResumeWhilePlayingKeepsThePublishedPosition(t *testing.T) {
	p := newTestAppPlayer(t)
	p.player = idlePlayer(t)
	playingTrack(t, p, jamTrackUri, "u0")
	p.outputDelay = 20 * time.Second
	p.state.player.Timestamp = time.Now().UnixMilli() + 17000
	p.state.player.PositionAsOfTimestamp = 0
	published := proto.Clone(p.state.player)

	require.NoError(t, p.play())

	require.True(t, proto.Equal(published, p.state.player), "the published state is unchanged")
}

// Resuming from a pause still publishes the decoder's position.
func TestResumeFromPausePublishesTheDecoderPosition(t *testing.T) {
	p := newTestAppPlayer(t)
	p.player = idlePlayer(t)
	playingTrack(t, p, jamTrackUri, "u0")
	p.state.setPaused(true)
	p.state.player.Timestamp = time.Now().UnixMilli() - 60000
	p.state.player.PositionAsOfTimestamp = 0

	before := time.Now().UnixMilli()
	require.NoError(t, p.play())

	require.False(t, p.state.player.IsPaused)
	require.GreaterOrEqual(t, p.state.player.Timestamp, before)
	require.Zero(t, p.state.player.PositionAsOfTimestamp)
}
