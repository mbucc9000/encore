//go:build test_unit

package daemon

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/devgianlu/go-librespot/dealer"
	connectpb "github.com/devgianlu/go-librespot/proto/spotify/connectstate"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"
)

const (
	thisDevice  = "this-device"
	otherDevice = "other-device"
	thirdDevice = "third-device"
)

func clusterMessage(t *testing.T, activeDeviceId string, playerTimestamp int64) dealer.Message {
	t.Helper()

	payload, err := proto.Marshal(&connectpb.ClusterUpdate{
		Cluster: &connectpb.Cluster{
			ActiveDeviceId: activeDeviceId,
			PlayerState:    &connectpb.PlayerState{Timestamp: playerTimestamp},
		},
		UpdateReason: connectpb.ClusterUpdateReason_DEVICE_STATE_CHANGED,
	})
	require.NoError(t, err)

	return dealer.Message{Uri: "hm://connect-state/v1/cluster", Payload: payload}
}

func playCommand() dealer.RequestPayload {
	var req dealer.RequestPayload
	req.Command.Endpoint = "play"
	req.Command.PlayOrigin = &connectpb.PlayOrigin{}
	req.Command.Context = &connectpb.Context{
		Uri: "spotify:album:3KIlhMEiSYNn8VD7e6yglU",
		Pages: []*connectpb.ContextPage{{Tracks: []*connectpb.ContextTrack{
			{Uri: "spotify:track:3j7BhP71ROCpc9R3w9P9UE", Uid: "u0"},
		}}},
	}
	req.SentByDeviceId = "webapi-0123"
	return req
}

// playOverOtherDevice has another device hold the session, with its player
// state from paused, then plays on this one.
func playOverOtherDevice(t *testing.T, paused int64) *AppPlayer {
	t.Helper()

	p := newTestAppPlayer(t)
	p.app.cfg = &Config{}
	p.app.deviceId = thisDevice
	p.resolveTrackList = resolveWith(0)

	require.NoError(t, p.handleDealerMessage(clusterMessage(t, otherDevice, paused)))
	require.NoError(t, p.handlePlayerCommand(playCommand()))
	require.True(t, p.state.active)
	return p
}

// A play is gated like a transfer. The device it took over from can report its
// state once more on its way to going inactive, and be made active again for a
// moment: librespot does. The update that results carries the state it had
// before the play, so it is not a transfer away, and the play must not be
// dropped for it.
func TestPlayIsNotBouncedBackByTheDeviceItTookOverFrom(t *testing.T) {
	p := playOverOtherDevice(t, 1000)

	require.NoError(t, p.handleDealerMessage(clusterMessage(t, otherDevice, 1000)))

	require.True(t, p.state.active, "the old device repeating its state is no transfer away")
}

// Playing on the old device again gives it a newer state: that is a transfer
// away like any other.
func TestPlayYieldsWhenTheOldDevicePlaysAgain(t *testing.T) {
	p := playOverOtherDevice(t, 1000)

	require.NoError(t, p.handleDealerMessage(clusterMessage(t, otherDevice, 2000)))

	require.False(t, p.state.active)
}

// Another device taking over reports a state newer than the play's.
func TestPlayYieldsToAThirdDevice(t *testing.T) {
	p := playOverOtherDevice(t, 1000)

	require.NoError(t, p.handleDealerMessage(clusterMessage(t, thirdDevice, 1500)))

	require.False(t, p.state.active)
}

// clusterUpdate is a cluster update carrying the cluster as given.
func clusterUpdate(t *testing.T, cluster *connectpb.Cluster) dealer.Message {
	t.Helper()

	payload, err := proto.Marshal(&connectpb.ClusterUpdate{
		Cluster:      cluster,
		UpdateReason: connectpb.ClusterUpdateReason_DEVICE_STATE_CHANGED,
	})
	require.NoError(t, err)

	return dealer.Message{Uri: "hm://connect-state/v1/cluster", Payload: payload}
}

func clusterEventsOf(p *AppPlayer) []ApiEventDataCluster {
	var out []ApiEventDataCluster
	for _, data := range emitted(p, ApiEventTypeCluster) {
		out = append(out, data.(ApiEventDataCluster))
	}
	return out
}

// The cluster event says what a cluster update shows of a Jam, by kinds and
// counts, once per change: which kind of device is active, how many devices
// are social-connect's (by their id, or by their info), and whether the player
// state is in a Jam's list, its jam mode, and its origin.
func TestClusterEvent(t *testing.T) {
	const plainSocial = "plain-device-id"

	p := newTestAppPlayer(t)
	p.app.deviceId = thisDevice

	plain := &connectpb.Cluster{
		ActiveDeviceId: thisDevice,
		Device:         map[string]*connectpb.DeviceInfo{thisDevice: {DeviceId: thisDevice, Name: "Encore"}},
		PlayerState: &connectpb.PlayerState{
			Timestamp:  1000,
			ContextUri: playlistUri,
			PlayOrigin: &connectpb.PlayOrigin{DeviceIdentifier: "webapi-0123"},
		},
	}
	require.NoError(t, p.handleDealerMessage(clusterUpdate(t, plain)))
	require.Equal(t, []ApiEventDataCluster{{Active: "self"}}, clusterEventsOf(p))

	plain.PlayerState.Timestamp = 2000
	require.NoError(t, p.handleDealerMessage(clusterUpdate(t, plain)))
	require.Len(t, clusterEventsOf(p), 1, "nothing changed")

	jam := &connectpb.Cluster{
		ActiveDeviceId: socialDevice,
		Device: map[string]*connectpb.DeviceInfo{
			thisDevice:   {DeviceId: thisDevice, Name: "Encore"},
			socialDevice: {DeviceId: socialDevice},
			plainSocial:  {DeviceId: plainSocial, IsSocialConnect: true},
			otherDevice:  {DeviceId: otherDevice, Name: "PC"},
		},
		PlayerState: &connectpb.PlayerState{
			Timestamp:  3000,
			ContextUri: jamListUri,
			Options:    &connectpb.ContextPlayerOptions{Modes: map[string]string{"jam": "on"}},
			PlayOrigin: &connectpb.PlayOrigin{DeviceIdentifier: socialDevice},
		},
	}
	require.NoError(t, p.handleDealerMessage(clusterUpdate(t, jam)))
	events := clusterEventsOf(p)
	require.Len(t, events, 2)
	require.Equal(t, ApiEventDataCluster{Active: "social", SocialDevices: 2, JamContext: true, JamMode: "on", SocialOrigin: true}, events[1])

	// No id in it, this device's included.
	raw, err := json.Marshal(&ApiEvent{Type: ApiEventTypeCluster, Data: events[1]})
	require.NoError(t, err)
	require.JSONEq(t, `{"type":"cluster","data":{"active":"social","social_devices":2,"jam_context":true,"jam_mode":"on","social_origin":true}}`, string(raw))
	for _, id := range []string{thisDevice, otherDevice, plainSocial, socialDevice[len(socialDevicePrefix):]} {
		require.NotContains(t, string(raw), id)
	}

	// Another device active, then none.
	jam.ActiveDeviceId = otherDevice
	require.NoError(t, p.handleDealerMessage(clusterUpdate(t, jam)))
	jam.ActiveDeviceId = ""
	require.NoError(t, p.handleDealerMessage(clusterUpdate(t, jam)))
	events = clusterEventsOf(p)
	require.Len(t, events, 4)
	require.Equal(t, "other", events[2].Active)
	require.Equal(t, "none", events[3].Active)

	// An update without a cluster or a player state is read as empty.
	require.NoError(t, p.handleDealerMessage(clusterUpdate(t, &connectpb.Cluster{})))
	events = clusterEventsOf(p)
	require.Len(t, events, 5)
	require.Equal(t, ApiEventDataCluster{Active: "none"}, events[4])

	// Only reading it: this device was never active, and nothing else was
	// emitted.
	require.False(t, p.state.active)
	require.Len(t, apiEvents(p), 5)
}

// The cluster event comes before what the update does to the player: a newer
// state of another device still stops playback here, as before.
func TestClusterEventBeforeATransferAway(t *testing.T) {
	p := playOverOtherDevice(t, 1000)
	require.Equal(t, []ApiEventDataCluster{{Active: "other"}}, clusterEventsOf(p))

	// Another device takes the playback into a Jam's list.
	require.NoError(t, p.handleDealerMessage(clusterUpdate(t, &connectpb.Cluster{
		ActiveDeviceId: thirdDevice,
		PlayerState:    &connectpb.PlayerState{Timestamp: 1500, ContextUri: jamListUri},
	})))

	require.False(t, p.state.active, "playback still stops here")
	events := clusterEventsOf(p)
	require.Len(t, events, 2)
	require.Equal(t, ApiEventDataCluster{Active: "other", JamContext: true}, events[1])

	lastCluster, lastInactive := -1, -1
	for i, typ := range apiEvents(p) {
		switch typ {
		case ApiEventTypeCluster:
			lastCluster = i
		case ApiEventTypeInactive:
			lastInactive = i
		}
	}
	require.NotEqual(t, -1, lastInactive)
	require.Less(t, lastCluster, lastInactive, "the cluster event first")
}

// Spotify's echo of a Jam this device switched itself into (activateJam): the
// cluster names this device active, in Jam mode, with its own playlist. The
// cluster event says so, and the device stays active.
func TestClusterEchoOfAnActivatedJam(t *testing.T) {
	p := playingPlaylist(t)
	p.app.cfg = &Config{}
	p.app.deviceId = thisDevice
	_, err := p.activateJam()
	require.NoError(t, err)

	require.NoError(t, p.handleDealerMessage(clusterUpdate(t, &connectpb.Cluster{
		ActiveDeviceId: thisDevice,
		Device:         map[string]*connectpb.DeviceInfo{thisDevice: {DeviceId: thisDevice, Name: "Encore"}},
		PlayerState: &connectpb.PlayerState{
			Timestamp:  time.Now().UnixMilli(),
			ContextUri: playlistUri,
			Options:    &connectpb.ContextPlayerOptions{Modes: map[string]string{"jam": "on"}},
			PlayOrigin: &connectpb.PlayOrigin{FeatureIdentifier: "go-librespot"},
		},
	})))

	require.Equal(t, []ApiEventDataCluster{{Active: "self", JamMode: "on"}}, clusterEventsOf(p))
	require.True(t, p.state.active)
	require.NotContains(t, apiEvents(p), ApiEventTypeInactive)
}

// A connect-state message the player does not handle is no longer dropped
// without a word: it is logged at info the first time its masked uri is seen,
// at debug after that, for 16 uris at most. Handled ones are not logged so.
func TestUnhandledConnectStateMessageIsLoggedOnce(t *testing.T) {
	const idA, idB = "0123456789abcdef0123456789abcdef01234567", "fedcba9876543210fedcba9876543210fedcba98"

	p := newTestAppPlayer(t)
	log := &recordingLogger{}
	p.app.log = log

	require.NoError(t, p.handleDealerMessage(dealer.Message{Uri: "hm://connect-state/v1/x/" + idA, Payload: []byte{1, 2, 3}}))
	require.NoError(t, p.handleDealerMessage(dealer.Message{Uri: "hm://connect-state/v1/x/" + idB}))

	require.Equal(t, []string{"connect-state message hm://connect-state/v1/x/* not handled (3 bytes)"}, log.info)
	require.Equal(t, []string{"connect-state message hm://connect-state/v1/x/* not handled (0 bytes)"}, log.debug)
	for _, line := range log.lines() {
		require.NotContains(t, line, idA)
		require.NotContains(t, line, idB)
	}

	// A cluster update is handled, and not logged as unhandled.
	require.NoError(t, p.handleDealerMessage(clusterMessage(t, otherDevice, 1000)))
	require.Len(t, log.info, 1)
	require.Len(t, log.debug, 1)

	// 16 uris at most at info.
	p = newTestAppPlayer(t)
	log = &recordingLogger{}
	p.app.log = log
	for i := range connectLogUris + 1 {
		require.NoError(t, p.handleDealerMessage(dealer.Message{Uri: fmt.Sprintf("hm://connect-state/v1/kind/%c", 'a'+i)}))
	}
	require.Len(t, log.info, connectLogUris)
	require.Len(t, log.debug, 1)
	require.Len(t, p.connectLogged, connectLogUris)
}
