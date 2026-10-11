package update

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

// The release source. Not configurable in release builds: a fork changes Repo and the keys together (§2.1).
const (
	Repo         = "mbucc9000/encore"
	APIBase      = "https://api.github.com"
	DownloadBase = "https://github.com"
)

// Kinds of installation (§5.1).
const (
	KindInstaller = "windows-installer"
	KindZip       = "windows-zip"
	KindDocker    = "docker"
	KindOther     = "other"
)

// Error codes (§2.2, §5.9).
const (
	CodeOffline          = "offline"
	CodeTimeout          = "timeout"
	CodeRateLimited      = "rate_limited"
	CodeHTTPError        = "http_error"
	CodeBadAnswer        = "bad_answer"
	CodeNoRelease        = "no_release"
	CodeIncomplete       = "incomplete_release"
	CodeBadSignature     = "bad_signature"
	CodeSumsEntryMissing = "sums_entry_missing"
	CodeDownloadFailed   = "download_failed"
	CodeNoSpace          = "no_space"
	CodeHashMismatch     = "hash_mismatch"
	CodeSetupCancelled   = "setup_cancelled"
	CodeSetupFailed      = "setup_failed"
	CodeSetupStartFailed = "setup_start_failed"
)

// Asset names (§0).
func InstallerName(v string) string { return "EncoreBridge-" + v + "-setup.exe" }
func ZipName(v string) string       { return "EncoreBridge-" + v + "-win64.zip" }
func SourceName(v string) string    { return "Encore-" + v + "-source.tar.gz" }

// KindAsset is the asset this kind of installation needs.
func KindAsset(kind, v string) string {
	switch kind {
	case KindInstaller:
		return InstallerName(v)
	case KindZip:
		return ZipName(v)
	}
	return SourceName(v)
}

// NotesURL is the release page (display only), built from constants and a validated version.
func NotesURL(v string) string { return DownloadBase + "/" + Repo + "/releases/tag/v" + v }

const (
	maxInstallerSize = 512 << 20
	maxAPIBody       = 1 << 20
	maxAPIRedirects  = 3
	maxDLRedirects   = 5
	freeSpaceMargin  = 64 << 20
)

// Logf writes one log line; level is "I", "W" or "E". Lines never carry URLs, addresses, ETags or answer bodies.
type Logf func(level, format string, a ...any)

// Config sets up a Client. Only Current, Kind, Keys and Logf matter in a release build.
type Config struct {
	Current string // the running version (main.version)
	Kind    string
	Keys    []Key // the embedded trust list (TrustedKeys)
	Logf    Logf

	// Test only: loopback bases (http://127.0.0.1:<port>, http://[::1]:<port>, http://localhost:<port>) for a fake
	// GitHub, and keys trusted only together with them. Both bases must be loopback, else New refuses them.
	APIBase, DownloadBase string
	TestKeys              []Key

	Now          func() time.Time
	Jitter       func() time.Duration                       // 0-60 min
	Sleep        func(context.Context, time.Duration) error // between download tries
	FreeSpace    func(dir string) (uint64, error)           // nil: not checked
	Transport    http.RoundTripper                          // nil: the default (HTTPS_PROXY honoured)
	APITimeout   time.Duration                              // 15 s
	ConnTimeout  time.Duration                              // 15 s
	StallTimeout time.Duration                              // 60 s
	RetryDelays  []time.Duration                            // 2 s, 10 s
	ProgressGap  time.Duration                              // 1 s
}

// Client checks and downloads. Safe for one caller at a time per State.
type Client struct {
	cfg      Config
	cur      Version
	dev      bool
	api, dl  *url.URL
	test     bool
	keys     []Key
	apiHTTP  *http.Client
	dlHTTP   *http.Client
	logf     Logf
	contacts atomic.Int64 // requests sent (tests)
}

// ErrTestBases: a test base that isn't a loopback http address. The message never repeats the value.
var ErrTestBases = errors.New("the test bases for the update check must both be loopback http addresses with a port; ignored")

// New makes a Client. With test bases that aren't both loopback it returns ErrTestBases.
func New(cfg Config) (*Client, error) {
	c := &Client{cfg: cfg, logf: cfg.Logf}
	if c.logf == nil {
		c.logf = func(string, string, ...any) {}
	}
	if c.cfg.Now == nil {
		c.cfg.Now = time.Now
	}
	if c.cfg.Jitter == nil {
		c.cfg.Jitter = func() time.Duration { return time.Duration(rand.Int64N(int64(MaxJitter))) }
	}
	if c.cfg.Sleep == nil {
		c.cfg.Sleep = sleepCtx
	}
	def := func(d *time.Duration, v time.Duration) {
		if *d <= 0 {
			*d = v
		}
	}
	def(&c.cfg.APITimeout, 15*time.Second)
	def(&c.cfg.ConnTimeout, 15*time.Second)
	def(&c.cfg.StallTimeout, 60*time.Second)
	def(&c.cfg.ProgressGap, time.Second)
	if c.cfg.RetryDelays == nil {
		c.cfg.RetryDelays = []time.Duration{2 * time.Second, 10 * time.Second}
	}
	c.cur, c.dev = ParseCurrent(cfg.Current)
	c.dev = !c.dev
	c.keys = append([]Key(nil), cfg.Keys...)

	if cfg.APIBase == "" && cfg.DownloadBase == "" {
		c.api, _ = url.Parse(APIBase)
		c.dl, _ = url.Parse(DownloadBase)
	} else {
		a, okA := loopbackBase(cfg.APIBase)
		d, okD := loopbackBase(cfg.DownloadBase)
		if !okA || !okD {
			return nil, ErrTestBases
		}
		c.api, c.dl, c.test = a, d, true
		c.keys = append(c.keys, cfg.TestKeys...)
	}

	tr := cfg.Transport
	if tr == nil {
		tr = &http.Transport{
			Proxy:                 http.ProxyFromEnvironment, // HTTPS_PROXY only; loopback is never proxied
			DialContext:           (&net.Dialer{Timeout: c.cfg.ConnTimeout, KeepAlive: 30 * time.Second}).DialContext,
			TLSHandshakeTimeout:   c.cfg.ConnTimeout,
			ResponseHeaderTimeout: c.cfg.StallTimeout,
			ForceAttemptHTTP2:     true,
			MaxIdleConns:          2,
			IdleConnTimeout:       30 * time.Second,
		}
	}
	// no cookie jar: nothing is ever stored or sent back except a content-hash ETag
	c.apiHTTP = &http.Client{Transport: tr, CheckRedirect: c.apiRedirect}
	c.dlHTTP = &http.Client{Transport: tr, CheckRedirect: c.dlRedirect}
	return c, nil
}

// loopbackBase accepts http://127.0.0.1:<port>, http://[::1]:<port> or http://localhost:<port> with no path.
func loopbackBase(s string) (*url.URL, bool) {
	u, err := url.Parse(s)
	if err != nil || u.Scheme != "http" || u.Port() == "" || u.User != nil || u.RawQuery != "" || strings.Trim(u.Path, "/") != "" {
		return nil, false
	}
	switch u.Hostname() {
	case "127.0.0.1", "::1", "localhost":
	default:
		return nil, false
	}
	u.Path = ""
	return u, true
}

// Dev reports a development build (no automatic checks, nothing offered).
func (c *Client) Dev() bool { return c.dev }

// Current is the running version.
func (c *Client) Current() string { return c.cfg.Current }

// Kind is this copy's kind.
func (c *Client) Kind() string { return c.cfg.Kind }

// Requests counts the requests this client sent (tests).
func (c *Client) Requests() int64 { return c.contacts.Load() }

func (c *Client) userAgent() string { return "EncoreBridge/" + c.cfg.Current }

func (c *Client) latestURL() string { return c.api.String() + "/repos/" + Repo + "/releases/latest" }

// AssetURL is where a release asset is downloaded from: built from constants and the validated version, never from
// the API's answer (§4.2).
func (c *Client) AssetURL(v, name string) string {
	return c.dl.String() + "/" + Repo + "/releases/download/v" + v + "/" + name
}

var errRedirect = errors.New("redirect not allowed")

// apiRedirect: at most 3, each to https://api.github.com/... (the same loopback base in tests). Go would add a
// Referer header on a redirect; nothing but the fixed headers is sent, so it is removed.
func (c *Client) apiRedirect(req *http.Request, via []*http.Request) error {
	req.Header.Del("Referer")
	if len(via) > maxAPIRedirects || !c.apiTarget(req.URL) {
		return errRedirect
	}
	return nil
}

func (c *Client) apiTarget(u *url.URL) bool {
	if c.test {
		return u.Scheme == c.api.Scheme && u.Host == c.api.Host
	}
	return AllowedAPIRedirect(u)
}

// AllowedAPIRedirect is the production rule for API redirects.
func AllowedAPIRedirect(u *url.URL) bool {
	return u.Scheme == "https" && strings.EqualFold(u.Host, "api.github.com") && u.User == nil
}

// dlRedirect: at most 5, each https to github.com or *.githubusercontent.com (the same loopback base in tests).
func (c *Client) dlRedirect(req *http.Request, via []*http.Request) error {
	req.Header.Del("Referer")
	if len(via) > maxDLRedirects {
		return errRedirect
	}
	if c.test {
		if req.URL.Scheme != c.dl.Scheme || req.URL.Host != c.dl.Host {
			return errRedirect
		}
		return nil
	}
	if !AllowedDownloadRedirect(req.URL) {
		return errRedirect
	}
	return nil
}

// AllowedDownloadRedirect is the production rule for download hops.
func AllowedDownloadRedirect(u *url.URL) bool {
	if u.Scheme != "https" || u.User != nil || u.Port() != "" {
		return false
	}
	h := strings.ToLower(u.Hostname())
	return h == "github.com" || (strings.HasSuffix(h, ".githubusercontent.com") && len(h) > len(".githubusercontent.com"))
}

// request builds a GET with exactly the allowed headers (§2.1): Accept, X-GitHub-Api-Version, User-Agent and, for the
// API only, If-None-Match. The transport adds Host, Connection and Go's Accept-Encoding; nothing else is sent.
func (c *Client) request(ctx context.Context, u, etag string) (*http.Request, *atomic.Bool, error) {
	written := new(atomic.Bool)
	trace := &httptrace.ClientTrace{WroteRequest: func(httptrace.WroteRequestInfo) { written.Store(true) }}
	req, err := http.NewRequestWithContext(httptrace.WithClientTrace(ctx, trace), http.MethodGet, u, nil)
	if err != nil {
		return nil, nil, err
	}
	req.Header = http.Header{}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	req.Header.Set("User-Agent", c.userAgent())
	if etag != "" {
		req.Header.Set("If-None-Match", etag)
	}
	return req, written, nil
}

// classify turns a transport error into a code (§2.2): nothing sent → offline; a timeout after sending → timeout; a
// refused redirect → bad_answer; anything else after sending → bad_answer.
func classify(err error, written bool) string {
	if errors.Is(err, errRedirect) {
		return CodeBadAnswer
	}
	if !written {
		return CodeOffline
	}
	var ne net.Error
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &ne) && ne.Timeout()) {
		return CodeTimeout
	}
	return CodeBadAnswer
}

// release is the part of GitHub's answer that is read (§2.5); everything else is ignored.
type release struct {
	TagName     *string `json:"tag_name"`
	Draft       bool    `json:"draft"`
	Prerelease  bool    `json:"prerelease"`
	PublishedAt *string `json:"published_at"`
	Assets      []struct {
		Name  string `json:"name"`
		Size  int64  `json:"size"`
		ID    int64  `json:"id"`
		State string `json:"state"`
	} `json:"assets"`
}

type answer struct {
	status    int
	etag      string
	rel       *release
	err       *CheckError
	contacted bool // the request may have reached GitHub
}

// fetchLatest asks for the latest release (one request, 15 s for the whole exchange, 1 MiB cap).
func (c *Client) fetchLatest(ctx context.Context, etag string) answer {
	ctx, cancel := context.WithTimeout(ctx, c.cfg.APITimeout)
	defer cancel()
	req, written, err := c.request(ctx, c.latestURL(), etag)
	if err != nil {
		return answer{err: &CheckError{Code: CodeBadAnswer}}
	}
	c.contacts.Add(1)
	resp, err := c.apiHTTP.Do(req)
	if err != nil {
		code := classify(err, written.Load())
		return answer{err: &CheckError{Code: code}, contacted: code != CodeOffline}
	}
	defer resp.Body.Close()
	a := answer{status: resp.StatusCode, contacted: true}
	now := c.cfg.Now()
	switch {
	case resp.StatusCode == http.StatusOK:
		body, err := io.ReadAll(io.LimitReader(resp.Body, maxAPIBody+1))
		if err != nil {
			a.err = &CheckError{Code: classify(err, true)}
			return a
		}
		if len(body) > maxAPIBody {
			a.err = &CheckError{Code: CodeBadAnswer}
			return a
		}
		var r release
		if json.Unmarshal(body, &r) != nil || r.TagName == nil {
			a.err = &CheckError{Code: CodeBadAnswer}
			return a
		}
		a.rel = &r
		if e := resp.Header.Get("ETag"); validETag(e) {
			a.etag = e
		}
	case resp.StatusCode == http.StatusNotModified:
		if etag == "" {
			a.err = &CheckError{Code: CodeBadAnswer} // a 304 to a request without If-None-Match
		}
	case resp.StatusCode == http.StatusNotFound:
	case resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusTooManyRequests:
		if rl := rateLimit(resp.Header, now); rl != nil {
			a.err = &CheckError{Code: CodeRateLimited, RetryAt: rl}
		} else {
			a.err = &CheckError{Code: CodeHTTPError, HTTPStatus: resp.StatusCode}
		}
	case resp.StatusCode >= 400 && resp.StatusCode <= 599:
		a.err = &CheckError{Code: CodeHTTPError, HTTPStatus: resp.StatusCode}
	default:
		a.err = &CheckError{Code: CodeBadAnswer}
	}
	io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	return a
}

// rateLimit reads GitHub's rate-limit headers (§2.2): the primary limit (x-ratelimit-remaining: 0, retry at
// x-ratelimit-reset) or the secondary one (retry-after seconds, at most 24 h). nil: not a rate limit.
func rateLimit(h http.Header, now time.Time) *time.Time {
	limit := now.Add(maxRetryAfter)
	if strings.TrimSpace(h.Get("X-RateLimit-Remaining")) == "0" {
		t := now.Add(time.Hour)
		if n, err := strconv.ParseInt(strings.TrimSpace(h.Get("X-RateLimit-Reset")), 10, 64); err == nil {
			t = time.Unix(n, 0).UTC()
		}
		if t.After(limit) {
			t = limit
		}
		if t.Before(now) {
			t = now
		}
		return &t
	}
	if ra := strings.TrimSpace(h.Get("Retry-After")); ra != "" {
		n, err := strconv.ParseInt(ra, 10, 64)
		if err != nil || n < 0 {
			return nil
		}
		t := now.Add(time.Duration(n) * time.Second)
		if n > int64(maxRetryAfter/time.Second) {
			t = limit
		}
		return &t
	}
	return nil
}

// getSmall downloads a small release file (SHA256SUMS.txt or its signature) with the download rules (§4.2): the
// constant URL, allowed redirect hops only, at most max bytes (more is a bad answer).
func (c *Client) getSmall(ctx context.Context, v, name string, max int64) ([]byte, *CheckError) {
	ctx, cancel := context.WithTimeout(ctx, c.cfg.APITimeout)
	defer cancel()
	req, written, err := c.request(ctx, c.AssetURL(v, name), "")
	if err != nil {
		return nil, &CheckError{Code: CodeBadAnswer}
	}
	c.contacts.Add(1)
	resp, err := c.dlHTTP.Do(req)
	if err != nil {
		return nil, &CheckError{Code: classify(err, written.Load())}
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusOK:
	case resp.StatusCode == http.StatusNotFound:
		return nil, &CheckError{Code: CodeIncomplete, Version: v}
	case resp.StatusCode >= 400 && resp.StatusCode <= 599:
		return nil, &CheckError{Code: CodeHTTPError, HTTPStatus: resp.StatusCode}
	default:
		return nil, &CheckError{Code: CodeBadAnswer}
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, max+1))
	if err != nil {
		return nil, &CheckError{Code: classify(err, true)}
	}
	if int64(len(b)) > max {
		return nil, &CheckError{Code: CodeBadAnswer}
	}
	return b, nil
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// FreeSpaceNeeded is what Update now needs free for an installer of size bytes (§5.4).
func FreeSpaceNeeded(size int64) uint64 { return uint64(size) + freeSpaceMargin }

// errText is a short, content-free description for the log (no addresses, no paths).
func errText(err error) string {
	var pe *os.PathError
	if errors.As(err, &pe) {
		return pe.Op + ": " + pe.Err.Error()
	}
	return fmt.Sprintf("%T", err)
}
