// Package fakegh is a fake GitHub for the launcher's update tests (DESIGN-UPDATES.md §14.2): the latest-release API
// endpoint of mbucc9000/encore and release downloads (answered with a redirect to a second "download server" path, as
// GitHub does). It records every request and can be told to misbehave. Tests use it through httptest (Start); the
// Wine smoke test runs cmd/fakegh, which serves a release folder. It only ever listens on loopback.
//
// The signing keys are the RFC 8032 §7.1 TEST 1 and TEST 2 keys: public test data, never trusted by a release build.
package fakegh

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Repo is the repository the fake serves.
const Repo = "mbucc9000/encore"

// RFC 8032 §7.1 test keys (seeds).
var (
	Test1Seed = mustHex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
	Test2Seed = mustHex("4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb")
)

func mustHex(s string) []byte {
	b, err := hex.DecodeString(s)
	if err != nil {
		panic(err)
	}
	return b
}

// PublicB64 is the base64 raw public key of a seed (the launcher's key format).
func PublicB64(seed []byte) string {
	return base64.StdEncoding.EncodeToString(ed25519.NewKeyFromSeed(seed).Public().(ed25519.PublicKey))
}

// Sums is SHA256SUMS.txt for files (sorted by name, two spaces, LF, final newline), skipping the list and signature.
func Sums(files map[string][]byte) []byte {
	var names []string
	for n := range files {
		if n != "SHA256SUMS.txt" && n != "SHA256SUMS.txt.sig" {
			names = append(names, n)
		}
	}
	sort.Strings(names)
	var b bytes.Buffer
	for _, n := range names {
		h := sha256.Sum256(files[n])
		fmt.Fprintf(&b, "%s  %s\n", hex.EncodeToString(h[:]), n)
	}
	return b.Bytes()
}

// Sign signs msg with a seed.
func Sign(seed, msg []byte) []byte { return ed25519.Sign(ed25519.NewKeyFromSeed(seed), msg) }

// Release is what the fake publishes.
type Release struct {
	Tag         string
	Draft       bool
	Prerelease  bool
	PublishedAt string
	Files       map[string][]byte // served by name (SHA256SUMS.txt and .sig included)
	States      map[string]string // asset state (default "uploaded")
	Sizes       map[string]int64  // the size the API reports (default: the file's)
	Omit        map[string]bool   // left out of the API's asset list
}

// MakeRelease builds a release of ver with files plus SHA256SUMS.txt signed with seed (nil: no signature file).
func MakeRelease(ver string, files map[string][]byte, seed []byte) *Release {
	r := &Release{Tag: "v" + ver, PublishedAt: "2026-10-10T12:00:00Z", Files: map[string][]byte{}}
	for n, b := range files {
		r.Files[n] = b
	}
	sums := Sums(r.Files)
	r.Files["SHA256SUMS.txt"] = sums
	if seed != nil {
		r.Files["SHA256SUMS.txt.sig"] = Sign(seed, sums)
	}
	return r
}

// Request is one recorded request.
type Request struct {
	Method, Path, RawQuery string
	Header                 http.Header
}

// Options make the fake misbehave.
type Options struct {
	LatestStatus     int    // answer the API with this status (404, 500, …)
	RateLimitReset   int64  // 403 with x-ratelimit-remaining: 0 and this x-ratelimit-reset
	RetryAfter       string // 429 with this retry-after
	ETag             string // sent with every 200 from the API
	Honor304         bool   // 304 when If-None-Match equals ETag
	Malformed        bool   // the API answers something that isn't JSON
	Oversize         bool   // the API answers more than 1 MiB
	StallAPI         bool   // the API never answers
	StallDownload    bool   // downloads send their headers, then nothing
	CutAt            float64
	CutTimes         int    // how many installer downloads are cut at CutAt (default 1 when CutAt > 0)
	IgnoreRange      bool   // answer 200 with the whole file to a Range request
	RedirectAPI      string // the API answers 301 to this
	RedirectDownload string // release downloads redirect here instead of the download path
	Missing404       string // this asset's download answers 404
}

// Server is a running fake.
type Server struct {
	URL string

	mu    sync.Mutex
	rel   *Release
	opt   Options
	reqs  []Request
	cuts  int
	stop  chan struct{}
	ts    *httptest.Server
	stall time.Duration
}

// Start runs a fake on a loopback port (httptest).
func Start(rel *Release, opt Options) *Server {
	s := New(rel, opt)
	s.ts = httptest.NewServer(s)
	s.URL = s.ts.URL
	return s
}

// New makes a fake without a listener (cmd/fakegh serves it).
func New(rel *Release, opt Options) *Server {
	return &Server{rel: rel, opt: opt, stop: make(chan struct{}), stall: time.Hour}
}

// Close stops a fake started with Start.
func (s *Server) Close() {
	s.mu.Lock()
	select {
	case <-s.stop:
	default:
		close(s.stop)
	}
	s.mu.Unlock()
	if s.ts != nil {
		s.ts.CloseClientConnections()
		s.ts.Close()
	}
}

// Set replaces the release and options.
func (s *Server) Set(rel *Release, opt Options) {
	s.mu.Lock()
	s.rel, s.opt, s.cuts = rel, opt, 0
	s.mu.Unlock()
}

// Requests returns the recorded requests.
func (s *Server) Requests() []Request {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Request(nil), s.reqs...)
}

// Count counts recorded requests whose path starts with prefix.
func (s *Server) Count(prefix string) int {
	n := 0
	for _, r := range s.Requests() {
		if strings.HasPrefix(r.Path, prefix) {
			n++
		}
	}
	return n
}

// ResetRequests forgets the recorded requests.
func (s *Server) ResetRequests() {
	s.mu.Lock()
	s.reqs = nil
	s.mu.Unlock()
}

const (
	latestPath   = "/repos/" + Repo + "/releases/latest"
	downloadPath = "/" + Repo + "/releases/download/"
	dlPath       = "/dl/"
)

// LatestPath and DownloadPrefix are the paths the fake answers.
func LatestPath() string     { return latestPath }
func DownloadPrefix() string { return downloadPath }

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	s.reqs = append(s.reqs, Request{Method: r.Method, Path: r.URL.Path, RawQuery: r.URL.RawQuery, Header: r.Header.Clone()})
	rel, opt := s.rel, s.opt
	s.mu.Unlock()
	switch {
	case r.URL.Path == latestPath:
		s.latest(w, r, rel, opt)
	case strings.HasPrefix(r.URL.Path, downloadPath):
		rest := strings.TrimPrefix(r.URL.Path, downloadPath)
		tag, name, ok := strings.Cut(rest, "/")
		if !ok || rel == nil || tag != rel.Tag {
			http.NotFound(w, r)
			return
		}
		if opt.RedirectDownload != "" {
			http.Redirect(w, r, opt.RedirectDownload, http.StatusFound)
			return
		}
		// GitHub sends a redirect to its download servers, with a signed query string
		http.Redirect(w, r, dlPath+tag+"/"+name+"?sig=abc&exp=1", http.StatusFound)
	case strings.HasPrefix(r.URL.Path, dlPath):
		rest := strings.TrimPrefix(r.URL.Path, dlPath)
		tag, name, ok := strings.Cut(rest, "/")
		if !ok || rel == nil || tag != rel.Tag || name == opt.Missing404 {
			http.NotFound(w, r)
			return
		}
		b, found := rel.Files[name]
		if !found {
			http.NotFound(w, r)
			return
		}
		s.serveFile(w, r, name, b, opt)
	default:
		http.NotFound(w, r)
	}
}

func (s *Server) wait(r *http.Request) {
	select {
	case <-r.Context().Done():
	case <-s.stop:
	case <-time.After(s.stall):
	}
}

func (s *Server) latest(w http.ResponseWriter, r *http.Request, rel *Release, opt Options) {
	switch {
	case opt.StallAPI:
		s.wait(r)
		return
	case opt.RedirectAPI != "":
		http.Redirect(w, r, opt.RedirectAPI, http.StatusMovedPermanently)
		return
	case opt.RateLimitReset != 0:
		w.Header().Set("X-RateLimit-Remaining", "0")
		w.Header().Set("X-RateLimit-Reset", strconv.FormatInt(opt.RateLimitReset, 10))
		http.Error(w, `{"message":"API rate limit exceeded"}`, http.StatusForbidden)
		return
	case opt.RetryAfter != "":
		w.Header().Set("Retry-After", opt.RetryAfter)
		http.Error(w, `{"message":"secondary rate limit"}`, http.StatusTooManyRequests)
		return
	case opt.LatestStatus != 0:
		http.Error(w, `{"message":"Not Found"}`, opt.LatestStatus)
		return
	case rel == nil:
		http.Error(w, `{"message":"Not Found"}`, http.StatusNotFound)
		return
	}
	if opt.Honor304 && opt.ETag != "" && r.Header.Get("If-None-Match") == opt.ETag {
		w.Header().Set("ETag", opt.ETag)
		w.WriteHeader(http.StatusNotModified)
		return
	}
	if opt.ETag != "" {
		w.Header().Set("ETag", opt.ETag)
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	if opt.Malformed {
		w.Write([]byte(`<html>this isn't JSON</html>`))
		return
	}
	type asset struct {
		Name     string `json:"name"`
		Size     int64  `json:"size"`
		ID       int64  `json:"id"`
		State    string `json:"state"`
		Download string `json:"browser_download_url"`
	}
	var names []string
	for n := range rel.Files {
		if !rel.Omit[n] {
			names = append(names, n)
		}
	}
	sort.Strings(names)
	var assets []asset
	for i, n := range names {
		size := int64(len(rel.Files[n]))
		if v, ok := rel.Sizes[n]; ok {
			size = v
		}
		state := "uploaded"
		if v, ok := rel.States[n]; ok {
			state = v
		}
		// a hostile download URL proves the launcher never uses it
		assets = append(assets, asset{Name: n, Size: size, ID: int64(1000 + i), State: state, Download: "https://evil.example/" + n})
	}
	var published any
	if rel.PublishedAt != "" {
		published = rel.PublishedAt
	}
	body := map[string]any{
		"tag_name": rel.Tag, "draft": rel.Draft, "prerelease": rel.Prerelease, "published_at": published,
		"name": "Encore <b>not shown</b>", "body": "release notes are never read", "html_url": "https://evil.example/notes",
		"assets": assets,
	}
	if opt.Oversize {
		body["body"] = strings.Repeat("x", 1<<20+10)
	}
	json.NewEncoder(w).Encode(body)
}

func (s *Server) serveFile(w http.ResponseWriter, r *http.Request, name string, b []byte, opt Options) {
	installer := strings.HasSuffix(name, "-setup.exe")
	if opt.StallDownload {
		w.Header().Set("Content-Length", strconv.Itoa(len(b)))
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		s.wait(r)
		return
	}
	s.mu.Lock()
	times := opt.CutTimes
	if times == 0 && opt.CutAt > 0 {
		times = 1
	}
	cut := installer && opt.CutAt > 0 && s.cuts < times && r.Header.Get("Range") == ""
	if cut {
		s.cuts++
	}
	s.mu.Unlock()
	if cut {
		n := int(float64(len(b)) * opt.CutAt)
		w.Header().Set("Content-Length", strconv.Itoa(len(b)))
		w.WriteHeader(http.StatusOK)
		w.Write(b[:n])
		w.(http.Flusher).Flush()
		panic(http.ErrAbortHandler) // the connection drops mid-file
	}
	if opt.IgnoreRange {
		w.Header().Set("Content-Length", strconv.Itoa(len(b)))
		w.WriteHeader(http.StatusOK)
		w.Write(b)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	http.ServeContent(w, r, name, time.Time{}, bytes.NewReader(b))
}
