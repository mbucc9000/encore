//go:build windows

package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"encore-bridge/launcher/internal/core"
	"encore-bridge/launcher/internal/update"
)

// client talks to the bridge's loopback-only launcher routes (CONTRACT.md §5) with the per-start token.
type client struct {
	base  string
	token string
	hc    *http.Client
}

func newClient(port int, token string) *client {
	return &client{
		base:  fmt.Sprintf("http://127.0.0.1:%d", port),
		token: token,
		hc: &http.Client{
			Timeout:   3 * time.Second,
			Transport: &http.Transport{Proxy: nil, MaxIdleConns: 2, IdleConnTimeout: 30 * time.Second},
		},
	}
}

// statusError carries the HTTP status of a refused call.
type statusError struct{ code int }

func (e statusError) Error() string { return fmt.Sprintf("the bridge answered HTTP %d", e.code) }

func (c *client) do(method, path string, body any) ([]byte, error) {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, c.base+path, rd)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-Encore-Launcher", c.token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.hc.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode/100 != 2 {
		return nil, statusError{resp.StatusCode}
	}
	return b, nil
}

// status reads GET /local/v1/status. A bridge without the launcher routes answers 404 (statusError{404}).
func (c *client) status() (*core.Status, error) {
	b, err := c.do(http.MethodGet, "/local/v1/status", nil)
	if err != nil {
		return nil, err
	}
	return core.ParseStatus(b)
}

// shutdown asks for a graceful stop (the fallback when the stdin line didn't work).
func (c *client) shutdown() error {
	_, err := c.do(http.MethodPost, "/local/v1/shutdown", map[string]any{})
	return err
}

// setShowcase switches the bridge's Showcase mode (D4) and returns the new state.
func (c *client) setShowcase(on bool) (bool, error) {
	b, err := c.do(http.MethodPost, "/local/v1/showcase", map[string]bool{"on": on})
	if err != nil {
		return false, err
	}
	var r struct {
		Showcase bool `json:"showcase"`
	}
	if err := json.Unmarshal(b, &r); err != nil {
		return false, err
	}
	return r.Showcase, nil
}

// pushUpdate sends the launcher's update view (with handled_request when it acknowledges an admin-page request) to
// POST /local/v1/update (CONTRACT.md §9). An older bridge answers 404 (statusError{404}); the tray then shows
// updates alone.
func (c *client) pushUpdate(v update.View) error {
	_, err := c.do(http.MethodPost, "/local/v1/update", v)
	return err
}
