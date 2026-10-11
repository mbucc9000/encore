//go:build test_unit

package spclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	librespot "github.com/devgianlu/go-librespot"
	"github.com/stretchr/testify/require"
)

// These tests run in synctest bubbles, whose clock is fake: the gate's waits
// take no real time, and the time a send is made can be read off the clock.

// socialSend is one request the fake transport saw.
type socialSend struct {
	at     time.Time
	method string
	path   string
	query  url.Values
	header http.Header
	length int64
	body   []byte
}

// fakeSocialTransport stands in for Spotify: it records every send and answers
// it with answer, or blocks it until release is closed when block is set.
type fakeSocialTransport struct {
	mu     sync.Mutex
	sends  []socialSend
	answer func(n int, req *http.Request) (*http.Response, error)
}

func (f *fakeSocialTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	// The body is read here, and put back for an answer that dumps the
	// request.
	var body []byte
	if req.Body != nil && req.Body != http.NoBody {
		var err error
		if body, err = io.ReadAll(req.Body); err != nil {
			return nil, err
		}
		_ = req.Body.Close()
		req.Body = io.NopCloser(bytes.NewReader(body))
	}

	f.mu.Lock()
	n := len(f.sends)
	f.sends = append(f.sends, socialSend{
		at:     time.Now(),
		method: req.Method,
		path:   req.URL.EscapedPath(),
		query:  req.URL.Query(),
		header: req.Header.Clone(),
		length: bodyLength(req),
		body:   body,
	})
	answer := f.answer
	f.mu.Unlock()

	if answer == nil {
		return respond(req, http.StatusNoContent, ""), nil
	}
	return answer(n, req)
}

// bodyLength is how much body a request carries: its length, or -1 for a body
// of unknown length.
func bodyLength(req *http.Request) int64 {
	if req.Body == nil || req.Body == http.NoBody {
		return 0
	}
	return req.ContentLength
}

func (f *fakeSocialTransport) sent() []socialSend {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]socialSend(nil), f.sends...)
}

func respond(req *http.Request, status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Header:     http.Header{},
		Body:       io.NopCloser(strings.NewReader(body)),
		Request:    req,
	}
}

// answering answers every send with the same status and body.
func answering(status int, body string) func(int, *http.Request) (*http.Response, error) {
	return func(_ int, req *http.Request) (*http.Response, error) {
		return respond(req, status, body), nil
	}
}

type socialFixture struct {
	sp        *Spclient
	gate      *SocialGate
	transport *fakeSocialTransport

	mu     sync.Mutex
	forced []bool
}

// newSocialFixture builds a spclient on the fake transport, with a gate on the
// bubble's clock. Call it inside the bubble.
func newSocialFixture(t *testing.T) *socialFixture {
	t.Helper()

	f := &socialFixture{transport: &fakeSocialTransport{}, gate: NewSocialGate()}

	var err error
	f.sp, err = NewSpclient(context.Background(), &librespot.NullLogger{}, &http.Client{Transport: f.transport},
		func(context.Context) string { return "spclient.test" },
		func(_ context.Context, force bool) (string, error) {
			f.mu.Lock()
			defer f.mu.Unlock()
			f.forced = append(f.forced, force)
			if force {
				return "fresh-token", nil
			}
			return "cached-token", nil
		},
		"device-id", "client-token")
	require.NoError(t, err)

	f.sp.SetSocialGate(f.gate)
	return f
}

func (f *socialFixture) tokenLookups() []bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]bool(nil), f.forced...)
}

const testDev = "0123456789abcdef0123456789abcdef01234567"

// Each call's method, path and query: current_or_new and kick exactly as the
// desktop client sent them in 2026, the others as it sent them in 2021-22
// without the device it no longer named; only join still names this one. No
// call sends the desktop's app-platform or spotify-app-version.
func TestSocialCallShapes(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := newSocialFixture(t)
		ctx := context.Background()

		calls := []struct {
			call   func() (json.RawMessage, error)
			method string
			path   string
			query  url.Values
		}{
			{func() (json.RawMessage, error) { return f.sp.SocialCurrent(ctx) },
				"GET", "/social-connect/v2/sessions/current", url.Values{}},
			{func() (json.RawMessage, error) { return f.sp.SocialCurrentOrNew(ctx) },
				"GET", "/social-connect/v2/sessions/current_or_new", url.Values{"activate": {"true"}}},
			{func() (json.RawMessage, error) { return f.sp.SocialInfo(ctx, "Tok-en_1") },
				"GET", "/social-connect/v2/sessions/info/Tok-en_1", url.Values{}},
			{func() (json.RawMessage, error) { return f.sp.SocialJoin(ctx, "Tok-en_1", testDev) },
				"POST", "/social-connect/v2/sessions/join/Tok-en_1", url.Values{"join_type": {"deeplinking"}, "local_device_id": {testDev}, "playback_control": {"listen_and_control"}}},
			{func() (json.RawMessage, error) { return f.sp.SocialLeave(ctx, "sid_1") },
				"POST", "/social-connect/v3/sessions/sid_1/leave", url.Values{}},
			{func() (json.RawMessage, error) { return f.sp.SocialEnd(ctx, "sid_1") },
				"DELETE", "/social-connect/v3/sessions/sid_1", url.Values{}},
			{func() (json.RawMessage, error) { return f.sp.SocialKick(ctx, "sid_1", "Mem-ber_1") },
				"POST", "/social-connect/v3/sessions/sid_1/member/Mem-ber_1/kick", url.Values{}},
		}

		for i, c := range calls {
			session, err := c.call()
			require.NoError(t, err)
			require.Nil(t, session, "204 is no session")

			sent := f.transport.sent()
			require.Len(t, sent, i+1)
			got := sent[i]
			require.Equal(t, c.method, got.method)
			require.Equal(t, c.path, got.path)
			require.Equal(t, c.query, got.query)
			require.Equal(t, "Bearer cached-token", got.header.Get("Authorization"))
			require.Equal(t, "client-token", got.header.Get("Client-Token"))
			require.Equal(t, "application/json", got.header.Get("Accept"))
			require.Len(t, got.header, 3, "%s %s sends no other header: no app-platform, no spotify-app-version", c.method, c.path)
			require.Empty(t, got.header.Values("App-Platform"))
			require.Empty(t, got.header.Values("Spotify-App-Version"))
			require.Zero(t, got.length, "no body")
			require.Empty(t, got.body, "no body")
		}
	})
}

// The kick is a POST with nothing in it, as the 2026 client sent it: on the
// wire that is Content-Length: 0 and no body.
func TestSocialKickSendsNoBody(t *testing.T) {
	var wire string
	f := newSocialFixture(t)
	f.transport.answer = func(_ int, req *http.Request) (*http.Response, error) {
		dump, err := httputil.DumpRequestOut(req, true)
		if err != nil {
			return nil, err
		}
		wire = string(dump)
		return respond(req, http.StatusOK, `{"session_id":"sid_1","session_members":[]}`), nil
	}

	session, err := f.sp.SocialKick(context.Background(), "sid_1", "0123456789abcdef0123456789abcdef")
	require.NoError(t, err)
	require.JSONEq(t, `{"session_id":"sid_1","session_members":[]}`, string(session), "the answer is the session")

	require.True(t, strings.HasPrefix(wire, "POST /social-connect/v3/sessions/sid_1/member/0123456789abcdef0123456789abcdef/kick HTTP/1.1\r\n"), wire)
	require.Contains(t, wire, "\r\nContent-Length: 0\r\n")
	require.True(t, strings.HasSuffix(wire, "\r\n\r\n"), "nothing after the headers")
}

// A token, session id or member id that cannot be one is refused before
// anything is sent.
func TestSocialRefusesBadIds(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := newSocialFixture(t)
		ctx := context.Background()

		for _, bad := range []string{"", "a/b", "..", "a%2Fb", "a b", "x?y=1", strings.Repeat("a", 129)} {
			_, err := f.sp.SocialInfo(ctx, bad)
			require.ErrorIs(t, err, ErrSocialArgument, "%q", bad)
			_, err = f.sp.SocialJoin(ctx, bad, testDev)
			require.ErrorIs(t, err, ErrSocialArgument)
			_, err = f.sp.SocialLeave(ctx, bad)
			require.ErrorIs(t, err, ErrSocialArgument)
			_, err = f.sp.SocialEnd(ctx, bad)
			require.ErrorIs(t, err, ErrSocialArgument)
			_, err = f.sp.SocialKick(ctx, bad, "member_1")
			require.ErrorIs(t, err, ErrSocialArgument)
			_, err = f.sp.SocialKick(ctx, "sid_1", bad)
			require.ErrorIs(t, err, ErrSocialArgument)
		}

		require.Empty(t, f.transport.sent())
		require.True(t, ValidSocialId(strings.Repeat("a", 128)))
	})
}

// Without the daemon's gate nothing is sent at all.
func TestSocialNeedsAGate(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := newSocialFixture(t)
		f.sp.SetSocialGate(nil)

		_, err := f.sp.SocialCurrent(context.Background())
		require.Error(t, err)
		require.Empty(t, f.transport.sent())
	})
}

// A server error or a network error is sent once, never again: Request would
// have repeated it until its context ran out.
func TestRequestSocialDoesNotRepeatFailures(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := newSocialFixture(t)
		f.transport.answer = answering(http.StatusServiceUnavailable, "")

		_, err := f.sp.SocialCurrent(context.Background())
		var statusErr *StatusError
		require.ErrorAs(t, err, &statusErr)
		require.Equal(t, http.StatusServiceUnavailable, statusErr.StatusCode)
		require.Len(t, f.transport.sent(), 1)
	})

	synctest.Test(t, func(t *testing.T) {
		f := newSocialFixture(t)
		f.transport.answer = func(int, *http.Request) (*http.Response, error) {
			return nil, errors.New("connection reset by peer")
		}

		_, err := f.sp.SocialJoin(context.Background(), "secret-join-token", testDev)
		var netErr *SocialNetworkError
		require.ErrorAs(t, err, &netErr)
		require.Len(t, f.transport.sent(), 1)
		require.NotContains(t, err.Error(), "secret-join-token", "the url is not in the error")
	})
}

// A 401 renews the token once and sends once more. A second 401 is the answer.
func TestRequestSocialRenewsTheTokenOnce(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := newSocialFixture(t)
		f.transport.answer = answering(http.StatusUnauthorized, "")

		_, err := f.sp.SocialCurrent(context.Background())
		var statusErr *StatusError
		require.ErrorAs(t, err, &statusErr)
		require.Equal(t, http.StatusUnauthorized, statusErr.StatusCode)

		sent := f.transport.sent()
		require.Len(t, sent, 2, "two sends, no more")
		require.Equal(t, []bool{false, true}, f.tokenLookups(), "one renewal")
		require.Equal(t, "Bearer fresh-token", sent[1].header.Get("Authorization"))
		require.GreaterOrEqual(t, sent[1].at.Sub(sent[0].at), socialSendSpacing, "the resend is spaced too")

		stats := f.gate.Stats()
		require.EqualValues(t, 2, stats.Sends)
		require.EqualValues(t, 1, stats.Renewals)
	})

	synctest.Test(t, func(t *testing.T) {
		f := newSocialFixture(t)
		f.transport.answer = func(n int, req *http.Request) (*http.Response, error) {
			if n == 0 {
				return respond(req, http.StatusUnauthorized, ""), nil
			}
			return respond(req, http.StatusOK, `{"session_id":"sid"}`), nil
		}

		session, err := f.sp.SocialCurrent(context.Background())
		require.NoError(t, err)
		require.JSONEq(t, `{"session_id":"sid"}`, string(session))
		require.Len(t, f.transport.sent(), 2)
	})
}

func TestSocialAnswers(t *testing.T) {
	for _, tt := range []struct {
		name    string
		status  int
		header  http.Header
		body    string
		session string
		check   func(t *testing.T, err error)
	}{
		{name: "session", status: 200, body: ` {"session_id":"sid","session_members":[]} `, session: `{"session_id":"sid","session_members":[]}`},
		{name: "empty", status: 200, body: "  "},
		{name: "no content", status: 204},
		{name: "not json", status: 200, body: "<html>", check: func(t *testing.T, err error) {
			var respErr *SocialResponseError
			require.ErrorAs(t, err, &respErr)
			require.Equal(t, 200, respErr.StatusCode)
		}},
		{name: "array", status: 200, body: `[1]`, check: func(t *testing.T, err error) {
			var respErr *SocialResponseError
			require.ErrorAs(t, err, &respErr)
		}},
		{name: "too large", status: 200, body: `{"x":"` + strings.Repeat("a", socialMaxBody) + `"}`, check: func(t *testing.T, err error) {
			var respErr *SocialResponseError
			require.ErrorAs(t, err, &respErr)
			require.Contains(t, respErr.Reason, "larger")
		}},
		{name: "redirect", status: 302, header: http.Header{"Location": {"https://elsewhere.test/"}}, check: func(t *testing.T, err error) {
			var respErr *SocialResponseError
			require.ErrorAs(t, err, &respErr)
			require.Equal(t, 302, respErr.StatusCode)
		}},
		{name: "forbidden", status: 403, check: func(t *testing.T, err error) {
			var statusErr *StatusError
			require.ErrorAs(t, err, &statusErr)
			require.Equal(t, 403, statusErr.StatusCode)
			require.Zero(t, statusErr.RetryAfter)
			require.Equal(t, "social-connect current", statusErr.Op)
		}},
		{name: "rate limited", status: 429, header: http.Header{"Retry-After": {"42"}}, check: func(t *testing.T, err error) {
			var statusErr *StatusError
			require.ErrorAs(t, err, &statusErr)
			require.Equal(t, 429, statusErr.StatusCode)
			require.Equal(t, 42*time.Second, statusErr.RetryAfter)
		}},
		{name: "rate limited without advice", status: 429, check: func(t *testing.T, err error) {
			var statusErr *StatusError
			require.ErrorAs(t, err, &statusErr)
			require.Zero(t, statusErr.RetryAfter)
		}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				f := newSocialFixture(t)
				f.transport.answer = func(_ int, req *http.Request) (*http.Response, error) {
					resp := respond(req, tt.status, tt.body)
					for k, v := range tt.header {
						resp.Header[k] = v
					}
					return resp, nil
				}

				session, err := f.sp.SocialCurrent(context.Background())
				require.Len(t, f.transport.sent(), 1, "never followed or repeated")
				if tt.check != nil {
					tt.check(t, err)
					return
				}

				require.NoError(t, err)
				if tt.session == "" {
					require.Nil(t, session)
				} else {
					require.Equal(t, tt.session, string(session))
				}
			})
		})
	}
}

// One call at a time, a second apart: Join's info and join go back to back,
// the second waiting in line for the first.
func TestSocialGateSpacesCalls(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := newSocialFixture(t)
		release := make(chan struct{})
		f.transport.answer = func(n int, req *http.Request) (*http.Response, error) {
			if n == 0 {
				<-release
			}
			return respond(req, http.StatusOK, `{"session_id":"sid"}`), nil
		}

		ctx := context.Background()
		errs := make(chan error, 2)
		go func() {
			_, err := f.sp.SocialInfo(ctx, "tok")
			errs <- err
		}()
		synctest.Wait()
		go func() {
			_, err := f.sp.SocialJoin(ctx, "tok", testDev)
			errs <- err
		}()

		// The first is on the wire for 3 s; the second waits for it.
		time.Sleep(3 * time.Second)
		synctest.Wait()
		require.Len(t, f.transport.sent(), 1, "one call in flight")

		close(release)
		require.NoError(t, <-errs)
		require.NoError(t, <-errs)

		sent := f.transport.sent()
		require.Len(t, sent, 2)
		require.Equal(t, "/social-connect/v2/sessions/join/tok", sent[1].path)

		// Calls made one after the other are spaced as well.
		start := time.Now()
		_, err := f.sp.SocialCurrent(ctx)
		require.NoError(t, err)
		_, err = f.sp.SocialCurrent(ctx)
		require.NoError(t, err)
		sent = f.transport.sent()
		require.Len(t, sent, 4)
		for i := 1; i < len(sent); i++ {
			require.GreaterOrEqual(t, sent[i].at.Sub(sent[i-1].at), socialSendSpacing)
		}
		require.GreaterOrEqual(t, time.Since(start), socialSendSpacing)
	})
}

// A call still waiting in line after 5 s gives up, unsent.
func TestSocialGateLineGivesUp(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := newSocialFixture(t)
		f.transport.answer = func(n int, req *http.Request) (*http.Response, error) {
			if n == 0 {
				time.Sleep(10 * time.Second)
			}
			return respond(req, http.StatusNoContent, ""), nil
		}

		ctx := context.Background()
		first := make(chan error, 1)
		go func() {
			_, err := f.sp.SocialCurrent(ctx)
			first <- err
		}()
		synctest.Wait()

		start := time.Now()
		_, err := f.sp.SocialEnd(ctx, "sid")
		var gateErr *SocialGateError
		require.ErrorAs(t, err, &gateErr)
		require.Equal(t, socialQueueWait, gateErr.RetryAfter)
		require.Equal(t, socialQueueWait, time.Since(start))
		require.Len(t, f.transport.sent(), 1, "the waiting call was never sent")

		require.NoError(t, <-first)
	})
}

// A cancelled call leaves the line, and the next one goes on.
func TestSocialGateCancelledWaiterLeavesTheLine(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := newSocialFixture(t)
		release := make(chan struct{})
		f.transport.answer = func(n int, req *http.Request) (*http.Response, error) {
			if n == 0 {
				<-release
			}
			return respond(req, http.StatusNoContent, ""), nil
		}

		first := make(chan error, 1)
		go func() {
			_, err := f.sp.SocialCurrent(context.Background())
			first <- err
		}()
		synctest.Wait()

		ctx, cancel := context.WithCancel(context.Background())
		second := make(chan error, 1)
		go func() {
			_, err := f.sp.SocialCurrent(ctx)
			second <- err
		}()
		synctest.Wait()
		third := make(chan error, 1)
		go func() {
			_, err := f.sp.SocialCurrent(context.Background())
			third <- err
		}()
		synctest.Wait()

		cancel()
		require.ErrorIs(t, <-second, context.Canceled)
		close(release)
		require.NoError(t, <-first)
		require.NoError(t, <-third)
		require.Len(t, f.transport.sent(), 2)
	})
}

// At most 30 sends in any 5 minutes, a 401 pair counting as two: the 31st send
// is refused at once, unsent, until the oldest leaves the window.
func TestSocialGateCapsTheWindow(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := newSocialFixture(t)
		f.transport.answer = func(n int, req *http.Request) (*http.Response, error) {
			// The first 14 calls are each refused once, then answered.
			if n < 28 && n%2 == 0 {
				return respond(req, http.StatusUnauthorized, ""), nil
			}
			return respond(req, http.StatusNoContent, ""), nil
		}

		ctx := context.Background()
		for range 16 {
			_, err := f.sp.SocialCurrent(ctx)
			require.NoError(t, err)
		}
		require.Len(t, f.transport.sent(), 30)
		require.Equal(t, 30, f.gate.Stats().SendsWindow)

		start := time.Now()
		_, err := f.sp.SocialCurrent(ctx)
		var gateErr *SocialGateError
		require.ErrorAs(t, err, &gateErr)
		require.Equal(t, start, time.Now(), "refused at once")
		require.Len(t, f.transport.sent(), 30)

		oldest := f.transport.sent()[0].at
		require.Equal(t, oldest.Add(socialWindow).Sub(start), gateErr.RetryAfter)

		time.Sleep(gateErr.RetryAfter)
		_, err = f.sp.SocialCurrent(ctx)
		require.NoError(t, err, "the oldest send has left the window")
		require.Len(t, f.transport.sent(), 31)
	})
}

// The resend after a renewal is a send like any other: with the window full
// after the first, it cannot go out. The call ends with Spotify's 401, and no
// login is spent renewing the token for a resend that is not made.
func TestSocialGateCapsTheResend(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := newSocialFixture(t)
		f.transport.answer = func(n int, req *http.Request) (*http.Response, error) {
			if n == socialWindowSends-1 {
				return respond(req, http.StatusUnauthorized, ""), nil
			}
			return respond(req, http.StatusNoContent, ""), nil
		}

		ctx := context.Background()
		for range socialWindowSends - 1 {
			_, err := f.sp.SocialCurrent(ctx)
			require.NoError(t, err)
		}

		_, err := f.sp.SocialCurrent(ctx)
		var statusErr *StatusError
		require.ErrorAs(t, err, &statusErr, "Spotify's 401 is the answer, not the gate's refusal")
		require.Equal(t, http.StatusUnauthorized, statusErr.StatusCode)
		require.Len(t, f.transport.sent(), socialWindowSends, "the resend was not made")
		require.NotContains(t, f.tokenLookups(), true, "nor a login spent on it")
		require.Zero(t, f.gate.Stats().Renewals)
	})
}

// A resend ctx would end before the spacing is over is not made either, and
// the token is not renewed for it.
func TestRequestSocialRenewsOnlyWithTimeToResend(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := newSocialFixture(t)
		f.transport.answer = answering(http.StatusUnauthorized, "")

		ctx, cancel := context.WithTimeout(context.Background(), socialSendSpacing/2)
		defer cancel()

		_, err := f.sp.SocialCurrent(ctx)
		var statusErr *StatusError
		require.ErrorAs(t, err, &statusErr)
		require.Equal(t, http.StatusUnauthorized, statusErr.StatusCode)
		require.Len(t, f.transport.sent(), 1)
		require.Equal(t, []bool{false}, f.tokenLookups(), "no renewal")
	})
}

// After a 429 nothing is sent for max(Retry-After, 60 s).
func TestSocialGateHoldsAfterARateLimit(t *testing.T) {
	for _, tt := range []struct {
		retryAfter string
		hold       time.Duration
	}{
		{"", SocialMinHold},
		{"5", SocialMinHold},
		{"120", 120 * time.Second},
	} {
		t.Run(fmt.Sprintf("Retry-After %q", tt.retryAfter), func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				f := newSocialFixture(t)
				f.transport.answer = func(n int, req *http.Request) (*http.Response, error) {
					if n == 0 {
						resp := respond(req, http.StatusTooManyRequests, "")
						if tt.retryAfter != "" {
							resp.Header.Set("Retry-After", tt.retryAfter)
						}
						return resp, nil
					}
					return respond(req, http.StatusNoContent, ""), nil
				}

				ctx := context.Background()
				_, err := f.sp.SocialCurrent(ctx)
				var statusErr *StatusError
				require.ErrorAs(t, err, &statusErr)
				limited := time.Now()
				require.Equal(t, limited.Add(tt.hold), f.gate.Stats().HeldUntil)

				time.Sleep(tt.hold - time.Second)
				_, err = f.sp.SocialCurrent(ctx)
				var gateErr *SocialGateError
				require.ErrorAs(t, err, &gateErr)
				require.Equal(t, time.Second, gateErr.RetryAfter)
				require.Len(t, f.transport.sent(), 1, "held, unsent")

				time.Sleep(time.Second)
				_, err = f.sp.SocialCurrent(ctx)
				require.NoError(t, err)
				require.Len(t, f.transport.sent(), 2)
				require.True(t, f.gate.Stats().HeldUntil.IsZero())
			})
		})
	}
}

// A call waiting in line behind one that gets a 429 is refused with it.
func TestSocialGateHoldReachesTheLine(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := newSocialFixture(t)
		release := make(chan struct{})
		f.transport.answer = func(n int, req *http.Request) (*http.Response, error) {
			<-release
			return respond(req, http.StatusTooManyRequests, ""), nil
		}

		ctx := context.Background()
		first := make(chan error, 1)
		go func() {
			_, err := f.sp.SocialCurrentOrNew(ctx)
			first <- err
		}()
		synctest.Wait()

		second := make(chan error, 1)
		go func() {
			_, err := f.sp.SocialCurrent(ctx)
			second <- err
		}()
		synctest.Wait()

		close(release)
		require.Error(t, <-first)
		var gateErr *SocialGateError
		require.ErrorAs(t, <-second, &gateErr)
		require.Len(t, f.transport.sent(), 1)
	})
}

func TestRetryAfterHeader(t *testing.T) {
	now := time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC)
	for v, want := range map[string]time.Duration{
		"":                              0,
		"30":                            30 * time.Second,
		"-5":                            0,
		"soon":                          0,
		"Tue, 06 Oct 2026 12:01:00 GMT": time.Minute,
		"Tue, 06 Oct 2026 11:00:00 GMT": 0,
	} {
		h := http.Header{}
		if v != "" {
			h.Set("Retry-After", v)
		}
		require.Equal(t, want, retryAfterHeader(h, now), "%q", v)
	}
}

// The tokens and the other device of a device_broadcast_status answer
// (synthetic values, the capture's lengths).
const (
	radarToken = "Rad4rT0kenAbCdEfGhIj"
	linkToken  = "L1nkT0kenAbCdEfGhIjKlM"
	otherDev   = "fedcba9876543210fedcba9876543210fedcba98"
)

// c0BroadcastAnswer is set_broadcast_status's answer in the shape the 2026
// capture recorded: the status and the device, with the tokens Encore never
// keeps.
func c0BroadcastAnswer(status, dev string) string {
	return `{"device_broadcast_status":{"timestamp":"1790000000000","broadcast_status":"` + status + `",` +
		`"device_id":"` + dev + `","social_radar_token":{"token":"` + radarToken + `"},` +
		`"link_token":{"token":"` + linkToken + `"},"device_type":"SMARTPHONE","device_name":"Encore"}}`
}

// set_broadcast_status as the 2026 desktop client sent it for the host device:
// a POST with no query, the usual headers plus a JSON Content-Type, and the
// body {"device_broadcast_status":{"timestamp","broadcast_status","device_id"}},
// its keys in that order and the timestamp Unix milliseconds as a string.
func TestSocialSetBroadcastStatusShape(t *testing.T) {
	for _, status := range []string{BroadcastOn, BroadcastOff} {
		t.Run(status, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				f := newSocialFixture(t)
				f.transport.answer = answering(http.StatusOK, c0BroadcastAnswer(status, testDev))

				got, err := f.sp.SocialSetBroadcastStatus(context.Background(), testDev, status)
				require.NoError(t, err)
				require.Equal(t, &BroadcastStatus{Status: status, Self: true}, got)

				sent := f.transport.sent()
				require.Len(t, sent, 1)
				send := sent[0]
				require.Equal(t, http.MethodPost, send.method)
				require.Equal(t, "/social-connect/v2/devices/set_broadcast_status", send.path)
				require.Equal(t, url.Values{}, send.query)
				require.Equal(t, "Bearer cached-token", send.header.Get("Authorization"))
				require.Equal(t, "client-token", send.header.Get("Client-Token"))
				require.Equal(t, "application/json", send.header.Get("Accept"))
				require.Equal(t, "application/json", send.header.Get("Content-Type"))
				require.Len(t, send.header, 4, "no other header: no app-platform, no spotify-app-version")
				require.Empty(t, send.header.Values("App-Platform"))
				require.Empty(t, send.header.Values("Spotify-App-Version"))

				// The bubble's clock starts in 2000, which is 12 digits.
				stamp := strconv.FormatInt(send.at.UnixMilli(), 10)
				require.Regexp(t, `^\d{12,13}$`, stamp)
				require.Equal(t,
					`{"device_broadcast_status":{"timestamp":"`+stamp+`","broadcast_status":"`+status+`","device_id":"`+testDev+`"}}`,
					string(send.body), "the capture's keys in its order, the timestamp a string")
				require.EqualValues(t, len(send.body), send.length)
			})
		})
	}
}

// Of an answer only the status, when it is an enum, and whether it names this
// device are kept. The tokens never get further than the spclient.
func TestSocialSetBroadcastStatusAnswer(t *testing.T) {
	for _, tt := range []struct {
		name   string
		status int
		body   string
		want   BroadcastStatus
	}{
		{"the capture's shape", 200, c0BroadcastAnswer(BroadcastOn, testDev), BroadcastStatus{Status: BroadcastOn, Self: true}},
		{"another device", 200, c0BroadcastAnswer(BroadcastOn, otherDev), BroadcastStatus{Status: BroadcastOn}},
		{"no device", 200, `{"device_broadcast_status":{"broadcast_status":"BROADCAST_OFF"}}`, BroadcastStatus{Status: BroadcastOff}},
		{"unavailable", 200, `{"device_broadcast_status":{"broadcast_status":"BROADCAST_UNAVAILABLE","device_id":"` + testDev + `"}}`,
			BroadcastStatus{Status: "BROADCAST_UNAVAILABLE", Self: true}},
		{"no content", 204, "", BroadcastStatus{}},
		{"empty body", 200, "", BroadcastStatus{}},
		{"empty object", 200, `{}`, BroadcastStatus{}},
		{"not an enum", 200, `{"device_broadcast_status":{"broadcast_status":"on","device_id":"` + testDev + `"}}`, BroadcastStatus{}},
		{"not a word", 200, `{"device_broadcast_status":{"broadcast_status":"BROADCAST ON <b>","device_id":"` + testDev + `"}}`, BroadcastStatus{}},
		{"numeric", 200, `{"device_broadcast_status":{"broadcast_status":1,"device_id":"` + testDev + `"}}`, BroadcastStatus{}},
		{"absent", 200, `{"device_broadcast_status":{"device_id":"` + testDev + `","link_token":{"token":"` + linkToken + `"}}}`, BroadcastStatus{}},
		{"not an object", 200, `{"device_broadcast_status":"BROADCAST_ON"}`, BroadcastStatus{}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				f := newSocialFixture(t)
				f.transport.answer = answering(tt.status, tt.body)

				got, err := f.sp.SocialSetBroadcastStatus(context.Background(), testDev, BroadcastOn)
				require.NoError(t, err)
				require.NotNil(t, got)
				require.Equal(t, tt.want, *got)

				kept := fmt.Sprintf("%+v %#v", got, got)
				require.NotContains(t, kept, radarToken)
				require.NotContains(t, kept, linkToken)
			})
		})
	}

	// A refusal is an error like any other call's.
	synctest.Test(t, func(t *testing.T) {
		f := newSocialFixture(t)
		f.transport.answer = answering(http.StatusForbidden, "")

		_, err := f.sp.SocialSetBroadcastStatus(context.Background(), testDev, BroadcastOn)
		var statusErr *StatusError
		require.ErrorAs(t, err, &statusErr)
		require.Equal(t, http.StatusForbidden, statusErr.StatusCode)
		require.Equal(t, "social-connect set_broadcast_status", statusErr.Op)
		require.Len(t, f.transport.sent(), 1)
	})
}

// Only this engine's own kind of device id (40 lowercase hex) and the two
// statuses Encore sets get as far as a send.
func TestSocialBroadcastRefusesBadArguments(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := newSocialFixture(t)
		ctx := context.Background()

		for _, dev := range []string{"", testDev[:39], testDev + "8", strings.ToUpper(testDev), "../x", testDev[:36] + "/../", testDev[:39] + "\n"} {
			_, err := f.sp.SocialSetBroadcastStatus(ctx, dev, BroadcastOn)
			require.ErrorIs(t, err, ErrSocialArgument, "%q", dev)
			_, err = f.sp.SocialJamStatus(ctx, dev)
			require.ErrorIs(t, err, ErrSocialArgument, "%q", dev)
		}

		for _, status := range []string{"ON", "on", "off", "BROADCAST_MAYBE", "BROADCAST_UNAVAILABLE", "BROADCAST_ON ", ""} {
			_, err := f.sp.SocialSetBroadcastStatus(ctx, testDev, status)
			require.ErrorIs(t, err, ErrSocialArgument, "%q", status)
		}

		require.Empty(t, f.transport.sent())
	})
}

// The resend after a 401 carries the very bytes of the first send: the body is
// built once and read afresh for each.
func TestSocialSetBroadcastStatusResendsTheSameBody(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := newSocialFixture(t)
		f.transport.answer = func(n int, req *http.Request) (*http.Response, error) {
			if n == 0 {
				return respond(req, http.StatusUnauthorized, ""), nil
			}
			return respond(req, http.StatusOK, c0BroadcastAnswer(BroadcastOn, testDev)), nil
		}

		got, err := f.sp.SocialSetBroadcastStatus(context.Background(), testDev, BroadcastOn)
		require.NoError(t, err)
		require.Equal(t, &BroadcastStatus{Status: BroadcastOn, Self: true}, got)

		sent := f.transport.sent()
		require.Len(t, sent, 2, "two sends, no more")
		require.Equal(t, []bool{false, true}, f.tokenLookups(), "one renewal")
		require.EqualValues(t, 1, f.gate.Stats().Renewals)
		require.GreaterOrEqual(t, sent[1].at.Sub(sent[0].at), socialSendSpacing)
		require.Equal(t, "Bearer fresh-token", sent[1].header.Get("Authorization"))

		require.NotEmpty(t, sent[0].body)
		require.Equal(t, sent[0].body, sent[1].body, "byte for byte")
		for _, send := range sent {
			require.EqualValues(t, len(send.body), send.length)
			require.Equal(t, "application/json", send.header.Get("Content-Type"))
		}
	})
}

// On the wire: the request line, the JSON Content-Type, the body's length, and
// the body itself after the blank line.
func TestSocialSetBroadcastStatusOnTheWire(t *testing.T) {
	var wire string
	f := newSocialFixture(t)
	f.transport.answer = func(_ int, req *http.Request) (*http.Response, error) {
		dump, err := httputil.DumpRequestOut(req, true)
		if err != nil {
			return nil, err
		}
		wire = string(dump)
		return respond(req, http.StatusOK, c0BroadcastAnswer(BroadcastOff, testDev)), nil
	}

	got, err := f.sp.SocialSetBroadcastStatus(context.Background(), testDev, BroadcastOff)
	require.NoError(t, err)
	require.Equal(t, &BroadcastStatus{Status: BroadcastOff, Self: true}, got)

	body := string(f.transport.sent()[0].body)
	require.True(t, strings.HasPrefix(body, `{"device_broadcast_status":{"timestamp":"`), body)
	require.True(t, strings.HasSuffix(body, `","broadcast_status":"BROADCAST_OFF","device_id":"`+testDev+`"}}`), body)

	require.True(t, strings.HasPrefix(wire, "POST /social-connect/v2/devices/set_broadcast_status HTTP/1.1\r\n"), wire)
	require.Contains(t, wire, "\r\nContent-Type: application/json\r\n")
	require.Contains(t, wire, fmt.Sprintf("\r\nContent-Length: %d\r\n", len(body)))
	require.True(t, strings.HasSuffix(wire, "\r\n\r\n"+body), "the body after the blank line: %s", wire)
}

// jam_status as the 2026 desktop client read it: a GET of the device's path,
// no query, the usual three headers and no body. Its answer in the capture
// said BROADCAST_UNAVAILABLE.
func TestSocialJamStatusShape(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := newSocialFixture(t)
		f.transport.answer = answering(http.StatusOK, `{"device_broadcast_status":{"timestamp":"1790000000000",`+
			`"broadcast_status":"BROADCAST_UNAVAILABLE","device_id":"`+testDev+`","link_token":{"token":"`+linkToken+`"},"device_name":""}}`)

		got, err := f.sp.SocialJamStatus(context.Background(), testDev)
		require.NoError(t, err)
		require.Equal(t, &BroadcastStatus{Status: "BROADCAST_UNAVAILABLE", Self: true}, got)

		sent := f.transport.sent()
		require.Len(t, sent, 1)
		send := sent[0]
		require.Equal(t, http.MethodGet, send.method)
		require.Equal(t, "/social-connect/v2/devices/"+testDev+"/jam_status", send.path)
		require.Equal(t, url.Values{}, send.query)
		require.Equal(t, "Bearer cached-token", send.header.Get("Authorization"))
		require.Equal(t, "client-token", send.header.Get("Client-Token"))
		require.Equal(t, "application/json", send.header.Get("Accept"))
		require.Len(t, send.header, 3, "no Content-Type without a body")
		require.Zero(t, send.length)
		require.Empty(t, send.body)
	})

	// The path holds the device id, which a failure does not repeat.
	synctest.Test(t, func(t *testing.T) {
		f := newSocialFixture(t)
		f.transport.answer = func(int, *http.Request) (*http.Response, error) {
			return nil, errors.New("connection reset by peer")
		}

		_, err := f.sp.SocialJamStatus(context.Background(), testDev)
		var netErr *SocialNetworkError
		require.ErrorAs(t, err, &netErr)
		require.NotContains(t, err.Error(), testDev, "the url is not in the error")
	})
}

// Start's pair in one gate: the broadcast first, current_or_new at least a
// second later, two sends in all, and only the broadcast with a body.
func TestBroadcastThenCurrentOrNewThroughTheGate(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := newSocialFixture(t)
		f.transport.answer = func(n int, req *http.Request) (*http.Response, error) {
			if n == 0 {
				return respond(req, http.StatusOK, c0BroadcastAnswer(BroadcastOn, testDev)), nil
			}
			return respond(req, http.StatusOK, `{"session_id":"sid"}`), nil
		}

		ctx := context.Background()
		start := time.Now()
		_, err := f.sp.SocialSetBroadcastStatus(ctx, testDev, BroadcastOn)
		require.NoError(t, err)
		session, err := f.sp.SocialCurrentOrNew(ctx)
		require.NoError(t, err)
		require.JSONEq(t, `{"session_id":"sid"}`, string(session))

		sent := f.transport.sent()
		require.Len(t, sent, 2)
		require.Equal(t, "/social-connect/v2/devices/set_broadcast_status", sent[0].path)
		require.Equal(t, "/social-connect/v2/sessions/current_or_new", sent[1].path)
		require.GreaterOrEqual(t, sent[1].at.Sub(sent[0].at), socialSendSpacing)
		require.GreaterOrEqual(t, time.Since(start), socialSendSpacing)
		require.NotEmpty(t, sent[0].body)
		require.Empty(t, sent[1].body)
		require.Empty(t, sent[1].header.Values("Content-Type"))
		require.EqualValues(t, 2, f.gate.Stats().Sends)
	})
}

// lineLogger keeps every line logged, at any level.
type lineLogger struct {
	librespot.NullLogger

	mu    sync.Mutex
	lines []string
}

func (l *lineLogger) add(line string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.lines = append(l.lines, line)
}

func (l *lineLogger) Tracef(format string, args ...interface{}) { l.add(fmt.Sprintf(format, args...)) }
func (l *lineLogger) Debugf(format string, args ...interface{}) { l.add(fmt.Sprintf(format, args...)) }
func (l *lineLogger) Infof(format string, args ...interface{})  { l.add(fmt.Sprintf(format, args...)) }
func (l *lineLogger) Warnf(format string, args ...interface{})  { l.add(fmt.Sprintf(format, args...)) }
func (l *lineLogger) Errorf(format string, args ...interface{}) { l.add(fmt.Sprintf(format, args...)) }
func (l *lineLogger) Trace(args ...interface{})                 { l.add(fmt.Sprint(args...)) }
func (l *lineLogger) Debug(args ...interface{})                 { l.add(fmt.Sprint(args...)) }
func (l *lineLogger) Info(args ...interface{})                  { l.add(fmt.Sprint(args...)) }
func (l *lineLogger) Warn(args ...interface{})                  { l.add(fmt.Sprint(args...)) }
func (l *lineLogger) Error(args ...interface{})                 { l.add(fmt.Sprint(args...)) }

func (l *lineLogger) WithField(string, interface{}) librespot.Logger { return l }
func (l *lineLogger) WithError(error) librespot.Logger               { return l }

func (l *lineLogger) all() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string(nil), l.lines...)
}

// The broadcast calls log their op and status only: no device id, no token.
func TestSocialBroadcastLogsNoIds(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := newSocialFixture(t)
		log := &lineLogger{}
		f.sp.log = log
		f.transport.answer = answering(http.StatusOK, c0BroadcastAnswer(BroadcastOn, testDev))

		ctx := context.Background()
		_, err := f.sp.SocialSetBroadcastStatus(ctx, testDev, BroadcastOn)
		require.NoError(t, err)
		_, err = f.sp.SocialJamStatus(ctx, testDev)
		require.NoError(t, err)

		lines := log.all()
		require.Len(t, lines, 2)
		require.Regexp(t, `^social-connect set_broadcast_status -> 200 in \d+ ms$`, lines[0])
		require.Regexp(t, `^social-connect jam_status -> 200 in \d+ ms$`, lines[1])
		for _, line := range lines {
			require.NotContains(t, line, testDev)
			require.NotContains(t, line, radarToken)
			require.NotContains(t, line, linkToken)
		}
	})
}
