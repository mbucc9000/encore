//go:build test_unit

package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	librespot "github.com/devgianlu/go-librespot"
	"github.com/devgianlu/go-librespot/dealer"
	connectpb "github.com/devgianlu/go-librespot/proto/spotify/connectstate"
	"github.com/devgianlu/go-librespot/spclient"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"
)

const socialDevice = "social-connect-1ce14fef83e5a794b92abe1681e910d9"

// emitted returns the data of the events of one type, in the order emitted.
func emitted(p *AppPlayer, typ ApiEventType) []any {
	var out []any
	for _, ev := range p.app.server.(*recordingApiServer).emitted {
		if ev.Type == typ {
			out = append(out, ev.Data)
		}
	}
	return out
}

func jamEventsOf(p *AppPlayer) []ApiEventDataJam {
	var out []ApiEventDataJam
	for _, data := range emitted(p, ApiEventTypeJam) {
		out = append(out, data.(ApiEventDataJam))
	}
	return out
}

func commandEventsOf(p *AppPlayer) []ApiEventDataCommand {
	var out []ApiEventDataCommand
	for _, data := range emitted(p, ApiEventTypeCommand) {
		out = append(out, data.(ApiEventDataCommand))
	}
	return out
}

// setJamMode is social-connect switching a Jam on or off on the speaker: a
// set_options carrying nothing but the mode.
func setJamMode(mode string) dealer.RequestPayload {
	var req dealer.RequestPayload
	req.Command.Endpoint = "set_options"
	req.Command.Modes = map[string]string{"jam": mode}
	req.SentByDeviceId = socialDevice
	return req
}

// inJam puts the test player in a Jam the way a participant's add does: the
// speaker plays the Jam's song, and a continuing transfer of the whole Jam
// takes over the session around it.
func inJam(t *testing.T, p *AppPlayer) {
	t.Helper()

	p.resolveTrackList = resolveWith(0)
	playingTrack(t, p, jamTrackUri, "u0")
	require.NoError(t, p.handlePlayerCommand(jamEdit(t, &connectpb.ContextTrack{Uri: jamTrackUri, Uid: "u0"}, "retain_original")))
	runQueuedJob(t, p)
	require.Equal(t, jamListUri, p.state.player.ContextUri)
}

func TestJamEventForSetOptions(t *testing.T) {
	p := newTestAppPlayer(t)

	require.NoError(t, p.handlePlayerCommand(setJamMode("on")))
	require.NoError(t, p.handlePlayerCommand(setJamMode("on")))
	require.Equal(t, []ApiEventDataJam{{Mode: "on"}}, jamEventsOf(p), "once, on the change")

	require.NoError(t, p.handlePlayerCommand(setJamMode("off")))
	require.Equal(t, []ApiEventDataJam{{Mode: "on"}, {Mode: "off"}}, jamEventsOf(p))
}

// A participant's add is a transfer of the whole Jam: the first one says the
// playback now comes from social-connect, a second identical one says nothing
// new.
func TestJamEventForAJamEdit(t *testing.T) {
	p := newTestAppPlayer(t)
	inJam(t, p)

	want := []ApiEventDataJam{{Mode: "on", Origin: socialDevice, ContextUri: jamListUri}}
	require.Equal(t, want, jamEventsOf(p))

	require.NoError(t, p.handlePlayerCommand(jamEdit(t, &connectpb.ContextTrack{Uri: jamTrackUri, Uid: "u0"}, "retain_original")))
	runQueuedJob(t, p)
	require.Equal(t, want, jamEventsOf(p), "nothing changed")
}

// Playback taken away by another device resets the state with no push of its
// own: the jam event says so right after inactive, and coming back to the
// same Jam is reported again.
func TestJamEventWhenPlaybackMovesAway(t *testing.T) {
	p := newTestAppPlayer(t)
	p.app.cfg = &Config{}
	p.app.deviceId = thisDevice
	inJam(t, p)

	require.NoError(t, p.handleDealerMessage(clusterMessage(t, otherDevice, time.Now().UnixMilli()+time.Minute.Milliseconds())))
	require.False(t, p.state.active)

	events := apiEvents(p)
	require.Equal(t, []ApiEventType{ApiEventTypeInactive, ApiEventTypeJam}, events[len(events)-2:])
	require.Equal(t, ApiEventDataJam{}, jamEventsOf(p)[1])

	inJam(t, p)
	require.Len(t, jamEventsOf(p), 3)
	require.Equal(t, jamEventsOf(p)[0], jamEventsOf(p)[2])
}

// Ordinary playback emits nothing, however often its context changes.
func TestNoJamEventOutsideAJam(t *testing.T) {
	p := newShuffleTestPlayer(t)

	for _, uri := range []string{"spotify:playlist:37i9dQZF1DX8vwRmUsEIMT", "spotify:playlist:37i9dQZF1EQpj7X7UK8OOF"} {
		spotCtx, _ := shuffleTestContext(uri, 0x01, 3)
		p.loadContext(spotCtx, nil, false, true, func(error) {})
		runQueuedJob(t, p)
		p.loader.queue = nil
	}

	require.Empty(t, jamEventsOf(p))
}

// The host playing a playlist from the API replaces social-connect as the
// origin. The mode is left as the Jam's transfer set it: the event reports it
// as it stands, and the client decides what that means.
func TestJamEventWhenAnApiPlayReplacesTheSocialOrigin(t *testing.T) {
	p := newTestAppPlayer(t)
	inJam(t, p)

	spotCtx, _ := shuffleTestContext(playlistUri, 0x01, 3)
	p.resolvePlayContext = func(_ context.Context, uri string) (*connectpb.Context, error) {
		require.Equal(t, playlistUri, uri)
		return spotCtx, nil
	}

	req, _ := NewApiRequest(ApiRequestTypePlay, ApiPlay{Uri: playlistUri})
	_, err := p.handleApiRequest(req)
	require.ErrorIs(t, err, errReplyDeferred)
	runQueuedJob(t, p)

	require.Equal(t, []ApiEventDataJam{
		{Mode: "on", Origin: socialDevice, ContextUri: jamListUri},
		{Mode: "on", Origin: "", ContextUri: playlistUri},
	}, jamEventsOf(p))
}

// Upstream's end sequence: set_options switches the Jam off, then the Jam's
// list arrives without a track and with empty options. The device is left
// idle with the mode off: applying that transfer's options would have put it
// back to unset.
func TestJamEndSequenceLeavesTheModeOff(t *testing.T) {
	p := newTestAppPlayer(t)
	inJam(t, p)
	sessionId := p.state.player.SessionId

	require.NoError(t, p.handlePlayerCommand(setJamMode("off")))
	require.NoError(t, p.handlePlayerCommand(jamEnd(t, jamListUri)))

	require.Equal(t, "off", p.state.player.Options.GetModes()["jam"])
	require.Empty(t, p.state.player.ContextUri)
	require.Equal(t, sessionId, p.state.player.SessionId, "the session is not the end transfer's")
	require.Equal(t, socialDevice, p.state.player.PlayOrigin.GetDeviceIdentifier())
	require.Empty(t, p.loader.queue)

	require.Equal(t, []ApiEventDataJam{
		{Mode: "on", Origin: socialDevice, ContextUri: jamListUri},
		{Mode: "off", Origin: socialDevice, ContextUri: jamListUri},
		{Mode: "off", Origin: socialDevice, ContextUri: ""},
	}, jamEventsOf(p))

	require.Equal(t, "off", lastPushedState(t, p).GetOptions().GetModes()["jam"])
}

// When the end arrives with no set_options before it, the mode that was on is
// switched off with it, and the command says it was taken as the end.
func TestJamEndWithoutSetOptionsSwitchesTheModeOff(t *testing.T) {
	p := newTestAppPlayer(t)
	inJam(t, p)
	p.emitQueueEvent() // the Jam's own, as the timer would have sent it

	require.NoError(t, p.handlePlayerCommand(jamEnd(t, jamListUri)))

	require.Equal(t, "off", p.state.player.Options.GetModes()["jam"])
	require.Empty(t, p.state.player.ContextUri)
	require.True(t, p.state.active)
	require.Empty(t, p.loader.queue)
	require.True(t, p.queueEventPending, "the emptied queue is announced")

	commands := commandEventsOf(p)
	end := commands[len(commands)-1]
	require.Equal(t, "transfer", end.Endpoint)
	require.Equal(t, socialDevice, end.From)
	require.True(t, end.JamEnd)
	require.NotNil(t, end.Continues)
	require.False(t, *end.Continues)
}

// A load still on its way when the end arrives, a skip just before it say,
// must not put the Jam's song back on.
func TestJamEndDropsALoadInFlight(t *testing.T) {
	p := newTestAppPlayer(t)
	inJam(t, p)

	next := &connectpb.ContextTrack{Uri: "spotify:track:3CRDbSIZ4r5MsZ0YwxuEkn", Uid: "u1"}
	require.NoError(t, p.handlePlayerCommand(jamEdit(t, next, "retain_original")))
	require.Len(t, p.loader.queue, 1)
	gen := p.loadGen

	require.NoError(t, p.handlePlayerCommand(jamEnd(t, jamListUri)))

	require.Empty(t, p.loader.queue)
	require.Greater(t, p.loadGen, gen)
	require.False(t, p.loadInFlight)
}

// Only the list with nothing to play in it is the end: one that still says
// where it stands is played from there.
func TestJamListWithACurrentUidIsNotTheEnd(t *testing.T) {
	p := newTestAppPlayer(t)
	inJam(t, p)

	req := jamEnd(t, jamListUri)
	var state connectpb.TransferState
	require.NoError(t, proto.Unmarshal(req.Command.Data, &state))
	state.CurrentSession.CurrentUid = "u1"
	req = transferCommand(t, &state)
	req.SentByDeviceId = socialDevice

	require.NoError(t, p.handlePlayerCommand(req))
	require.Len(t, p.loader.queue, 1, "the transfer goes ahead")
	require.False(t, commandEventsOf(p)[len(commandEventsOf(p))-1].JamEnd)
}

// Only the end of the Jam this device played is taken for one. The list of a
// Jam it never played, which is also how a Jam with nothing played in it yet
// can reach a device joining it, plays from the top like any other context
// without a track, and the mode its set_options switched on is not switched
// off: not on an idle device, and not on one a Jam before it ended on.
func TestAJamListThisDeviceDidNotPlayIsNotTheEnd(t *testing.T) {
	const otherJamListUri = "spotify:list:jam-list:0b5a3f2e9c8d7b6a5f4e3d2c1b0a9f8e"

	for _, tt := range []struct {
		name  string
		setup func(t *testing.T, p *AppPlayer)
	}{
		{"idle", func(t *testing.T, p *AppPlayer) { p.resolveTrackList = resolveWith(0) }},
		{"after another Jam's end", func(t *testing.T, p *AppPlayer) {
			inJam(t, p)
			require.NoError(t, p.handlePlayerCommand(jamEnd(t, jamListUri)))
			require.Equal(t, socialDevice, p.state.player.PlayOrigin.GetDeviceIdentifier(), "the end kept the session")
		}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			p := newTestAppPlayer(t)
			tt.setup(t, p)
			ends := len(commandEventsOf(p))

			require.NoError(t, p.handlePlayerCommand(setJamMode("on")))
			require.NoError(t, p.handlePlayerCommand(jamEnd(t, otherJamListUri)))

			commands := commandEventsOf(p)
			require.Len(t, commands, ends+2)
			require.False(t, commands[ends+1].JamEnd)
			require.Len(t, p.loader.queue, 1, "the list plays from the top")
			require.Equal(t, "transfer "+otherJamListUri, p.loader.queue[0].name)
			require.NotEqual(t, "off", p.state.player.Options.GetModes()["jam"], "not switched off as at an end")
		})
	}
}

// The Jam this device played stays the one whose end it takes while the host
// plays something else on it in between.
func TestJamEndAfterAnApiPlay(t *testing.T) {
	p := newTestAppPlayer(t)
	inJam(t, p)

	spotCtx, _ := shuffleTestContext(playlistUri, 0x01, 3)
	p.resolvePlayContext = func(context.Context, string) (*connectpb.Context, error) { return spotCtx, nil }
	req, _ := NewApiRequest(ApiRequestTypePlay, ApiPlay{Uri: playlistUri})
	_, err := p.handleApiRequest(req)
	require.ErrorIs(t, err, errReplyDeferred)
	runQueuedJob(t, p)
	p.loader.queue = nil
	require.Equal(t, playlistUri, p.state.player.ContextUri)

	require.NoError(t, p.handlePlayerCommand(jamEnd(t, jamListUri)))

	commands := commandEventsOf(p)
	require.True(t, commands[len(commands)-1].JamEnd)
	require.Empty(t, p.state.player.ContextUri)
	require.Empty(t, p.loader.queue)
}

func TestCommandEvents(t *testing.T) {
	p := newTestAppPlayer(t)
	inJam(t, p)

	// A guest's pause, which this harness can apply without a session.
	var pause dealer.RequestPayload
	pause.Command.Endpoint = "pause"
	pause.SentByDeviceId = socialDevice
	_ = p.handlePlayerCommand(pause)

	commands := commandEventsOf(p)
	require.Len(t, commands, 2)

	require.Equal(t, "transfer", commands[0].Endpoint)
	require.Equal(t, socialDevice, commands[0].From)
	require.NotNil(t, commands[0].Continues)
	require.True(t, *commands[0].Continues, "a participant's add carries on the stream")
	require.False(t, commands[0].JamEnd)

	require.Equal(t, ApiEventDataCommand{Endpoint: "pause", From: socialDevice}, commands[1])

	raw, err := json.Marshal(commands[1])
	require.NoError(t, err)
	require.JSONEq(t, `{"endpoint":"pause","from":"`+socialDevice+`"}`, string(raw), "continues only on transfers")
}

// A transfer that does not carry on the stream says so.
func TestCommandEventForATransferThatLoads(t *testing.T) {
	p := newTestAppPlayer(t)
	p.resolveTrackList = resolveWith(0)
	playingTrack(t, p, jamTrackUri, "u0")

	next := &connectpb.ContextTrack{Uri: "spotify:track:3CRDbSIZ4r5MsZ0YwxuEkn", Uid: "u1"}
	require.NoError(t, p.handlePlayerCommand(jamEdit(t, next, "retain_original")))

	commands := commandEventsOf(p)
	require.Len(t, commands, 1)
	require.NotNil(t, commands[0].Continues)
	require.False(t, *commands[0].Continues)
}

// A burst of queue edits makes one queue event, half a second after the first.
func TestQueueEventCoalesces(t *testing.T) {
	p := newShuffleTestPlayer(t)
	spotCtx, _ := shuffleTestContext(playlistUri, 0x01, 3)
	p.loadContext(spotCtx, nil, false, true, func(error) {})
	runQueuedJob(t, p)
	p.loader.queue = nil

	// The load armed it; let that one go.
	require.True(t, p.queueEventPending)
	<-p.queueEventTimer.C
	p.emitQueueEvent()
	require.Len(t, emitted(p, ApiEventTypeQueue), 1)

	start := time.Now()
	for i := range 5 {
		p.addToQueue(&connectpb.ContextTrack{Uri: trackUri(0x20 + byte(i))})
		runQueuedJob(t, p)
	}
	require.Less(t, time.Since(start), 100*time.Millisecond)
	require.True(t, p.queueEventPending)
	require.Len(t, emitted(p, ApiEventTypeQueue), 1, "nothing yet")

	<-p.queueEventTimer.C
	require.GreaterOrEqual(t, time.Since(start), queueEventInterval)
	p.emitQueueEvent()
	require.Len(t, emitted(p, ApiEventTypeQueue), 2, "one for the five")

	select {
	case <-p.queueEventTimer.C:
		t.Fatal("armed once only")
	case <-time.After(2 * queueEventInterval):
	}
	require.Equal(t, ApiEventDataQueue{}, emitted(p, ApiEventTypeQueue)[1])
}

func TestForgetJam(t *testing.T) {
	p := newTestAppPlayer(t)
	require.NoError(t, p.handlePlayerCommand(setJamMode("on")))

	require.Equal(t, &ApiJamForget{Changed: true}, p.forgetJam())
	require.Equal(t, "off", p.state.player.Options.GetModes()["jam"])

	// Pushed like any change, once the coalescing of pushes lets it go.
	require.True(t, p.stateDirty)
	p.flushState()
	require.Equal(t, "off", lastPushedState(t, p).GetOptions().GetModes()["jam"])

	require.Equal(t, &ApiJamForget{Changed: false}, p.forgetJam(), "once only")

	// Nothing to forget on a device that was never in a Jam either.
	require.Equal(t, &ApiJamForget{Changed: false}, newTestAppPlayer(t).forgetJam())
}

func TestJamForgetRoute(t *testing.T) {
	p := newTestAppPlayer(t)
	require.NoError(t, p.handlePlayerCommand(setJamMode("on")))

	data, err := p.handleApiRequest(ApiRequest{Type: ApiRequestTypeJamForget})
	require.NoError(t, err)
	require.Equal(t, &ApiJamForget{Changed: true}, data)
}

// playingPlaylist is the gateway's ordinary playback: a playlist played from
// the API, so the device is active, the playlist is its context with its list
// resolved, the origin is not social-connect's and the jam mode is unset.
func playingPlaylist(t *testing.T) *AppPlayer {
	t.Helper()

	p := newShuffleTestPlayer(t)
	spotCtx, _ := shuffleTestContext(playlistUri, 0x01, 3)
	p.resolvePlayContext = func(context.Context, string) (*connectpb.Context, error) { return spotCtx, nil }
	req, _ := NewApiRequest(ApiRequestTypePlay, ApiPlay{Uri: playlistUri})
	_, err := p.handleApiRequest(req)
	require.ErrorIs(t, err, errReplyDeferred)
	runQueuedJob(t, p)   // the play's resolve: takes the device over, starts the context's load
	runQueuedJob(t, p)   // the context's load: the list
	p.loader.queue = nil // its first track need not load

	require.True(t, p.state.active)
	require.Equal(t, playlistUri, p.state.player.ContextUri)
	require.NotNil(t, p.state.tracks)
	require.Empty(t, jamEventsOf(p), "ordinary playback emits no jam event")
	return p
}

// quietPushes lets the next state change be pushed at once and alone: what
// is waiting to be pushed is dropped, and the coalescing of pushes starts
// afresh.
func quietPushes(p *AppPlayer) {
	drain(p.statePush)
	p.statePutScheduled = false
	p.lastStatePut = time.Time{}
}

// The device that starts a Jam switches itself into Jam mode: the mode goes on
// as a set_options would put it, the jam event says so, and the connect state
// is pushed with it. The context, the track, the playback and the origin stay
// as they are, and nothing loads.
func TestActivateJam(t *testing.T) {
	p := playingPlaylist(t)
	quietPushes(p)

	track := p.state.player.Track.GetUri()
	require.NotEmpty(t, track)
	paused, position := p.state.player.IsPaused, p.state.player.PositionAsOfTimestamp
	sessionId := p.state.player.SessionId
	origin := proto.Clone(p.state.player.PlayOrigin)

	data, err := p.activateJam()
	require.NoError(t, err)
	require.Equal(t, &ApiJamActivate{Changed: true}, data)
	require.Equal(t, "on", p.state.player.Options.GetModes()["jam"])

	require.Equal(t, []ApiEventDataJam{{Mode: "on", Origin: "", ContextUri: playlistUri}}, jamEventsOf(p))

	require.Equal(t, playlistUri, p.state.player.ContextUri)
	require.Equal(t, track, p.state.player.Track.GetUri())
	require.Equal(t, paused, p.state.player.IsPaused)
	require.Equal(t, position, p.state.player.PositionAsOfTimestamp)
	require.Equal(t, sessionId, p.state.player.SessionId)
	require.True(t, proto.Equal(origin, p.state.player.PlayOrigin), "the origin is still the API play's")
	require.Empty(t, p.loader.queue, "nothing reloads")

	pushes := drain(p.statePush)
	require.Len(t, pushes, 1, "pushed at once, once")
	require.Equal(t, connectpb.PutStateReason_PLAYER_STATE_CHANGED, pushes[0].reason)

	var req connectpb.PutStateRequest
	require.NoError(t, proto.Unmarshal(pushes[0].body, &req))
	require.True(t, req.IsActive)
	require.Equal(t, connectpb.PutStateReason_PLAYER_STATE_CHANGED, req.PutStateReason)
	require.Equal(t, "on", req.GetDevice().GetPlayerState().GetOptions().GetModes()["jam"])
	require.Equal(t, playlistUri, req.GetDevice().GetPlayerState().GetContextUri())
}

// It is what a set_options from social-connect does: the same options, the
// same jam event, and the same options in the connect state.
func TestActivateJamIsTheSetOptionsPath(t *testing.T) {
	received, activated := playingPlaylist(t), playingPlaylist(t)

	require.NoError(t, received.handlePlayerCommand(setJamMode("on")))
	_, err := activated.activateJam()
	require.NoError(t, err)

	require.True(t, proto.Equal(received.state.player.Options, activated.state.player.Options))

	fromCommand, fromActivate := jamEventsOf(received), jamEventsOf(activated)
	require.NotEmpty(t, fromCommand)
	require.NotEmpty(t, fromActivate)
	require.Equal(t, fromCommand[len(fromCommand)-1], fromActivate[len(fromActivate)-1])

	received.flushState()
	activated.flushState()
	require.True(t, proto.Equal(lastPushedState(t, received).GetOptions(), lastPushedState(t, activated).GetOptions()))
}

// Once only: a second call finds the mode on, and changes, emits and pushes
// nothing.
func TestActivateJamOnce(t *testing.T) {
	p := playingPlaylist(t)

	data, err := p.activateJam()
	require.NoError(t, err)
	require.Equal(t, &ApiJamActivate{Changed: true}, data)
	events := len(jamEventsOf(p))
	p.flushState()
	quietPushes(p)

	data, err = p.activateJam()
	require.NoError(t, err)
	require.Equal(t, &ApiJamActivate{Changed: false}, data)
	require.Len(t, jamEventsOf(p), events)
	require.Empty(t, drain(p.statePush))
	require.False(t, p.stateDirty, "nothing waits to be pushed either")
}

// Refused, with nothing changed, emitted or pushed, unless this device is the
// active one and plays a context of its own that is not a Jam's: a Jam's list,
// or playback social-connect handed over, is a Jam Spotify drives.
func TestActivateJamRefused(t *testing.T) {
	for _, tt := range []struct {
		name  string
		setup func(t *testing.T) *AppPlayer
		why   string
	}{
		{"inactive", newTestAppPlayer, "this device is not the active one"},
		{"inactive with a playlist", func(t *testing.T) *AppPlayer {
			p := playingPlaylist(t)
			p.state.setActive(false)
			return p
		}, "this device is not the active one"},
		{"nothing loaded", func(t *testing.T) *AppPlayer {
			p := newTestAppPlayer(t)
			p.state.setActive(true)
			return p
		}, "nothing is loaded"},
		{"a Jam's list", func(t *testing.T) *AppPlayer {
			p := newTestAppPlayer(t)
			inJam(t, p)
			return p
		}, "the playback is a Jam's already"},
		{"social-connect's playback", func(t *testing.T) *AppPlayer {
			// As a participant's transfer of the host's own context leaves it.
			p := playingPlaylist(t)
			p.state.player.PlayOrigin.DeviceIdentifier = socialDevice
			return p
		}, "the playback is a Jam's already"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			p := tt.setup(t)
			log := &recordingLogger{}
			p.app.log = log
			mode := p.state.player.Options.GetModes()["jam"]
			events := len(jamEventsOf(p))
			drain(p.statePush)

			data, err := p.activateJam()
			require.ErrorIs(t, err, ErrConflict)
			require.Nil(t, data)

			require.Equal(t, mode, p.state.player.Options.GetModes()["jam"], "the mode is unchanged")
			require.Len(t, jamEventsOf(p), events)
			require.Empty(t, drain(p.statePush))
			require.Equal(t, []string{"jam mode not switched on: " + tt.why}, log.info)
		})
	}
}

// The route answers the outcome, and a refusal as no data at all: a nil
// interface, not a typed nil.
func TestJamActivateRoute(t *testing.T) {
	data, err := playingPlaylist(t).handleApiRequest(ApiRequest{Type: ApiRequestTypeJamActivate})
	require.NoError(t, err)
	require.Equal(t, &ApiJamActivate{Changed: true}, data)

	data, err = newTestAppPlayer(t).handleApiRequest(ApiRequest{Type: ApiRequestTypeJamActivate})
	require.ErrorIs(t, err, ErrConflict)
	require.True(t, data == nil, "a nil interface")
}

// /jam/forget is the inverse: the mode goes off again, said and pushed, and
// the playlist plays on.
func TestForgetAfterActivate(t *testing.T) {
	p := playingPlaylist(t)
	_, err := p.activateJam()
	require.NoError(t, err)

	require.Equal(t, &ApiJamForget{Changed: true}, p.forgetJam())
	require.Equal(t, []ApiEventDataJam{
		{Mode: "on", Origin: "", ContextUri: playlistUri},
		{Mode: "off", Origin: "", ContextUri: playlistUri},
	}, jamEventsOf(p))

	p.flushState()
	require.Equal(t, "off", lastPushedState(t, p).GetOptions().GetModes()["jam"])
	require.Equal(t, playlistUri, p.state.player.ContextUri)
}

// What it logs is fixed text: no device, context or session.
func TestActivateJamLogs(t *testing.T) {
	p := playingPlaylist(t)
	p.app.deviceId = thisDevice
	log := &recordingLogger{}
	p.app.log = log

	for range 2 {
		_, err := p.activateJam()
		require.NoError(t, err)
	}
	require.Equal(t, []string{"jam mode switched on for a Jam this device started"}, log.info, "once, on the change")

	p.state.player.PlayOrigin.DeviceIdentifier = socialDevice
	_, err := p.activateJam()
	require.ErrorIs(t, err, ErrConflict)
	p.state.setActive(false)
	_, err = p.activateJam()
	require.ErrorIs(t, err, ErrConflict)
	require.Len(t, log.info, 3)

	sessionId := p.state.player.SessionId
	require.NotEmpty(t, sessionId)
	for _, line := range log.lines() {
		for _, id := range []string{playlistUri, thisDevice, sessionId, socialDevice} {
			require.NotContains(t, line, id)
		}
	}
}

func TestJamStatus(t *testing.T) {
	p := newTestAppPlayer(t)
	p.app.socialGate = spclient.NewSocialGate()

	var resp ApiStatus
	p.jamStatus(&resp)
	require.Empty(t, resp.JamMode)
	require.Equal(t, []string{"current", "start", "info", "join", "leave", "end", "remove", "forget", "broadcast", "activate"}, resp.JamRoutes)
	require.Equal(t, ApiSocialStats{}, resp.Social)
	require.True(t, resp.QueueEdit)

	require.NoError(t, p.handlePlayerCommand(setJamMode("on")))
	p.jamStatus(&resp)
	require.Equal(t, "on", resp.JamMode)
}

// The queue is the state's, entry by entry: uid, provider and metadata as the
// transfer gave them, and a track only for what the cache holds. Asking for it
// schedules no fetch.
func TestPlayerQueue(t *testing.T) {
	p := newMetaTestPlayer(t, echoMetadata, nil)

	cached := librespot.NewMediaFromTrack(metaTrack(gid(0x02), "Added By Jake"))
	p.app.metaCache.put(trackUri(0x02), cached)

	p.state.player.ContextUri = jamListUri
	p.state.player.ContextMetadata = map[string]string{"context_description": "Jake's Jam"}
	p.state.player.Track = &connectpb.ProvidedTrack{Uri: trackUri(0x01), Uid: "u0", Provider: "context"}
	p.state.player.NextTracks = []*connectpb.ProvidedTrack{
		{Uri: trackUri(0x02), Uid: "q3", Provider: "queue", Metadata: map[string]string{"is_queued": "true", "added_by": "spotify:user:jake"}},
		{Uri: trackUri(0x03), Uid: "u1", Provider: "context", Metadata: map[string]string{}},
		{Uri: trackUri(0x04), Uid: "", Provider: "autoplay", Metadata: map[string]string{"autoplay.is_autoplay": "true"}},
	}

	data, err := p.handleApiRequest(ApiRequest{Type: ApiRequestTypePlayerQueue})
	require.NoError(t, err)
	queue := data.(*ApiPlayerQueue)

	require.Equal(t, jamListUri, queue.ContextUri)
	require.Equal(t, "Jake's Jam", queue.ContextName)
	require.NotNil(t, queue.Current)
	require.Equal(t, ApiQueueEntry{Uri: trackUri(0x01), Uid: "u0", Provider: "context"}, *queue.Current)

	require.Len(t, queue.Next, 3)
	require.Equal(t, "q3", queue.Next[0].Uid)
	require.Equal(t, "queue", queue.Next[0].Provider)
	require.Equal(t, map[string]string{"is_queued": "true", "added_by": "spotify:user:jake"}, queue.Next[0].Metadata)
	require.NotNil(t, queue.Next[0].Track, "cached")
	require.Equal(t, "Added By Jake", queue.Next[0].Track.Name)

	require.Nil(t, queue.Next[1].Metadata, "an empty map is left out")
	require.Nil(t, queue.Next[1].Track, "not cached")
	require.Equal(t, "autoplay", queue.Next[2].Provider)

	// A copy: the answer is encoded off the player loop.
	queue.Next[0].Metadata["added_by"] = "changed"
	require.Equal(t, "spotify:user:jake", p.state.player.NextTracks[0].Metadata["added_by"])

	require.False(t, p.metaPrefetchTimer.Stop(), "no metadata fetch was scheduled")

	raw, err := json.Marshal(queue.Next[1])
	require.NoError(t, err)
	require.JSONEq(t, `{"uri":"`+trackUri(0x03)+`","uid":"u1","provider":"context"}`, string(raw))

	// The revision of these rows, by uid, or by uri for the one without.
	require.Equal(t, fnvHex("u0\nq3\nu1\n"+trackUri(0x04)), queue.Rev)
	require.Equal(t, p.queueRev(), queue.Rev)
}

func TestPlayerQueueWithNothingLoaded(t *testing.T) {
	p := newTestAppPlayer(t)

	raw, err := json.Marshal(p.playerQueue())
	require.NoError(t, err)
	require.JSONEq(t, `{"next":[],"rev":"cbf29ce484222325"}`, string(raw), "the revision of nothing: FNV-1a's offset basis")
}

// recordingLogger keeps every line logged at info and debug.
type recordingLogger struct {
	librespot.NullLogger

	mu    sync.Mutex
	info  []string
	debug []string
}

func (l *recordingLogger) Infof(format string, args ...interface{}) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.info = append(l.info, fmt.Sprintf(format, args...))
}

func (l *recordingLogger) Debugf(format string, args ...interface{}) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.debug = append(l.debug, fmt.Sprintf(format, args...))
}

func (l *recordingLogger) Info(args ...interface{}) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.info = append(l.info, fmt.Sprint(args...))
}

func (l *recordingLogger) WithField(string, interface{}) librespot.Logger { return l }
func (l *recordingLogger) WithError(error) librespot.Logger               { return l }

func (l *recordingLogger) lines() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append(append([]string(nil), l.info...), l.debug...)
}

const socialPushUri = "hm://social-connect/v2/session_update/35lwkDPCBS93o5gUm1sCsy"

// A push is passed on as it came, its payload as JSON when it is JSON, and its
// uri logged masked: at info the first few times, at debug after that.
func TestSocialConnectPushes(t *testing.T) {
	p := newTestAppPlayer(t)
	log := &recordingLogger{}
	p.app.log = log

	p.handleSocialMessage(dealer.Message{Uri: socialPushUri, Payload: []byte(`{"session":{"session_id":"35lwkDPCBS93o5gUm1sCsy"}}`)})
	p.handleSocialMessage(dealer.Message{Uri: socialPushUri, Payload: []byte{0x0a, 0x03, 0x01, 0x02, 0x03}})
	p.handleSocialMessage(dealer.Message{Uri: socialPushUri, Payload: []byte(`"` + strings.Repeat("a", socialEventMaxPayload) + `"`)})
	p.handleSocialMessage(dealer.Message{Uri: socialPushUri})

	events := emitted(p, ApiEventTypeSocialConnect)
	require.Len(t, events, 4)

	raw, err := json.Marshal(events[0])
	require.NoError(t, err)
	require.JSONEq(t, `{"uri":"`+socialPushUri+`","payload":{"session":{"session_id":"35lwkDPCBS93o5gUm1sCsy"}}}`, string(raw))

	for i, size := range []int{5, socialEventMaxPayload + 2, 0} {
		raw, err := json.Marshal(events[i+1])
		require.NoError(t, err)
		require.JSONEq(t, fmt.Sprintf(`{"uri":%q,"payload_bytes":%d}`, socialPushUri, size), string(raw))
	}

	require.Len(t, log.info, socialLogFirst)
	require.Len(t, log.debug, 1)
	for _, line := range log.lines() {
		require.Contains(t, line, "hm://social-connect/v2/session_update/*")
		require.NotContains(t, line, "35lwkDPCBS93o5gUm1sCsy")
	}
}

// A session_update push in the shape social-connect sent it in the 2026
// capture (synthetic values) goes on to the gateway intact, byte for byte, the
// order of its keys and its numbers included: the gateway reads it.
func TestSocialConnectSessionUpdateReachesTheGatewayIntact(t *testing.T) {
	const uri = "social-connect/v2/session_update"
	payload := `{"session":{"timestamp":"1790000000000","session_id":"0123456789abcdef0123456789abcdef",` +
		`"join_session_token":"AbCdEfGhIjKlMnOpQrStUv","join_session_url":"spotify.link/AbCdEfGhIjK",` +
		`"session_owner_id":"0123456789abcdef0123456789abcdef","session_members":[{"joined_timestamp":"1790000000000",` +
		`"id":"0123456789abcdef0123456789abcdef","username":"abcdefghijklmnopqrstuvwxy","display_name":"Alex \u00e9 <&>",` +
		`"image_url":"https://i.scdn.co/image/0123456789abcdef0123456789abcdef01234567",` +
		`"large_image_url":"https://i.scdn.co/image/76543210fedcba9876543210fedcba9876543210",` +
		`"is_listening":true,"is_controlling":true,"playbackControl":"LISTEN_AND_CONTROL","is_current_user":true}],` +
		`"join_session_uri":"spotify:socialsession:AbCdEfGhIjKlMnOpQrStUv","is_session_owner":true,` +
		`"maxMemberCount":32,"big":9007199254740993,"active":true,"queue_only_mode":false,` +
		`"host_device_info":{"device_id":"0123456789abcdef0123456789abcdef01234567","device_name":"Encore",` +
		`"device_type":"SMARTPHONE","is_group":false},"user_capabilities":{"invite":true,"remove_participants":true,` +
		`"manage_participant_settings":true},"session_config":{},"requires_jam_lens":true},` +
		`"reason":"USER_JOINED","update_session_members":[]}`

	// As the dealer delivers it (dealer: TestHandleMessageDeliversJsonPayloads).
	msg := dealer.Message{Uri: uri, Headers: map[string]string{"Content-Type": "application/json"}, Payload: []byte(payload)}

	p := newTestAppPlayer(t)
	p.handleSocialMessage(msg)

	events := emitted(p, ApiEventTypeSocialConnect)
	require.Len(t, events, 1)
	data := events[0].(ApiEventDataSocialConnect)
	require.Equal(t, uri, data.Uri)
	require.Equal(t, payload, string(data.Payload), "byte for byte")

	// Encoded for the websocket, the payload is the same JSON.
	raw, err := json.Marshal(&ApiEvent{Type: ApiEventTypeSocialConnect, Data: data})
	require.NoError(t, err)
	var got struct {
		Data struct {
			Uri     string          `json:"uri"`
			Payload json.RawMessage `json:"payload"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(raw, &got))
	require.Equal(t, uri, got.Data.Uri)
	require.JSONEq(t, payload, string(got.Data.Payload))
	require.Contains(t, string(got.Data.Payload), `"big":9007199254740993`, "an integer past 2^53 is exact")
}

// fakeSocial stands in for social-connect behind the Jam routes: it records the
// calls and answers each with the next of its answers.
type fakeSocial struct {
	mu      sync.Mutex
	calls   []string
	answers []fakeAnswer
}

type fakeAnswer struct {
	session   json.RawMessage
	broadcast *spclient.BroadcastStatus
	err       error
}

func (f *fakeSocial) answer(call string) (json.RawMessage, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	f.calls = append(f.calls, call)
	if len(f.answers) == 0 {
		return nil, nil
	}
	a := f.answers[0]
	f.answers = f.answers[1:]
	return a.session, a.err
}

func (f *fakeSocial) SocialCurrent(context.Context) (json.RawMessage, error) {
	return f.answer("current")
}

func (f *fakeSocial) SocialCurrentOrNew(context.Context) (json.RawMessage, error) {
	return f.answer("current_or_new")
}

func (f *fakeSocial) SocialInfo(_ context.Context, token string) (json.RawMessage, error) {
	return f.answer("info " + token)
}

func (f *fakeSocial) SocialJoin(_ context.Context, token, dev string) (json.RawMessage, error) {
	return f.answer("join " + token + " " + dev)
}

func (f *fakeSocial) SocialLeave(_ context.Context, sid string) (json.RawMessage, error) {
	return f.answer("leave " + sid)
}

func (f *fakeSocial) SocialEnd(_ context.Context, sid string) (json.RawMessage, error) {
	return f.answer("end " + sid)
}

func (f *fakeSocial) SocialKick(_ context.Context, sid, member string) (json.RawMessage, error) {
	return f.answer("kick " + sid + " " + member)
}

// broadcastAnswer is answer for the broadcast calls: it records the call and
// answers with the next answer's broadcast.
func (f *fakeSocial) broadcastAnswer(call string) (*spclient.BroadcastStatus, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	f.calls = append(f.calls, call)
	if len(f.answers) == 0 {
		return nil, nil
	}
	a := f.answers[0]
	f.answers = f.answers[1:]
	return a.broadcast, a.err
}

func (f *fakeSocial) SocialSetBroadcastStatus(_ context.Context, dev, status string) (*spclient.BroadcastStatus, error) {
	return f.broadcastAnswer("broadcast " + dev + " " + status)
}

func (f *fakeSocial) SocialJamStatus(_ context.Context, dev string) (*spclient.BroadcastStatus, error) {
	return f.broadcastAnswer("jam_status " + dev)
}

// jamCall runs a Jam route on the test player and waits for its answer.
func jamCall(t *testing.T, p *AppPlayer, typ ApiRequestType, data ApiRequestDataJam) (any, error) {
	t.Helper()

	req, wait := NewApiRequest(typ, data)
	_, err := p.handleApiRequest(req)
	require.ErrorIs(t, err, errReplyDeferred, "answered off the player loop")

	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	return wait(ctx)
}

func newJamTestPlayer(t *testing.T, social socialConnect) *AppPlayer {
	t.Helper()

	p := newTestAppPlayer(t)
	p.ctx = t.Context()
	p.app.deviceId = "0123456789abcdef0123456789abcdef01234567"
	p.social = social
	return p
}

// Each route makes its own call, with the Jam or the member it names. Only
// join names this device: it says which device is to play the Jam.
func TestJamRoutesCallSocialConnect(t *testing.T) {
	social := &fakeSocial{}
	p := newJamTestPlayer(t, social)
	dev := p.app.deviceId

	for _, tt := range []struct {
		typ  ApiRequestType
		data ApiRequestDataJam
		call string
	}{
		{ApiRequestTypeJamCurrent, ApiRequestDataJam{}, "current"},
		{ApiRequestTypeJamStart, ApiRequestDataJam{}, "current_or_new"},
		{ApiRequestTypeJamInfo, ApiRequestDataJam{Token: "tok"}, "info tok"},
		{ApiRequestTypeJamJoin, ApiRequestDataJam{Token: "tok"}, "join tok " + dev},
		{ApiRequestTypeJamLeave, ApiRequestDataJam{SessionId: "sid"}, "leave sid"},
		{ApiRequestTypeJamEnd, ApiRequestDataJam{SessionId: "sid"}, "end sid"},
		{ApiRequestTypeJamRemove, ApiRequestDataJam{SessionId: "sid", MemberId: "mid"}, "kick sid mid"},
	} {
		data, err := jamCall(t, p, tt.typ, tt.data)
		require.NoError(t, err)
		require.Equal(t, &ApiJamSession{}, data)
		require.Equal(t, tt.call, social.calls[len(social.calls)-1])
	}
}

// The session goes back exactly as social-connect sent it; no session is {}.
func TestJamRouteBodies(t *testing.T) {
	session := json.RawMessage(`{"session_id":"sid","join_session_token":"tok","session_members":[{"username":"jake","display_name":"Jake"}]}`)
	social := &fakeSocial{answers: []fakeAnswer{{session: session}, {}, {session: session}}}
	p := newJamTestPlayer(t, social)

	data, err := jamCall(t, p, ApiRequestTypeJamStart, ApiRequestDataJam{})
	require.NoError(t, err)
	raw, err := json.Marshal(data)
	require.NoError(t, err)
	require.Equal(t, `{"session":`+string(session)+`}`, string(raw))

	data, err = jamCall(t, p, ApiRequestTypeJamCurrent, ApiRequestDataJam{})
	require.NoError(t, err)
	raw, err = json.Marshal(data)
	require.NoError(t, err)
	require.Equal(t, `{}`, string(raw))

	// Leave and end answer {} whatever social-connect sent.
	data, err = jamCall(t, p, ApiRequestTypeJamLeave, ApiRequestDataJam{SessionId: "sid"})
	require.NoError(t, err)
	require.Equal(t, &ApiJamSession{}, data)
}

// The kick answers the session without the member, which goes back as it came;
// an empty answer is {}.
func TestJamRemove(t *testing.T) {
	session := json.RawMessage(`{"session_id":"sid","session_owner_id":"0123456789abcdef0123456789abcdef","session_members":[{"id":"0123456789abcdef0123456789abcdef","username":"alex","is_current_user":true}]}`)
	social := &fakeSocial{answers: []fakeAnswer{{session: session}, {}}}
	p := newJamTestPlayer(t, social)

	data, err := jamCall(t, p, ApiRequestTypeJamRemove, ApiRequestDataJam{SessionId: "sid", MemberId: "fedcba9876543210fedcba9876543210"})
	require.NoError(t, err)
	raw, err := json.Marshal(data)
	require.NoError(t, err)
	require.Equal(t, `{"session":`+string(session)+`}`, string(raw), "byte for byte")
	require.Equal(t, []string{"kick sid fedcba9876543210fedcba9876543210"}, social.calls)

	data, err = jamCall(t, p, ApiRequestTypeJamRemove, ApiRequestDataJam{SessionId: "sid", MemberId: "fedcba9876543210fedcba9876543210"})
	require.NoError(t, err)
	raw, err = json.Marshal(data)
	require.NoError(t, err)
	require.Equal(t, `{}`, string(raw))
	require.Len(t, social.calls, 2, "each one call, never resent")
}

// requireApiError asserts the error a route answers: its status, how long to
// wait, and Spotify's own status.
func requireApiError(t *testing.T, err error, kind error, wait time.Duration, upstream int) {
	t.Helper()

	require.ErrorIs(t, err, kind)
	var detail apiErrorDetail
	require.ErrorAs(t, err, &detail)
	require.Equal(t, wait, detail.retryAfter())
	require.Equal(t, upstream, detail.upstreamStatus())
}

func TestJamRouteErrors(t *testing.T) {
	for _, tt := range []struct {
		name     string
		typ      ApiRequestType
		err      error
		kind     error
		wait     time.Duration
		upstream int
	}{
		{"refused token", ApiRequestTypeJamJoin, &spclient.StatusError{StatusCode: 401}, ErrForbidden, 0, 401},
		{"forbidden", ApiRequestTypeJamStart, &spclient.StatusError{StatusCode: 403}, ErrForbidden, 0, 403},
		{"not found", ApiRequestTypeJamInfo, &spclient.StatusError{StatusCode: 404}, ErrNotFound, 0, 404},
		{"gone", ApiRequestTypeJamLeave, &spclient.StatusError{StatusCode: 410}, ErrNotFound, 0, 410},
		{"conflict", ApiRequestTypeJamEnd, &spclient.StatusError{StatusCode: 409}, ErrConflict, 0, 409},
		{"member gone", ApiRequestTypeJamRemove, &spclient.StatusError{StatusCode: 404}, ErrNotFound, 0, 404},
		{"remove refused", ApiRequestTypeJamRemove, &spclient.StatusError{StatusCode: 403}, ErrForbidden, 0, 403},
		{"bad member", ApiRequestTypeJamRemove, spclient.ErrSocialArgument, ErrBadRequest, 0, 0},
		{"rate limited", ApiRequestTypeJamCurrent, &spclient.StatusError{StatusCode: 429, RetryAfter: 5 * time.Second}, ErrTooManyRequests, spclient.SocialMinHold, 429},
		{"rate limited long", ApiRequestTypeJamCurrent, &spclient.StatusError{StatusCode: 429, RetryAfter: 120 * time.Second}, ErrTooManyRequests, 120 * time.Second, 429},
		{"server error", ApiRequestTypeJamCurrent, &spclient.StatusError{StatusCode: 503}, ErrUpstream, 0, 503},
		{"other status", ApiRequestTypeJamStart, &spclient.StatusError{StatusCode: 400}, ErrUpstream, 0, 400},
		{"unusable body", ApiRequestTypeJamCurrent, &spclient.SocialResponseError{Op: "current", StatusCode: 200, Reason: "not a JSON object"}, ErrUpstream, 0, 200},
		{"gate", ApiRequestTypeJamJoin, &spclient.SocialGateError{RetryAfter: 5 * time.Second, Reason: "busy"}, ErrTooManyRequests, 5 * time.Second, 0},
		{"no answer", ApiRequestTypeJamEnd, &spclient.SocialNetworkError{Op: "end", Err: context.DeadlineExceeded}, ErrUpstream, 0, 0},
		{"bad id", ApiRequestTypeJamLeave, spclient.ErrSocialArgument, ErrBadRequest, 0, 0},
	} {
		t.Run(tt.name, func(t *testing.T) {
			p := newJamTestPlayer(t, &fakeSocial{answers: []fakeAnswer{{err: tt.err}}})

			_, err := jamCall(t, p, tt.typ, ApiRequestDataJam{Token: "tok", SessionId: "sid", MemberId: "mid"})
			requireApiError(t, err, tt.kind, tt.wait, tt.upstream)
		})
	}
}

// For /jam/current, social-connect's 404 or 410 is an answer: it says
// something other than "no Jam", which is a 204 or an empty body.
func TestJamCurrentNotFound(t *testing.T) {
	for _, status := range []int{http.StatusNotFound, http.StatusGone} {
		p := newJamTestPlayer(t, &fakeSocial{answers: []fakeAnswer{{err: &spclient.StatusError{StatusCode: status}}}})

		data, err := jamCall(t, p, ApiRequestTypeJamCurrent, ApiRequestDataJam{})
		require.NoError(t, err)
		raw, err := json.Marshal(data)
		require.NoError(t, err)
		require.JSONEq(t, `{"not_found":true}`, string(raw))
	}
}

// For /jam/current, social-connect's 200 with an empty object is no Jam too:
// {}, as for a 204, never {"session":{}}. The other routes pass it on.
func TestJamCurrentEmptyObject(t *testing.T) {
	for _, body := range []string{`{}`, "{ \n\t}"} {
		p := newJamTestPlayer(t, &fakeSocial{answers: []fakeAnswer{{session: json.RawMessage(body)}}})

		data, err := jamCall(t, p, ApiRequestTypeJamCurrent, ApiRequestDataJam{})
		require.NoError(t, err)
		raw, err := json.Marshal(data)
		require.NoError(t, err)
		require.Equal(t, `{}`, string(raw), "body %q", body)
	}

	p := newJamTestPlayer(t, &fakeSocial{answers: []fakeAnswer{{session: json.RawMessage(`{"session_id":"sid"}`)}, {session: json.RawMessage(`{}`)}}})
	data, err := jamCall(t, p, ApiRequestTypeJamCurrent, ApiRequestDataJam{})
	require.NoError(t, err)
	require.Equal(t, &ApiJamSession{Session: json.RawMessage(`{"session_id":"sid"}`)}, data)
	data, err = jamCall(t, p, ApiRequestTypeJamJoin, ApiRequestDataJam{Token: "tok"})
	require.NoError(t, err)
	require.Equal(t, &ApiJamSession{Session: json.RawMessage(`{}`)}, data)

	// The whole way: the real spclient trims the body before it gets here.
	transport := &socialTransport{answer: func(int) (int, string) { return http.StatusOK, " {\r\n} \n" }}
	sp, err := spclient.NewSpclient(t.Context(), &librespot.NullLogger{}, &http.Client{Transport: transport},
		func(context.Context) string { return "spclient.test" },
		func(context.Context, bool) (string, error) { return "token", nil },
		"0123456789abcdef0123456789abcdef01234567", "")
	require.NoError(t, err)
	p = newJamTestPlayer(t, sp)
	p.app.socialGate = spclient.NewSocialGate()
	sp.SetSocialGate(p.app.socialGate)

	data, err = jamCall(t, p, ApiRequestTypeJamCurrent, ApiRequestDataJam{})
	require.NoError(t, err)
	require.Equal(t, &ApiJamSession{}, data)
	require.Equal(t, 1, transport.count())
}

// socialTransport stands in for Spotify under a real spclient: every send is
// counted, its body and time kept, and answered by answer.
type socialTransport struct {
	mu     sync.Mutex
	sends  []string
	bodies [][]byte
	times  []time.Time
	answer func(n int) (int, string)
}

func (f *socialTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	var body []byte
	if req.Body != nil && req.Body != http.NoBody {
		var err error
		if body, err = io.ReadAll(req.Body); err != nil {
			return nil, err
		}
		_ = req.Body.Close()
	}

	f.mu.Lock()
	n := len(f.sends)
	f.sends = append(f.sends, req.Method+" "+req.URL.Path)
	f.bodies = append(f.bodies, body)
	f.times = append(f.times, time.Now())
	f.mu.Unlock()

	status, reply := f.answer(n)
	return &http.Response{
		StatusCode: status,
		Header:     http.Header{},
		Body:       io.NopCloser(strings.NewReader(reply)),
		Request:    req,
	}, nil
}

func (f *socialTransport) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.sends)
}

// The whole way, through the real spclient and the daemon's gate: a refused
// token is sent twice and answered 403 with Spotify's 401, and a 429 holds the
// next call at the gate, unsent.
func TestJamRoutesThroughTheGate(t *testing.T) {
	transport := &socialTransport{}
	sp, err := spclient.NewSpclient(t.Context(), &librespot.NullLogger{}, &http.Client{Transport: transport},
		func(context.Context) string { return "spclient.test" },
		func(context.Context, bool) (string, error) { return "token", nil },
		"0123456789abcdef0123456789abcdef01234567", "")
	require.NoError(t, err)

	p := newJamTestPlayer(t, sp)
	p.app.socialGate = spclient.NewSocialGate()
	sp.SetSocialGate(p.app.socialGate)

	transport.answer = func(int) (int, string) { return http.StatusNoContent, "" }
	data, err := jamCall(t, p, ApiRequestTypeJamCurrent, ApiRequestDataJam{})
	require.NoError(t, err)
	require.Equal(t, &ApiJamSession{}, data)

	transport.answer = func(int) (int, string) { return http.StatusNotFound, "" }
	data, err = jamCall(t, p, ApiRequestTypeJamCurrent, ApiRequestDataJam{})
	require.NoError(t, err)
	require.Equal(t, &ApiJamSession{NotFound: true}, data)

	transport.answer = func(int) (int, string) { return http.StatusUnauthorized, "" }
	_, err = jamCall(t, p, ApiRequestTypeJamCurrent, ApiRequestDataJam{})
	requireApiError(t, err, ErrForbidden, 0, http.StatusUnauthorized)
	require.Equal(t, 4, transport.count(), "a refused token is sent twice, no more")

	transport.answer = func(int) (int, string) { return http.StatusTooManyRequests, "" }
	_, err = jamCall(t, p, ApiRequestTypeJamStart, ApiRequestDataJam{})
	requireApiError(t, err, ErrTooManyRequests, spclient.SocialMinHold, http.StatusTooManyRequests)

	_, err = jamCall(t, p, ApiRequestTypeJamEnd, ApiRequestDataJam{SessionId: "sid"})
	var gateErr *spclient.SocialGateError
	require.True(t, errors.As(err, &gateErr), "held at the gate")
	require.ErrorIs(t, err, ErrTooManyRequests)
	require.Equal(t, 5, transport.count(), "and not sent")

	var status ApiStatus
	p.jamStatus(&status)
	require.EqualValues(t, 5, status.Social.Sends)
	require.Equal(t, 5, status.Social.Sends5m)
	require.EqualValues(t, 1, status.Social.Renewals)
	require.Greater(t, status.Social.HeldUntil, time.Now().UnixMilli())
}

// The broadcast routes call social-connect for this device, always: the set
// with the status asked for, the read with nothing else. The answer is the
// status and whether it named this device.
func TestJamBroadcastRoutes(t *testing.T) {
	social := &fakeSocial{answers: []fakeAnswer{
		{broadcast: &spclient.BroadcastStatus{Status: spclient.BroadcastOn, Self: true}},
		{broadcast: &spclient.BroadcastStatus{Status: spclient.BroadcastOff, Self: true}},
		{broadcast: &spclient.BroadcastStatus{Status: "BROADCAST_UNAVAILABLE"}},
		{broadcast: &spclient.BroadcastStatus{}},
		{},
	}}
	p := newJamTestPlayer(t, social)
	dev := p.app.deviceId

	for _, tt := range []struct {
		typ  ApiRequestType
		data ApiRequestDataJam
		call string
		want *ApiJamBroadcast
	}{
		{ApiRequestTypeJamBroadcastSet, ApiRequestDataJam{Broadcast: spclient.BroadcastOn}, "broadcast " + dev + " BROADCAST_ON",
			&ApiJamBroadcast{BroadcastStatus: spclient.BroadcastOn, Self: true}},
		// A token or session id in the data names nothing: the device is
		// this one.
		{ApiRequestTypeJamBroadcastSet, ApiRequestDataJam{Broadcast: spclient.BroadcastOff, Token: "tok", SessionId: "sid"}, "broadcast " + dev + " BROADCAST_OFF",
			&ApiJamBroadcast{BroadcastStatus: spclient.BroadcastOff, Self: true}},
		{ApiRequestTypeJamBroadcastGet, ApiRequestDataJam{}, "jam_status " + dev, &ApiJamBroadcast{BroadcastStatus: "BROADCAST_UNAVAILABLE"}},
		{ApiRequestTypeJamBroadcastGet, ApiRequestDataJam{}, "jam_status " + dev, &ApiJamBroadcast{}},
		{ApiRequestTypeJamBroadcastGet, ApiRequestDataJam{}, "jam_status " + dev, &ApiJamBroadcast{}},
	} {
		data, err := jamCall(t, p, tt.typ, tt.data)
		require.NoError(t, err)
		require.Equal(t, tt.want, data)
		require.Equal(t, tt.call, social.calls[len(social.calls)-1])
	}
	require.Len(t, social.calls, 5, "each one call")

	raw, err := json.Marshal(&ApiJamBroadcast{BroadcastStatus: spclient.BroadcastOn, Self: true})
	require.NoError(t, err)
	require.Equal(t, `{"broadcast_status":"BROADCAST_ON","self":true}`, string(raw))
	raw, err = json.Marshal(&ApiJamBroadcast{})
	require.NoError(t, err)
	require.Equal(t, `{"broadcast_status":"","self":false}`, string(raw))
}

// The broadcast routes fail as the other Jam routes do.
func TestJamBroadcastErrors(t *testing.T) {
	for _, tt := range []struct {
		name     string
		typ      ApiRequestType
		err      error
		kind     error
		wait     time.Duration
		upstream int
	}{
		{"refused token", ApiRequestTypeJamBroadcastSet, &spclient.StatusError{StatusCode: 401}, ErrForbidden, 0, 401},
		{"forbidden", ApiRequestTypeJamBroadcastGet, &spclient.StatusError{StatusCode: 403}, ErrForbidden, 0, 403},
		{"not found", ApiRequestTypeJamBroadcastGet, &spclient.StatusError{StatusCode: 404}, ErrNotFound, 0, 404},
		{"conflict", ApiRequestTypeJamBroadcastSet, &spclient.StatusError{StatusCode: 409}, ErrConflict, 0, 409},
		{"rate limited", ApiRequestTypeJamBroadcastSet, &spclient.StatusError{StatusCode: 429, RetryAfter: 5 * time.Second}, ErrTooManyRequests, spclient.SocialMinHold, 429},
		{"gate", ApiRequestTypeJamBroadcastSet, &spclient.SocialGateError{RetryAfter: 5 * time.Second, Reason: "busy"}, ErrTooManyRequests, 5 * time.Second, 0},
		{"bad device id", ApiRequestTypeJamBroadcastGet, spclient.ErrSocialArgument, ErrBadRequest, 0, 0},
		{"bad status", ApiRequestTypeJamBroadcastSet, spclient.ErrSocialArgument, ErrBadRequest, 0, 0},
		{"server error", ApiRequestTypeJamBroadcastGet, &spclient.StatusError{StatusCode: 503}, ErrUpstream, 0, 503},
		{"other status", ApiRequestTypeJamBroadcastSet, &spclient.StatusError{StatusCode: 400}, ErrUpstream, 0, 400},
		{"unusable body", ApiRequestTypeJamBroadcastSet, &spclient.SocialResponseError{Op: "set_broadcast_status", StatusCode: 200, Reason: "not a JSON object"}, ErrUpstream, 0, 200},
		{"no answer", ApiRequestTypeJamBroadcastSet, &spclient.SocialNetworkError{Op: "set_broadcast_status", Err: context.DeadlineExceeded}, ErrUpstream, 0, 0},
	} {
		t.Run(tt.name, func(t *testing.T) {
			p := newJamTestPlayer(t, &fakeSocial{answers: []fakeAnswer{{err: tt.err}}})

			_, err := jamCall(t, p, tt.typ, ApiRequestDataJam{Broadcast: spclient.BroadcastOn})
			requireApiError(t, err, tt.kind, tt.wait, tt.upstream)
		})
	}
}

// Start's pair the whole way, through the real spclient and the daemon's gate:
// the broadcast's body goes out, current_or_new at least a second later, two
// sends in all, and the answer keeps none of the tokens.
func TestJamBroadcastThroughTheGate(t *testing.T) {
	const dev = "0123456789abcdef0123456789abcdef01234567"
	const radarToken, linkToken = "Rad4rT0kenAbCdEfGhIj", "L1nkT0kenAbCdEfGhIjKlM"

	transport := &socialTransport{answer: func(n int) (int, string) {
		if n == 0 {
			return http.StatusOK, `{"device_broadcast_status":{"timestamp":"1790000000000","broadcast_status":"BROADCAST_ON",` +
				`"device_id":"` + dev + `","social_radar_token":{"token":"` + radarToken + `"},` +
				`"link_token":{"token":"` + linkToken + `"},"device_type":"SMARTPHONE","device_name":"Encore"}}`
		}
		return http.StatusOK, `{"session_id":"sid"}`
	}}
	sp, err := spclient.NewSpclient(t.Context(), &librespot.NullLogger{}, &http.Client{Transport: transport},
		func(context.Context) string { return "spclient.test" },
		func(context.Context, bool) (string, error) { return "token", nil },
		dev, "")
	require.NoError(t, err)

	p := newJamTestPlayer(t, sp)
	require.Equal(t, dev, p.app.deviceId)
	p.app.socialGate = spclient.NewSocialGate()
	sp.SetSocialGate(p.app.socialGate)

	start := time.Now()
	data, err := jamCall(t, p, ApiRequestTypeJamBroadcastSet, ApiRequestDataJam{Broadcast: spclient.BroadcastOn})
	require.NoError(t, err)
	require.Equal(t, &ApiJamBroadcast{BroadcastStatus: spclient.BroadcastOn, Self: true}, data)
	raw, err := json.Marshal(data)
	require.NoError(t, err)
	require.NotContains(t, string(raw), radarToken)
	require.NotContains(t, string(raw), linkToken)

	data, err = jamCall(t, p, ApiRequestTypeJamStart, ApiRequestDataJam{})
	require.NoError(t, err)
	require.Equal(t, &ApiJamSession{Session: json.RawMessage(`{"session_id":"sid"}`)}, data)

	transport.mu.Lock()
	sends, bodies, times := transport.sends, transport.bodies, transport.times
	transport.mu.Unlock()

	require.Equal(t, []string{"POST /social-connect/v2/devices/set_broadcast_status", "GET /social-connect/v2/sessions/current_or_new"}, sends)
	require.Empty(t, bodies[1])
	require.GreaterOrEqual(t, times[1].Sub(start), time.Second, "spaced by the gate")

	var sent struct {
		Status struct {
			Timestamp       string `json:"timestamp"`
			BroadcastStatus string `json:"broadcast_status"`
			DeviceId        string `json:"device_id"`
		} `json:"device_broadcast_status"`
	}
	require.NoError(t, json.Unmarshal(bodies[0], &sent))
	require.Equal(t, spclient.BroadcastOn, sent.Status.BroadcastStatus)
	require.Equal(t, dev, sent.Status.DeviceId)
	require.Regexp(t, `^\d{13}$`, sent.Status.Timestamp)

	var status ApiStatus
	p.jamStatus(&status)
	require.EqualValues(t, 2, status.Social.Sends)
}

// A transfer the engine cannot apply is reported too, with why: one it cannot
// read, and one with neither a context nor a track to play. A hand-over lost
// that way showed nowhere but the engine's log.
func TestCommandEventForAFailedTransfer(t *testing.T) {
	no := false

	p := newTestAppPlayer(t)
	var garbage dealer.RequestPayload
	garbage.Command.Endpoint = "transfer"
	garbage.Command.Data = []byte{0x0a, 0x05, 0x01} // a field of 5 bytes, 1 of them sent
	garbage.SentByDeviceId = socialDevice
	require.Error(t, p.handlePlayerCommand(garbage))

	require.Equal(t, []ApiEventDataCommand{{Endpoint: "transfer", From: socialDevice, Continues: &no, Error: "unmarshal"}}, commandEventsOf(p))
	raw, err := json.Marshal(commandEventsOf(p)[0])
	require.NoError(t, err)
	require.JSONEq(t, `{"endpoint":"transfer","from":"`+socialDevice+`","continues":false,"error":"unmarshal"}`, string(raw))

	p = newTestAppPlayer(t)
	nothing := transferCommand(t, &connectpb.TransferState{
		CurrentSession: &connectpb.Session{},
		Playback:       &connectpb.Playback{},
	})
	nothing.SentByDeviceId = socialDevice
	require.Error(t, p.handlePlayerCommand(nothing))
	require.Equal(t, []ApiEventDataCommand{{Endpoint: "transfer", From: socialDevice, Continues: &no, Error: "nothing_to_play"}}, commandEventsOf(p))
	require.False(t, p.state.active, "still refused")

	// One that is applied says nothing of an error.
	p = newTestAppPlayer(t)
	inJam(t, p)
	commands := commandEventsOf(p)
	require.Len(t, commands, 1)
	require.Empty(t, commands[0].Error)
	raw, err = json.Marshal(commands[0])
	require.NoError(t, err)
	require.NotContains(t, string(raw), `"error"`)
}
