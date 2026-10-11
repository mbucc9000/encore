//go:build test_unit

package session

import (
	"context"
	"fmt"
	"net/http"
	"runtime"
	"testing"
	"time"

	librespot "github.com/devgianlu/go-librespot"
)

// Encore patch 6b: loopback only on Windows, upstream's bind elsewhere.
func TestOAuthCallbackAddr(t *testing.T) {
	want := ":4242"
	if runtime.GOOS == "windows" {
		want = "127.0.0.1:4242"
	}
	if got := oauthCallbackAddr(4242); got != want {
		t.Errorf("oauthCallbackAddr(4242) = %q, want %q", got, want)
	}
}

// The redirect URI names 127.0.0.1, so the callback must answer there on
// every platform.
func TestOAuth2ServerTakesTheCodeOnLoopback(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	port, codes, err := NewOAuth2Server(ctx, &librespot.NullLogger{}, 0)
	if err != nil {
		t.Fatalf("NewOAuth2Server: %v", err)
	}

	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/login?code=abc", port))
	if err != nil {
		t.Fatalf("calling the callback: %v", err)
	}
	_ = resp.Body.Close()

	select {
	case code := <-codes:
		if code != "abc" {
			t.Errorf("code = %q, want %q", code, "abc")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the callback did not hand the code over")
	}
}
