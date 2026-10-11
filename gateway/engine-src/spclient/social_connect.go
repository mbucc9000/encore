package spclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"sync"
	"time"
)

// social-connect is the service behind Spotify's Jams (social sessions). It is
// private and undocumented. The request shapes here are the ones the desktop
// client sent in a capture of 2026 where it showed them (current_or_new, kick),
// else those seen from it in 2021-22, without the device parameter the 2026
// client no longer sent (see each call). Everything sent to it goes through
// RequestSocial and a SocialGate: one call at a time, spaced, capped, and never
// resent except once after renewing the token.

// socialMaxBody bounds the body of a social-connect answer. A session with a
// full Jam's members is a few kilobytes.
const socialMaxBody = 256 << 10

// socialIdPattern is what a join token, a session id or a member id looks
// like. Anything else is refused before it gets near a path.
var socialIdPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

// ValidSocialId reports whether s can be a social-connect join token, session
// id or member id.
func ValidSocialId(s string) bool {
	return socialIdPattern.MatchString(s)
}

// ErrSocialArgument reports a join token, session id, member id, device id or
// broadcast status that cannot be one. Nothing was sent.
var ErrSocialArgument = errors.New("invalid social-connect token, session id, member id, device id or broadcast status")

// SocialResponseError reports a social-connect answer with a success status
// but a body that is not a JSON object of at most socialMaxBody.
type SocialResponseError struct {
	Op         string
	StatusCode int
	Reason     string
}

func (e *SocialResponseError) Error() string {
	return fmt.Sprintf("unusable answer from social-connect %s (status %d): %s", e.Op, e.StatusCode, e.Reason)
}

// SocialNetworkError reports a social-connect request that got no answer. It
// keeps the cause but not the url, which holds a join token or session id.
type SocialNetworkError struct {
	Op  string
	Err error
}

func (e *SocialNetworkError) Error() string {
	return fmt.Sprintf("social-connect %s failed: %v", e.Op, e.Err)
}

func (e *SocialNetworkError) Unwrap() error { return e.Err }

// SetSocialGate sets the gate every social-connect request goes through. It
// belongs to the daemon rather than the session, so that a new session does
// not start with a fresh budget. Without one, nothing is sent.
func (c *Spclient) SetSocialGate(gate *SocialGate) {
	c.socialGate = gate
}

// RequestSocial sends a request to social-connect. Unlike Request and
// RequestOnce it does not loop: it sends once, and only a 401 is answered, by
// renewing the token once and sending once more. Network errors and every
// other status, 5xx included, are returned to the caller as they are. So one
// call is at most 2 sends and 1 renewal; Request would have resent a refused
// one with a fresh login each time until its context ran out.
//
// The call holds the gate's slot across its sends, each of which the gate
// spaces and counts, and the gate is told every answer. The renewal is a full
// login, so it is made only for a resend the gate will let out: when the cap,
// a hold or ctx would stop it, the 401 is the answer, and nothing is renewed.
// Redirects are not followed: each would be a send the gate did not see. op
// names the call in the log, which never shows the url.
//
// body, when not nil, goes with every send: each one reads it afresh, so the
// resend after a 401 carries the same bytes. A nil body sends none.
func (c *Spclient) RequestSocial(ctx context.Context, op, method, path string, query url.Values, header http.Header, body []byte) (*http.Response, error) {
	gate := c.socialGate
	if gate == nil {
		return nil, fmt.Errorf("social-connect %s: no gate to send through", op)
	}

	if err := gate.acquire(ctx); err != nil {
		return nil, err
	}
	defer gate.release()

	reqUrl := c.baseUrl.JoinPath(path)
	if query != nil {
		reqUrl.RawQuery = query.Encode()
	}

	renewed := false
	for {
		accessToken, err := c.accessToken(ctx, renewed)
		if err != nil {
			return nil, fmt.Errorf("social-connect %s: failed obtaining access token: %w", op, err)
		}

		if err := gate.beforeSend(ctx); err != nil {
			return nil, err
		}

		req := &http.Request{URL: reqUrl, Method: method, Header: http.Header{}}
		if body != nil {
			req.Body = io.NopCloser(bytes.NewReader(body))
			req.GetBody = func() (io.ReadCloser, error) { return io.NopCloser(bytes.NewReader(body)), nil }
			req.ContentLength = int64(len(body))
		}
		for key, values := range header {
			req.Header[key] = values
		}
		if len(c.clientToken) > 0 {
			req.Header.Set("Client-Token", c.clientToken)
		}
		req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", accessToken))

		var after string
		if renewed {
			after = " after renewal"
		}

		start := time.Now()
		resp, err := c.noRedirectClient.Do(req.WithContext(ctx))
		elapsed := time.Since(start).Milliseconds()
		if err != nil {
			c.log.Infof("social-connect %s -> no answer in %d ms%s", op, elapsed, after)

			// The url error carries the url itself, with the token or id in it.
			var urlErr *url.Error
			if errors.As(err, &urlErr) {
				err = urlErr.Err
			}
			return nil, &SocialNetworkError{Op: op, Err: err}
		}

		c.log.Infof("social-connect %s -> %d in %d ms%s", op, resp.StatusCode, elapsed, after)
		gate.noteAnswer(resp.StatusCode, retryAfterHeader(resp.Header, time.Now()))

		if resp.StatusCode == http.StatusUnauthorized && !renewed {
			if err := gate.resendRefusal(ctx); err != nil {
				c.log.Infof("social-connect %s: no renewal, the resend could not go out: %v", op, err)
				return resp, nil
			}

			_ = resp.Body.Close()

			renewed = true
			gate.noteRenewal()
			continue
		}

		return resp, nil
	}
}

// retryAfterHeader reads a Retry-After header as a duration: seconds, or an
// HTTP date. Zero when it is absent or makes no sense.
func retryAfterHeader(h http.Header, now time.Time) time.Duration {
	v := h.Get("Retry-After")
	if v == "" {
		return 0
	}
	if secs, err := strconv.Atoi(v); err == nil {
		return time.Duration(max(secs, 0)) * time.Second
	}
	if t, err := http.ParseTime(v); err == nil && t.After(now) {
		return t.Sub(now)
	}
	return 0
}

// socialCall makes one social-connect call and reads its answer: the body as
// a JSON object, or nil for 204 or an empty body. A status of 400 or more is a
// StatusError, 429s carrying their Retry-After. A request body, which only
// set_broadcast_status has, is JSON: it alone adds a Content-Type.
func (c *Spclient) socialCall(ctx context.Context, op, method, path string, query url.Values, reqBody []byte) (json.RawMessage, error) {
	header := http.Header{"Accept": {"application/json"}}
	if reqBody != nil {
		header.Set("Content-Type", "application/json")
	}

	resp, err := c.RequestSocial(ctx, op, method, path, query, header, reqBody)
	if err != nil {
		return nil, err
	}

	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode >= 400 {
		statusErr := &StatusError{Op: "social-connect " + op, StatusCode: resp.StatusCode}
		if resp.StatusCode == http.StatusTooManyRequests {
			statusErr.RetryAfter = retryAfterHeader(resp.Header, time.Now())
		}
		return nil, statusErr
	} else if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, &SocialResponseError{Op: op, StatusCode: resp.StatusCode, Reason: "not a success"}
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, socialMaxBody+1))
	if err != nil {
		return nil, &SocialNetworkError{Op: op, Err: err}
	} else if len(body) > socialMaxBody {
		return nil, &SocialResponseError{Op: op, StatusCode: resp.StatusCode, Reason: fmt.Sprintf("body larger than %d bytes", socialMaxBody)}
	}

	body = bytes.TrimSpace(body)
	if len(body) == 0 {
		return nil, nil
	} else if body[0] != '{' || !json.Valid(body) {
		return nil, &SocialResponseError{Op: op, StatusCode: resp.StatusCode, Reason: "not a JSON object"}
	}

	return json.RawMessage(body), nil
}

// SocialCurrent reads the session the account is in, if any. No query: the
// session is the account's, not a device's, and no call of the 2026 client
// named a device.
func (c *Spclient) SocialCurrent(ctx context.Context) (json.RawMessage, error) {
	return c.socialCall(ctx, "current", "GET", "/social-connect/v2/sessions/current", nil, nil)
}

// SocialCurrentOrNew reads the session the account is in, creating one hosted
// by the account when there is none. The query is exactly the 2026 client's:
// it named no device, the session's host device being the account's active
// one, so the caller makes sure that is this device.
func (c *Spclient) SocialCurrentOrNew(ctx context.Context) (json.RawMessage, error) {
	return c.socialCall(ctx, "current_or_new", "GET", "/social-connect/v2/sessions/current_or_new",
		url.Values{"activate": {"true"}}, nil)
}

// SocialInfo reads the session a join token leads to.
func (c *Spclient) SocialInfo(ctx context.Context, token string) (json.RawMessage, error) {
	if !ValidSocialId(token) {
		return nil, ErrSocialArgument
	}

	return c.socialCall(ctx, "info", "GET", "/social-connect/v2/sessions/info/"+url.PathEscape(token), nil, nil)
}

// SocialJoin joins the session of a join token, playing it on dev. Of all the
// calls this one keeps local_device_id: it is the one that says which device
// is to play the Jam, and the account's active device may be another, or none.
func (c *Spclient) SocialJoin(ctx context.Context, token, dev string) (json.RawMessage, error) {
	if !ValidSocialId(token) {
		return nil, ErrSocialArgument
	}

	return c.socialCall(ctx, "join", "POST", "/social-connect/v2/sessions/join/"+url.PathEscape(token),
		url.Values{"join_type": {"deeplinking"}, "local_device_id": {dev}, "playback_control": {"listen_and_control"}}, nil)
}

// SocialLeave leaves a session the account is a guest in.
func (c *Spclient) SocialLeave(ctx context.Context, sid string) (json.RawMessage, error) {
	if !ValidSocialId(sid) {
		return nil, ErrSocialArgument
	}

	return c.socialCall(ctx, "leave", "POST", "/social-connect/v3/sessions/"+url.PathEscape(sid)+"/leave", nil, nil)
}

// SocialEnd ends a session the account hosts.
func (c *Spclient) SocialEnd(ctx context.Context, sid string) (json.RawMessage, error) {
	if !ValidSocialId(sid) {
		return nil, ErrSocialArgument
	}

	return c.socialCall(ctx, "end", "DELETE", "/social-connect/v3/sessions/"+url.PathEscape(sid), nil, nil)
}

// SocialKick removes a member from a session the account hosts, as the 2026
// client did: no query and no body. member is the member's id in the session
// (its "id", not its username). The answer is the session without them.
func (c *Spclient) SocialKick(ctx context.Context, sid, member string) (json.RawMessage, error) {
	if !ValidSocialId(sid) || !ValidSocialId(member) {
		return nil, ErrSocialArgument
	}

	return c.socialCall(ctx, "kick", "POST",
		"/social-connect/v3/sessions/"+url.PathEscape(sid)+"/member/"+url.PathEscape(member)+"/kick", nil, nil)
}

// socialDevicePattern is what this engine's own device id looks like
// (daemon/app.go: 20 random bytes, hex). The broadcast calls name no other.
var socialDevicePattern = regexp.MustCompile(`^[0-9a-f]{40}$`)

// broadcastEnum is what a broadcast_status in an answer looks like: an enum
// such as BROADCAST_ON. Anything else is not kept.
var broadcastEnum = regexp.MustCompile(`^[A-Z][A-Z_]{2,39}$`)

// The two broadcast statuses Encore sets.
const (
	BroadcastOn  = "BROADCAST_ON"
	BroadcastOff = "BROADCAST_OFF"
)

// BroadcastStatus is all Encore keeps of a device_broadcast_status: the status
// and whether it names this device. The answer's link_token and
// social_radar_token are never kept, logged or passed on. The zero value is an
// answer without a usable status.
type BroadcastStatus struct {
	Status string
	Self   bool
}

// deviceBroadcastStatus is the body set_broadcast_status sends, its fields in
// the order the 2026 desktop client sent them.
type deviceBroadcastStatus struct {
	// Timestamp is Unix milliseconds as a decimal string, as in the capture.
	Timestamp       string `json:"timestamp"`
	BroadcastStatus string `json:"broadcast_status"`
	DeviceId        string `json:"device_id"`
}

// SocialSetBroadcastStatus sets dev's Jam broadcast to status (BroadcastOn or
// BroadcastOff), as the 2026 desktop client did for the host device a second
// before its current_or_new: POST
// /social-connect/v2/devices/set_broadcast_status, no query, the body
// {"device_broadcast_status":{"timestamp","broadcast_status","device_id"}}.
// It is a write: never resent but once after renewing the token on a 401.
func (c *Spclient) SocialSetBroadcastStatus(ctx context.Context, dev, status string) (*BroadcastStatus, error) {
	if !socialDevicePattern.MatchString(dev) || (status != BroadcastOn && status != BroadcastOff) {
		return nil, ErrSocialArgument
	}

	body, err := json.Marshal(struct {
		Status deviceBroadcastStatus `json:"device_broadcast_status"`
	}{deviceBroadcastStatus{
		Timestamp:       strconv.FormatInt(time.Now().UnixMilli(), 10),
		BroadcastStatus: status,
		DeviceId:        dev,
	}})
	if err != nil {
		return nil, err
	}

	raw, err := c.socialCall(ctx, "set_broadcast_status", "POST", "/social-connect/v2/devices/set_broadcast_status", nil, body)
	if err != nil {
		return nil, err
	}
	return broadcastOf(raw, dev), nil
}

// SocialJamStatus reads dev's Jam broadcast, as the 2026 desktop client did:
// GET /social-connect/v2/devices/<dev>/jam_status, no query. The path holds
// dev, which the log never shows (op only) and SocialNetworkError drops.
func (c *Spclient) SocialJamStatus(ctx context.Context, dev string) (*BroadcastStatus, error) {
	if !socialDevicePattern.MatchString(dev) {
		return nil, ErrSocialArgument
	}

	raw, err := c.socialCall(ctx, "jam_status", "GET", "/social-connect/v2/devices/"+dev+"/jam_status", nil, nil)
	if err != nil {
		return nil, err
	}
	return broadcastOf(raw, dev), nil
}

// broadcastOf keeps the status of a device_broadcast_status answer, when it is
// an enum, and whether the answer names dev. Everything else, the tokens
// included, is dropped here. No answer, or one without a usable status, is
// the zero BroadcastStatus.
func broadcastOf(raw json.RawMessage, dev string) *BroadcastStatus {
	var answer struct {
		Device struct {
			Status   json.RawMessage `json:"broadcast_status"`
			DeviceId json.RawMessage `json:"device_id"`
		} `json:"device_broadcast_status"`
	}
	if raw == nil || json.Unmarshal(raw, &answer) != nil {
		return &BroadcastStatus{}
	}

	// Read as raw values, so that a status or device id of another JSON kind
	// counts as none rather than failing the whole answer.
	var status, id string
	if json.Unmarshal(answer.Device.Status, &status) != nil || !broadcastEnum.MatchString(status) {
		return &BroadcastStatus{}
	}
	_ = json.Unmarshal(answer.Device.DeviceId, &id)

	return &BroadcastStatus{Status: status, Self: id == dev}
}

// The social-connect budget. Every HTTP send counts, the one after a token
// renewal included.
const (
	// socialSendSpacing is the least time between two sends.
	socialSendSpacing = time.Second

	// socialWindow and socialWindowSends cap the sends in any rolling window.
	socialWindow      = 5 * time.Minute
	socialWindowSends = 30

	// socialQueueWait is how long a call waits in line for the slot and the
	// spacing before it is refused unsent.
	socialQueueWait = 5 * time.Second

	// SocialMinHold is the least time nothing is sent after a 429.
	SocialMinHold = 60 * time.Second
)

// SocialGateError reports a social-connect call the gate refused, sending
// nothing: one already waiting too long in line, the window's cap reached, or
// the hold after a 429. RetryAfter is when asking again can succeed.
type SocialGateError struct {
	RetryAfter time.Duration
	Reason     string
}

func (e *SocialGateError) Error() string {
	return fmt.Sprintf("social-connect gate refused the call: %s (retry after %s)", e.Reason, e.RetryAfter.Round(time.Second))
}

// SocialStats is what the gate has counted, for the status.
type SocialStats struct {
	// Sends counts every HTTP send since the daemon started.
	Sends uint64
	// SendsWindow counts the sends within the rolling window.
	SendsWindow int
	// Renewals counts the token renewals after a 401.
	Renewals uint64
	// HeldUntil is when the hold after a 429 ends, zero when none is on.
	HeldUntil time.Time
}

// SocialGate paces social-connect: one call in flight, which holds the slot
// across its sends; at least socialSendSpacing between sends; at most
// socialWindowSends sends per socialWindow; and nothing for max(Retry-After,
// SocialMinHold) after a 429. A call that finds the slot taken or the spacing
// not over waits in line, oldest first, for up to socialQueueWait. One made
// while the cap is reached or a hold is on is refused at once.
type SocialGate struct {
	now   func() time.Time
	after func(time.Duration) <-chan time.Time

	mu sync.Mutex

	busy bool
	// line holds the calls waiting for the slot, oldest first. Each is
	// signalled when it may look again.
	line []chan struct{}

	lastSend  time.Time
	window    []time.Time
	sends     uint64
	renewals  uint64
	heldUntil time.Time
}

// NewSocialGate builds a gate on the real clock.
func NewSocialGate() *SocialGate {
	return NewSocialGateWithClock(time.Now, time.After)
}

// NewSocialGateWithClock builds a gate on the given clock.
func NewSocialGateWithClock(now func() time.Time, after func(time.Duration) <-chan time.Time) *SocialGate {
	return &SocialGate{now: now, after: after}
}

// Stats reports the gate's counts, all zero for no gate.
func (g *SocialGate) Stats() SocialStats {
	if g == nil {
		return SocialStats{}
	}

	g.mu.Lock()
	defer g.mu.Unlock()

	now := g.now()
	g.pruneLocked(now)

	stats := SocialStats{Sends: g.sends, SendsWindow: len(g.window), Renewals: g.renewals}
	if now.Before(g.heldUntil) {
		stats.HeldUntil = g.heldUntil
	}
	return stats
}

func (g *SocialGate) pruneLocked(now time.Time) {
	drop := 0
	for drop < len(g.window) && !now.Before(g.window[drop].Add(socialWindow)) {
		drop++
	}
	g.window = g.window[drop:]
}

// refusalLocked reports why nothing may be sent now, if anything stops it
// other than the slot and the spacing.
func (g *SocialGate) refusalLocked() error {
	now := g.now()
	if now.Before(g.heldUntil) {
		return &SocialGateError{RetryAfter: g.heldUntil.Sub(now), Reason: "holding after a 429"}
	}

	g.pruneLocked(now)
	if len(g.window) >= socialWindowSends {
		return &SocialGateError{
			RetryAfter: g.window[0].Add(socialWindow).Sub(now),
			Reason:     fmt.Sprintf("%d sends in %s", len(g.window), socialWindow),
		}
	}

	return nil
}

// signalHeadLocked lets the call at the front of the line look again.
func (g *SocialGate) signalHeadLocked() {
	if len(g.line) == 0 {
		return
	}

	select {
	case g.line[0] <- struct{}{}:
	default:
	}
}

// leaveLocked takes a call out of the line.
func (g *SocialGate) leaveLocked(turn chan struct{}) {
	for i, c := range g.line {
		if c == turn {
			g.line = append(g.line[:i], g.line[i+1:]...)
			break
		}
	}
	g.signalHeadLocked()
}

// acquire takes the slot for one call, once the calls ahead have had theirs
// and the spacing since the last send is over. It gives up after
// socialQueueWait in line.
func (g *SocialGate) acquire(ctx context.Context) error {
	g.mu.Lock()
	if err := g.refusalLocked(); err != nil {
		g.mu.Unlock()
		return err
	}

	turn := make(chan struct{}, 1)
	g.line = append(g.line, turn)
	deadline := g.now().Add(socialQueueWait)

	for {
		now := g.now()

		var wait time.Duration
		if g.line[0] == turn && !g.busy {
			if wait = g.lastSend.Add(socialSendSpacing).Sub(now); wait <= 0 {
				g.line = g.line[1:]
				g.busy = true
				g.mu.Unlock()
				return nil
			}
		}

		left := deadline.Sub(now)
		if left <= 0 {
			g.leaveLocked(turn)
			g.mu.Unlock()
			return &SocialGateError{RetryAfter: socialQueueWait, Reason: "another call took too long"}
		}

		// Not at the front, or the slot is taken: woken by a signal, or the
		// deadline. At the front with the slot free: by the spacing's end.
		if wait <= 0 || wait > left {
			wait = left
		}
		timer := g.after(wait)
		g.mu.Unlock()

		select {
		case <-turn:
		case <-timer:
		case <-ctx.Done():
			g.mu.Lock()
			g.leaveLocked(turn)
			g.mu.Unlock()
			return ctx.Err()
		}

		g.mu.Lock()

		// The call ahead may have been answered with a 429, or used up the
		// window, meanwhile.
		if err := g.refusalLocked(); err != nil {
			g.leaveLocked(turn)
			g.mu.Unlock()
			return err
		}
	}
}

// release gives the slot to the next call in line.
func (g *SocialGate) release() {
	g.mu.Lock()
	defer g.mu.Unlock()

	g.busy = false
	g.signalHeadLocked()
}

// beforeSend clears one send by the call holding the slot: refused at once
// while a hold is on or the window's cap is reached, otherwise held until the
// spacing since the last send is over, then counted.
func (g *SocialGate) beforeSend(ctx context.Context) error {
	g.mu.Lock()
	defer g.mu.Unlock()

	for {
		if err := g.refusalLocked(); err != nil {
			return err
		}

		wait := g.lastSend.Add(socialSendSpacing).Sub(g.now())
		if wait <= 0 {
			break
		}

		timer := g.after(wait)
		g.mu.Unlock()
		select {
		case <-timer:
		case <-ctx.Done():
			g.mu.Lock()
			return ctx.Err()
		}
		g.mu.Lock()
	}

	now := g.now()
	g.lastSend = now
	g.window = append(g.window, now)
	g.sends++
	return nil
}

// resendRefusal reports, without waiting, why the call holding the slot could
// not send again: a hold, the window's cap, or ctx ending before the spacing
// does. Nothing else can stop the resend, since no other call sends meanwhile.
func (g *SocialGate) resendRefusal(ctx context.Context) error {
	g.mu.Lock()
	defer g.mu.Unlock()

	if err := g.refusalLocked(); err != nil {
		return err
	} else if err := ctx.Err(); err != nil {
		return err
	}

	if deadline, ok := ctx.Deadline(); ok && !deadline.After(g.lastSend.Add(socialSendSpacing)) {
		return context.DeadlineExceeded
	}
	return nil
}

// noteRenewal counts a token renewal after a 401.
func (g *SocialGate) noteRenewal() {
	g.mu.Lock()
	defer g.mu.Unlock()

	g.renewals++
}

// noteAnswer takes in the status of an answer: a 429 holds every call for
// max(retryAfter, SocialMinHold).
func (g *SocialGate) noteAnswer(status int, retryAfter time.Duration) {
	if status != http.StatusTooManyRequests {
		return
	}

	g.mu.Lock()
	defer g.mu.Unlock()

	if until := g.now().Add(max(retryAfter, SocialMinHold)); until.After(g.heldUntil) {
		g.heldUntil = until
	}
}
