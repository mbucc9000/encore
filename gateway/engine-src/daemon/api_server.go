package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	librespot "github.com/devgianlu/go-librespot"
	"github.com/devgianlu/go-librespot/player"
	metadatapb "github.com/devgianlu/go-librespot/proto/spotify/metadata"
	"github.com/devgianlu/go-librespot/spclient"
	"github.com/rs/cors"
)

const timeout = 10 * time.Second

// requestPickupTimeout bounds how long a request waits for the daemon to take
// it. A variable so tests need not wait it out.
var requestPickupTimeout = timeout

type ApiServer interface {
	Emit(ev *ApiEvent)
	Receive() <-chan ApiRequest
	SetAuthCode(auth *ApiDeviceAuth)
	Close() error
}

type ConcreteApiServer struct {
	log librespot.Logger

	allowOrigin string
	certFile    string
	keyFile     string

	// close is read by the websocket loop and by serve while Close writes it
	// from whichever goroutine shuts the daemon down.
	close    atomic.Bool
	listener net.Listener

	requests chan ApiRequest

	// authCode is the pending device authorization pairing code.
	authCode atomic.Pointer[ApiDeviceAuth]

	clients     []*wsClient
	clientsLock sync.RWMutex
}

// wsEventQueueSize is how many events a websocket client may fall behind by
// before the oldest ones start being dropped.
const wsEventQueueSize = 64

// wsClient is one connected event listener. Events are handed to its own writer
// goroutine rather than written inline, so that a client which has stopped
// reading cannot hold up whoever emitted the event — that is the player loop.
type wsClient struct {
	conn      *websocket.Conn
	events    chan *ApiEvent
	done      chan struct{}
	closeOnce sync.Once
}

func (c *wsClient) close() {
	c.closeOnce.Do(func() { close(c.done) })
}

// send queues an event, making room by discarding the oldest when the client is
// too far behind: a listener that falls behind is better off converging on the
// current state than replaying a stale backlog.
func (c *wsClient) send(log librespot.Logger, ev *ApiEvent) bool {
	select {
	case <-c.done:
		return false
	default:
	}

	for range 2 {
		select {
		case c.events <- ev:
			return true
		default:
		}

		select {
		case <-c.events:
			log.Warnf("websocket client is not keeping up, dropping an event")
		default:
		}
	}

	return false
}

var (
	ErrNoSession        = errors.New("no session")
	ErrBadRequest       = errors.New("bad request")
	ErrForbidden        = errors.New("forbidden")
	ErrNotFound         = errors.New("not found")
	ErrMethodNotAllowed = errors.New("method not allowed")
	ErrTooManyRequests  = errors.New("the app has exceeded its rate limits")
	ErrConflict         = errors.New("conflict")
	ErrUpstream         = errors.New("upstream failed")
)

// apiErrorDetail is implemented by errors that tell the client more than a
// status: how long to wait before asking again, and what Spotify answered.
type apiErrorDetail interface {
	// retryAfter is how long to wait before asking again, zero for no advice.
	retryAfter() time.Duration
	// upstreamStatus is the status Spotify answered with, zero when it did
	// not answer.
	upstreamStatus() int
}

// apiError is a failure that carries a sentinel above for its status, and the
// details of apiErrorDetail.
type apiError struct {
	kind     error
	err      error
	wait     time.Duration
	upstream int
}

func (e *apiError) Error() string             { return e.err.Error() }
func (e *apiError) Unwrap() []error           { return []error{e.kind, e.err} }
func (e *apiError) retryAfter() time.Duration { return e.wait }
func (e *apiError) upstreamStatus() int       { return e.upstream }

type ApiRequestType string

const (
	ApiRequestTypeRoot                ApiRequestType = "root"
	ApiRequestTypeStatus              ApiRequestType = "status"
	ApiRequestTypeResume              ApiRequestType = "resume"
	ApiRequestTypePause               ApiRequestType = "pause"
	ApiRequestTypePlayPause           ApiRequestType = "playpause"
	ApiRequestTypeSeek                ApiRequestType = "seek"
	ApiRequestTypePrev                ApiRequestType = "prev"
	ApiRequestTypeNext                ApiRequestType = "next"
	ApiRequestTypePlay                ApiRequestType = "play"
	ApiRequestTypeStop                ApiRequestType = "stop"
	ApiRequestTypeGetVolume           ApiRequestType = "get_volume"
	ApiRequestTypeSetVolume           ApiRequestType = "set_volume"
	ApiRequestTypeSetRepeatingContext ApiRequestType = "repeating_context"
	ApiRequestTypeSetRepeatingTrack   ApiRequestType = "repeating_track"
	ApiRequestTypeSetShufflingContext ApiRequestType = "shuffling_context"
	ApiRequestTypeAddToQueue          ApiRequestType = "add_to_queue"
	ApiRequestTypeToken               ApiRequestType = "token"
	ApiRequestSetDeviceName           ApiRequestType = "set_device_name"
	ApiRequestTypeReopenOutput        ApiRequestType = "reopen_output"
	ApiRequestTypeOutputDelay         ApiRequestType = "output_delay"
	ApiRequestTypeContextTracks       ApiRequestType = "context_tracks"
	ApiRequestTypeLibraryPlaylists    ApiRequestType = "library_playlists"
	ApiRequestTypeSetLiked            ApiRequestType = "set_liked"
	ApiRequestTypeGetLiked            ApiRequestType = "get_liked"
	ApiRequestTypePlaylistAddTracks   ApiRequestType = "playlist_add_tracks"
	ApiRequestTypePlayerQueue         ApiRequestType = "player_queue"
	ApiRequestTypeJamCurrent          ApiRequestType = "jam_current"
	ApiRequestTypeJamStart            ApiRequestType = "jam_start"
	ApiRequestTypeJamInfo             ApiRequestType = "jam_info"
	ApiRequestTypeJamJoin             ApiRequestType = "jam_join"
	ApiRequestTypeJamLeave            ApiRequestType = "jam_leave"
	ApiRequestTypeJamEnd              ApiRequestType = "jam_end"
	ApiRequestTypeJamRemove           ApiRequestType = "jam_remove"
	ApiRequestTypeJamForget           ApiRequestType = "jam_forget"
	ApiRequestTypeJamBroadcastGet     ApiRequestType = "jam_broadcast_get"
	ApiRequestTypeJamBroadcastSet     ApiRequestType = "jam_broadcast_set"
	ApiRequestTypeJamActivate         ApiRequestType = "jam_activate"
	ApiRequestTypeQueueRemove         ApiRequestType = "queue_remove"
	ApiRequestTypeQueueMove           ApiRequestType = "queue_move"
	ApiRequestTypeQueueTop            ApiRequestType = "queue_top"  // Encore patch 9
	ApiRequestTypeQueueJump           ApiRequestType = "queue_jump" // Encore patch 9
)

// ApiRequestDataJam names the Jam a Jam route acts on: by its join token for
// info and join, by its session id for leave, end and remove, and for remove
// the member as well. For the broadcast it is the status to set
// (spclient.BroadcastOn or spclient.BroadcastOff); the device is always this
// one.
type ApiRequestDataJam struct {
	Token     string
	SessionId string
	MemberId  string
	Broadcast string
}

// ApiRequestDataQueueEdit is an edit of what plays next: the row named by its
// uid, the revision of the rows the client was shown, and for a move the row
// it is to precede ("" for the end of its section).
type ApiRequestDataQueueEdit struct {
	Rev    string
	Uid    string
	Before string
}

// ApiRequestDataQueueJump is a jump to a row that plays next, named by its uid.
// Encore patch 9.
type ApiRequestDataQueueJump struct {
	Uid string
}

// ApiRequestDataContextTracks carries the query parameters of the context
// listing request; the spec generates payloads only for request bodies. The
// zero value of everything but Uri asks for what the parameters default to:
// every entry described, and the metadata swept.
type ApiRequestDataContextTracks struct {
	Uri string

	// Refresh drops the reused listing first, so the context is enumerated
	// again (refresh=true).
	Refresh bool

	// Summary leaves the entries out and only counts them (meta=false).
	Summary bool

	// From and Limit select the entries described. A nil Limit runs to the
	// end of the listing.
	From  int
	Limit *int

	// NoSweep enumerates the context if needed but fetches no metadata for it
	// (sweep=false).
	NoSweep bool
}

// ApiRequestDataLibraryPlaylists carries the paging query parameters of the
// library playlists request.
type ApiRequestDataLibraryPlaylists struct {
	Offset int
	Limit  int
}

type ApiEventType string

const (
	ApiEventTypePlaying        ApiEventType = "playing"
	ApiEventTypeNotPlaying     ApiEventType = "not_playing"
	ApiEventTypeWillPlay       ApiEventType = "will_play"
	ApiEventTypePaused         ApiEventType = "paused"
	ApiEventTypeActive         ApiEventType = "active"
	ApiEventTypeInactive       ApiEventType = "inactive"
	ApiEventTypeMetadata       ApiEventType = "metadata"
	ApiEventTypeVolume         ApiEventType = "volume"
	ApiEventTypeSeek           ApiEventType = "seek"
	ApiEventTypeStopped        ApiEventType = "stopped"
	ApiEventTypeRepeatTrack    ApiEventType = "repeat_track"
	ApiEventTypeRepeatContext  ApiEventType = "repeat_context"
	ApiEventTypeShuffleContext ApiEventType = "shuffle_context"
	ApiEventTypePlaybackReady  ApiEventType = "playback_ready"
	ApiEventTypePlaybackError  ApiEventType = "playback_error"
	ApiEventTypeJam            ApiEventType = "jam"
	ApiEventTypeQueue          ApiEventType = "queue"
	ApiEventTypeCommand        ApiEventType = "command"
	ApiEventTypeSocialConnect  ApiEventType = "social_connect"
	ApiEventTypeCluster        ApiEventType = "cluster"
)

type ApiRequest struct {
	Type ApiRequestType
	Data any

	resp chan apiResponse
}

func (r *ApiRequest) Reply(data any, err error) {
	r.resp <- apiResponse{data, err}
}

// NewApiRequest builds an ApiRequest pre-wired with a reply channel, plus a
// wait function that blocks until the daemon calls Reply (or ctx is done).
func NewApiRequest(t ApiRequestType, data any) (req ApiRequest, wait func(context.Context) (any, error)) {
	ch := make(chan apiResponse, 1)
	req = ApiRequest{Type: t, Data: data, resp: ch}
	wait = func(ctx context.Context) (any, error) {
		select {
		case r := <-ch:
			return r.data, r.err
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return
}

type apiResponse struct {
	data any
	err  error
}

func getBestImageIdForSize(images []*metadatapb.Image, size string) []byte {
	if len(images) == 0 {
		return nil
	}

	imageSize := metadatapb.Image_Size(metadatapb.Image_Size_value[strings.ToUpper(size)])

	dist := func(a metadatapb.Image_Size) int {
		diff := int(a) - int(imageSize)
		if diff < 0 {
			return -diff
		}
		return diff
	}

	// Find an image with the exact requested size.
	// If no exact match, return the closest image to the requested size.
	var bestImage *metadatapb.Image
	for _, img := range images {
		if img.Size == nil {
			continue
		}

		if *img.Size == imageSize {
			return img.FileId
		}

		// Find the image with the closest size. This logic works because the
		// metadatapb.Image_Size enum values are ordered from smallest to largest.
		if bestImage == nil || dist(*img.Size) < dist(*bestImage.Size) {
			bestImage = img
		}
	}

	if bestImage != nil {
		return bestImage.FileId
	}

	// Fallback to the first image if none have size information.
	return images[0].FileId
}

func (p *AppPlayer) newApiResponseStatusTrack(stream *player.Stream, position int64) *ApiTrack {
	media := stream.Media

	resp := p.newApiResponseStatusMedia(media, position)

	// The context entry the stream was asked for. Relinking can hand back
	// other media, which uri names, and a client matching the track against
	// the context listing needs the entry.
	if stream.RequestedId.Type() != librespot.SpotifyIdTypeUnknown {
		resp.ContextTrackUri = stream.RequestedId.Uri()
	}

	// The file is what actually got decoded, so report from it rather than from
	// the requested bitrate: they differ whenever the preferred format was not
	// on offer.
	if stream.File != nil && stream.File.Format != nil {
		format := *stream.File.Format
		resp.Format = format.String()
		resp.Codec = TrackCodec(player.GetFormatCodec(format))
		if bitrate := player.GetFormatBitrate(format); bitrate > 0 {
			resp.Bitrate = &bitrate
		}
	}

	// Taken from the decoder rather than the format name so they stay honest if
	// the player ever stops requiring 44100Hz.
	if stream.SampleRate > 0 {
		sampleRate := int(stream.SampleRate)
		resp.SampleRate = &sampleRate
	}
	if stream.BitDepth > 0 {
		bitDepth := int(stream.BitDepth)
		resp.BitDepth = &bitDepth
	}

	return resp
}

func (p *AppPlayer) newApiResponseStatusMedia(media *librespot.Media, position int64) *ApiTrack {
	if media.IsTrack() {
		track := media.Track()

		var artists []string
		for _, a := range track.Artist {
			artists = append(artists, *a.Name)
		}

		albumCoverId := getBestImageIdForSize(track.Album.Cover, p.app.cfg.ImageSize)
		if albumCoverId == nil && track.Album.CoverGroup != nil {
			albumCoverId = getBestImageIdForSize(track.Album.CoverGroup.Image, p.app.cfg.ImageSize)
		}

		artistUris := make([]string, 0, len(track.Artist))
		for _, a := range track.Artist {
			artistUris = append(artistUris, gidUri(librespot.SpotifyIdTypeArtist, a.GetGid()))
		}

		return &ApiTrack{
			Uri:           librespot.SpotifyIdFromGid(librespot.SpotifyIdTypeTrack, track.Gid).Uri(),
			Name:          *track.Name,
			ArtistNames:   artists,
			ArtistUris:    artistUris,
			AlbumName:     *track.Album.Name,
			AlbumUri:      gidUri(librespot.SpotifyIdTypeAlbum, track.Album.GetGid()),
			AlbumCoverUrl: p.prodInfo.ImageUrl(albumCoverId),
			Position:      position,
			Duration:      int(*track.Duration),
			ReleaseDate:   track.Album.Date.String(),
			TrackNumber:   int(*track.Number),
			DiscNumber:    int(*track.DiscNumber),
			Explicit:      track.GetExplicit(),
		}
	} else {
		episode := media.Episode()

		albumCoverId := getBestImageIdForSize(episode.CoverImage.Image, p.app.cfg.ImageSize)

		return &ApiTrack{
			Uri:           librespot.SpotifyIdFromGid(librespot.SpotifyIdTypeEpisode, episode.Gid).Uri(),
			Name:          *episode.Name,
			ArtistNames:   []string{*episode.Show.Name},
			ArtistUris:    []string{},
			AlbumName:     *episode.Show.Name,
			AlbumUri:      gidUri(librespot.SpotifyIdTypeShow, episode.Show.GetGid()),
			AlbumCoverUrl: p.prodInfo.ImageUrl(albumCoverId),
			Position:      position,
			Duration:      int(*episode.Duration),
			ReleaseDate:   "",
			TrackNumber:   0,
			DiscNumber:    0,
			Explicit:      false,
		}
	}
}

// gidUri turns a metadata gid into a URI of the given type, or "" when the
// gid is missing or malformed.
func gidUri(typ librespot.SpotifyIdType, gid []byte) string {
	if len(gid) != 16 {
		return ""
	}
	return librespot.SpotifyIdFromGid(typ, gid).Uri()
}

type ApiEvent struct {
	Type ApiEventType `json:"type"`
	Data any          `json:"data"`
}

type ApiEventDataMetadata ApiTrack

type ApiEventDataVolume ApiVolume

type ApiEventDataPlaying struct {
	ContextUri string `json:"context_uri"`
	Uri        string `json:"uri"`
	Resume     bool   `json:"resume"`
	PlayOrigin string `json:"play_origin"`
}

type ApiEventDataWillPlay struct {
	ContextUri string `json:"context_uri"`
	Uri        string `json:"uri"`
	PlayOrigin string `json:"play_origin"`
}

type ApiEventDataNotPlaying struct {
	ContextUri string `json:"context_uri"`
	Uri        string `json:"uri"`
	PlayOrigin string `json:"play_origin"`
}

type ApiEventDataPaused struct {
	ContextUri string `json:"context_uri"`
	Uri        string `json:"uri"`
	PlayOrigin string `json:"play_origin"`
}

type ApiEventDataStopped struct {
	PlayOrigin string `json:"play_origin"`
}

type ApiEventDataPlaybackError struct {
	ContextUri string `json:"context_uri"`
	Uri        string `json:"uri"`
	PlayOrigin string `json:"play_origin"`
	Stage      string `json:"stage"`
	Kind       string `json:"kind"`
	Unplayable bool   `json:"unplayable"`
	Message    string `json:"message"`
}

type ApiEventDataSeek struct {
	ContextUri string `json:"context_uri"`
	Uri        string `json:"uri"`
	Position   int    `json:"position"`
	Duration   int    `json:"duration"`
	PlayOrigin string `json:"play_origin"`
}

type ApiEventDataRepeatTrack struct {
	Value bool `json:"value"`
}

type ApiEventDataRepeatContext struct {
	Value bool `json:"value"`
}

type ApiEventDataShuffleContext struct {
	Value bool `json:"value"`
}

// ApiEventDataJam is what the options and the session say about a Jam: the
// jam mode as it stands ("on", "off" or ""), the device the playback came
// from, and the context.
type ApiEventDataJam struct {
	Mode       string `json:"mode"`
	Origin     string `json:"origin"`
	ContextUri string `json:"context_uri"`
}

// ApiEventDataQueue is empty: the event only says what plays next may have
// changed, and /player/queue says how.
type ApiEventDataQueue struct{}

// ApiEventDataCommand is a player command another device sent.
type ApiEventDataCommand struct {
	Endpoint string `json:"endpoint"`
	From     string `json:"from"`

	// Continues is set on transfers: whether it carries on the playing
	// stream.
	Continues *bool `json:"continues,omitempty"`

	// JamEnd is set when a Jam's list arrived without a track, and the device
	// was left idle.
	JamEnd bool `json:"jam_end,omitempty"`

	// Error is set on a transfer the engine could not apply: "unmarshal" for
	// one it could not read, "nothing_to_play" for one with neither a context
	// nor a track. Continues is false then.
	Error string `json:"error,omitempty"`
}

// ApiEventDataCluster is what a cluster update says about a Jam, by kinds and
// counts only, never an id: which kind of device it names active ("self",
// "social" for social-connect's, "other" or "none"), how many of its devices
// are social-connect's, and whether its player state is in a Jam's list, its
// jam mode ("on", "off" or ""), and whether its play origin is
// social-connect's.
type ApiEventDataCluster struct {
	Active        string `json:"active"`
	SocialDevices int    `json:"social_devices"`
	JamContext    bool   `json:"jam_context"`
	JamMode       string `json:"jam_mode"`
	SocialOrigin  bool   `json:"social_origin"`
}

// ApiEventDataSocialConnect is a message social-connect pushed: its payload
// when that is JSON of at most 64 KB, else only its size.
type ApiEventDataSocialConnect struct {
	Uri          string          `json:"uri"`
	Payload      json.RawMessage `json:"payload,omitempty"`
	PayloadBytes *int            `json:"payload_bytes,omitempty"`
}

func NewApiServer(log librespot.Logger, address string, port int, allowOrigin string, certFile string, keyFile string) (_ ApiServer, err error) {
	s := &ConcreteApiServer{log: log, allowOrigin: allowOrigin, certFile: certFile, keyFile: keyFile}
	s.requests = make(chan ApiRequest)

	s.listener, err = net.Listen("tcp", fmt.Sprintf("%s:%d", address, port))
	if err != nil {
		return nil, fmt.Errorf("failed starting api listener: %w", err)
	}

	log.Infof("api server listening on %s", s.listener.Addr())

	go s.serve()
	return s, nil
}

type StubApiServer struct {
	log librespot.Logger
}

func NewStubApiServer(log librespot.Logger) (ApiServer, error) {
	return &StubApiServer{log: log}, nil
}

func (s *StubApiServer) Emit(ev *ApiEvent) {
	s.log.Tracef("voiding websocket event: %s", ev.Type)
}

func (s *StubApiServer) Receive() <-chan ApiRequest {
	return make(<-chan ApiRequest)
}

func (s *StubApiServer) SetAuthCode(*ApiDeviceAuth) {}

func (s *StubApiServer) Close() error {
	return nil
}

func (s *ConcreteApiServer) handleRequest(req ApiRequest, w http.ResponseWriter) {
	req.resp = make(chan apiResponse, 1)

	// Only the hand-off is bounded: once taken, a request is answered, if
	// perhaps later (see errReplyDeferred). One nobody takes is owed nothing,
	// and waiting on it would park this handler for good.
	pickup := time.NewTimer(requestPickupTimeout)
	defer pickup.Stop()

	select {
	case s.requests <- req:
	case <-pickup.C:
		s.log.Warnf("nothing picked up request %s", req.Type)
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}

	resp := <-req.resp

	if resp.err != nil {
		var detail apiErrorDetail
		if errors.As(resp.err, &detail) {
			if wait := detail.retryAfter(); wait > 0 {
				w.Header().Set("Retry-After", strconv.FormatInt(int64((wait+time.Second-1)/time.Second), 10))
			}
			if status := detail.upstreamStatus(); status > 0 {
				w.Header().Set("X-Upstream-Status", strconv.Itoa(status))
			}
		}

		switch {
		case errors.Is(resp.err, ErrNoSession):
			w.WriteHeader(http.StatusNoContent)
			return
		case errors.Is(resp.err, ErrForbidden):
			w.WriteHeader(http.StatusForbidden)
			return
		case errors.Is(resp.err, ErrNotFound):
			w.WriteHeader(http.StatusNotFound)
			return
		case errors.Is(resp.err, ErrMethodNotAllowed):
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		case errors.Is(resp.err, ErrTooManyRequests):
			w.WriteHeader(http.StatusTooManyRequests)
			return
		case errors.Is(resp.err, ErrSuperseded), errors.Is(resp.err, ErrLoaderBusy), errors.Is(resp.err, spclient.ErrPlaylistConflict), errors.Is(resp.err, ErrConflict):
			w.WriteHeader(http.StatusConflict)
			return
		case errors.Is(resp.err, ErrBadRequest):
			w.WriteHeader(http.StatusBadRequest)
			return
		case errors.Is(resp.err, ErrUpstream):
			w.WriteHeader(http.StatusBadGateway)
			return
		default:
			s.log.WithError(resp.err).Errorf("failed handling request %s", req.Type)
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
	}

	switch respData := resp.data.(type) {
	case []byte:
		w.Header().Set("Content-Type", "application/octet-stream")
		_, _ = w.Write(respData)
	default:
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(respData)
	}
}

func jsonDecode(r *http.Request, v any) error {
	defer func() { _ = r.Body.Close() }()

	data, err := io.ReadAll(r.Body)
	if err != nil {
		return err
	} else if len(data) == 0 {
		return nil
	}

	return json.Unmarshal(data, v)
}

// The handlers below implement the generated ServerInterface; the routing that
// dispatches to them is generated from api-spec.yml into api_gen.go. Each one
// decodes and validates its payload, then hands an ApiRequest to the daemon and
// blocks on the reply.

var _ ServerInterface = (*ConcreteApiServer)(nil)

func (s *ConcreteApiServer) GetRoot(w http.ResponseWriter, _ *http.Request) {
	s.handleRequest(ApiRequest{Type: ApiRequestTypeRoot}, w)
}

func (s *ConcreteApiServer) GetStatus(w http.ResponseWriter, _ *http.Request) {
	s.handleRequest(ApiRequest{Type: ApiRequestTypeStatus}, w)
}

func (s *ConcreteApiServer) GetAuthCode(w http.ResponseWriter, _ *http.Request) {
	auth := s.authCode.Load()
	if auth == nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(auth)
}

func (s *ConcreteApiServer) GetToken(w http.ResponseWriter, _ *http.Request) {
	s.handleRequest(ApiRequest{Type: ApiRequestTypeToken}, w)
}

func (s *ConcreteApiServer) GetContextTracks(w http.ResponseWriter, _ *http.Request, params GetContextTracksParams) {
	if params.From < 0 || (params.Limit != nil && *params.Limit < 0) {
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	// meta and sweep default to true, so only an explicit false counts.
	s.handleRequest(ApiRequest{Type: ApiRequestTypeContextTracks, Data: ApiRequestDataContextTracks{
		Uri:     params.Uri,
		Refresh: params.Refresh,
		Summary: params.Meta != nil && !*params.Meta,
		From:    params.From,
		Limit:   params.Limit,
		NoSweep: params.Sweep != nil && !*params.Sweep,
	}}, w)
}

// Paging bounds of /library/playlists, matching the spec.
const (
	libraryPlaylistsDefaultLimit = 50
	libraryPlaylistsMaxLimit     = 500
)

func (s *ConcreteApiServer) GetLibraryPlaylists(w http.ResponseWriter, r *http.Request, params GetLibraryPlaylistsParams) {
	// The generated params cannot tell an absent limit from limit=0.
	if !r.URL.Query().Has("limit") {
		params.Limit = libraryPlaylistsDefaultLimit
	}

	if params.Offset < 0 || params.Limit < 1 || params.Limit > libraryPlaylistsMaxLimit {
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	s.handleRequest(ApiRequest{Type: ApiRequestTypeLibraryPlaylists, Data: ApiRequestDataLibraryPlaylists{Offset: params.Offset, Limit: params.Limit}}, w)
}

// maxLibraryUris caps how many items one library request may name.
const maxLibraryUris = 50

// validItemUris reports whether uris holds 1 to maxLibraryUris URIs, all
// of one of the given types.
func validItemUris(uris []string, types ...librespot.SpotifyIdType) bool {
	if len(uris) == 0 || len(uris) > maxLibraryUris {
		return false
	}

	for _, uri := range uris {
		id, err := librespot.SpotifyIdFromUri(uri)
		if err != nil || !slices.Contains(types, id.Type()) {
			return false
		}
	}

	return true
}

func (s *ConcreteApiServer) GetLiked(w http.ResponseWriter, _ *http.Request, params GetLikedParams) {
	if !validItemUris(params.Uris, librespot.SpotifyIdTypeTrack) {
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	s.handleRequest(ApiRequest{Type: ApiRequestTypeGetLiked, Data: params.Uris}, w)
}

func (s *ConcreteApiServer) SetLiked(w http.ResponseWriter, r *http.Request) {
	// liked is required: decoded into a plain bool, a missing or null value
	// would read as false and remove the tracks from Liked Songs.
	var data struct {
		Uris  []string `json:"uris"`
		Liked *bool    `json:"liked"`
	}
	if err := jsonDecode(r, &data); err != nil || data.Liked == nil || !validItemUris(data.Uris, librespot.SpotifyIdTypeTrack) {
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	s.handleRequest(ApiRequest{Type: ApiRequestTypeSetLiked, Data: ApiSetLiked{Uris: data.Uris, Liked: *data.Liked}}, w)
}

func (s *ConcreteApiServer) PlaylistAddTracks(w http.ResponseWriter, r *http.Request) {
	var data ApiPlaylistAddTracks
	if err := jsonDecode(r, &data); err != nil || !validItemUris(data.Uris, librespot.SpotifyIdTypeTrack, librespot.SpotifyIdTypeEpisode) {
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	if id, err := librespot.SpotifyIdFromUri(data.PlaylistUri); err != nil || id.Type() != librespot.SpotifyIdTypePlaylist {
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	s.handleRequest(ApiRequest{Type: ApiRequestTypePlaylistAddTracks, Data: data}, w)
}

func (s *ConcreteApiServer) PlayerResume(w http.ResponseWriter, _ *http.Request) {
	s.handleRequest(ApiRequest{Type: ApiRequestTypeResume}, w)
}

func (s *ConcreteApiServer) PlayerPause(w http.ResponseWriter, _ *http.Request) {
	s.handleRequest(ApiRequest{Type: ApiRequestTypePause}, w)
}

func (s *ConcreteApiServer) PlayerPlayPause(w http.ResponseWriter, _ *http.Request) {
	s.handleRequest(ApiRequest{Type: ApiRequestTypePlayPause}, w)
}

func (s *ConcreteApiServer) PlayerStop(w http.ResponseWriter, _ *http.Request) {
	s.handleRequest(ApiRequest{Type: ApiRequestTypeStop}, w)
}

func (s *ConcreteApiServer) PlayerPrev(w http.ResponseWriter, _ *http.Request) {
	s.handleRequest(ApiRequest{Type: ApiRequestTypePrev}, w)
}

func (s *ConcreteApiServer) PlayerGetVolume(w http.ResponseWriter, _ *http.Request) {
	s.handleRequest(ApiRequest{Type: ApiRequestTypeGetVolume}, w)
}

func (s *ConcreteApiServer) PlayerPlay(w http.ResponseWriter, r *http.Request) {
	var data ApiPlay
	if err := jsonDecode(r, &data); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	if len(data.Uri) == 0 {
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	s.handleRequest(ApiRequest{Type: ApiRequestTypePlay, Data: data}, w)
}

func (s *ConcreteApiServer) PlayerNext(w http.ResponseWriter, r *http.Request) {
	var data ApiNext
	if err := jsonDecode(r, &data); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	s.handleRequest(ApiRequest{Type: ApiRequestTypeNext, Data: data}, w)
}

func (s *ConcreteApiServer) PlayerSeek(w http.ResponseWriter, r *http.Request) {
	var data ApiSeek
	if err := jsonDecode(r, &data); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	if !data.Relative && data.Position < 0 {
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	s.handleRequest(ApiRequest{Type: ApiRequestTypeSeek, Data: data}, w)
}

func (s *ConcreteApiServer) PlayerSetVolume(w http.ResponseWriter, r *http.Request) {
	var data ApiSetVolume
	if err := jsonDecode(r, &data); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	if !data.Relative && data.Volume < 0 {
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	s.handleRequest(ApiRequest{Type: ApiRequestTypeSetVolume, Data: data}, w)
}

func (s *ConcreteApiServer) PlayerRepeatContext(w http.ResponseWriter, r *http.Request) {
	var data ApiRepeatContext
	if err := jsonDecode(r, &data); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	s.handleRequest(ApiRequest{Type: ApiRequestTypeSetRepeatingContext, Data: data.RepeatContext}, w)
}

func (s *ConcreteApiServer) PlayerRepeatTrack(w http.ResponseWriter, r *http.Request) {
	var data ApiRepeatTrack
	if err := jsonDecode(r, &data); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	s.handleRequest(ApiRequest{Type: ApiRequestTypeSetRepeatingTrack, Data: data.RepeatTrack}, w)
}

func (s *ConcreteApiServer) PlayerShuffleContext(w http.ResponseWriter, r *http.Request) {
	var data ApiShuffleContext
	if err := jsonDecode(r, &data); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	s.handleRequest(ApiRequest{Type: ApiRequestTypeSetShufflingContext, Data: data.ShuffleContext}, w)
}

func (s *ConcreteApiServer) PlayerAddToQueue(w http.ResponseWriter, r *http.Request) {
	var data ApiAddToQueue
	if err := jsonDecode(r, &data); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	if len(data.Uri) == 0 {
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	s.handleRequest(ApiRequest{Type: ApiRequestTypeAddToQueue, Data: data.Uri}, w)
}

func (s *ConcreteApiServer) SetDeviceName(w http.ResponseWriter, r *http.Request) {
	var data ApiSetDeviceName
	if err := jsonDecode(r, &data); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	if len(data.Name) == 0 {
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	s.handleRequest(ApiRequest{Type: ApiRequestSetDeviceName, Data: data.Name}, w)
}

func (s *ConcreteApiServer) PlayerOutput(w http.ResponseWriter, r *http.Request) {
	var data ApiOutput
	if err := jsonDecode(r, &data); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	s.handleRequest(ApiRequest{Type: ApiRequestTypeReopenOutput, Data: data.Device}, w)
}

// maxOutputDelay bounds /player/output_delay, matching the spec.
const maxOutputDelay = 120 * time.Second

func (s *ConcreteApiServer) PlayerOutputDelay(w http.ResponseWriter, r *http.Request) {
	// delay_ms is required: decoded into a plain int64, a missing value would
	// read as no delay at all.
	var data struct {
		DelayMs *int64 `json:"delay_ms"`
	}
	if err := jsonDecode(r, &data); err != nil || data.DelayMs == nil || *data.DelayMs < 0 || *data.DelayMs > maxOutputDelay.Milliseconds() {
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	s.handleRequest(ApiRequest{Type: ApiRequestTypeOutputDelay, Data: ApiOutputDelay{DelayMs: *data.DelayMs}}, w)
}

func (s *ConcreteApiServer) GetPlayerQueue(w http.ResponseWriter, _ *http.Request) {
	s.handleRequest(ApiRequest{Type: ApiRequestTypePlayerQueue}, w)
}

// emptyBody reports whether a request's body is absent or JSON, which is all a
// route that takes an empty object asks of it.
func emptyBody(r *http.Request) bool {
	var data any
	return jsonDecode(r, &data) == nil
}

func (s *ConcreteApiServer) GetJamCurrent(w http.ResponseWriter, _ *http.Request) {
	s.handleRequest(ApiRequest{Type: ApiRequestTypeJamCurrent}, w)
}

func (s *ConcreteApiServer) JamStart(w http.ResponseWriter, r *http.Request) {
	if !emptyBody(r) {
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	s.handleRequest(ApiRequest{Type: ApiRequestTypeJamStart}, w)
}

func (s *ConcreteApiServer) GetJamInfo(w http.ResponseWriter, _ *http.Request, params GetJamInfoParams) {
	if !spclient.ValidSocialId(params.Token) {
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	s.handleRequest(ApiRequest{Type: ApiRequestTypeJamInfo, Data: ApiRequestDataJam{Token: params.Token}}, w)
}

func (s *ConcreteApiServer) JamJoin(w http.ResponseWriter, r *http.Request) {
	var data ApiJamToken
	if err := jsonDecode(r, &data); err != nil || !spclient.ValidSocialId(data.Token) {
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	s.handleRequest(ApiRequest{Type: ApiRequestTypeJamJoin, Data: ApiRequestDataJam{Token: data.Token}}, w)
}

func (s *ConcreteApiServer) JamLeave(w http.ResponseWriter, r *http.Request) {
	var data ApiJamSessionRef
	if err := jsonDecode(r, &data); err != nil || !spclient.ValidSocialId(data.SessionId) {
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	s.handleRequest(ApiRequest{Type: ApiRequestTypeJamLeave, Data: ApiRequestDataJam{SessionId: data.SessionId}}, w)
}

func (s *ConcreteApiServer) JamEnd(w http.ResponseWriter, r *http.Request) {
	var data ApiJamSessionRef
	if err := jsonDecode(r, &data); err != nil || !spclient.ValidSocialId(data.SessionId) {
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	s.handleRequest(ApiRequest{Type: ApiRequestTypeJamEnd, Data: ApiRequestDataJam{SessionId: data.SessionId}}, w)
}

func (s *ConcreteApiServer) JamRemove(w http.ResponseWriter, r *http.Request) {
	var data ApiJamMemberRef
	if err := jsonDecode(r, &data); err != nil || !spclient.ValidSocialId(data.SessionId) || !spclient.ValidSocialId(data.MemberId) {
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	s.handleRequest(ApiRequest{Type: ApiRequestTypeJamRemove, Data: ApiRequestDataJam{SessionId: data.SessionId, MemberId: data.MemberId}}, w)
}

func (s *ConcreteApiServer) JamForget(w http.ResponseWriter, r *http.Request) {
	if !emptyBody(r) {
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	s.handleRequest(ApiRequest{Type: ApiRequestTypeJamForget}, w)
}

// JamActivate switches this device into Jam mode for a Jam it started itself
// (activateJam): local, like /jam/forget. The body, if any, is JSON.
func (s *ConcreteApiServer) JamActivate(w http.ResponseWriter, r *http.Request) {
	if !emptyBody(r) {
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	s.handleRequest(ApiRequest{Type: ApiRequestTypeJamActivate}, w)
}

func (s *ConcreteApiServer) GetJamBroadcast(w http.ResponseWriter, _ *http.Request) {
	s.handleRequest(ApiRequest{Type: ApiRequestTypeJamBroadcastGet}, w)
}

// JamBroadcast sets this device's Jam broadcast: {"status":"on"} or
// {"status":"off"}, nothing else. Any other body, none included, is refused
// before anything is sent: the broadcast is a write.
func (s *ConcreteApiServer) JamBroadcast(w http.ResponseWriter, r *http.Request) {
	var data ApiJamBroadcastRequest
	if err := jsonDecode(r, &data); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	var broadcast string
	switch string(data.Status) {
	case "on":
		broadcast = spclient.BroadcastOn
	case "off":
		broadcast = spclient.BroadcastOff
	default:
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	s.handleRequest(ApiRequest{Type: ApiRequestTypeJamBroadcastSet, Data: ApiRequestDataJam{Broadcast: broadcast}}, w)
}

func (s *ConcreteApiServer) PlayerQueueRemove(w http.ResponseWriter, r *http.Request) {
	s.queueEdit(w, r, ApiRequestTypeQueueRemove)
}

func (s *ConcreteApiServer) PlayerQueueMove(w http.ResponseWriter, r *http.Request) {
	s.queueEdit(w, r, ApiRequestTypeQueueMove)
}

// PlayerQueueTop is Play Next: the body is a removal's. Encore patch 9.
func (s *ConcreteApiServer) PlayerQueueTop(w http.ResponseWriter, r *http.Request) {
	s.queueEdit(w, r, ApiRequestTypeQueueTop)
}

// PlayerQueueJump checks the body of a jump before the daemon sees it: the uid
// is a string of 1 to maxQueueUid bytes. Encore patch 9.
func (s *ConcreteApiServer) PlayerQueueJump(w http.ResponseWriter, r *http.Request) {
	var data struct {
		Uid *string `json:"uid"`
	}
	if err := jsonDecode(r, &data); err != nil || data.Uid == nil || len(*data.Uid) == 0 || len(*data.Uid) > maxQueueUid {
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	s.handleRequest(ApiRequest{Type: ApiRequestTypeQueueJump, Data: ApiRequestDataQueueJump{Uid: *data.Uid}}, w)
}

// queueEdit checks the body of an Up Next edit before the daemon sees it: rev
// and uid are strings, the uid is 1 to maxQueueUid bytes, and a move's before,
// absent or null for "", is a string of at most as many that is not the uid.
// A removal's and Play Next's before is ignored.
func (s *ConcreteApiServer) queueEdit(w http.ResponseWriter, r *http.Request, typ ApiRequestType) {
	var data struct {
		Rev    *string `json:"rev"`
		Uid    *string `json:"uid"`
		Before *string `json:"before"`
	}
	if err := jsonDecode(r, &data); err != nil || data.Rev == nil || data.Uid == nil ||
		len(*data.Uid) == 0 || len(*data.Uid) > maxQueueUid {
		w.WriteHeader(http.StatusBadRequest)
		return
	}

	edit := ApiRequestDataQueueEdit{Rev: *data.Rev, Uid: *data.Uid}
	if typ == ApiRequestTypeQueueMove && data.Before != nil {
		if len(*data.Before) > maxQueueUid || *data.Before == *data.Uid {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		edit.Before = *data.Before
	}

	s.handleRequest(ApiRequest{Type: typ, Data: edit}, w)
}

func (s *ConcreteApiServer) GetEvents(w http.ResponseWriter, r *http.Request) {
	opts := &websocket.AcceptOptions{}
	if len(s.allowOrigin) > 0 {
		allow := s.allowOrigin
		allow = strings.TrimPrefix(allow, "http://")
		allow = strings.TrimPrefix(allow, "https://")
		allow = strings.TrimSuffix(allow, "/")
		opts.OriginPatterns = []string{allow}
	}

	c, err := websocket.Accept(w, r, opts)
	if err != nil {
		s.log.WithError(err).Error("failed accepting websocket connection")
		w.WriteHeader(http.StatusInternalServerError)
		return
	}

	client := &wsClient{
		conn:   c,
		events: make(chan *ApiEvent, wsEventQueueSize),
		done:   make(chan struct{}),
	}

	s.clientsLock.Lock()
	s.clients = append(s.clients, client)
	s.clientsLock.Unlock()

	go s.writeEvents(client)
	defer client.close()

	s.log.Debugf("new websocket client")

	for {
		_, _, err := c.Read(context.Background())
		if s.close.Load() {
			return
		} else if err != nil {
			s.log.WithError(err).Error("websocket connection errored")

			// remove the client from the list
			s.clientsLock.Lock()
			for i, cc := range s.clients {
				if cc == client {
					s.clients = append(s.clients[:i], s.clients[i+1:]...)
					break
				}
			}
			s.clientsLock.Unlock()
			return
		}
	}
}

// refuseCrossSite (Encore patch 6c) refuses what a web page in a browser sent
// from another site. rs/cors only keeps such a page from reading the answers:
// a "simple" request (a form post, or fetch with mode no-cors) still reaches
// the handler, so any website the user opens could skip, pause or start a Jam
// on this loopback API. Browsers send Origin with every cross-site POST and
// every websocket handshake; the Encore gateway and command-line clients send
// none. An origin that allow_origin allows, and the API's own origin, pass.
func refuseCrossSite(c *cors.Cors, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if origin := r.Header.Get("Origin"); origin != "" && !sameOrigin(origin, r.Host) && !c.OriginAllowed(r) {
			http.Error(w, "cross-site request refused", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func sameOrigin(origin, host string) bool {
	u, err := url.Parse(origin)
	return err == nil && u.Host != "" && strings.EqualFold(u.Host, host)
}

func (s *ConcreteApiServer) serve() {
	m := http.NewServeMux()
	handler := HandlerFromMux(s, m)

	c := cors.New(cors.Options{
		AllowedOrigins:      []string{s.allowOrigin},
		AllowPrivateNetwork: true,
		AllowCredentials:    true,
	})
	h := refuseCrossSite(c, c.Handler(handler))

	var err error
	if len(s.certFile) > 0 && len(s.keyFile) > 0 {
		err = http.ServeTLS(s.listener, h, s.certFile, s.keyFile)
	} else {
		err = http.Serve(s.listener, h)
	}

	if s.close.Load() {
		return
	} else if err != nil {
		s.log.WithError(err).Error("failed serving api")
		_ = s.Close()
	}
}
func (s *ConcreteApiServer) Emit(ev *ApiEvent) {
	s.clientsLock.RLock()
	defer s.clientsLock.RUnlock()

	s.log.Tracef("emitting websocket event: %s", ev.Type)

	for _, client := range s.clients {
		client.send(s.log, ev)
	}
}

// writeEvents delivers one client's events in order. One goroutine per client
// rather than one per event, because listeners rely on the order they arrive in:
// will_play before metadata, paused before playing.
func (s *ConcreteApiServer) writeEvents(client *wsClient) {
	for {
		select {
		case <-client.done:
			return
		case ev := <-client.events:
			ctx, cancel := context.WithTimeout(context.Background(), timeout)
			err := wsjson.Write(ctx, client.conn, ev)
			cancel()
			if err != nil && !s.close.Load() {
				// purposely do not propagate this to the caller
				s.log.WithError(err).Error("failed communicating with websocket client")
			}
		}
	}
}

func (s *ConcreteApiServer) Receive() <-chan ApiRequest {
	return s.requests
}

func (s *ConcreteApiServer) SetAuthCode(auth *ApiDeviceAuth) {
	s.authCode.Store(auth)
}

func (s *ConcreteApiServer) Close() error {
	s.close.Store(true)

	// close all websocket clients
	s.clientsLock.RLock()
	for _, client := range s.clients {
		client.close()
		_ = client.conn.Close(websocket.StatusGoingAway, "")
	}
	s.clientsLock.RUnlock()

	// close the listener
	_ = s.listener.Close()
	return nil
}
