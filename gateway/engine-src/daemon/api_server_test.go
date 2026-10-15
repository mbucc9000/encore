//go:build test_integration

package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	librespot "github.com/devgianlu/go-librespot"
	"github.com/devgianlu/go-librespot/spclient"
	"github.com/devgianlu/go-librespot/tracks"
	"github.com/stretchr/testify/require"
)

// testServer is a ConcreteApiServer on a random port with a stand-in for the
// daemon: reply decides what every request resolves to, and the requests it
// saw are readable afterwards. A nil reply leaves the requests unread, as
// nothing reads them while the daemon is still logging in. Built by hand rather than through NewApiServer
// because only the struct exposes the listener address.
type testServer struct {
	t      *testing.T
	url    string
	server *ConcreteApiServer

	received chan ApiRequest
}

func newTestServer(t *testing.T, reply func(req ApiRequest) (any, error)) *testServer {
	t.Helper()

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)

	s := &ConcreteApiServer{
		log:      &librespot.NullLogger{},
		listener: listener,
		requests: make(chan ApiRequest),
	}
	go s.serve()
	t.Cleanup(func() { _ = s.Close() })

	ts := &testServer{
		t:        t,
		url:      "http://" + listener.Addr().String(),
		server:   s,
		received: make(chan ApiRequest, 16),
	}

	if reply == nil {
		return ts
	}

	// Stand in for AppPlayer.Run, which is what normally drains this channel.
	go func() {
		for req := range s.requests {
			ts.received <- req
			data, err := reply(req)
			req.Reply(data, err)
		}
	}()

	return ts
}

// do issues a request; body of nil sends no body at all, a string is sent verbatim.
func (ts *testServer) do(method, path string, body any) *http.Response {
	ts.t.Helper()

	var r io.Reader
	switch b := body.(type) {
	case nil:
	case string:
		r = bytes.NewReader([]byte(b))
	default:
		raw, err := json.Marshal(b)
		require.NoError(ts.t, err)
		r = bytes.NewReader(raw)
	}

	req, err := http.NewRequest(method, ts.url+path, r)
	require.NoError(ts.t, err)

	resp, err := http.DefaultClient.Do(req)
	require.NoError(ts.t, err)
	ts.t.Cleanup(func() { _ = resp.Body.Close() })

	return resp
}

// request returns the single ApiRequest the daemon was handed, failing if none arrived.
func (ts *testServer) request() ApiRequest {
	ts.t.Helper()

	select {
	case req := <-ts.received:
		return req
	case <-time.After(2 * time.Second):
		ts.t.Fatal("no request reached the daemon")
		return ApiRequest{}
	}
}

// requireNoRequest asserts the handler rejected the call without bothering the daemon.
func (ts *testServer) requireNoRequest() {
	ts.t.Helper()

	select {
	case req := <-ts.received:
		ts.t.Fatalf("request %s should not have reached the daemon", req.Type)
	case <-time.After(100 * time.Millisecond):
	}
}

func okReply(ApiRequest) (any, error) { return nil, nil }

func body(t *testing.T, resp *http.Response) string {
	t.Helper()
	raw, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	return string(raw)
}

// Every endpoint and the methods it accepts. Anything else must be refused
// before the daemon is involved.
var endpointMethods = map[string][]string{
	"/":                             {http.MethodGet},
	"/status":                       {http.MethodGet},
	"/auth/code":                    {http.MethodGet},
	"/token":                        {http.MethodPost},
	"/set_device_name":              {http.MethodPost},
	"/player/play":                  {http.MethodPost},
	"/player/resume":                {http.MethodPost},
	"/player/pause":                 {http.MethodPost},
	"/player/playpause":             {http.MethodPost},
	"/player/stop":                  {http.MethodPost},
	"/player/next":                  {http.MethodPost},
	"/player/prev":                  {http.MethodPost},
	"/player/seek":                  {http.MethodPost},
	"/player/volume":                {http.MethodGet, http.MethodPost},
	"/player/repeat_context":        {http.MethodPost},
	"/player/repeat_track":          {http.MethodPost},
	"/player/shuffle_context":       {http.MethodPost},
	"/player/add_to_queue":          {http.MethodPost},
	"/player/output":                {http.MethodPost},
	"/player/output_delay":          {http.MethodPost},
	"/context/tracks":               {http.MethodGet},
	"/library/playlists":            {http.MethodGet},
	"/library/liked":                {http.MethodGet, http.MethodPost},
	"/library/playlists/add_tracks": {http.MethodPost},
	"/player/queue":                 {http.MethodGet},
	"/player/queue/remove":          {http.MethodPost},
	"/player/queue/move":            {http.MethodPost},
	"/player/queue/top":             {http.MethodPost},
	"/player/queue/jump":            {http.MethodPost},
	"/jam/current":                  {http.MethodGet},
	"/jam/start":                    {http.MethodPost},
	"/jam/info":                     {http.MethodGet},
	"/jam/join":                     {http.MethodPost},
	"/jam/leave":                    {http.MethodPost},
	"/jam/end":                      {http.MethodPost},
	"/jam/remove":                   {http.MethodPost},
	"/jam/forget":                   {http.MethodPost},
	"/jam/activate":                 {http.MethodPost},
	"/jam/broadcast":                {http.MethodGet, http.MethodPost},
}

func TestApiRejectsWrongMethod(t *testing.T) {
	ts := newTestServer(t, okReply)

	for path, allowed := range endpointMethods {
		for _, method := range []string{http.MethodGet, http.MethodPost, http.MethodPut, http.MethodDelete} {
			if slices.Contains(allowed, method) {
				continue
			}

			t.Run(method+path, func(t *testing.T) {
				resp := ts.do(method, path, nil)
				require.Equal(t, http.StatusMethodNotAllowed, resp.StatusCode)
			})
		}
	}
}

func TestApiRoot(t *testing.T) {
	ts := newTestServer(t, func(ApiRequest) (any, error) {
		return &ApiRoot{PlaybackReady: true}, nil
	})

	resp := ts.do(http.MethodGet, "/", nil)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.Equal(t, "application/json", resp.Header.Get("Content-Type"))
	require.JSONEq(t, `{"playback_ready":true}`, body(t, resp))

	require.Equal(t, ApiRequestTypeRoot, ts.request().Type)
}

// The pairing code is answered from the server's own state, never forwarded:
// the device authorization flow blocks the daemon before anything drains the
// request channel, so a request that had to reach a player would hang for as
// long as the code is worth having.
func TestApiAuthCode(t *testing.T) {
	ts := newTestServer(t, okReply)

	resp := ts.do(http.MethodGet, "/auth/code", nil)
	require.Equal(t, http.StatusNoContent, resp.StatusCode)
	ts.requireNoRequest()

	expiry := time.Now().Add(5 * time.Minute).UTC().Truncate(time.Second)
	ts.server.SetAuthCode(&ApiDeviceAuth{
		Url:       "https://spotify.com/pair?code=ABCDEF",
		Code:      "ABCDEF",
		ExpiresAt: expiry,
	})

	resp = ts.do(http.MethodGet, "/auth/code", nil)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.Equal(t, "application/json", resp.Header.Get("Content-Type"))
	require.JSONEq(t, fmt.Sprintf(
		`{"url":"https://spotify.com/pair?code=ABCDEF","code":"ABCDEF","expires_at":%q}`,
		expiry.Format(time.RFC3339),
	), body(t, resp))
	ts.requireNoRequest()

	// Cleared once the user has approved the request or the code has expired.
	ts.server.SetAuthCode(nil)

	resp = ts.do(http.MethodGet, "/auth/code", nil)
	require.Equal(t, http.StatusNoContent, resp.StatusCode)
}

func TestApiStatus(t *testing.T) {
	ts := newTestServer(t, func(ApiRequest) (any, error) {
		return &ApiStatus{
			Username:    "someone",
			DeviceId:    "abc",
			DeviceName:  "test device",
			Volume:      42,
			VolumeSteps: 100,
			Stopped:     true,
		}, nil
	})

	resp := ts.do(http.MethodGet, "/status", nil)
	require.Equal(t, http.StatusOK, resp.StatusCode)

	var got ApiStatus
	require.NoError(t, json.Unmarshal([]byte(body(t, resp)), &got))
	require.Equal(t, "someone", got.Username)
	require.EqualValues(t, 42, got.Volume)
	require.True(t, got.Stopped)
	require.Nil(t, got.Track)

	require.Equal(t, ApiRequestTypeStatus, ts.request().Type)
}

// The status payload is the API's largest contract and is now generated from
// the spec, so pin the exact JSON: every field present, nothing omitted, and
// nulls where the schema says nullable.
func TestApiStatusWireFormat(t *testing.T) {
	coverUrl := "https://i.scdn.co/image/xxx"
	bitrate, sampleRate, bitDepth := 160, 44100, 16
	playOrigin := "go-librespot"
	originDeviceId := "def"
	contextUri := "spotify:playlist:xxx"
	contextName := "Some Playlist"

	ts := newTestServer(t, func(ApiRequest) (any, error) {
		return &ApiStatus{
			Username:           "someone",
			DeviceId:           "abc",
			DeviceType:         "COMPUTER",
			DeviceName:         "test device",
			PlayOrigin:         &playOrigin,
			PlayOriginDeviceId: &originDeviceId,
			ContextUri:         &contextUri,
			ContextName:        &contextName,
			Stopped:            false,
			Paused:             false,
			Buffering:          false,
			Volume:             42,
			VolumeSteps:        100,
			RepeatContext:      false,
			RepeatTrack:        false,
			ShuffleContext:     false,
			Track: &ApiTrack{
				Uri:           "spotify:track:xxx",
				Name:          "Some Song",
				ArtistNames:   []string{"Someone"},
				ArtistUris:    []string{"spotify:artist:yyy"},
				AlbumName:     "Some Album",
				AlbumUri:      "spotify:album:zzz",
				AlbumCoverUrl: &coverUrl,
				Position:      1000,
				Duration:      200000,
				ReleaseDate:   "2020-01-01",
				TrackNumber:   3,
				DiscNumber:    1,
				Format:        "OGG_VORBIS_160",
				Codec:         TrackCodecVorbis,
				Bitrate:       &bitrate,
				SampleRate:    &sampleRate,
				BitDepth:      &bitDepth,

				// The playing track names the context entry it was asked for.
				ContextTrackUri: "spotify:track:www",
				Explicit:        true,
			},
			JamMode:   "on",
			JamRoutes: jamRoutes,
			Social:    ApiSocialStats{Sends: 7, Sends5m: 3, Renewals: 1, HeldUntil: 1790000000000},
			QueueEdit: true,
			QueueOps:  queueOps,
		}, nil
	})

	resp := ts.do(http.MethodGet, "/status", nil)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.JSONEq(t, `{
		"username": "someone",
		"device_id": "abc",
		"device_type": "COMPUTER",
		"device_name": "test device",
		"play_origin": "go-librespot",
		"play_origin_device_id": "def",
		"context_uri": "spotify:playlist:xxx",
		"context_name": "Some Playlist",
		"stopped": false,
		"paused": false,
		"buffering": false,
		"volume": 42,
		"volume_steps": 100,
		"repeat_context": false,
		"repeat_track": false,
		"shuffle_context": false,
		"track": {
			"uri": "spotify:track:xxx",
			"context_track_uri": "spotify:track:www",
			"name": "Some Song",
			"artist_names": ["Someone"],
			"artist_uris": ["spotify:artist:yyy"],
			"album_name": "Some Album",
			"album_uri": "spotify:album:zzz",
			"album_cover_url": "https://i.scdn.co/image/xxx",
			"position": 1000,
			"duration": 200000,
			"release_date": "2020-01-01",
			"track_number": 3,
			"disc_number": 1,
			"explicit": true,
			"format": "OGG_VORBIS_160",
			"codec": "vorbis",
			"bitrate": 160,
			"sample_rate": 44100,
			"bit_depth": 16
		},
		"jam_mode": "on",
		"jam_routes": ["current", "start", "info", "join", "leave", "end", "remove", "forget", "broadcast", "activate"],
		"social": {"sends": 7, "sends5m": 3, "renewals": 1, "held_until": 1790000000000},
		"queue_edit": true,
		"queue_ops": ["shuffled", "top", "jump"]
	}`, body(t, resp))
}

// The nullable fields must serialise as null rather than disappear.
func TestApiStatusWireFormatNulls(t *testing.T) {
	ts := newTestServer(t, func(ApiRequest) (any, error) {
		return &ApiStatus{Track: &ApiTrack{ArtistNames: []string{}}}, nil
	})

	resp := ts.do(http.MethodGet, "/status", nil)

	var got map[string]any
	require.NoError(t, json.Unmarshal([]byte(body(t, resp)), &got))

	for _, field := range []string{"play_origin", "play_origin_device_id", "context_uri", "context_name"} {
		value, present := got[field]
		require.True(t, present, "%s must be present", field)
		require.Nil(t, value, "%s must be null", field)
	}

	track, ok := got["track"].(map[string]any)
	require.True(t, ok)
	for _, field := range []string{"album_cover_url", "bitrate", "sample_rate", "bit_depth"} {
		value, present := track[field]
		require.True(t, present, "%s must be present", field)
		require.Nil(t, value, "%s must be null", field)
	}

	// Only the playing track names the context entry it was asked for.
	_, present := track["context_track_uri"]
	require.False(t, present, "context_track_uri is left out when unknown")
	require.Equal(t, false, track["explicit"], "explicit is always there")

	// An unset jam mode and no hold are left out; the counts are always there.
	_, present = got["jam_mode"]
	require.False(t, present, "jam_mode is left out when unset")
	require.Equal(t, map[string]any{"sends": 0.0, "sends5m": 0.0, "renewals": 0.0}, got["social"])
	require.Equal(t, false, got["queue_edit"], "queue_edit is always there")
	value, present := got["queue_ops"]
	require.True(t, present, "queue_ops is always there")
	require.Nil(t, value)
}

// The endpoints that take no body and just forward a bare request type.
func TestApiSimpleCommands(t *testing.T) {
	for path, want := range map[string]ApiRequestType{
		"/player/resume":    ApiRequestTypeResume,
		"/player/pause":     ApiRequestTypePause,
		"/player/playpause": ApiRequestTypePlayPause,
		"/player/stop":      ApiRequestTypeStop,
		"/player/prev":      ApiRequestTypePrev,
		"/token":            ApiRequestTypeToken,
	} {
		t.Run(path, func(t *testing.T) {
			ts := newTestServer(t, okReply)

			resp := ts.do(http.MethodPost, path, nil)
			require.Equal(t, http.StatusOK, resp.StatusCode)
			require.Equal(t, want, ts.request().Type)
		})
	}
}

func TestApiPlay(t *testing.T) {
	t.Run("decodes the whole payload", func(t *testing.T) {
		ts := newTestServer(t, okReply)

		resp := ts.do(http.MethodPost, "/player/play", map[string]any{
			"uri":             "spotify:playlist:xxx",
			"skip_to_uri":     "spotify:track:yyy",
			"paused":          true,
			"position":        12345,
			"shuffle_context": true,
		})
		require.Equal(t, http.StatusOK, resp.StatusCode)

		req := ts.request()
		require.Equal(t, ApiRequestTypePlay, req.Type)
		require.Equal(t, ApiPlay{
			Uri:            "spotify:playlist:xxx",
			SkipToUri:      "spotify:track:yyy",
			Paused:         true,
			Position:       12345,
			ShuffleContext: pointer(true),
		}, req.Data)
	})

	t.Run("position defaults to the start", func(t *testing.T) {
		ts := newTestServer(t, okReply)

		ts.do(http.MethodPost, "/player/play", map[string]any{"uri": "spotify:track:xxx"})
		require.EqualValues(t, 0, ts.request().Data.(ApiPlay).Position)
	})

	// Omitted keeps the current setting, which false would not.
	t.Run("shuffle_context tells omitted from false", func(t *testing.T) {
		ts := newTestServer(t, okReply)

		ts.do(http.MethodPost, "/player/play", map[string]any{"uri": "spotify:playlist:xxx"})
		require.Nil(t, ts.request().Data.(ApiPlay).ShuffleContext)

		ts.do(http.MethodPost, "/player/play", map[string]any{"uri": "spotify:playlist:xxx", "shuffle_context": false})
		require.Equal(t, pointer(false), ts.request().Data.(ApiPlay).ShuffleContext)
	})

	for name, payload := range map[string]any{
		"missing uri":  map[string]any{"paused": true},
		"empty uri":    map[string]any{"uri": ""},
		"no body":      nil,
		"invalid json": "{not json",
	} {
		t.Run("rejects "+name, func(t *testing.T) {
			ts := newTestServer(t, okReply)

			resp := ts.do(http.MethodPost, "/player/play", payload)
			require.Equal(t, http.StatusBadRequest, resp.StatusCode)
			ts.requireNoRequest()
		})
	}
}

func TestApiNext(t *testing.T) {
	t.Run("with a target uri", func(t *testing.T) {
		ts := newTestServer(t, okReply)

		ts.do(http.MethodPost, "/player/next", map[string]any{"uri": "spotify:track:xxx"})

		req := ts.request()
		require.Equal(t, ApiRequestTypeNext, req.Type)
		data := req.Data.(ApiNext)
		require.NotNil(t, data.Uri)
		require.Equal(t, "spotify:track:xxx", *data.Uri)
	})

	t.Run("without a body", func(t *testing.T) {
		ts := newTestServer(t, okReply)

		resp := ts.do(http.MethodPost, "/player/next", nil)
		require.Equal(t, http.StatusOK, resp.StatusCode)
		require.Nil(t, ts.request().Data.(ApiNext).Uri)
	})
}

func TestApiSeek(t *testing.T) {
	t.Run("absolute", func(t *testing.T) {
		ts := newTestServer(t, okReply)

		resp := ts.do(http.MethodPost, "/player/seek", map[string]any{"position": 5000})
		require.Equal(t, http.StatusOK, resp.StatusCode)

		req := ts.request()
		require.Equal(t, ApiRequestTypeSeek, req.Type)
		require.Equal(t, ApiSeek{Position: 5000}, req.Data)
	})

	t.Run("relative may go backwards", func(t *testing.T) {
		ts := newTestServer(t, okReply)

		resp := ts.do(http.MethodPost, "/player/seek", map[string]any{"position": -5000, "relative": true})
		require.Equal(t, http.StatusOK, resp.StatusCode)
		require.Equal(t, ApiSeek{Position: -5000, Relative: true}, ts.request().Data)
	})

	t.Run("absolute rejects a negative position", func(t *testing.T) {
		ts := newTestServer(t, okReply)

		resp := ts.do(http.MethodPost, "/player/seek", map[string]any{"position": -1})
		require.Equal(t, http.StatusBadRequest, resp.StatusCode)
		ts.requireNoRequest()
	})
}

func TestApiVolume(t *testing.T) {
	t.Run("get", func(t *testing.T) {
		ts := newTestServer(t, func(ApiRequest) (any, error) {
			return &ApiVolume{Value: 30, Max: 100}, nil
		})

		resp := ts.do(http.MethodGet, "/player/volume", nil)
		require.Equal(t, http.StatusOK, resp.StatusCode)
		require.JSONEq(t, `{"value":30,"max":100}`, body(t, resp))
		require.Equal(t, ApiRequestTypeGetVolume, ts.request().Type)
	})

	t.Run("set", func(t *testing.T) {
		ts := newTestServer(t, okReply)

		resp := ts.do(http.MethodPost, "/player/volume", map[string]any{"volume": 64})
		require.Equal(t, http.StatusOK, resp.StatusCode)

		req := ts.request()
		require.Equal(t, ApiRequestTypeSetVolume, req.Type)
		require.Equal(t, ApiSetVolume{Volume: 64}, req.Data)
	})

	t.Run("relative may go negative", func(t *testing.T) {
		ts := newTestServer(t, okReply)

		resp := ts.do(http.MethodPost, "/player/volume", map[string]any{"volume": -10, "relative": true})
		require.Equal(t, http.StatusOK, resp.StatusCode)
		require.Equal(t, ApiSetVolume{Volume: -10, Relative: true}, ts.request().Data)
	})

	t.Run("absolute rejects a negative volume", func(t *testing.T) {
		ts := newTestServer(t, okReply)

		resp := ts.do(http.MethodPost, "/player/volume", map[string]any{"volume": -1})
		require.Equal(t, http.StatusBadRequest, resp.StatusCode)
		ts.requireNoRequest()
	})
}

// These three unwrap their single boolean field before handing it on.
func TestApiToggles(t *testing.T) {
	for _, tt := range []struct {
		path  string
		field string
		want  ApiRequestType
	}{
		{"/player/repeat_context", "repeat_context", ApiRequestTypeSetRepeatingContext},
		{"/player/repeat_track", "repeat_track", ApiRequestTypeSetRepeatingTrack},
		{"/player/shuffle_context", "shuffle_context", ApiRequestTypeSetShufflingContext},
	} {
		t.Run(tt.path, func(t *testing.T) {
			ts := newTestServer(t, okReply)

			resp := ts.do(http.MethodPost, tt.path, map[string]any{tt.field: true})
			require.Equal(t, http.StatusOK, resp.StatusCode)

			req := ts.request()
			require.Equal(t, tt.want, req.Type)
			require.Equal(t, true, req.Data)
		})

		t.Run(tt.path+" defaults to false", func(t *testing.T) {
			ts := newTestServer(t, okReply)

			ts.do(http.MethodPost, tt.path, map[string]any{})
			require.Equal(t, false, ts.request().Data)
		})
	}
}

func TestApiAddToQueue(t *testing.T) {
	t.Run("forwards the uri", func(t *testing.T) {
		ts := newTestServer(t, okReply)

		resp := ts.do(http.MethodPost, "/player/add_to_queue", map[string]any{"uri": "spotify:track:xxx"})
		require.Equal(t, http.StatusOK, resp.StatusCode)

		req := ts.request()
		require.Equal(t, ApiRequestTypeAddToQueue, req.Type)
		require.Equal(t, "spotify:track:xxx", req.Data)
	})

	t.Run("rejects an empty uri", func(t *testing.T) {
		ts := newTestServer(t, okReply)

		resp := ts.do(http.MethodPost, "/player/add_to_queue", map[string]any{"uri": ""})
		require.Equal(t, http.StatusBadRequest, resp.StatusCode)
		ts.requireNoRequest()
	})
}

func TestApiLibraryPlaylists(t *testing.T) {
	t.Run("defaults the paging", func(t *testing.T) {
		ts := newTestServer(t, okReply)

		resp := ts.do(http.MethodGet, "/library/playlists", nil)
		require.Equal(t, http.StatusOK, resp.StatusCode)

		req := ts.request()
		require.Equal(t, ApiRequestTypeLibraryPlaylists, req.Type)
		require.Equal(t, ApiRequestDataLibraryPlaylists{Offset: 0, Limit: 50}, req.Data)
	})

	t.Run("forwards the paging", func(t *testing.T) {
		ts := newTestServer(t, okReply)

		resp := ts.do(http.MethodGet, "/library/playlists?offset=20&limit=500", nil)
		require.Equal(t, http.StatusOK, resp.StatusCode)
		require.Equal(t, ApiRequestDataLibraryPlaylists{Offset: 20, Limit: 500}, ts.request().Data)
	})

	for _, query := range []string{"limit=0", "limit=501", "offset=-1", "limit=abc"} {
		t.Run("rejects "+query, func(t *testing.T) {
			ts := newTestServer(t, okReply)

			resp := ts.do(http.MethodGet, "/library/playlists?"+query, nil)
			require.Equal(t, http.StatusBadRequest, resp.StatusCode)
			ts.requireNoRequest()
		})
	}

	t.Run("serialises the page", func(t *testing.T) {
		ts := newTestServer(t, func(ApiRequest) (any, error) {
			return pageLibraryPlaylists([]ApiLibraryPlaylist{{
				Uri:      "spotify:playlist:xxx",
				Name:     "Mix",
				Folder:   []string{},
				Revision: "0000002a8f3c",
			}}, 0, 50), nil
		})

		resp := ts.do(http.MethodGet, "/library/playlists", nil)
		require.Equal(t, http.StatusOK, resp.StatusCode)
		require.JSONEq(t, `{"total":1,"offset":0,"limit":50,"items":[{
			"uri":"spotify:playlist:xxx","name":"Mix","description":"","owner_username":"",
			"length":0,"image_url":null,"collaborative":false,"can_edit":false,"folder":[],
			"revision":"0000002a8f3c"}]}`, body(t, resp))
	})
}

func TestApiContextTracks(t *testing.T) {
	t.Run("defaults to the whole listing, swept", func(t *testing.T) {
		ts := newTestServer(t, okReply)

		resp := ts.do(http.MethodGet, "/context/tracks?uri=spotify:playlist:xxx", nil)
		require.Equal(t, http.StatusOK, resp.StatusCode)

		req := ts.request()
		require.Equal(t, ApiRequestTypeContextTracks, req.Type)
		require.Equal(t, ApiRequestDataContextTracks{Uri: "spotify:playlist:xxx"}, req.Data)
	})

	t.Run("forwards the options", func(t *testing.T) {
		ts := newTestServer(t, okReply)

		resp := ts.do(http.MethodGet, "/context/tracks?uri=spotify:playlist:xxx&refresh=1&meta=0&from=500&limit=100&sweep=false", nil)
		require.Equal(t, http.StatusOK, resp.StatusCode)
		require.Equal(t, ApiRequestDataContextTracks{
			Uri:     "spotify:playlist:xxx",
			Refresh: true,
			Summary: true,
			From:    500,
			Limit:   pointer(100),
			NoSweep: true,
		}, ts.request().Data)
	})

	t.Run("an explicit true is the default", func(t *testing.T) {
		ts := newTestServer(t, okReply)

		ts.do(http.MethodGet, "/context/tracks?uri=spotify:playlist:xxx&meta=true&sweep=1&limit=0", nil)
		require.Equal(t, ApiRequestDataContextTracks{Uri: "spotify:playlist:xxx", Limit: pointer(0)}, ts.request().Data)
	})

	for _, query := range []string{"", "?uri=", "?uri=spotify:playlist:xxx&from=-1", "?uri=spotify:playlist:xxx&limit=-1", "?uri=spotify:playlist:xxx&meta=maybe"} {
		t.Run("rejects "+query, func(t *testing.T) {
			ts := newTestServer(t, okReply)

			resp := ts.do(http.MethodGet, "/context/tracks"+query, nil)
			require.Equal(t, http.StatusBadRequest, resp.StatusCode)
			ts.requireNoRequest()
		})
	}

	t.Run("a summary has no tracks", func(t *testing.T) {
		ts := newTestServer(t, func(ApiRequest) (any, error) {
			return &ApiContextTracks{Uri: "spotify:playlist:xxx", Ready: true, Length: 3, Cached: 2, Failed: 1, Revision: "0000002a8f3c", FetchedAt: 1790340000000}, nil
		})

		resp := ts.do(http.MethodGet, "/context/tracks?uri=spotify:playlist:xxx&meta=0", nil)
		require.Equal(t, http.StatusOK, resp.StatusCode)
		require.JSONEq(t, `{"uri":"spotify:playlist:xxx","ready":true,"length":3,"cached":2,"failed":1,
			"sweeping":false,"revision":"0000002a8f3c","fetched_at":1790340000000,"truncated":false}`, body(t, resp))
	})

	t.Run("entries are failed only when they are", func(t *testing.T) {
		ts := newTestServer(t, func(ApiRequest) (any, error) {
			return &ApiContextTracks{Uri: "spotify:playlist:xxx", Ready: true, Length: 2, Failed: 1, Tracks: &[]ApiContextTrackItem{
				{Uri: "spotify:track:xxx", Failed: true},
				{Uri: "spotify:track:yyy"},
			}}, nil
		})

		resp := ts.do(http.MethodGet, "/context/tracks?uri=spotify:playlist:xxx", nil)
		require.Equal(t, http.StatusOK, resp.StatusCode)
		require.JSONEq(t, `{"uri":"spotify:playlist:xxx","ready":true,"length":2,"cached":0,"failed":1,
			"sweeping":false,"revision":"","fetched_at":0,"truncated":false,"tracks":[
			{"uri":"spotify:track:xxx","track":null,"failed":true},
			{"uri":"spotify:track:yyy","track":null}]}`, body(t, resp))
	})
}

func TestApiGetLiked(t *testing.T) {
	t.Run("forwards comma-separated uris", func(t *testing.T) {
		ts := newTestServer(t, func(ApiRequest) (any, error) {
			return &ApiLikedStates{Items: []ApiLikedState{{Uri: "spotify:track:4uLU6hMCjMI75M1A2tKUQC", Liked: true}}}, nil
		})

		resp := ts.do(http.MethodGet, "/library/liked?uris=spotify:track:4uLU6hMCjMI75M1A2tKUQC,spotify:track:37i9dQZF1DXcBWIGoYBM5M", nil)
		require.Equal(t, http.StatusOK, resp.StatusCode)
		require.JSONEq(t, `{"items":[{"uri":"spotify:track:4uLU6hMCjMI75M1A2tKUQC","liked":true}]}`, body(t, resp))

		req := ts.request()
		require.Equal(t, ApiRequestTypeGetLiked, req.Type)
		require.Equal(t, []string{"spotify:track:4uLU6hMCjMI75M1A2tKUQC", "spotify:track:37i9dQZF1DXcBWIGoYBM5M"}, req.Data)
	})

	for _, query := range []string{"", "?uris=", "?uris=spotify:album:4uLU6hMCjMI75M1A2tKUQC", "?uris=nope"} {
		t.Run("rejects "+query, func(t *testing.T) {
			ts := newTestServer(t, okReply)

			resp := ts.do(http.MethodGet, "/library/liked"+query, nil)
			require.Equal(t, http.StatusBadRequest, resp.StatusCode)
			ts.requireNoRequest()
		})
	}
}

func TestApiSetLiked(t *testing.T) {
	t.Run("forwards the payload", func(t *testing.T) {
		ts := newTestServer(t, okReply)

		resp := ts.do(http.MethodPost, "/library/liked", map[string]any{"uris": []string{"spotify:track:4uLU6hMCjMI75M1A2tKUQC"}, "liked": true})
		require.Equal(t, http.StatusOK, resp.StatusCode)

		req := ts.request()
		require.Equal(t, ApiRequestTypeSetLiked, req.Type)
		require.Equal(t, ApiSetLiked{Uris: []string{"spotify:track:4uLU6hMCjMI75M1A2tKUQC"}, Liked: true}, req.Data)
	})

	tooMany := make([]string, 51)
	for i := range tooMany {
		tooMany[i] = "spotify:track:4uLU6hMCjMI75M1A2tKUQC"
	}
	for name, payload := range map[string]any{
		"missing liked": map[string]any{"uris": []string{"spotify:track:4uLU6hMCjMI75M1A2tKUQC"}},
		"null liked":    map[string]any{"uris": []string{"spotify:track:4uLU6hMCjMI75M1A2tKUQC"}, "liked": nil},
		"no uris":       map[string]any{"uris": []string{}, "liked": true},
		"too many":      map[string]any{"uris": tooMany, "liked": true},
		"not track":     map[string]any{"uris": []string{"spotify:album:4uLU6hMCjMI75M1A2tKUQC"}, "liked": true},
		"garbage":       map[string]any{"uris": []string{"nope"}, "liked": true},
	} {
		t.Run("rejects "+name, func(t *testing.T) {
			ts := newTestServer(t, okReply)

			resp := ts.do(http.MethodPost, "/library/liked", payload)
			require.Equal(t, http.StatusBadRequest, resp.StatusCode)
			ts.requireNoRequest()
		})
	}
}

func TestApiPlaylistAddTracks(t *testing.T) {
	t.Run("forwards the payload", func(t *testing.T) {
		ts := newTestServer(t, okReply)

		resp := ts.do(http.MethodPost, "/library/playlists/add_tracks", map[string]any{
			"playlist_uri": "spotify:playlist:37i9dQZF1DXcBWIGoYBM5M",
			"uris":         []string{"spotify:track:4uLU6hMCjMI75M1A2tKUQC", "spotify:episode:4uLU6hMCjMI75M1A2tKUQC"},
		})
		require.Equal(t, http.StatusOK, resp.StatusCode)

		req := ts.request()
		require.Equal(t, ApiRequestTypePlaylistAddTracks, req.Type)
		require.Equal(t, "spotify:playlist:37i9dQZF1DXcBWIGoYBM5M", req.Data.(ApiPlaylistAddTracks).PlaylistUri)
	})

	for name, payload := range map[string]any{
		"album as playlist": map[string]any{"playlist_uri": "spotify:album:37i9dQZF1DXcBWIGoYBM5M", "uris": []string{"spotify:track:4uLU6hMCjMI75M1A2tKUQC"}},
		"no uris":           map[string]any{"playlist_uri": "spotify:playlist:37i9dQZF1DXcBWIGoYBM5M", "uris": []string{}},
		"artist item":       map[string]any{"playlist_uri": "spotify:playlist:37i9dQZF1DXcBWIGoYBM5M", "uris": []string{"spotify:artist:4uLU6hMCjMI75M1A2tKUQC"}},
	} {
		t.Run("rejects "+name, func(t *testing.T) {
			ts := newTestServer(t, okReply)

			resp := ts.do(http.MethodPost, "/library/playlists/add_tracks", payload)
			require.Equal(t, http.StatusBadRequest, resp.StatusCode)
			ts.requireNoRequest()
		})
	}

	t.Run("maps a lasting conflict to 409", func(t *testing.T) {
		ts := newTestServer(t, func(ApiRequest) (any, error) {
			return nil, fmt.Errorf("failed appending to playlist: %w", spclient.ErrPlaylistConflict)
		})

		resp := ts.do(http.MethodPost, "/library/playlists/add_tracks", map[string]any{
			"playlist_uri": "spotify:playlist:37i9dQZF1DXcBWIGoYBM5M",
			"uris":         []string{"spotify:track:4uLU6hMCjMI75M1A2tKUQC"},
		})
		require.Equal(t, http.StatusConflict, resp.StatusCode)
	})
}

func TestApiSetDeviceName(t *testing.T) {
	t.Run("forwards the name", func(t *testing.T) {
		ts := newTestServer(t, okReply)

		resp := ts.do(http.MethodPost, "/set_device_name", map[string]any{"name": "kitchen"})
		require.Equal(t, http.StatusOK, resp.StatusCode)

		req := ts.request()
		require.Equal(t, ApiRequestSetDeviceName, req.Type)
		require.Equal(t, "kitchen", req.Data)
	})

	t.Run("rejects an empty name", func(t *testing.T) {
		ts := newTestServer(t, okReply)

		resp := ts.do(http.MethodPost, "/set_device_name", map[string]any{"name": ""})
		require.Equal(t, http.StatusBadRequest, resp.StatusCode)
		ts.requireNoRequest()
	})
}

func TestApiReopenOutput(t *testing.T) {
	t.Run("forwards the device", func(t *testing.T) {
		ts := newTestServer(t, okReply)

		resp := ts.do(http.MethodPost, "/player/output", map[string]any{"device": "hw:1,0"})
		require.Equal(t, http.StatusOK, resp.StatusCode)

		req := ts.request()
		require.Equal(t, ApiRequestTypeReopenOutput, req.Type)
		require.Equal(t, "hw:1,0", req.Data)
	})

	// An empty device is meaningful here: it selects the configured default.
	t.Run("accepts an empty device", func(t *testing.T) {
		ts := newTestServer(t, okReply)

		resp := ts.do(http.MethodPost, "/player/output", map[string]any{"device": ""})
		require.Equal(t, http.StatusOK, resp.StatusCode)
		require.Equal(t, "", ts.request().Data)
	})
}

func TestApiOutputDelay(t *testing.T) {
	t.Run("forwards the delay and answers with the result", func(t *testing.T) {
		ts := newTestServer(t, func(ApiRequest) (any, error) {
			return &ApiOutputDelayResult{DelayMs: 1500, Republished: true, PositionMs: 0}, nil
		})

		resp := ts.do(http.MethodPost, "/player/output_delay", map[string]any{"delay_ms": 1500})
		require.Equal(t, http.StatusOK, resp.StatusCode)
		require.JSONEq(t, `{"delay_ms":1500,"republished":true,"position_ms":0}`, body(t, resp))

		req := ts.request()
		require.Equal(t, ApiRequestTypeOutputDelay, req.Type)
		require.Equal(t, ApiOutputDelay{DelayMs: 1500}, req.Data)
	})

	for name, payload := range map[string]string{
		"missing":      `{}`,
		"null":         `{"delay_ms":null}`,
		"negative":     `{"delay_ms":-1}`,
		"too long":     `{"delay_ms":120001}`,
		"not a number": `{"delay_ms":"10"}`,
		"fractional":   `{"delay_ms":1.5}`,
	} {
		t.Run("rejects "+name, func(t *testing.T) {
			ts := newTestServer(t, okReply)

			resp := ts.do(http.MethodPost, "/player/output_delay", payload)
			require.Equal(t, http.StatusBadRequest, resp.StatusCode)
			ts.requireNoRequest()
		})
	}
}

func TestApiErrorsMapToStatusCodes(t *testing.T) {
	for _, tt := range []struct {
		err  error
		want int
	}{
		{ErrNoSession, http.StatusNoContent},
		{ErrForbidden, http.StatusForbidden},
		{ErrNotFound, http.StatusNotFound},
		{ErrMethodNotAllowed, http.StatusMethodNotAllowed},
		{ErrTooManyRequests, http.StatusTooManyRequests},
		{ErrBadRequest, http.StatusBadRequest},
		{errors.New("something else"), http.StatusInternalServerError},
	} {
		t.Run(fmt.Sprint(tt.want), func(t *testing.T) {
			ts := newTestServer(t, func(ApiRequest) (any, error) { return nil, tt.err })

			resp := ts.do(http.MethodGet, "/status", nil)
			require.Equal(t, tt.want, resp.StatusCode)
		})
	}
}

func TestApiNewErrorsMapToStatusCodes(t *testing.T) {
	for _, tt := range []struct {
		err  error
		want int
	}{
		{ErrConflict, http.StatusConflict},
		{ErrUpstream, http.StatusBadGateway},
	} {
		t.Run(fmt.Sprint(tt.want), func(t *testing.T) {
			ts := newTestServer(t, func(ApiRequest) (any, error) { return nil, tt.err })

			resp := ts.do(http.MethodGet, "/jam/current", nil)
			require.Equal(t, tt.want, resp.StatusCode)
			require.Empty(t, resp.Header.Get("Retry-After"))
			require.Empty(t, resp.Header.Get("X-Upstream-Status"))
		})
	}
}

// Errors are matched with errors.Is, so a wrapped sentinel must map the same way.
func TestApiWrappedErrorsMapToStatusCodes(t *testing.T) {
	ts := newTestServer(t, func(ApiRequest) (any, error) {
		return nil, fmt.Errorf("while doing the thing: %w", ErrNotFound)
	})

	resp := ts.do(http.MethodGet, "/status", nil)
	require.Equal(t, http.StatusNotFound, resp.StatusCode)
}

// A request nothing takes must be answered rather than park its handler.
func TestApiUnreadRequestIsUnavailable(t *testing.T) {
	old := requestPickupTimeout
	requestPickupTimeout = 50 * time.Millisecond
	t.Cleanup(func() { requestPickupTimeout = old })

	ts := newTestServer(t, nil)

	resp := ts.do(http.MethodGet, "/status", nil)
	require.Equal(t, http.StatusServiceUnavailable, resp.StatusCode)
}

// Without zeroconf nothing reads the requests until the login is done, so they
// are answered as the zeroconf branch answers them without a session.
func TestAnswerWithoutSession(t *testing.T) {
	ts := newTestServer(t, nil)
	app := &App{server: ts.server}

	stop := app.answerWithoutSession(context.Background())

	resp := ts.do(http.MethodGet, "/", nil)
	require.Equal(t, http.StatusOK, resp.StatusCode)

	resp = ts.do(http.MethodGet, "/status", nil)
	require.Equal(t, http.StatusNoContent, resp.StatusCode)

	resp = ts.do(http.MethodPost, "/set_device_name", ApiSetDeviceName{Name: "renamed"})
	require.Equal(t, http.StatusNoContent, resp.StatusCode)

	stopped := make(chan struct{})
	go func() {
		stop()
		close(stopped)
	}()
	select {
	case <-stopped:
	case <-time.After(time.Second):
		t.Fatal("stop did not return")
	}

	// Once stopped, requests reach whoever reads next: the player, normally.
	go func() {
		req := <-ts.server.Receive()
		req.Reply(&ApiStatus{Username: "someone"}, nil)
	}()

	resp = ts.do(http.MethodGet, "/status", nil)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.Contains(t, body(t, resp), "someone")
}

func TestApiUnknownPathIsNotFound(t *testing.T) {
	ts := newTestServer(t, okReply)

	// The generated router registers the root as "GET /{$}", an exact match, so
	// unrouted paths 404. Before codegen "/" was a plain ServeMux catch-all and
	// this answered 200 with the root payload.
	resp := ts.do(http.MethodGet, "/nope", nil)
	require.Equal(t, http.StatusNotFound, resp.StatusCode)
	ts.requireNoRequest()
}

func TestApiEventsWebsocketReceivesEmittedEvents(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)

	s := &ConcreteApiServer{
		log:      &librespot.NullLogger{},
		listener: listener,
		requests: make(chan ApiRequest),
	}
	go s.serve()
	t.Cleanup(func() { _ = s.Close() })

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, "ws://"+listener.Addr().String()+"/events", nil)
	require.NoError(t, err)
	defer func() { _ = conn.Close(websocket.StatusNormalClosure, "") }()

	// Emit only reaches clients already registered, and registration finishes
	// asynchronously after the handshake returns.
	require.Eventually(t, func() bool {
		s.clientsLock.RLock()
		defer s.clientsLock.RUnlock()
		return len(s.clients) == 1
	}, 2*time.Second, 10*time.Millisecond)

	s.Emit(&ApiEvent{Type: ApiEventTypeVolume, Data: ApiEventDataVolume{Value: 55, Max: 100}})

	_, raw, err := conn.Read(ctx)
	require.NoError(t, err)
	require.JSONEq(t, `{"type":"volume","data":{"value":55,"max":100}}`, string(raw))
}

// A listener that stops reading must not hold up whoever emitted the event —
// that caller is the player loop.
func TestApiEmitDoesNotBlockOnAStalledClient(t *testing.T) {
	s := &ConcreteApiServer{log: &librespot.NullLogger{}}
	client := &wsClient{
		events: make(chan *ApiEvent, wsEventQueueSize),
		done:   make(chan struct{}),
	}

	s.clientsLock.Lock()
	s.clients = append(s.clients, client)
	s.clientsLock.Unlock()

	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := range uint32(wsEventQueueSize * 4) {
			s.Emit(&ApiEvent{Type: ApiEventTypeVolume, Data: ApiEventDataVolume{Value: i, Max: 100}})
		}
	}()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Emit blocked on a client that never reads")
	}

	require.Len(t, client.events, wsEventQueueSize, "the queue is bounded")

	// The events kept are the most recent ones: a listener that fell behind
	// converges on the current state rather than replaying a stale backlog.
	ev := <-client.events
	require.Equal(t, uint32(wsEventQueueSize*3), ev.Data.(ApiEventDataVolume).Value)
}

// Once a client is gone, sending to it reports failure instead of filling a
// queue nobody will drain.
func TestApiSendToClosedClientGivesUp(t *testing.T) {
	client := &wsClient{
		events: make(chan *ApiEvent, 1),
		done:   make(chan struct{}),
	}
	client.close()
	client.close() // idempotent: both GetEvents and Close reach for it

	require.False(t, client.send(&librespot.NullLogger{}, &ApiEvent{Type: ApiEventTypeVolume}))
}

func TestApiPlayerQueue(t *testing.T) {
	ts := newTestServer(t, func(ApiRequest) (any, error) {
		return &ApiPlayerQueue{
			ContextUri: "spotify:list:jam-list:163dc0978f246346e7f1d14a4dd2bb9d",
			Rev:        "9f3a6c1e0b2d4471",
			Current:    &ApiQueueEntry{Uri: "spotify:track:xxx", Uid: "u0", Provider: "context"},
			Next: []ApiQueueEntry{{
				Uri: "spotify:track:yyy", Uid: "q1", Provider: "queue",
				Metadata: map[string]string{"is_queued": "true"},
			}},
		}, nil
	})

	resp := ts.do(http.MethodGet, "/player/queue", nil)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.JSONEq(t, `{
		"context_uri": "spotify:list:jam-list:163dc0978f246346e7f1d14a4dd2bb9d",
		"rev": "9f3a6c1e0b2d4471",
		"current": {"uri": "spotify:track:xxx", "uid": "u0", "provider": "context"},
		"next": [{"uri": "spotify:track:yyy", "uid": "q1", "provider": "queue", "metadata": {"is_queued": "true"}}]
	}`, body(t, resp))
	require.Equal(t, ApiRequestTypePlayerQueue, ts.request().Type)
}

// Each Jam route hands the daemon its own request, with the Jam it names.
func TestApiJamRoutesForward(t *testing.T) {
	for _, tt := range []struct {
		method string
		path   string
		body   any
		typ    ApiRequestType
		data   any
	}{
		{http.MethodGet, "/jam/current", nil, ApiRequestTypeJamCurrent, nil},
		{http.MethodPost, "/jam/start", nil, ApiRequestTypeJamStart, nil},
		{http.MethodPost, "/jam/start", "{}", ApiRequestTypeJamStart, nil},
		{http.MethodGet, "/jam/info?token=Tok-en_1", nil, ApiRequestTypeJamInfo, ApiRequestDataJam{Token: "Tok-en_1"}},
		{http.MethodPost, "/jam/join", map[string]any{"token": "Tok-en_1"}, ApiRequestTypeJamJoin, ApiRequestDataJam{Token: "Tok-en_1"}},
		{http.MethodPost, "/jam/leave", map[string]any{"session_id": "sid_1"}, ApiRequestTypeJamLeave, ApiRequestDataJam{SessionId: "sid_1"}},
		{http.MethodPost, "/jam/end", map[string]any{"session_id": "sid_1"}, ApiRequestTypeJamEnd, ApiRequestDataJam{SessionId: "sid_1"}},
		{http.MethodPost, "/jam/remove", map[string]any{"session_id": "sid_1", "member_id": "0123456789abcdef0123456789abcdef"},
			ApiRequestTypeJamRemove, ApiRequestDataJam{SessionId: "sid_1", MemberId: "0123456789abcdef0123456789abcdef"}},
		{http.MethodPost, "/jam/forget", "{}", ApiRequestTypeJamForget, nil},
		{http.MethodPost, "/jam/activate", nil, ApiRequestTypeJamActivate, nil},
		{http.MethodPost, "/jam/activate", "{}", ApiRequestTypeJamActivate, nil},
		{http.MethodGet, "/jam/broadcast", nil, ApiRequestTypeJamBroadcastGet, nil},
		{http.MethodPost, "/jam/broadcast", map[string]any{"status": "on"}, ApiRequestTypeJamBroadcastSet, ApiRequestDataJam{Broadcast: "BROADCAST_ON"}},
		{http.MethodPost, "/jam/broadcast", map[string]any{"status": "off"}, ApiRequestTypeJamBroadcastSet, ApiRequestDataJam{Broadcast: "BROADCAST_OFF"}},
	} {
		t.Run(tt.method+tt.path, func(t *testing.T) {
			ts := newTestServer(t, func(ApiRequest) (any, error) { return &ApiJamSession{}, nil })

			resp := ts.do(tt.method, tt.path, tt.body)
			require.Equal(t, http.StatusOK, resp.StatusCode)
			require.JSONEq(t, `{}`, body(t, resp))

			req := ts.request()
			require.Equal(t, tt.typ, req.Type)
			require.Equal(t, tt.data, req.Data)
		})
	}
}

// A token or session id that cannot be one never reaches the daemon, and so
// never reaches social-connect.
func TestApiJamRoutesValidate(t *testing.T) {
	for _, tt := range []struct {
		method string
		path   string
		body   any
	}{
		{http.MethodGet, "/jam/info", nil},
		{http.MethodGet, "/jam/info?token=", nil},
		{http.MethodGet, "/jam/info?token=a%2Fb", nil},
		{http.MethodGet, "/jam/info?token=" + strings.Repeat("a", 129), nil},
		{http.MethodPost, "/jam/join", nil},
		{http.MethodPost, "/jam/join", "{"},
		{http.MethodPost, "/jam/join", map[string]any{"token": "../x"}},
		{http.MethodPost, "/jam/join", map[string]any{"token": 7}},
		{http.MethodPost, "/jam/leave", map[string]any{}},
		{http.MethodPost, "/jam/leave", map[string]any{"session_id": "a b"}},
		{http.MethodPost, "/jam/end", map[string]any{"session_id": ""}},
		{http.MethodPost, "/jam/end", "not json"},
		{http.MethodPost, "/jam/remove", map[string]any{"session_id": "sid_1"}},
		{http.MethodPost, "/jam/remove", map[string]any{"member_id": "mid_1"}},
		{http.MethodPost, "/jam/remove", map[string]any{"session_id": "sid_1", "member_id": "a/b"}},
		{http.MethodPost, "/jam/remove", map[string]any{"session_id": "s d", "member_id": "mid_1"}},
		{http.MethodPost, "/jam/remove", map[string]any{"session_id": "sid_1", "member_id": strings.Repeat("a", 129)}},
		{http.MethodPost, "/jam/remove", map[string]any{"session_id": "sid_1", "member_id": 7}},
		{http.MethodPost, "/jam/start", "not json"},
		{http.MethodPost, "/jam/forget", "{"},
		{http.MethodPost, "/jam/activate", "{"},
		{http.MethodPost, "/jam/activate", "not json"},
		{http.MethodPost, "/jam/broadcast", nil},
		{http.MethodPost, "/jam/broadcast", "{}"},
		{http.MethodPost, "/jam/broadcast", "null"},
		{http.MethodPost, "/jam/broadcast", map[string]any{"status": "ON"}},
		{http.MethodPost, "/jam/broadcast", map[string]any{"status": "BROADCAST_ON"}},
		{http.MethodPost, "/jam/broadcast", map[string]any{"status": ""}},
		{http.MethodPost, "/jam/broadcast", map[string]any{"status": true}},
		{http.MethodPost, "/jam/broadcast", map[string]any{"broadcast": "on"}},
		{http.MethodPost, "/jam/broadcast", "not json"},
	} {
		t.Run(fmt.Sprint(tt.method, tt.path, tt.body), func(t *testing.T) {
			ts := newTestServer(t, okReply)

			resp := ts.do(tt.method, tt.path, tt.body)
			require.Equal(t, http.StatusBadRequest, resp.StatusCode)
			ts.requireNoRequest()
		})
	}
}

// What a Jam route answers: the session as it came, {} without one, and
// {"not_found": true} for the current session social-connect does not know.
func TestApiJamBodies(t *testing.T) {
	session := `{"session_id":"sid","session_members":[{"username":"jake","display_name":"Jake"}],"queue_only_mode":false}`

	for _, tt := range []struct {
		answer any
		want   string
	}{
		{&ApiJamSession{Session: json.RawMessage(session)}, `{"session":` + session + `}`},
		{&ApiJamSession{}, `{}`},
		{&ApiJamSession{NotFound: true}, `{"not_found":true}`},
		{&ApiJamForget{Changed: true}, `{"changed":true}`},
		{&ApiJamForget{}, `{"changed":false}`},
		{&ApiJamActivate{Changed: true}, `{"changed":true}`},
		{&ApiJamActivate{}, `{"changed":false}`},
	} {
		ts := newTestServer(t, func(ApiRequest) (any, error) { return tt.answer, nil })

		resp := ts.do(http.MethodGet, "/jam/current", nil)
		require.Equal(t, http.StatusOK, resp.StatusCode)
		require.Equal(t, tt.want+"\n", body(t, resp), "byte for byte")
	}
}

// /jam/activate refused (not the active device, nothing loaded, a Jam's
// playback already) is a 409 and nothing else: no body, and neither
// Retry-After nor X-Upstream-Status, since Spotify was not asked.
func TestApiJamActivateRefused(t *testing.T) {
	ts := newTestServer(t, func(ApiRequest) (any, error) {
		return nil, &apiError{kind: ErrConflict, err: errors.New("x")}
	})

	resp := ts.do(http.MethodPost, "/jam/activate", nil)
	require.Equal(t, http.StatusConflict, resp.StatusCode)
	require.Empty(t, body(t, resp))
	require.Empty(t, resp.Header.Get("Retry-After"))
	require.Empty(t, resp.Header.Get("X-Upstream-Status"))
	require.Equal(t, ApiRequestTypeJamActivate, ts.request().Type)
}

// Errors carry Retry-After when there is advice, and Spotify's own status
// whenever it answered, so that a 401 can be told from a 403 and Spotify's
// 404 from a route missing here.
func TestApiJamErrors(t *testing.T) {
	for _, tt := range []struct {
		name       string
		err        error
		status     int
		retryAfter string
		upstream   string
	}{
		{"refused token", &spclient.StatusError{StatusCode: 401}, http.StatusForbidden, "", "401"},
		{"forbidden", &spclient.StatusError{StatusCode: 403}, http.StatusForbidden, "", "403"},
		{"not found", &spclient.StatusError{StatusCode: 404}, http.StatusNotFound, "", "404"},
		{"conflict", &spclient.StatusError{StatusCode: 409}, http.StatusConflict, "", "409"},
		{"rate limited", &spclient.StatusError{StatusCode: 429, RetryAfter: 90 * time.Second}, http.StatusTooManyRequests, "90", "429"},
		{"rate limited, no advice", &spclient.StatusError{StatusCode: 429}, http.StatusTooManyRequests, "60", "429"},
		{"server error", &spclient.StatusError{StatusCode: 503}, http.StatusBadGateway, "", "503"},
		{"unusable answer", &spclient.SocialResponseError{Op: "current", StatusCode: 200}, http.StatusBadGateway, "", "200"},
		{"gate", &spclient.SocialGateError{RetryAfter: 1500 * time.Millisecond}, http.StatusTooManyRequests, "2", ""},
		{"no answer", &spclient.SocialNetworkError{Op: "current", Err: context.DeadlineExceeded}, http.StatusBadGateway, "", ""},
	} {
		t.Run(tt.name, func(t *testing.T) {
			ts := newTestServer(t, func(ApiRequest) (any, error) { return nil, socialApiError(tt.err) })

			resp := ts.do(http.MethodPost, "/jam/start", nil)
			require.Equal(t, tt.status, resp.StatusCode)
			require.Equal(t, tt.retryAfter, resp.Header.Get("Retry-After"))
			require.Equal(t, tt.upstream, resp.Header.Get("X-Upstream-Status"))
		})
	}
}

// /jam/broadcast answers the status and whether it named this device, and
// fails as the other Jam routes do, on either method.
func TestApiJamBroadcast(t *testing.T) {
	ts := newTestServer(t, func(ApiRequest) (any, error) {
		return &ApiJamBroadcast{BroadcastStatus: "BROADCAST_ON", Self: true}, nil
	})
	resp := ts.do(http.MethodPost, "/jam/broadcast", `{"status":"on"}`)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.Equal(t, `{"broadcast_status":"BROADCAST_ON","self":true}`+"\n", body(t, resp), "byte for byte")

	for _, tt := range []struct {
		name       string
		err        error
		status     int
		retryAfter string
		upstream   string
	}{
		{"refused token", &spclient.StatusError{StatusCode: 401}, http.StatusForbidden, "", "401"},
		{"not found", &spclient.StatusError{StatusCode: 404}, http.StatusNotFound, "", "404"},
		{"rate limited", &spclient.StatusError{StatusCode: 429}, http.StatusTooManyRequests, "60", "429"},
		{"gate", &spclient.SocialGateError{RetryAfter: 1500 * time.Millisecond}, http.StatusTooManyRequests, "2", ""},
		{"bad device id", spclient.ErrSocialArgument, http.StatusBadRequest, "", ""},
		{"server error", &spclient.StatusError{StatusCode: 503}, http.StatusBadGateway, "", "503"},
		{"no answer", &spclient.SocialNetworkError{Op: "jam_status", Err: context.DeadlineExceeded}, http.StatusBadGateway, "", ""},
	} {
		for _, method := range []string{http.MethodGet, http.MethodPost} {
			t.Run(method+" "+tt.name, func(t *testing.T) {
				ts := newTestServer(t, func(ApiRequest) (any, error) { return nil, socialApiError(tt.err) })

				var reqBody any
				if method == http.MethodPost {
					reqBody = `{"status":"off"}`
				}
				resp := ts.do(method, "/jam/broadcast", reqBody)
				require.Equal(t, tt.status, resp.StatusCode)
				require.Equal(t, tt.retryAfter, resp.Header.Get("Retry-After"))
				require.Equal(t, tt.upstream, resp.Header.Get("X-Upstream-Status"))
			})
		}
	}
}

// Patch 3 items 7 and 9 (guest control, a guest's add) were not in the capture
// of the official client: their routes do not exist, and /status does not list
// them. Item 8, remove, was, and is.
func TestApiJamUncapturedRoutesAreAbsent(t *testing.T) {
	ts := newTestServer(t, okReply)

	for _, name := range []string{"settings", "queue"} {
		resp := ts.do(http.MethodPost, "/jam/"+name, "{}")
		require.Equal(t, http.StatusNotFound, resp.StatusCode)
		require.NotContains(t, jamRoutes, name)
	}
	ts.requireNoRequest()

	require.Contains(t, jamRoutes, "remove")
}

// An Up Next edit hands the daemon the row, the revision and for a move the
// row to precede; a missing before is the end of the section.
func TestApiQueueEditsForward(t *testing.T) {
	for _, tt := range []struct {
		path string
		body string
		typ  ApiRequestType
		data ApiRequestDataQueueEdit
	}{
		{"/player/queue/remove", `{"rev":"9f3a6c1e0b2d4471","uid":"q1"}`, ApiRequestTypeQueueRemove, ApiRequestDataQueueEdit{Rev: "9f3a6c1e0b2d4471", Uid: "q1"}},
		{"/player/queue/remove", `{"rev":"","uid":"q1","before":"u2"}`, ApiRequestTypeQueueRemove, ApiRequestDataQueueEdit{Uid: "q1"}},
		{"/player/queue/move", `{"rev":"9f3a6c1e0b2d4471","uid":"u3","before":"u1"}`, ApiRequestTypeQueueMove, ApiRequestDataQueueEdit{Rev: "9f3a6c1e0b2d4471", Uid: "u3", Before: "u1"}},
		{"/player/queue/move", `{"rev":"9f3a6c1e0b2d4471","uid":"u3","before":""}`, ApiRequestTypeQueueMove, ApiRequestDataQueueEdit{Rev: "9f3a6c1e0b2d4471", Uid: "u3"}},
		{"/player/queue/move", `{"rev":"9f3a6c1e0b2d4471","uid":"u3"}`, ApiRequestTypeQueueMove, ApiRequestDataQueueEdit{Rev: "9f3a6c1e0b2d4471", Uid: "u3"}},
		{"/player/queue/move", `{"rev":"9f3a6c1e0b2d4471","uid":"u3","before":null}`, ApiRequestTypeQueueMove, ApiRequestDataQueueEdit{Rev: "9f3a6c1e0b2d4471", Uid: "u3"}},
		{"/player/queue/move", `{"rev":"x","uid":"` + "u" + `","before":"` + strings.Repeat("b", 128) + `"}`, ApiRequestTypeQueueMove, ApiRequestDataQueueEdit{Rev: "x", Uid: "u", Before: strings.Repeat("b", 128)}},
		{"/player/queue/top", `{"rev":"9f3a6c1e0b2d4471","uid":"u3"}`, ApiRequestTypeQueueTop, ApiRequestDataQueueEdit{Rev: "9f3a6c1e0b2d4471", Uid: "u3"}},
		{"/player/queue/top", `{"rev":"","uid":"q1","before":"u2"}`, ApiRequestTypeQueueTop, ApiRequestDataQueueEdit{Uid: "q1"}},
	} {
		t.Run(tt.path+" "+tt.body, func(t *testing.T) {
			ts := newTestServer(t, func(ApiRequest) (any, error) { return &ApiQueueRevision{Rev: "0123456789abcdef"}, nil })

			resp := ts.do(http.MethodPost, tt.path, tt.body)
			require.Equal(t, http.StatusOK, resp.StatusCode)
			require.JSONEq(t, `{"rev":"0123456789abcdef"}`, body(t, resp))

			req := ts.request()
			require.Equal(t, tt.typ, req.Type)
			require.Equal(t, tt.data, req.Data)
		})
	}
}

// A malformed edit never reaches the daemon.
func TestApiQueueEditsValidate(t *testing.T) {
	for _, tt := range []struct {
		path string
		body string
	}{
		{"/player/queue/remove", ``},
		{"/player/queue/remove", `{`},
		{"/player/queue/remove", `{"uid":"q1"}`},
		{"/player/queue/remove", `{"rev":7,"uid":"q1"}`},
		{"/player/queue/remove", `{"rev":null,"uid":"q1"}`},
		{"/player/queue/remove", `{"rev":"r"}`},
		{"/player/queue/remove", `{"rev":"r","uid":""}`},
		{"/player/queue/remove", `{"rev":"r","uid":7}`},
		{"/player/queue/remove", `{"rev":"r","uid":"` + strings.Repeat("u", 129) + `"}`},
		{"/player/queue/move", `{"rev":"r","uid":"u1","before":"u1"}`},
		{"/player/queue/move", `{"rev":"r","uid":"u1","before":7}`},
		{"/player/queue/move", `{"rev":"r","uid":"u1","before":"` + strings.Repeat("b", 129) + `"}`},
		{"/player/queue/move", `{"rev":"r","before":"u1"}`},
		{"/player/queue/top", ``},
		{"/player/queue/top", `{"uid":"q1"}`},
		{"/player/queue/top", `{"rev":"r","uid":""}`},
		{"/player/queue/top", `{"rev":"r","uid":7}`},
		{"/player/queue/top", `{"rev":"r","uid":"` + strings.Repeat("u", 129) + `"}`},
		{"/player/queue/jump", ``},
		{"/player/queue/jump", `{`},
		{"/player/queue/jump", `{}`},
		{"/player/queue/jump", `{"uid":null}`},
		{"/player/queue/jump", `{"uid":""}`},
		{"/player/queue/jump", `{"uid":7}`},
		{"/player/queue/jump", `{"uid":"` + strings.Repeat("u", 129) + `"}`},
	} {
		t.Run(tt.path+" "+tt.body, func(t *testing.T) {
			ts := newTestServer(t, okReply)

			resp := ts.do(http.MethodPost, tt.path, tt.body)
			require.Equal(t, http.StatusBadRequest, resp.StatusCode)
			ts.requireNoRequest()
		})
	}
}

// Encore patch 9: a jump hands the daemon the row's uid alone, and answers
// with the new revision; a rev in the body is ignored.
func TestApiQueueJumpForwards(t *testing.T) {
	for _, payload := range []string{`{"uid":"u3"}`, `{"uid":"u3","rev":"9f3a6c1e0b2d4471"}`} {
		ts := newTestServer(t, func(ApiRequest) (any, error) { return &ApiQueueRevision{Rev: "0123456789abcdef"}, nil })

		resp := ts.do(http.MethodPost, "/player/queue/jump", payload)
		require.Equal(t, http.StatusOK, resp.StatusCode)
		require.JSONEq(t, `{"rev":"0123456789abcdef"}`, body(t, resp))

		req := ts.request()
		require.Equal(t, ApiRequestTypeQueueJump, req.Type)
		require.Equal(t, ApiRequestDataQueueJump{Uid: "u3"}, req.Data)
	}

	ts := newTestServer(t, func(ApiRequest) (any, error) { return &ApiQueueTopResult{Rev: "0123456789abcdef", Uid: "q4"}, nil })
	resp := ts.do(http.MethodPost, "/player/queue/top", `{"rev":"r","uid":"u3"}`)
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.JSONEq(t, `{"rev":"0123456789abcdef","uid":"q4"}`, body(t, resp))
}

// What a jump the daemon refuses answers.
func TestApiQueueJumpErrors(t *testing.T) {
	for _, tt := range []struct {
		err  error
		want int
	}{
		{&apiError{kind: ErrConflict, err: tracks.ErrNotAhead}, http.StatusConflict},
		{ErrNoSession, http.StatusNoContent},
		{ErrSuperseded, http.StatusConflict},
		{ErrLoaderBusy, http.StatusConflict},
	} {
		t.Run(fmt.Sprint(tt.want, tt.err), func(t *testing.T) {
			ts := newTestServer(t, func(ApiRequest) (any, error) { return nil, tt.err })

			resp := ts.do(http.MethodPost, "/player/queue/jump", `{"uid":"q1"}`)
			require.Equal(t, tt.want, resp.StatusCode)
		})
	}
}

// What an edit the daemon refuses answers.
func TestApiQueueEditErrors(t *testing.T) {
	for _, tt := range []struct {
		err  error
		want int
	}{
		{&apiError{kind: ErrConflict, err: errQueueRowGone}, http.StatusConflict},
		{&apiError{kind: ErrBadRequest, err: errQueueRowGone}, http.StatusBadRequest},
		{ErrNoSession, http.StatusNoContent},
		{ErrSuperseded, http.StatusConflict},
		{ErrLoaderBusy, http.StatusConflict},
	} {
		t.Run(fmt.Sprint(tt.want, tt.err), func(t *testing.T) {
			ts := newTestServer(t, func(ApiRequest) (any, error) { return nil, tt.err })

			resp := ts.do(http.MethodPost, "/player/queue/remove", `{"rev":"r","uid":"q1"}`)
			require.Equal(t, tt.want, resp.StatusCode)
			require.Empty(t, resp.Header.Get("X-Upstream-Status"))
		})
	}
}
