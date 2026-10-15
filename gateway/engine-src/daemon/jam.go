package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"maps"
	"net/http"
	"strings"
	"time"

	"github.com/devgianlu/go-librespot/dealer"
	connectpb "github.com/devgianlu/go-librespot/proto/spotify/connectstate"
	"github.com/devgianlu/go-librespot/spclient"
)

// Spotify Jams (social sessions). A Jam reaches this device as ordinary
// Connect commands sent by social-connect from a virtual device, so playing
// one needs nothing here. What is here lets a client see one and act on it:
// the routes that call social-connect, the events that say what social-connect
// did to the player, the queue as the state holds it, and the Jam's end, which
// would otherwise replay the Jam's list from its first song. Editing what plays
// next is in queue_edit.go, and jumping to a row of it in queue_jump.go.

// socialTimeout bounds a Jam route, its wait in the gate's line included.
const socialTimeout = 20 * time.Second

// jamRoutes are the Jam routes this engine serves, as /status lists them.
var jamRoutes = []string{"current", "start", "info", "join", "leave", "end", "remove", "forget", "broadcast", "activate"}

// socialDevicePrefix starts the device id social-connect sends a Jam's
// commands from.
const socialDevicePrefix = "social-connect-"

// jamListPrefix starts the context uri of a Jam's list.
const jamListPrefix = "spotify:list:jam-list:"

// socialConnect is what the Jam routes call. It is the session's spclient;
// tests stand in for it.
type socialConnect interface {
	SocialCurrent(ctx context.Context) (json.RawMessage, error)
	SocialCurrentOrNew(ctx context.Context) (json.RawMessage, error)
	SocialInfo(ctx context.Context, token string) (json.RawMessage, error)
	SocialJoin(ctx context.Context, token, dev string) (json.RawMessage, error)
	SocialLeave(ctx context.Context, sid string) (json.RawMessage, error)
	SocialEnd(ctx context.Context, sid string) (json.RawMessage, error)
	SocialKick(ctx context.Context, sid, member string) (json.RawMessage, error)
	SocialSetBroadcastStatus(ctx context.Context, dev, status string) (*spclient.BroadcastStatus, error)
	SocialJamStatus(ctx context.Context, dev string) (*spclient.BroadcastStatus, error)
}

func (p *AppPlayer) socialClient() socialConnect {
	if p.social != nil {
		return p.social
	}
	return p.sess.Spclient()
}

// jamRequest answers a Jam route that calls social-connect. The call touches
// no player state, and the gate can keep it waiting in line, so it runs
// detached. Only join and the broadcast calls name this device: join is the
// one call that says which device is to play the Jam, and the broadcast is
// this device's own. No client ever passes a device id.
func (p *AppPlayer) jamRequest(req ApiRequest) (any, error) {
	social, dev := p.socialClient(), p.app.deviceId
	data, _ := req.Data.(ApiRequestDataJam)

	reply := apiReply(req)
	p.goDetached(socialTimeout, func(ctx context.Context) {
		switch req.Type {
		case ApiRequestTypeJamBroadcastGet, ApiRequestTypeJamBroadcastSet:
			var status *spclient.BroadcastStatus
			var err error
			if req.Type == ApiRequestTypeJamBroadcastGet {
				status, err = social.SocialJamStatus(ctx, dev)
			} else {
				status, err = social.SocialSetBroadcastStatus(ctx, dev, data.Broadcast)
			}

			reply.done(p.jamBroadcastAnswer(req.Type, status, err))
			return
		}

		var session json.RawMessage
		var err error
		switch req.Type {
		case ApiRequestTypeJamCurrent:
			session, err = social.SocialCurrent(ctx)
		case ApiRequestTypeJamStart:
			session, err = social.SocialCurrentOrNew(ctx)
		case ApiRequestTypeJamInfo:
			session, err = social.SocialInfo(ctx, data.Token)
		case ApiRequestTypeJamJoin:
			session, err = social.SocialJoin(ctx, data.Token, dev)
		case ApiRequestTypeJamLeave:
			_, err = social.SocialLeave(ctx, data.SessionId)
		case ApiRequestTypeJamEnd:
			_, err = social.SocialEnd(ctx, data.SessionId)
		case ApiRequestTypeJamRemove:
			// The kick answers the session without the member: passed on.
			session, err = social.SocialKick(ctx, data.SessionId, data.MemberId)
		}

		reply.done(p.jamAnswer(req.Type, session, err))
	})

	return nil, errReplyDeferred
}

// jamAnswer is what a Jam route answers: the session as social-connect sent
// it, or nothing. For /jam/current a 404 or 410 is an answer too, not an
// error: the gateway tells it apart from no Jam at all. An empty object there
// is no Jam, like a 204 or an empty body, and answers the same {}.
func (p *AppPlayer) jamAnswer(typ ApiRequestType, session json.RawMessage, err error) (any, error) {
	if err == nil {
		if typ == ApiRequestTypeJamCurrent && emptyObject(session) {
			return &ApiJamSession{}, nil
		}
		return &ApiJamSession{Session: session}, nil
	}

	var statusErr *spclient.StatusError
	if typ == ApiRequestTypeJamCurrent && errors.As(err, &statusErr) &&
		(statusErr.StatusCode == http.StatusNotFound || statusErr.StatusCode == http.StatusGone) {
		return &ApiJamSession{NotFound: true}, nil
	}

	var gateErr *spclient.SocialGateError
	if errors.As(err, &gateErr) {
		p.app.log.Infof("%s not sent: %s", typ, gateErr.Reason)
	}

	return nil, socialApiError(err)
}

// jamBroadcastAnswer is what /jam/broadcast answers: the status social-connect
// gave for this device and whether its answer named it, nothing else of it.
// Errors map as for the other Jam routes.
func (p *AppPlayer) jamBroadcastAnswer(typ ApiRequestType, status *spclient.BroadcastStatus, err error) (any, error) {
	if err == nil {
		if status == nil {
			return &ApiJamBroadcast{}, nil
		}
		return &ApiJamBroadcast{BroadcastStatus: status.Status, Self: status.Self}, nil
	}

	var gateErr *spclient.SocialGateError
	if errors.As(err, &gateErr) {
		p.app.log.Infof("%s not sent: %s", typ, gateErr.Reason)
	}

	return nil, socialApiError(err)
}

// emptyObject reports whether a body as social-connect's client returns it, a
// JSON object trimmed of surrounding space or nil, is an object with nothing
// in it.
func emptyObject(body json.RawMessage) bool {
	n := len(body)
	return n >= 2 && body[0] == '{' && body[n-1] == '}' && len(bytes.TrimSpace(body[1:n-1])) == 0
}

// socialApiError maps a social-connect failure onto the API's answer. Spotify's
// status goes along whenever it answered, so that a client can tell a 401 from
// a 403, and Spotify's 404 from a route missing here.
func socialApiError(err error) error {
	var gateErr *spclient.SocialGateError
	var statusErr *spclient.StatusError
	var respErr *spclient.SocialResponseError

	switch {
	case errors.As(err, &gateErr):
		return &apiError{kind: ErrTooManyRequests, err: err, wait: gateErr.RetryAfter}
	case errors.As(err, &statusErr):
		e := &apiError{kind: ErrUpstream, err: err, upstream: statusErr.StatusCode}
		switch statusErr.StatusCode {
		case http.StatusUnauthorized, http.StatusForbidden:
			e.kind = ErrForbidden
		case http.StatusNotFound, http.StatusGone:
			e.kind = ErrNotFound
		case http.StatusConflict:
			e.kind = ErrConflict
		case http.StatusTooManyRequests:
			// The gate holds every call for at least this long now.
			e.kind = ErrTooManyRequests
			e.wait = max(statusErr.RetryAfter, spclient.SocialMinHold)
		}
		return e
	case errors.As(err, &respErr):
		return &apiError{kind: ErrUpstream, err: err, upstream: respErr.StatusCode}
	case errors.Is(err, spclient.ErrSocialArgument):
		return &apiError{kind: ErrBadRequest, err: err}
	default:
		// No answer: the network, the timeout, or no token to send with.
		return &apiError{kind: ErrUpstream, err: err}
	}
}

// forgetJam switches the jam mode off, as social-connect's own set_options
// would have, once a Jam was ended or left from here and that never came.
// Without it the connect state went on saying the Jam was on.
func (p *AppPlayer) forgetJam() *ApiJamForget {
	if p.state.player.Options.GetModes()["jam"] != "on" {
		return &ApiJamForget{Changed: false}
	}

	p.app.log.Info("the jam mode is still on after the Jam was left or ended, switching it off")
	p.setModes(map[string]string{"jam": "off"})
	return &ApiJamForget{Changed: true}
}

// activateJam switches the jam mode on for a Jam this device started itself:
// what social-connect's set_options {"modes":{"jam":"on"}} does on a Jam's
// speaker (the set_options case calls the same setModes), which Spotify never
// sends the device that starts a Jam: that device puts itself into Jam mode
// (DESIGN-JAM-SELF §1). Only while this device is the active one, with a
// context of its own: never over a Jam's list or playback that came from
// social-connect, which is a Jam Spotify drives. Local: the context, the
// track and the playback stay as they are, nothing is sent to social-connect,
// and the connect state is pushed as for any change (updateState).
// forgetJam is its inverse.
func (p *AppPlayer) activateJam() (*ApiJamActivate, error) {
	refuse := func(why string) (*ApiJamActivate, error) {
		p.app.log.Infof("jam mode not switched on: %s", why)
		return nil, &apiError{kind: ErrConflict, err: errors.New("jam mode not switched on: " + why)}
	}

	switch {
	case !p.state.active:
		return refuse("this device is not the active one")
	case p.state.player.ContextUri == "" || p.state.tracks == nil:
		return refuse("nothing is loaded")
	case strings.HasPrefix(p.state.player.ContextUri, jamListPrefix),
		strings.HasPrefix(p.state.player.PlayOrigin.GetDeviceIdentifier(), socialDevicePrefix):
		return refuse("the playback is a Jam's already")
	}

	if p.state.player.Options.GetModes()["jam"] == "on" {
		return &ApiJamActivate{Changed: false}, nil
	}

	p.app.log.Info("jam mode switched on for a Jam this device started")
	p.setModes(map[string]string{"jam": "on"})
	return &ApiJamActivate{Changed: true}, nil
}

// jamStatus fills in what /status says about Jams, and that this engine edits
// what plays next (queue_edit.go), and how (queue_ops, Encore patch 9).
func (p *AppPlayer) jamStatus(resp *ApiStatus) {
	resp.JamMode = p.state.player.Options.GetModes()["jam"]
	resp.JamRoutes = append([]string(nil), jamRoutes...)
	resp.QueueEdit = true
	resp.QueueOps = append([]string(nil), queueOps...)

	stats := p.app.socialGate.Stats()
	resp.Social = ApiSocialStats{Sends: stats.Sends, Sends5m: stats.SendsWindow, Renewals: stats.Renewals}
	if !stats.HeldUntil.IsZero() {
		resp.Social.HeldUntil = stats.HeldUntil.UnixMilli()
	}
}

// playerQueue describes what plays now and next from the state alone. It
// fetches nothing: whatever moves the window already asks for its metadata
// (publishUpcoming), so a client asking again a moment later gets more. Its
// rev is what an edit of these rows names (queue_edit.go).
func (p *AppPlayer) playerQueue() *ApiPlayerQueue {
	next := p.publishedNext()

	resp := &ApiPlayerQueue{
		ContextUri:  p.state.player.ContextUri,
		ContextName: p.state.player.ContextMetadata["context_description"],
		Rev:         p.queueRev(),
		Next:        make([]ApiQueueEntry, 0, len(next)),
	}

	if track := p.state.player.Track; track != nil {
		entry := p.queueEntry(track)
		resp.Current = &entry
	}
	for _, track := range next {
		resp.Next = append(resp.Next, p.queueEntry(track))
	}

	return resp
}

// queueEntry describes one entry of the state. The metadata is copied: the
// answer is encoded off the player loop.
func (p *AppPlayer) queueEntry(track *connectpb.ProvidedTrack) ApiQueueEntry {
	entry := ApiQueueEntry{Uri: track.Uri, Uid: track.Uid, Provider: track.Provider}
	if len(track.Metadata) > 0 {
		entry.Metadata = maps.Clone(track.Metadata)
	}
	if media := p.app.metaCache.get(track.Uri); media != nil && p.prodInfo != nil {
		entry.Track = p.newApiResponseStatusMedia(media, 0)
	}
	return entry
}

// jamSignal is what the jam event reports: the jam mode, whether the playback
// came from social-connect, and the context.
type jamSignal struct {
	mode       string
	social     bool
	contextUri string
}

// checkJamEvent emits the jam event when what it reports changed since it was
// last emitted. The context counts only while the mode is set or the playback
// came from social-connect, so ordinary playback emits nothing. Every state
// change passes through updateState or flushState, which call this, so it also
// remembers the Jam's list the state last named, for isJamEnd.
func (p *AppPlayer) checkJamEvent() {
	origin := p.state.player.PlayOrigin.GetDeviceIdentifier()
	now := jamSignal{
		mode:       p.state.player.Options.GetModes()["jam"],
		social:     strings.HasPrefix(origin, socialDevicePrefix),
		contextUri: p.state.player.ContextUri,
	}

	if strings.HasPrefix(now.contextUri, jamListPrefix) {
		p.jamList = now.contextUri
	}

	last := p.jamSent
	if now.mode == last.mode && now.social == last.social &&
		(now.contextUri == last.contextUri || (now.mode == "" && !now.social)) {
		return
	}

	p.jamSent = now
	p.app.server.Emit(&ApiEvent{
		Type: ApiEventTypeJam,
		Data: ApiEventDataJam{Mode: now.mode, Origin: origin, ContextUri: now.contextUri},
	})
}

// emitCommand reports a player command another device sent, right before it
// is applied.
func (p *AppPlayer) emitCommand(req dealer.RequestPayload, continues *bool, jamEnd bool) {
	p.app.server.Emit(&ApiEvent{
		Type: ApiEventTypeCommand,
		Data: ApiEventDataCommand{
			Endpoint:  req.Command.Endpoint,
			From:      req.SentByDeviceId,
			Continues: continues,
			JamEnd:    jamEnd,
		},
	})
}

// emitCommandFailed reports a transfer another device sent that is not
// applied: it failed before it was known whether it carries on the stream,
// which is when emitCommand would have reported it. reason names why
// ("unmarshal", "nothing_to_play"). A hand-over dropped this way would
// otherwise leave no trace outside the engine's own log.
func (p *AppPlayer) emitCommandFailed(req dealer.RequestPayload, reason string) {
	continues := false
	p.app.server.Emit(&ApiEvent{
		Type: ApiEventTypeCommand,
		Data: ApiEventDataCommand{
			Endpoint:  req.Command.Endpoint,
			From:      req.SentByDeviceId,
			Continues: &continues,
			Error:     reason,
		},
	})
}

// isSocialDevice reports whether a device of the cluster is social-connect's:
// its id has the prefix its commands come from, or its info says so.
func isSocialDevice(id string, info *connectpb.DeviceInfo) bool {
	return strings.HasPrefix(id, socialDevicePrefix) ||
		strings.HasPrefix(info.GetDeviceId(), socialDevicePrefix) ||
		info.GetIsSocialConnect()
}

// clusterSummary is what the cluster event reports of a cluster: kinds, a
// count and booleans, never an id.
func (p *AppPlayer) clusterSummary(cluster *connectpb.Cluster) ApiEventDataCluster {
	devices := cluster.GetDevice()

	active := cluster.GetActiveDeviceId()
	var kind string
	switch {
	case active == "":
		kind = "none"
	case active == p.app.deviceId:
		kind = "self"
	case isSocialDevice(active, devices[active]):
		kind = "social"
	default:
		kind = "other"
	}

	social := 0
	for id, info := range devices {
		if isSocialDevice(id, info) {
			social++
		}
	}

	state := cluster.GetPlayerState()
	return ApiEventDataCluster{
		Active:        kind,
		SocialDevices: social,
		JamContext:    strings.HasPrefix(state.GetContextUri(), jamListPrefix),
		JamMode:       state.GetOptions().GetModes()["jam"],
		SocialOrigin:  strings.HasPrefix(state.GetPlayOrigin().GetDeviceIdentifier(), socialDevicePrefix),
	}
}

// checkClusterEvent emits the cluster event when what it reports of a cluster
// update differs from what it last emitted: which kind of device the cluster
// names active, how many of its devices are social-connect's, and whether its
// player state is in a Jam's list, has the jam mode set, or came from
// social-connect. It only reads: whether this device stops being active is
// decided after it, as before.
func (p *AppPlayer) checkClusterEvent(cluster *connectpb.Cluster) {
	now := p.clusterSummary(cluster)
	if last := p.clusterSent; last != nil && *last == now {
		return
	}

	p.clusterSent = &now
	p.app.server.Emit(&ApiEvent{Type: ApiEventTypeCluster, Data: now})
}

// queueEventInterval is how long a queue event waits, so that a burst of
// changes makes one.
const queueEventInterval = 500 * time.Millisecond

// scheduleQueueEvent arms the queue event, unless it already is.
func (p *AppPlayer) scheduleQueueEvent() {
	if p.queueEventPending {
		return
	}

	p.queueEventPending = true
	p.queueEventTimer.Reset(queueEventInterval)
}

// emitQueueEvent is the fire of the queue event timer.
func (p *AppPlayer) emitQueueEvent() {
	p.queueEventPending = false
	p.app.server.Emit(&ApiEvent{Type: ApiEventTypeQueue, Data: ApiEventDataQueue{}})
}

// socialEventMaxPayload bounds the payload a social_connect event carries.
const socialEventMaxPayload = 64 << 10

// socialLogFirst is how many messages per masked uri are logged at info in a
// session, and socialLogUris how many uris are counted for that.
const (
	socialLogFirst = 3
	socialLogUris  = 64
)

// handleSocialMessage passes on a message social-connect pushed. Nothing here
// reads it: the client parses what it knows (a session_update carries the
// whole session), so the payload goes on exactly as the dealer delivered it.
// The uri is logged masked.
func (p *AppPlayer) handleSocialMessage(msg dealer.Message) {
	masked := dealer.MaskIds(msg.Uri)
	if p.socialLogged == nil {
		p.socialLogged = map[string]int{}
	}
	if n, seen := p.socialLogged[masked]; n < socialLogFirst && (seen || len(p.socialLogged) < socialLogUris) {
		p.socialLogged[masked] = n + 1
		p.app.log.Infof("social-connect pushed %s (%d bytes)", masked, len(msg.Payload))
	} else {
		p.app.log.Debugf("social-connect pushed %s (%d bytes)", masked, len(msg.Payload))
	}

	data := ApiEventDataSocialConnect{Uri: msg.Uri}
	if len(msg.Payload) <= socialEventMaxPayload && json.Valid(msg.Payload) {
		data.Payload = json.RawMessage(msg.Payload)
	} else {
		size := len(msg.Payload)
		data.PayloadBytes = &size
	}

	p.app.server.Emit(&ApiEvent{Type: ApiEventTypeSocialConnect, Data: data})
}

// connectLogUris is how many masked uris of connect-state messages the player
// does not handle are logged at info, each the first time it is seen.
const connectLogUris = 16

// noteConnectMessage logs a connect-state message the player does not handle,
// which it used to drop without a word: at info the first time its masked uri
// is seen (connectLogUris of them at most), at debug after that.
func (p *AppPlayer) noteConnectMessage(msg dealer.Message) {
	masked := dealer.MaskIds(msg.Uri)
	if p.connectLogged == nil {
		p.connectLogged = map[string]int{}
	}

	n, seen := p.connectLogged[masked]
	if !seen && len(p.connectLogged) >= connectLogUris {
		p.app.log.Debugf("connect-state message %s not handled (%d bytes)", masked, len(msg.Payload))
		return
	}

	p.connectLogged[masked] = n + 1
	if n == 0 {
		p.app.log.Infof("connect-state message %s not handled (%d bytes)", masked, len(msg.Payload))
	} else {
		p.app.log.Debugf("connect-state message %s not handled (%d bytes)", masked, len(msg.Payload))
	}
}

// isJamEnd reports whether a transfer is how the end of the Jam this device
// played reaches it: that Jam's list, with its pages, and nothing in it to
// play. Played from the top, which is what any other such transfer does, it
// replayed the Jam's first song and its history for nobody. played is the last
// Jam's list the state named. The list of another Jam is not its end: a Jam
// with nothing played in it yet may reach a device joining it the same way.
func isJamEnd(transferState *connectpb.TransferState, played string) bool {
	uri := transferState.GetCurrentSession().GetContext().GetUri()
	return strings.HasPrefix(uri, jamListPrefix) && uri == played &&
		singleTrackContext(transferState.GetPlayback().GetCurrentTrack()) == nil &&
		transferState.GetCurrentSession().GetCurrentUid() == ""
}

// takeJamEnd leaves the device idle at a Jam's end, active and logged in, as
// for a transfer with nothing to play. The transfer's session is not applied:
// its options are empty, so a set_options that switched the Jam off just
// before would have been undone. A mode still on is switched off instead.
func (p *AppPlayer) takeJamEnd() {
	p.app.log.Info("a Jam's list arrived with no track: taken as the Jam's end, left idle")

	// A load still on its way, a skip just before the end say, would put the
	// Jam's song back on.
	p.loadGen++
	p.loader.dropLoads()
	p.loadInFlight = false
	p.pendingPlayerEvents = nil
	p.keptStep, p.keptStepPaused = false, nil // Encore patch 7

	if p.state.player.Options.GetModes()["jam"] == "on" {
		p.setModes(map[string]string{"jam": "off"})
	}

	p.state.setActive(true)
	p.abandonTransfer()
	p.app.server.Emit(&ApiEvent{
		Type: ApiEventTypeActive,
	})
}
