//go:build test_unit

package dealer

import (
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	librespot "github.com/devgianlu/go-librespot"
	"github.com/stretchr/testify/require"
)

// levelLogger keeps every line with its level and the uri field it was logged
// with.
type levelLogger struct {
	librespot.NullLogger

	mu    *sync.Mutex
	lines *[]string
	uri   string
}

func newLevelLogger() *levelLogger {
	return &levelLogger{mu: &sync.Mutex{}, lines: &[]string{}}
}

func (l *levelLogger) add(level, msg string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	*l.lines = append(*l.lines, fmt.Sprintf("%s %s uri=%s", level, msg, l.uri))
}

func (l *levelLogger) Debug(args ...interface{}) { l.add("debug", fmt.Sprint(args...)) }
func (l *levelLogger) Info(args ...interface{})  { l.add("info", fmt.Sprint(args...)) }
func (l *levelLogger) Warn(args ...interface{})  { l.add("warn", fmt.Sprint(args...)) }
func (l *levelLogger) Warnf(format string, args ...interface{}) {
	l.add("warn", fmt.Sprintf(format, args...))
}

func (l *levelLogger) WithField(key string, value interface{}) librespot.Logger {
	if key != "uri" {
		return l
	}
	return &levelLogger{mu: l.mu, lines: l.lines, uri: fmt.Sprint(value)}
}

func (l *levelLogger) WithError(error) librespot.Logger { return l }

func (l *levelLogger) all() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string(nil), *l.lines...)
}

// newTestDealer is a dealer with no connection, whose receivers are buffered
// so that handleMessage can be driven by hand.
func newTestDealer(log librespot.Logger, prefixes ...string) (*Dealer, chan Message) {
	c := make(chan Message, 4)
	d := &Dealer{log: log, done: make(chan struct{})}
	d.messageReceivers = append(d.messageReceivers, messageReceiver{uriPrefixes: prefixes, c: c})
	return d, c
}

func received(t *testing.T, c chan Message) Message {
	t.Helper()

	select {
	case msg := <-c:
		return msg
	case <-time.After(time.Second):
		t.Fatal("nothing delivered")
		return Message{}
	}
}

const socialUri = "hm://social-connect/v2/session_update/35lwkDPCBS93o5gUm1sCsy"

// Some services push their payload as JSON rather than as a base64 string.
// Such a payload was dropped with a warning even when a receiver wanted it; it
// is delivered now, byte for byte as it came, with no transfer encoding
// applied: social-connect's session_update, which the gateway reads, keeps its
// keys in their order and its numbers exact, past 2^53 too.
func TestHandleMessageDeliversJsonPayloads(t *testing.T) {
	d, c := newTestDealer(&librespot.NullLogger{}, "hm://social-connect/", "social-connect/")

	// The 2026 capture's uri has no hm:// in front; the values are synthetic.
	payload := `{"session":{"session_id":"0123456789abcdef0123456789abcdef","timestamp":"1790000000000",` +
		`"session_members":[{"username":"jake","display_name":"J\u00e4ke <&>","playbackControl":"CONTROL"}],` +
		`"maxMemberCount":32,"big":9007199254740993,"ratio":1.50},"reason":"USER_JOINED"}`
	var raw RawMessage
	require.NoError(t, json.Unmarshal([]byte(`{"type":"message","uri":"social-connect/v2/session_update",
		"headers":{"Content-Type":"application/json","Transfer-Encoding":"gzip"},
		"payloads":[ `+payload+` ]}`), &raw))
	d.handleMessage(&raw)

	msg := received(t, c)
	require.Equal(t, "social-connect/v2/session_update", msg.Uri)
	require.Equal(t, payload, string(msg.Payload), "byte for byte")

	require.NoError(t, json.Unmarshal([]byte(`{"type":"message","uri":"`+socialUri+`","payloads":[[1,"two"]]}`), &raw))
	d.handleMessage(&raw)
	require.Equal(t, `[1,"two"]`, string(received(t, c).Payload))
}

// A payload that is neither a string nor JSON's object or array is dropped
// with a warning, as before.
func TestHandleMessageDropsOtherPayloads(t *testing.T) {
	log := newLevelLogger()
	d, c := newTestDealer(log, "hm://social-connect/")

	for _, payload := range []string{"7", "null", "true"} {
		var raw RawMessage
		require.NoError(t, json.Unmarshal([]byte(`{"type":"message","uri":"`+socialUri+`","payloads":[`+payload+`]}`), &raw))
		d.handleMessage(&raw)
	}

	require.Empty(t, c)
	require.Equal(t, []string{
		"warn unsupported payload format: number uri=hm://social-connect/v2/session_update/*",
		"warn unsupported payload format: null uri=hm://social-connect/v2/session_update/*",
		"warn unsupported payload format: boolean uri=hm://social-connect/v2/session_update/*",
	}, log.all())
}

// The usual base64 payload is unchanged: as it is, with its "/" escaped in
// the JSON string, and gzipped.
func TestHandleMessageDecodesBase64Payloads(t *testing.T) {
	d, c := newTestDealer(&librespot.NullLogger{}, "hm://social-connect/")

	payload := base64.StdEncoding.EncodeToString([]byte(`{"session_id":"sid"}`))
	var raw RawMessage
	require.NoError(t, json.Unmarshal([]byte(`{"type":"message","uri":"`+socialUri+`","payloads":["`+payload+`"]}`), &raw))
	d.handleMessage(&raw)

	require.Equal(t, `{"session_id":"sid"}`, string(received(t, c).Payload))

	// "???" encodes with a "/", which JSON may escape.
	payload = base64.StdEncoding.EncodeToString([]byte(`{"q":"???"}`))
	require.Contains(t, payload, "/")
	payload = strings.ReplaceAll(payload, "/", `\/`)
	require.NoError(t, json.Unmarshal([]byte(`{"type":"message","uri":"`+socialUri+`","payloads":["`+payload+`"]}`), &raw))
	d.handleMessage(&raw)
	require.Equal(t, `{"q":"???"}`, string(received(t, c).Payload))

	var zipped bytes.Buffer
	gz := gzip.NewWriter(&zipped)
	_, err := gz.Write([]byte(`{"session_id":"sid"}`))
	require.NoError(t, err)
	require.NoError(t, gz.Close())
	payload = base64.StdEncoding.EncodeToString(zipped.Bytes())

	require.NoError(t, json.Unmarshal([]byte(`{"type":"message","uri":"`+socialUri+`",
		"headers":{"Transfer-Encoding":"gzip"},"payloads":["`+payload+`"]}`), &raw))
	d.handleMessage(&raw)
	require.Equal(t, `{"session_id":"sid"}`, string(received(t, c).Payload))
}

// A message with more than one payload panicked before any matching, and
// nothing recovered the receive loop: the daemon exited. It is dropped with a
// warning now.
func TestHandleMessageDropsSeveralPayloads(t *testing.T) {
	log := newLevelLogger()
	d, c := newTestDealer(log, "hm://social-connect/")

	var raw RawMessage
	require.NoError(t, json.Unmarshal([]byte(`{"type":"message","uri":"`+socialUri+`","payloads":["YQ==","Yg=="]}`), &raw))
	require.NotPanics(t, func() { d.handleMessage(&raw) })

	require.Empty(t, c)
	require.Equal(t, []string{"warn dropping dealer message with 2 payloads uri=hm://social-connect/v2/session_update/*"}, log.all())
}

// A message nothing receives is logged at info the first time its masked uri
// is seen, at debug after that, and never with its ids.
func TestHandleMessageLogsUnmatchedUrisOnce(t *testing.T) {
	log := newLevelLogger()
	d, _ := newTestDealer(log, "hm://connect-state/v1/")

	for _, uri := range []string{
		"hm://social-connect/v2/session_update/35lwkDPCBS93o5gUm1sCsy",
		"hm://social-connect/v2/session_update/9aWl1cNlqkTlzTNwFa1t2A?x=1",
		"hm://playlist/v2/playlist/37i9dQZF1DXcBWIGoYBM5M",
	} {
		d.handleMessage(&RawMessage{Type: "message", Uri: uri})
	}

	require.Equal(t, []string{
		"info skipping dealer message nothing receives (logged at info once per uri) uri=hm://social-connect/v2/session_update/*",
		"debug skipping dealer message uri=hm://social-connect/v2/session_update/*?x=1",
		"info skipping dealer message nothing receives (logged at info once per uri) uri=hm://playlist/v2/playlist/*",
	}, log.all())
}

// Ids are masked whole, the ones with '-' or '_' in them too; words joined by
// those stay readable.
func TestMaskIds(t *testing.T) {
	for in, want := range map[string]string{
		"hm://pusher/v1/connections/Y2xpZW50LWlkLTEyMzQ1Njc4OTA=":                      "hm://pusher/v1/connections/*=",
		"hm://social-connect/v2/sessions/35lwkDPCBS93o5gUm1sCsy/members":               "hm://social-connect/v2/sessions/*/members",
		"hm://social-connect/v2/session/123e4567-e89b-12d3-a456-426614174000/update":   "hm://social-connect/v2/session/*/update",
		"hm://social-connect/v2/join?token=Ab3_x9Kq-Lm2Zp7Qr&type=REMOTE":              "hm://social-connect/v2/join?token=*&type=REMOTE",
		"hm://social-connect/v2/members/spotify%3Auser%3Ajake_smith_1990/session_info": "hm://social-connect/v2/members/spotify%3Auser%*/session_info",
		"hm://connect-state/v1/cluster":                                                "hm://connect-state/v1/cluster",
		"social-connect-1ce14fef83e5a794b92abe1681e910d9":                              "*",
		"session_update": "session_update",
		"q1w2_e3r4-t5":   "*",
		"q1w2_e3r4-t":    "q1w2_e3r4-t",
		"abcdefghijk":    "abcdefghijk",
		"abcdefghijkl":   "*",
	} {
		require.Equal(t, want, MaskIds(in), in)
	}
}
