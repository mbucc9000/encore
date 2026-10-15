//go:build test_unit

package daemon

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"testing"
	"time"

	librespot "github.com/devgianlu/go-librespot"
	"github.com/devgianlu/go-librespot/dealer"
	"github.com/devgianlu/go-librespot/mpris"
	"github.com/devgianlu/go-librespot/player"
	connectpb "github.com/devgianlu/go-librespot/proto/spotify/connectstate"
	metadatapb "github.com/devgianlu/go-librespot/proto/spotify/metadata"
	"github.com/devgianlu/go-librespot/session"
	"github.com/devgianlu/go-librespot/spclient"
	"github.com/devgianlu/go-librespot/tracks"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"
)

func newTestAppPlayer(t *testing.T) *AppPlayer {
	t.Helper()

	log := &librespot.NullLogger{}
	server, err := NewStubApiServer(log)
	require.NoError(t, err)

	stateTimer := time.NewTimer(time.Hour)
	stateTimer.Stop()
	prefetchTimer := time.NewTimer(time.Hour)
	prefetchTimer.Stop()
	queueEventTimer := time.NewTimer(time.Hour)
	queueEventTimer.Stop()

	p := &AppPlayer{
		app:    &App{log: log, server: &recordingApiServer{ApiServer: server}, mpris: mpris.DummyServer{}},
		state:  &State{device: &connectpb.DeviceInfo{}},
		player: closedPlayer(t),
		// Neither lane is started, so the work a command provokes stays in
		// its queue instead of reaching the network.
		statePush:       newTestStatePushLane(nil),
		loader:          newTestLoaderLane(),
		stateTimer:      stateTimer,
		prefetchTimer:   prefetchTimer,
		queueEventTimer: queueEventTimer,
	}
	p.state.reset()
	return p
}

// closedPlayer answers every command at once without doing anything, so code
// that drives the player can run without an audio output.
func closedPlayer(t *testing.T) *player.Player {
	t.Helper()

	pl, err := player.NewPlayer(&player.Options{Log: &librespot.NullLogger{}})
	require.NoError(t, err)
	pl.Close()
	return pl
}

// recordingApiServer keeps every event emitted to API clients.
type recordingApiServer struct {
	ApiServer
	events  []ApiEventType
	emitted []*ApiEvent
}

func (s *recordingApiServer) Emit(ev *ApiEvent) {
	s.events = append(s.events, ev.Type)
	s.emitted = append(s.emitted, ev)
}

func apiEvents(p *AppPlayer) []ApiEventType {
	return p.app.server.(*recordingApiServer).events
}

// runQueuedJob takes the one job waiting on the loader lane, runs it and applies
// its result, as the lane and the player loop would.
func runQueuedJob(t *testing.T, p *AppPlayer) {
	t.Helper()

	require.Len(t, p.loader.queue, 1)
	job := p.loader.queue[0]
	p.loader.queue = nil

	p.applyLoaderResult(p.loader.execute(job, t.Context()))
}

// lastPushedState decodes the most recent connect state waiting to be sent.
func lastPushedState(t *testing.T, p *AppPlayer) *connectpb.PlayerState {
	t.Helper()

	pushes := drain(p.statePush)
	require.NotEmpty(t, pushes)

	var req connectpb.PutStateRequest
	require.NoError(t, proto.Unmarshal(pushes[len(pushes)-1].body, &req))
	return req.Device.PlayerState
}

// logoutRequested reports whether anything asked for the session to be handed
// back. Running the once from here only succeeds if nothing did before.
func logoutRequested(p *AppPlayer) bool {
	requested := true
	p.logoutOnce.Do(func() { requested = false })
	return requested
}

// failResolve stands in for a resolve that fails for a reason other than the
// backend refusing the context, such as the network.
func failResolve(context.Context, *connectpb.Context) (*tracks.List, error) {
	return nil, errors.New("connection reset")
}

// resolveWith stands in for resolving a transferred context: refused names the
// context uris the backend answers with the given status, and anything else
// resolves to whatever tracks its pages already hold.
func resolveWith(status int, refused ...string) func(context.Context, *connectpb.Context) (*tracks.List, error) {
	return func(ctx context.Context, spotCtx *connectpb.Context) (*tracks.List, error) {
		for _, uri := range refused {
			if spotCtx.Uri == uri {
				return nil, fmt.Errorf("failed initializing context resolver: %w",
					&spclient.ContextResolveError{StatusCode: status})
			}
		}
		if len(spotCtx.Pages) == 0 {
			return nil, fmt.Errorf("test resolver cannot fetch %s", spotCtx.Uri)
		}

		// With its tracks already in hand the resolver never reaches for the
		// spclient, so there is none.
		return tracks.NewTrackListFromContext(ctx, &librespot.NullLogger{}, nil, spotCtx)
	}
}

func transferCommand(t *testing.T, state *connectpb.TransferState) dealer.RequestPayload {
	t.Helper()

	data, err := proto.Marshal(state)
	require.NoError(t, err)

	// An absent payload means something else entirely: it is how Spotify makes
	// a device active without playing anything.
	require.NotEmpty(t, data)

	var req dealer.RequestPayload
	req.Command.Endpoint = "transfer"
	req.Command.Data = data
	return req
}

// A transfer whose session carries no context used to be dereferenced straight
// into a segfault. With no track to fall back on either, it is refused.
func TestHandlePlayerCommandTransferWithoutContextOrTrack(t *testing.T) {
	p := newTestAppPlayer(t)

	req := transferCommand(t, &connectpb.TransferState{
		CurrentSession: &connectpb.Session{},
		Playback:       &connectpb.Playback{},
	})

	require.Error(t, p.handlePlayerCommand(req))
	require.False(t, p.state.active)
	require.Nil(t, p.state.tracks)
}

// A queued or autoplayed track arrives on its own, with no context to take it
// from: the transfer is taken over a context holding that track alone.
func TestHandlePlayerCommandTransferWithoutContextPlaysTheTrack(t *testing.T) {
	const uri = "spotify:track:2FY7b99s15jUprqC0M5NCT"

	id, err := librespot.SpotifyIdFromUri(uri)
	require.NoError(t, err)

	for _, tt := range []struct {
		name  string
		track *connectpb.ContextTrack
	}{
		{name: "by uri", track: &connectpb.ContextTrack{Uri: uri}},
		{name: "by gid", track: &connectpb.ContextTrack{Gid: id.Id()}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			p := newTestAppPlayer(t)

			req := transferCommand(t, &connectpb.TransferState{
				CurrentSession: &connectpb.Session{},
				Playback: &connectpb.Playback{
					Timestamp:             1789403433449,
					PositionAsOfTimestamp: 47480,
					CurrentTrack:          tt.track,
				},
			})

			require.NoError(t, p.handlePlayerCommand(req))
			require.True(t, p.state.active)
			require.Equal(t, uri, p.state.player.ContextUri)
			require.NotNil(t, p.state.player.PlayOrigin)
			require.Equal(t, uri, p.state.player.Track.GetUri())

			// The position comes across too, so the track picks up where the
			// other device left it.
			require.EqualValues(t, 47480, p.state.player.PositionAsOfTimestamp)

			// And the context reaches the loader, which is what actually
			// resolves and plays it.
			require.Len(t, p.loader.queue, 1)
			require.Equal(t, "transfer "+uri, p.loader.queue[0].name)
		})
	}
}

const (
	jamListUri  = "spotify:list:jam-list:163dc0978f246346e7f1d14a4dd2bb9d"
	jamTrackUri = "spotify:track:1qDrWA6lyx8cLECdZE7TV7"
	queuedUri   = "spotify:track:2FY7b99s15jUprqC0M5NCT"
	playlistUri = "spotify:playlist:37i9dQZF1DWVKDF4ycOESi"
)

// A Jam as a client in it transfers it: the Jam's list as the context, the
// track playing in it, and something queued.
func jamTransfer(t *testing.T, current *connectpb.ContextTrack) dealer.RequestPayload {
	t.Helper()

	return listTransfer(t, jamListUri, current)
}

// listTransfer is jamTransfer with another context: the context alone, without
// its pages, the track playing in it, and something queued.
func listTransfer(t *testing.T, uri string, current *connectpb.ContextTrack) dealer.RequestPayload {
	t.Helper()

	return transferCommand(t, &connectpb.TransferState{
		Options:        &connectpb.ContextPlayerOptions{},
		CurrentSession: &connectpb.Session{Context: &connectpb.Context{Uri: uri}},
		Playback: &connectpb.Playback{
			Timestamp:             1789403433449,
			PositionAsOfTimestamp: 47480,
			CurrentTrack:          current,
		},
		Queue: &connectpb.Queue{Tracks: []*connectpb.ContextTrack{{Uri: queuedUri, Uid: "q0"}}},
	})
}

// requireIdle asserts the device is left the way a failed transfer must leave
// it: still active and still logged in, advertising nothing, with controllers
// and API clients told so.
func requireIdle(t *testing.T, p *AppPlayer) {
	t.Helper()

	require.True(t, p.state.active, "the account that just cast onto the device keeps it")
	require.False(t, logoutRequested(p), "the session must not be handed back")

	require.Nil(t, p.state.tracks)
	require.Empty(t, p.loader.queue, "nothing is left to load")

	state := lastPushedState(t, p)
	require.False(t, state.IsPlaying)
	require.False(t, state.IsBuffering)
	require.Empty(t, state.ContextUri)
	require.Nil(t, state.Track)
	require.Empty(t, state.NextTracks)

	require.Contains(t, apiEvents(p), ApiEventTypeStopped)
}

// A transfer is claimed before its context is resolved. When the resolve then
// fails, the claim has to be taken back: left alone, the device goes on
// advertising itself as buffering a context it will never play, and the client
// that sent the transfer, having been told it worked, never sends it again.
func TestTransferThatCannotResolveLeavesTheDeviceIdle(t *testing.T) {
	p := newTestAppPlayer(t)
	p.resolveTrackList = failResolve

	req := transferCommand(t, &connectpb.TransferState{
		Options:        &connectpb.ContextPlayerOptions{},
		CurrentSession: &connectpb.Session{Context: &connectpb.Context{Uri: "spotify:playlist:37i9dQZF1DWVKDF4ycOESi"}},
		Playback:       &connectpb.Playback{CurrentTrack: &connectpb.ContextTrack{Uri: jamTrackUri}},
	})
	require.NoError(t, p.handlePlayerCommand(req))
	require.True(t, p.state.player.IsBuffering, "claimed before the resolve")

	runQueuedJob(t, p)

	// A failure that is not the backend refusing the context says nothing
	// about the track either, so there is no falling back to it.
	requireIdle(t, p)
}

// The field case of #338: the backend refuses the Jam's list, but the transfer
// still says which track was playing. That track plays, with what was queued
// behind it.
func TestTransferOfARefusedContextPlaysTheTransferredTrack(t *testing.T) {
	for _, status := range []int{http.StatusForbidden, http.StatusNotFound} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			p := newTestAppPlayer(t)
			p.resolveTrackList = resolveWith(status, jamListUri)

			require.NoError(t, p.handlePlayerCommand(jamTransfer(t, &connectpb.ContextTrack{Uri: jamTrackUri, Uid: "u0"})))
			runQueuedJob(t, p)

			// Reported as a context of that one track, the same as a transfer
			// that carried no context at all.
			require.Equal(t, jamTrackUri, p.state.player.ContextUri)
			require.Empty(t, p.state.player.ContextUrl)
			require.Equal(t, jamTrackUri, p.state.player.Track.GetUri())

			require.NotNil(t, p.state.tracks)
			require.Len(t, p.state.player.NextTracks, 1)
			require.Equal(t, queuedUri, p.state.player.NextTracks[0].Uri)
			require.Equal(t, "queue", p.state.player.NextTracks[0].Provider)

			// And the track itself is being loaded.
			require.Len(t, p.loader.queue, 1)
			require.True(t, p.state.active)
			require.False(t, logoutRequested(p))
		})
	}
}

// A context can arrive with no track in it. The claim must not dereference the
// missing track, and a resolve that then fails leaves the device idle. (A
// Jam's list without a track is the Jam's end, taken before any claim.)
func TestTransferWithoutATrackThatCannotResolveLeavesTheDeviceIdle(t *testing.T) {
	p := newTestAppPlayer(t)
	p.resolveTrackList = failResolve

	require.NoError(t, p.handlePlayerCommand(listTransfer(t, playlistUri, nil)))
	require.Nil(t, p.state.player.Track)

	runQueuedJob(t, p)

	requireIdle(t, p)
}

// Refused, and with no track to fall back on, there is nothing to play.
func TestTransferOfARefusedContextWithoutATrackLeavesTheDeviceIdle(t *testing.T) {
	p := newTestAppPlayer(t)
	p.resolveTrackList = resolveWith(http.StatusForbidden, playlistUri)

	require.NoError(t, p.handlePlayerCommand(listTransfer(t, playlistUri, nil)))
	require.Nil(t, p.state.player.Track, "a context with no track in it is claimed without one")

	runQueuedJob(t, p)

	requireIdle(t, p)
}

// A transfer that has since been replaced must not undo the one that replaced
// it when it fails.
func TestSupersededTransferFailureLeavesTheNewerTransfer(t *testing.T) {
	const newer = "spotify:playlist:37i9dQZF1DWVKDF4ycOESi"

	p := newTestAppPlayer(t)
	p.resolveTrackList = failResolve

	require.NoError(t, p.handlePlayerCommand(listTransfer(t, "spotify:playlist:37i9dQZF1EQpj7X7UK8OOF", nil)))
	require.Len(t, p.loader.queue, 1)
	stale := p.loader.queue[0]
	p.loader.queue = nil
	res := p.loader.execute(stale, t.Context())

	require.NoError(t, p.handlePlayerCommand(transferCommand(t, &connectpb.TransferState{
		Options:        &connectpb.ContextPlayerOptions{},
		CurrentSession: &connectpb.Session{Context: &connectpb.Context{Uri: newer}},
		Playback:       &connectpb.Playback{CurrentTrack: &connectpb.ContextTrack{Uri: jamTrackUri}},
	})))

	p.applyLoaderResult(res)

	require.Equal(t, newer, p.state.player.ContextUri)
	require.True(t, p.state.player.IsBuffering, "still waiting on its own resolve")
	require.Len(t, p.loader.queue, 1, "which is still queued")
	require.NotContains(t, apiEvents(p), ApiEventTypeStopped)
}

// playingTrack puts a stream for the given track on air, as a load would have
// left it: the device active, the stream the player's primary, and the track in
// the state. The closed player reports its position as zero.
func playingTrack(t *testing.T, p *AppPlayer, uri, uid string) *player.Stream {
	t.Helper()

	id, err := librespot.SpotifyIdFromUri(uri)
	require.NoError(t, err)

	stream := &player.Stream{
		RequestedId: *id,
		Media: librespot.NewMediaFromTrack(&metadatapb.Track{
			Gid:      id.Id(),
			Name:     proto.String("Follow You"),
			Duration: proto.Int32(175643),
		}),
	}

	p.state.setActive(true)
	p.primaryStream = stream
	p.state.player.ContextUri = "spotify:playlist:37i9dQZF1EQpj7X7UK8OOF"
	p.state.player.Track = &connectpb.ProvidedTrack{Uri: uri, Uid: uid, Provider: "context"}
	p.state.player.IsPlaying = true
	p.state.setPaused(false)
	return stream
}

// dropStreamForLoad forgets the playing stream once a command has decided to
// load. The load reports the stream it replaces through the session, which the
// harness does not have; what is under test is the decision, taken already.
func dropStreamForLoad(p *AppPlayer) {
	p.primaryStream = nil
}

// jamEdit is what social-connect sends the speaker when a Jam's participant
// adds a song while the Jam's list plays there: the whole Jam, its pages
// included, naming the track that is playing at the position it has reached,
// and retaining the original session.
func jamEdit(t *testing.T, current *connectpb.ContextTrack, retain string) dealer.RequestPayload {
	t.Helper()

	req := transferCommand(t, &connectpb.TransferState{
		Options: &connectpb.ContextPlayerOptions{Modes: map[string]string{"jam": "on"}},
		CurrentSession: &connectpb.Session{
			Context: &connectpb.Context{
				Uri: jamListUri,
				Pages: []*connectpb.ContextPage{{Tracks: []*connectpb.ContextTrack{
					{Uri: jamTrackUri, Uid: "u0"},
					{Uri: "spotify:track:3CRDbSIZ4r5MsZ0YwxuEkn", Uid: "u1"},
				}}},
			},
			PlayOrigin:        &connectpb.PlayOrigin{FeatureIdentifier: "playlist"},
			OriginalSessionId: proto.String("35lwkDPCBS93o5gUm1sCsy"),
		},
		Playback: &connectpb.Playback{
			Timestamp:             time.Now().UnixMilli(),
			PositionAsOfTimestamp: 1000,
			CurrentTrack:          current,
		},
		Queue: &connectpb.Queue{Tracks: []*connectpb.ContextTrack{{Uri: queuedUri, Uid: "q0"}}},
	})
	req.SentByDeviceId = "social-connect-1ce14fef83e5a794b92abe1681e910d9"
	req.Command.Options.RetainSession = retain
	return req
}

// The Jam's list, the queue and the session are taken over around the stream
// that is already playing: no claim that would show the device buffering, and
// no second load of the same track. Reloading it on every edit restarted the
// song for everyone, and cost an audio key each time.
func TestJamEditTransferKeepsThePlayingStream(t *testing.T) {
	p := newTestAppPlayer(t)
	p.resolveTrackList = resolveWith(0)
	stream := playingTrack(t, p, jamTrackUri, "u0")

	require.NoError(t, p.handlePlayerCommand(jamEdit(t, &connectpb.ContextTrack{Uri: jamTrackUri, Uid: "u0"}, "retain_original")))
	require.False(t, p.state.player.IsBuffering, "nothing is claimed while the context resolves")

	runQueuedJob(t, p)

	require.Same(t, stream, p.primaryStream)
	require.Empty(t, p.loader.queue, "the playing track is not loaded again")

	require.Equal(t, jamListUri, p.state.player.ContextUri)
	require.Equal(t, "social-connect-1ce14fef83e5a794b92abe1681e910d9", p.state.player.PlayOrigin.GetDeviceIdentifier())
	require.Equal(t, "35lwkDPCBS93o5gUm1sCsy", p.state.player.SessionId)
	require.Equal(t, "on", p.state.player.Options.GetModes()["jam"])

	require.Equal(t, jamTrackUri, p.state.player.Track.GetUri())
	require.Equal(t, "Follow You", p.state.player.Track.GetMetadata()["title"], "the media's metadata is put back on the fresh track")
	require.Len(t, p.state.player.NextTracks, 2)
	require.Equal(t, queuedUri, p.state.player.NextTracks[0].GetUri())
	require.Equal(t, "queue", p.state.player.NextTracks[0].GetProvider())

	require.True(t, p.state.player.IsPlaying)
	require.False(t, p.state.player.IsBuffering)
	require.False(t, p.state.player.IsPaused)
	require.NotContains(t, apiEvents(p), ApiEventTypeWillPlay)
}

// A skip in a Jam arrives the same way, naming the next track: that one loads.
func TestJamEditTransferOfAnotherTrackLoadsIt(t *testing.T) {
	p := newTestAppPlayer(t)
	p.resolveTrackList = resolveWith(0)
	playingTrack(t, p, jamTrackUri, "u0")

	next := &connectpb.ContextTrack{Uri: "spotify:track:3CRDbSIZ4r5MsZ0YwxuEkn", Uid: "u1"}
	require.NoError(t, p.handlePlayerCommand(jamEdit(t, next, "retain_original")))
	require.True(t, p.state.player.IsBuffering, "claimed like any other transfer")

	dropStreamForLoad(p)
	runQueuedJob(t, p)

	require.Len(t, p.loader.queue, 1)
	require.Equal(t, "load "+next.Uri, p.loader.queue[0].name)
}

// A song listed twice is two entries. Moving from one to the other is a skip,
// even though the uri is the same.
func TestJamEditTransferToTheSameSongListedTwiceLoadsIt(t *testing.T) {
	p := newTestAppPlayer(t)
	p.resolveTrackList = resolveWith(0)
	playingTrack(t, p, jamTrackUri, "u9")

	require.NoError(t, p.handlePlayerCommand(jamEdit(t, &connectpb.ContextTrack{Uri: jamTrackUri, Uid: "u0"}, "retain_original")))
	dropStreamForLoad(p)
	runQueuedJob(t, p)

	require.Len(t, p.loader.queue, 1)
	require.Equal(t, "load "+jamTrackUri, p.loader.queue[0].name)
}

// Encore patch 9: a uid the engine made up for the playing entry is not one
// Spotify has, which told it the entry has none: a transfer naming the same
// song by a uid of Spotify's own carries it on, as before the patch.
func TestJamEditTransferAgainstAMadeUpUidKeepsThePlayingStream(t *testing.T) {
	p := newTestAppPlayer(t)
	p.resolveTrackList = resolveWith(0)
	stream := playingTrack(t, p, jamTrackUri, "enc-0-00112233aabbccdd-0")

	require.NoError(t, p.handlePlayerCommand(jamEdit(t, &connectpb.ContextTrack{Uri: jamTrackUri, Uid: "u0"}, "retain_original")))
	runQueuedJob(t, p)

	require.Same(t, stream, p.primaryStream)
	require.Empty(t, p.loader.queue, "the playing track is not loaded again")
}

// A user casting onto the device does not retain the session: that is a new
// start, and the track is loaded even if it is the one already playing.
func TestTransferThatDoesNotRetainTheSessionLoadsTheTrack(t *testing.T) {
	p := newTestAppPlayer(t)
	p.resolveTrackList = resolveWith(0)
	playingTrack(t, p, jamTrackUri, "u0")

	require.NoError(t, p.handlePlayerCommand(jamEdit(t, &connectpb.ContextTrack{Uri: jamTrackUri, Uid: "u0"}, "do_not_retain")))
	require.True(t, p.state.player.IsBuffering)

	dropStreamForLoad(p)
	runQueuedJob(t, p)

	require.Len(t, p.loader.queue, 1)
	require.Equal(t, "load "+jamTrackUri, p.loader.queue[0].name)
}

// A continuation claimed nothing. If it cannot be applied, what it would have
// updated is still playing, and must go on doing so.
func TestFailedJamEditTransferKeepsPlaying(t *testing.T) {
	p := newTestAppPlayer(t)
	p.resolveTrackList = failResolve
	stream := playingTrack(t, p, jamTrackUri, "u0")

	require.NoError(t, p.handlePlayerCommand(jamEdit(t, &connectpb.ContextTrack{Uri: jamTrackUri, Uid: "u0"}, "retain_original")))
	runQueuedJob(t, p)

	require.Same(t, stream, p.primaryStream)
	require.True(t, p.state.active)
	require.True(t, p.state.player.IsPlaying)
	require.Equal(t, "spotify:playlist:37i9dQZF1EQpj7X7UK8OOF", p.state.player.ContextUri)
	require.Empty(t, p.loader.queue)
	require.NotContains(t, apiEvents(p), ApiEventTypeStopped)
}

// A Jam is switched on and off by a set_options that carries only modes. They
// have to reach the reported options: otherwise the device keeps the modes of
// the last transfer, and goes on reporting a Jam that has ended.
func TestSetOptionsAppliesModes(t *testing.T) {
	p := newTestAppPlayer(t)
	p.state.player.Options = &connectpb.ContextPlayerOptions{
		RepeatingContext: true,
		Modes:            map[string]string{"jam": "on", "context_enhancement": "NONE"},
	}

	var req dealer.RequestPayload
	req.Command.Endpoint = "set_options"
	req.Command.Modes = map[string]string{"jam": "off"}
	require.NoError(t, p.handlePlayerCommand(req))

	require.Equal(t, map[string]string{"jam": "off", "context_enhancement": "NONE"}, p.state.player.Options.Modes)
	require.True(t, p.state.player.Options.RepeatingContext, "a command with only modes leaves the rest alone")
	require.Equal(t, "off", lastPushedState(t, p).GetOptions().GetModes()["jam"])
}

// A device that has never been in a Jam has no modes at all to merge into.
func TestSetOptionsAppliesModesWithoutAny(t *testing.T) {
	p := newTestAppPlayer(t)

	var req dealer.RequestPayload
	req.Command.Endpoint = "set_options"
	req.Command.Modes = map[string]string{"jam": "on"}
	require.NoError(t, p.handlePlayerCommand(req))

	require.Equal(t, "on", p.state.player.Options.GetModes()["jam"])
}

// An account with no playback at all casting onto the device hands over nothing
// but still asks for something to play. The device is taken over, with nothing
// on it: refused, the client just sends the transfer again.
func TestEmptyTransferAskingForSomethingIsTakenOverIdle(t *testing.T) {
	p := newTestAppPlayer(t)

	req := transferCommand(t, &connectpb.TransferState{
		Options:        &connectpb.ContextPlayerOptions{},
		CurrentSession: &connectpb.Session{},
		Playback:       &connectpb.Playback{Timestamp: 1790340000000},
	})
	req.Command.Options.RestoreTrack = "always_play_something"

	require.NoError(t, p.handlePlayerCommand(req))

	requireIdle(t, p)
	require.Contains(t, apiEvents(p), ApiEventTypeActive)
}

// The desktop client with nothing loaded sends a context that is there but
// empty, rather than none. It names nothing to resolve, so it is taken over
// idle the same way, instead of failing as an unsupported context.
func TestEmptyContextTransferAskingForSomethingIsTakenOverIdle(t *testing.T) {
	p := newTestAppPlayer(t)

	req := transferCommand(t, &connectpb.TransferState{
		Options:        &connectpb.ContextPlayerOptions{},
		CurrentSession: &connectpb.Session{Context: &connectpb.Context{Restrictions: &connectpb.Restrictions{}}},
		Playback:       &connectpb.Playback{Timestamp: 1790340000000},
	})
	req.Command.Options.RestoreTrack = "always_play_something"

	require.NoError(t, p.handlePlayerCommand(req))

	requireIdle(t, p)
	require.Contains(t, apiEvents(p), ApiEventTypeActive)
}

// jamEnd is what a Jam's end sends the speaker (upstream's field case): the
// Jam's list with its pages, and nothing else: no track, no position, no
// queue, and empty options.
func jamEnd(t *testing.T, uri string) dealer.RequestPayload {
	t.Helper()

	req := transferCommand(t, &connectpb.TransferState{
		Options: &connectpb.ContextPlayerOptions{},
		CurrentSession: &connectpb.Session{Context: &connectpb.Context{
			Uri: uri,
			Pages: []*connectpb.ContextPage{{Tracks: []*connectpb.ContextTrack{
				{Uri: jamTrackUri, Uid: "u0"},
				{Uri: "spotify:track:3CRDbSIZ4r5MsZ0YwxuEkn", Uid: "u1"},
			}}},
		}},
		Playback: &connectpb.Playback{},
		Queue:    &connectpb.Queue{},
	})
	req.SentByDeviceId = "social-connect-1ce14fef83e5a794b92abe1681e910d9"
	req.Command.Options.RetainSession = "retain_original"
	req.Command.Options.RestoreTrack = "always_play_something"
	return req
}

// A context sent without a track in it used to be left unpositioned, and
// reading it panicked, taking the daemon down. It plays from the top instead,
// whatever it is but a Jam's list.
func TestTransferOfAContextWithoutATrackPlaysItFromTheTop(t *testing.T) {
	p := newTestAppPlayer(t)
	p.resolveTrackList = resolveWith(0)
	playingTrack(t, p, jamTrackUri, "u0")

	require.NoError(t, p.handlePlayerCommand(jamEnd(t, playlistUri)))
	dropStreamForLoad(p)
	runQueuedJob(t, p)

	require.Equal(t, jamTrackUri, p.state.tracks.CurrentTrack().GetUri())
	require.Len(t, p.loader.queue, 1)
	require.Equal(t, "load "+jamTrackUri, p.loader.queue[0].name)
}

// The same transfer of a Jam's list is how the Jam's end reaches the speaker
// playing it. Played from the top, it replayed the Jam's first song for
// nobody: the device is left idle instead, active and logged in, with nothing
// to load.
func TestTransferOfAJamListWithoutATrackLeavesTheDeviceIdle(t *testing.T) {
	p := newTestAppPlayer(t)
	inJam(t, p)

	require.NoError(t, p.handlePlayerCommand(jamEnd(t, jamListUri)))

	require.True(t, p.state.active, "the device stays active")
	require.False(t, logoutRequested(p), "and keeps its session")
	require.Nil(t, p.state.tracks)
	require.Empty(t, p.loader.queue, "nothing is loaded")

	// The Jam's song stops; the player announces that with its stop event.
	require.Nil(t, p.primaryStream)

	state := lastPushedState(t, p)
	require.False(t, state.IsPlaying)
	require.False(t, state.IsBuffering)
	require.Empty(t, state.ContextUri)
	require.Nil(t, state.Track)
	require.Contains(t, apiEvents(p), ApiEventTypeActive)
}

// playingQueueTransfer hands over a queued song as the one playing. The
// session's current uid then names the context track that comes after the
// queue, as social-connect and the desktop client send it. That is the usual
// state of a Jam, whose participants queue songs.
func playingQueueTransfer(t *testing.T, retain, resumeUid string) dealer.RequestPayload {
	t.Helper()

	queued := &connectpb.ContextTrack{Uri: queuedUri, Uid: "q1", Metadata: map[string]string{"is_queued": "true"}}
	req := transferCommand(t, &connectpb.TransferState{
		Options: &connectpb.ContextPlayerOptions{},
		CurrentSession: &connectpb.Session{
			Context: &connectpb.Context{
				Uri: "spotify:playlist:37i9dQZF1DX8vwRmUsEIMT",
				Pages: []*connectpb.ContextPage{{Tracks: []*connectpb.ContextTrack{
					{Uri: "spotify:track:3j7BhP71ROCpc9R3w9P9UE", Uid: "u0"},
					{Uri: "spotify:track:2infXICqVSUM3bbGSOgFOY", Uid: "u1"},
					{Uri: "spotify:track:11hcBLPtbMp4aQI6zGQLub", Uid: "u2"},
				}}},
			},
			CurrentUid: resumeUid,
		},
		Playback: &connectpb.Playback{
			Timestamp:             time.Now().UnixMilli(),
			PositionAsOfTimestamp: 1000,
			CurrentTrack:          queued,
		},
		Queue: &connectpb.Queue{IsPlayingQueue: true, Tracks: []*connectpb.ContextTrack{proto.Clone(queued).(*connectpb.ContextTrack)}},
	})
	req.Command.Options.RetainSession = retain
	return req
}

func trackUris(tracks []*connectpb.ProvidedTrack) []string {
	uris := make([]string, 0, len(tracks))
	for _, track := range tracks {
		uris = append(uris, track.GetUri())
	}
	return uris
}

// A queued song is not in the context, so seeking the context to it fails.
// That used to play it ahead of the context and then the context from its
// top, replaying what had been played before the queue took over.
func TestTransferOfAPlayingQueuedTrackKeepsTheContextPosition(t *testing.T) {
	for _, tt := range []struct {
		name      string
		resumeUid string
		next      []string
	}{
		{name: "mid context", resumeUid: "u1", next: []string{"spotify:track:2infXICqVSUM3bbGSOgFOY", "spotify:track:11hcBLPtbMp4aQI6zGQLub"}},
		{name: "before the first track", resumeUid: "u0", next: []string{"spotify:track:3j7BhP71ROCpc9R3w9P9UE", "spotify:track:2infXICqVSUM3bbGSOgFOY", "spotify:track:11hcBLPtbMp4aQI6zGQLub"}},
		{name: "unknown uid", resumeUid: "u9", next: []string{"spotify:track:3j7BhP71ROCpc9R3w9P9UE", "spotify:track:2infXICqVSUM3bbGSOgFOY", "spotify:track:11hcBLPtbMp4aQI6zGQLub"}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			p := newTestAppPlayer(t)
			p.resolveTrackList = resolveWith(0)

			require.NoError(t, p.handlePlayerCommand(playingQueueTransfer(t, "do_not_retain", tt.resumeUid)))
			runQueuedJob(t, p)

			require.Equal(t, queuedUri, p.state.tracks.CurrentTrack().GetUri())
			require.Equal(t, "queue", p.state.tracks.CurrentTrack().GetProvider())
			require.Equal(t, tt.next, trackUris(p.state.tracks.NextTracks(t.Context(), nil)))
		})
	}
}

// The same inside a Jam, where an edit arrives as a transfer of the song that
// is playing: the stream is kept and so is the context's position.
func TestJamEditWhileAQueuedTrackPlaysKeepsTheContextPosition(t *testing.T) {
	p := newTestAppPlayer(t)
	p.resolveTrackList = resolveWith(0)
	stream := playingTrack(t, p, queuedUri, "q1")

	require.NoError(t, p.handlePlayerCommand(playingQueueTransfer(t, "retain_original", "u2")))
	runQueuedJob(t, p)

	require.Same(t, stream, p.primaryStream)
	require.Empty(t, p.loader.queue, "the playing track is not loaded again")
	require.Equal(t, []string{"spotify:track:11hcBLPtbMp4aQI6zGQLub"}, trackUris(p.state.player.NextTracks))
}

// Starting a context keeps what is queued, as the official clients do. In a
// Jam the queue is what the participants added, and the host starting a
// playlist used to throw it away.
func TestStartingAContextKeepsTheQueue(t *testing.T) {
	spotCtx := &connectpb.Context{
		Uri: "spotify:playlist:37i9dQZF1DX8vwRmUsEIMT",
		Pages: []*connectpb.ContextPage{{Tracks: []*connectpb.ContextTrack{
			{Uri: jamTrackUri, Uid: "u0"},
			{Uri: "spotify:track:3CRDbSIZ4r5MsZ0YwxuEkn", Uid: "u1"},
		}}},
	}
	queued := []*connectpb.ContextTrack{{Uri: queuedUri, Uid: "q0", Metadata: map[string]string{"is_queued": "true"}}}

	_, snap, err := resolveContext(t.Context(), &librespot.NullLogger{}, nil, spotCtx, nil, false, queued)
	require.NoError(t, err)

	require.Equal(t, jamTrackUri, snap.Current.GetUri())
	require.Equal(t, []string{queuedUri, "spotify:track:3CRDbSIZ4r5MsZ0YwxuEkn"}, trackUris(snap.Next))
	require.Equal(t, "queue", snap.Next[0].GetProvider())
}

// What carries over is what is still to play: a queued track that is playing
// has been jumped away from by starting something else.
func TestUpcomingQueueLeavesOutThePlayingEntry(t *testing.T) {
	list, err := tracks.NewTrackListFromContext(t.Context(), &librespot.NullLogger{}, nil, &connectpb.Context{
		Uri:   "spotify:playlist:37i9dQZF1DX8vwRmUsEIMT",
		Pages: []*connectpb.ContextPage{{Tracks: []*connectpb.ContextTrack{{Uri: jamTrackUri, Uid: "u0"}}}},
	})
	require.NoError(t, err)
	require.True(t, list.GoStart(t.Context()))

	list.AddToQueue(&connectpb.ContextTrack{Uri: queuedUri, Uid: "q0"})
	list.AddToQueue(&connectpb.ContextTrack{Uri: "spotify:track:3CRDbSIZ4r5MsZ0YwxuEkn", Uid: "q1"})
	require.Len(t, list.UpcomingQueue(), 2)

	list.SetPlayingQueue(true)
	upcoming := list.UpcomingQueue()
	require.Len(t, upcoming, 1)
	require.Equal(t, "q1", upcoming[0].GetUid())
}

// shuffleTestContext is a context of n tracks whose page holds all of them, so
// loading it never reaches for the network. first numbers its first track.
func shuffleTestContext(uri string, first byte, n int) (*connectpb.Context, []string) {
	spotCtx := &connectpb.Context{Uri: uri, Pages: []*connectpb.ContextPage{{}}}
	var uris []string
	for i := range n {
		track := trackUri(first + byte(i))
		spotCtx.Pages[0].Tracks = append(spotCtx.Pages[0].Tracks, &connectpb.ContextTrack{Uri: track, Uid: fmt.Sprintf("u%d", i)})
		uris = append(uris, track)
	}
	return spotCtx, uris
}

// newShuffleTestPlayer is a test player whose context loads can run. The
// resolve reads the session's spclient, which a context that holds all of its
// tracks never uses.
func newShuffleTestPlayer(t *testing.T) *AppPlayer {
	t.Helper()

	p := newTestAppPlayer(t)
	p.sess = &session.Session{}
	return p
}

// A play that asks for shuffle sets it before its context loads, and the
// context is shuffled as it resolves: the play starts on a random track.
func TestPlayWithShuffleStartsTheContextShuffled(t *testing.T) {
	p := newShuffleTestPlayer(t)
	spotCtx, inOrder := shuffleTestContext("spotify:playlist:37i9dQZF1DX8vwRmUsEIMT", 0x01, 40)

	p.setPlayShuffle(pointer(true))
	p.loadContext(spotCtx, nil, false, true, func(error) {})
	runQueuedJob(t, p)

	require.True(t, p.state.player.Options.ShufflingContext)
	require.Contains(t, apiEvents(p), ApiEventTypeShuffleContext)
	shuffled := trackUris(p.state.tracks.AllTracks(0))
	require.ElementsMatch(t, inOrder, shuffled)
	require.NotEqual(t, inOrder, shuffled, "40 tracks shuffled into their own order is a 1 in 40! chance")
}

// With a context loaded, a shuffled play leaves it alone. /player/shuffle_context
// would reshuffle it, walking all of its pages, for a list the play replaces.
func TestPlayWithShuffleLeavesTheOldContextAlone(t *testing.T) {
	p := newShuffleTestPlayer(t)
	oldCtx, oldOrder := shuffleTestContext("spotify:playlist:37i9dQZF1DX8vwRmUsEIMT", 0x01, 40)
	p.loadContext(oldCtx, nil, false, true, func(error) {})
	runQueuedJob(t, p)
	p.loader.queue = nil // the old context's first track need not load
	old := p.state.tracks
	require.NotNil(t, old)

	p.setPlayShuffle(pointer(true))
	require.Empty(t, p.loader.queue, "no shuffle job for the old context")
	require.Equal(t, oldOrder, trackUris(old.AllTracks(0)))

	newCtx, newOrder := shuffleTestContext("spotify:playlist:37i9dQZF1EQpj7X7UK8OOF", 0x41, 40)
	p.loadContext(newCtx, nil, false, true, func(error) {})
	require.Len(t, p.loader.queue, 1)
	require.Equal(t, "resolve "+newCtx.Uri, p.loader.queue[0].name)
	runQueuedJob(t, p)

	require.NotSame(t, old, p.state.tracks)
	require.NotEqual(t, newOrder, trackUris(p.state.tracks.AllTracks(0)), "the new context starts shuffled")
	require.Equal(t, oldOrder, trackUris(old.AllTracks(0)), "the old one was never touched")
}

// A play without shuffle_context keeps the current setting, and one that asks
// for the setting already in force announces nothing.
func TestPlayShuffleOnlyChangesWhatItNames(t *testing.T) {
	p := newTestAppPlayer(t)
	p.state.player.Options.ShufflingContext = true

	p.setPlayShuffle(nil)
	p.setPlayShuffle(pointer(true))
	require.True(t, p.state.player.Options.ShufflingContext)
	require.Empty(t, apiEvents(p))

	p.setPlayShuffle(pointer(false))
	require.False(t, p.state.player.Options.ShufflingContext)
	require.Equal(t, []ApiEventType{ApiEventTypeShuffleContext}, apiEvents(p))
}
