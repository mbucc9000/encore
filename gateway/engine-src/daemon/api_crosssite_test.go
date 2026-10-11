//go:build test_integration

package daemon

import (
	"bytes"
	"net"
	"net/http"
	"testing"

	librespot "github.com/devgianlu/go-librespot"
	"github.com/stretchr/testify/require"
)

// Encore patch 6c: a request a browser sent from another site (it carries that
// site's Origin) never reaches the daemon, even as a "simple" request that
// rs/cors alone would let through; requests without an Origin (the gateway,
// command-line clients) and from the API's own origin do.
func TestApiRefusesCrossSiteRequests(t *testing.T) {
	ts := newTestServer(t, okReply)

	post := func(origin, contentType string) *http.Response {
		req, err := http.NewRequest(http.MethodPost, ts.url+"/player/next", bytes.NewReader([]byte("{}")))
		require.NoError(t, err)
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		req.Header.Set("Content-Type", contentType)
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		t.Cleanup(func() { _ = resp.Body.Close() })
		return resp
	}

	for _, origin := range []string{"https://evil.example", "http://127.0.0.1.evil.example", "null"} {
		resp := post(origin, "text/plain")
		require.Equal(t, http.StatusForbidden, resp.StatusCode, origin)
		ts.requireNoRequest()
	}

	resp := post("", "text/plain")
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.Equal(t, ApiRequestTypeNext, ts.request().Type)

	resp = post(ts.url, "application/json")
	require.Equal(t, http.StatusOK, resp.StatusCode, "the API's own origin")
	require.Equal(t, ApiRequestTypeNext, ts.request().Type)
}

// allow_origin still lets the origin it names through (upstream's setting).
func TestApiAllowOriginStillPasses(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	s := &ConcreteApiServer{log: &librespot.NullLogger{}, listener: listener, requests: make(chan ApiRequest), allowOrigin: "https://ui.example"}
	go s.serve()
	t.Cleanup(func() { _ = s.Close() })
	go func() {
		for req := range s.requests {
			req.Reply(nil, nil)
		}
	}()

	do := func(origin string) int {
		req, err := http.NewRequest(http.MethodPost, "http://"+listener.Addr().String()+"/player/next", bytes.NewReader([]byte("{}")))
		require.NoError(t, err)
		req.Header.Set("Origin", origin)
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		_ = resp.Body.Close()
		return resp.StatusCode
	}
	require.Equal(t, http.StatusOK, do("https://ui.example"))
	require.Equal(t, http.StatusForbidden, do("https://other.example"))
}
