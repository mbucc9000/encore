package daemon

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	librespot "github.com/devgianlu/go-librespot"
	connectpb "github.com/devgianlu/go-librespot/proto/spotify/connectstate"
	extmetadatapb "github.com/devgianlu/go-librespot/proto/spotify/extendedmetadata"
	metadatapb "github.com/devgianlu/go-librespot/proto/spotify/metadata"
	"github.com/devgianlu/go-librespot/spclient"
	"github.com/devgianlu/go-librespot/tracks"
	lru "github.com/hashicorp/golang-lru/v2"
)

// trackMetaCacheLimit is the least capacity of the in-memory metadata cache.
// Entries are a few KB each (a metadata proto), so it keeps the cache under
// ~10MB unless metadata.max_tracks asks for more.
const trackMetaCacheLimit = 1000

// trackMetaCacheHeadroom is kept on top of metadata.max_tracks for the moving
// playback window of other contexts.
const trackMetaCacheHeadroom = 200

// trackMetaCacheCapacity sizes the cache so that a fully swept context of
// maxTracks tracks fits. A smaller cache evicts the start of a context while
// sweeping its end, so cached never reaches length, and a client polling for
// that restarts the sweep over and over.
func trackMetaCacheCapacity(maxTracks int) int {
	return max(trackMetaCacheLimit, maxTracks+trackMetaCacheHeadroom)
}

// metaFailureTTL is how long a uri the backend had no metadata for is left
// out of the fetches. Long enough that polling a listing that holds one costs
// nothing, short enough that a track that comes back is picked up the same
// sitting.
const metaFailureTTL = time.Hour

// metaTransientFailureTTL is how long a uri the backend answered with a server
// error or a rate limit is left out instead. That is a fault of the moment, not
// an answer about the track, so it is asked for again as soon as a failed
// sweep would be, while a listing that holds one can still finish.
const metaTransientFailureTTL = metaSweepHold

// trackMetaCache is a bounded in-memory cache of track metadata keyed by URI.
// It is fed by loaded and prefetched streams and by background batch fetches
// of the current context window, and read by /status to describe the upcoming
// track before its stream loads. The LRU underneath is safe for the
// concurrent reads and writes this sees: the fetches run detached from the
// player loop. A nil cache is what metadata.enabled=false looks like, and
// every method treats it as a no-op.
type trackMetaCache struct {
	lru *lru.Cache[string, *librespot.Media]

	// failed remembers until when a uri that a request the backend answered
	// gave no usable metadata for is left out by missing, rather than asked
	// for again on every poll. A put of the uri forgets it.
	failed *lru.Cache[string, time.Time]

	// now is the clock failures expire by; replaced by tests.
	now func() time.Time
}

func newTrackMetaCache(capacity int) *trackMetaCache {
	l, _ := lru.New[string, *librespot.Media](capacity)
	failed, _ := lru.New[string, time.Time](capacity)
	return &trackMetaCache{lru: l, failed: failed, now: time.Now}
}

func (c *trackMetaCache) get(uri string) *librespot.Media {
	if c == nil {
		return nil
	}

	media, _ := c.lru.Get(uri)
	return media
}

func (c *trackMetaCache) put(uri string, media *librespot.Media) {
	if c == nil || uri == "" || media == nil {
		return
	}

	c.lru.Add(uri, media)
	c.failed.Remove(uri)
}

// has reports whether uri is cached without counting as a use of it, so
// counting a listing leaves the eviction order alone.
func (c *trackMetaCache) has(uri string) bool {
	return c != nil && c.lru.Contains(uri)
}

// markFailed remembers for ttl that the backend answered for uri without
// usable metadata. A uri that is cached is left alone: its metadata arrived
// another way meanwhile, a stream load say.
func (c *trackMetaCache) markFailed(uri string, ttl time.Duration) {
	if c == nil || uri == "" || c.lru.Contains(uri) {
		return
	}

	c.failed.Add(uri, c.now().Add(ttl))
}

// isFailed reports whether uri was marked failed and the mark still holds.
func (c *trackMetaCache) isFailed(uri string) bool {
	if c == nil {
		return false
	}

	until, ok := c.failed.Peek(uri)
	return ok && !c.now().After(until)
}

// putStream remembers a stream's metadata under the uri it was requested as
// and, when relinking changed it, under the uri of the media that actually
// came back: the state window names tracks by the former, the media by the
// latter.
func (c *trackMetaCache) putStream(requestedUri string, media *librespot.Media) {
	if c == nil || media == nil {
		return
	}

	c.put(requestedUri, media)
	c.put(media.Id().Uri(), media)
}

// missing returns the subset of uris not present in the cache and not
// recently failed, preserving order and dropping duplicates.
func (c *trackMetaCache) missing(uris []string) []string {
	if c == nil {
		return nil
	}

	var out []string
	seen := map[string]bool{}
	for _, uri := range uris {
		if uri == "" || seen[uri] {
			continue
		}
		seen[uri] = true
		if !c.lru.Contains(uri) && !c.isFailed(uri) {
			out = append(out, uri)
		}
	}
	return out
}

// contextListTTL bounds how long an enumerated context listing is reused.
// Re-polls while a sweep fills in metadata (seconds apart) must not re-page the
// whole context, but a playlist edited between two sittings should be picked up.
const contextListTTL = 5 * time.Minute

// contextListCacheLimit bounds how many enumerated contexts are remembered.
const contextListCacheLimit = 8

// contextListHold is how long a context whose enumeration failed is not
// enumerated again. A client polls the listing every second or so, and each
// poll would otherwise start the walk over from the first page, against the
// backend that just refused it.
const contextListHold = 30 * time.Second

type contextListEntry struct {
	uris    []string
	fetched time.Time

	// revision is the playlist.revision the resolver reported for the
	// context, "" for anything but a playlist.
	revision string

	// truncated reports that the enumeration stopped at metadata.max_tracks.
	truncated bool
}

// contextListCache remembers the track URIs of recently enumerated contexts.
// Enumeration pages over the network, and both the listing endpoint and the
// sweep ask for the same context repeatedly, so without this a client polling
// for a filling sweep would re-page the whole playlist on every poll. Nil when
// metadata.enabled is false, like trackMetaCache.
type contextListCache struct {
	lru *lru.Cache[string, contextListEntry]

	// now is the clock the TTL is checked against; replaced by tests.
	now func() time.Time

	// inFlight maps the uris being enumerated right now to the generation
	// they started at, so that a client polling every second does not spawn
	// an enumeration per poll, and an invalidation during an enumeration can
	// tell put to drop its possibly pre-change result. Changes to the LRU go
	// through mu too, so a put and an invalidation cannot interleave.
	mu       sync.Mutex
	inFlight map[string]uint64

	// failedAt maps each context whose last enumeration failed to when it
	// did, so that for contextListHold it is refused like one in flight and
	// the listing endpoint answers with the failure. Guarded by mu.
	failedAt map[string]time.Time
}

func newContextListCache() *contextListCache {
	l, _ := lru.New[string, contextListEntry](contextListCacheLimit)
	return &contextListCache{lru: l, now: time.Now, inFlight: map[string]uint64{}, failedAt: map[string]time.Time{}}
}

func (c *contextListCache) get(uri string) ([]string, bool) {
	e, ok := c.entry(uri)
	return e.uris, ok
}

// entry is get with what the enumeration recorded about the listing.
func (c *contextListCache) entry(uri string) (contextListEntry, bool) {
	if c == nil {
		return contextListEntry{}, false
	}

	e, ok := c.lru.Get(uri)
	if !ok || c.now().Sub(e.fetched) > contextListTTL {
		return contextListEntry{}, false
	}
	return e, true
}

// put caches the listing an enumeration begun at gen produced, stamped with
// the time, unless the context was invalidated since: the listing may then
// predate the change.
func (c *contextListCache) put(uri string, e contextListEntry, gen uint64) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if started, ok := c.inFlight[uri]; ok && started != gen {
		return
	}
	e.fetched = c.now()
	c.lru.Add(uri, e)
	delete(c.failedAt, uri)
}

// invalidate drops the listing of uri after it was changed through the
// daemon, so the next request enumerates it again instead of serving the
// old listing for the rest of contextListTTL.
func (c *contextListCache) invalidate(uri string) {
	if c == nil {
		return
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	c.lru.Remove(uri)
	if gen, ok := c.inFlight[uri]; ok {
		c.inFlight[uri] = gen + 1
	}
}

// beginFetch claims the right to enumerate uri and returns the generation to
// hand to put, reporting false when the listing is already cached, another
// goroutine is already enumerating it, or its last enumeration failed less
// than contextListHold ago.
func (c *contextListCache) beginFetch(uri string) (gen uint64, ok bool) {
	if c == nil {
		return 0, false
	}
	if _, ok := c.get(uri); ok {
		return 0, false
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	if _, ok := c.inFlight[uri]; ok || c.heldLocked(uri) {
		return 0, false
	}
	c.inFlight[uri] = 0
	return 0, true
}

func (c *contextListCache) endFetch(uri string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.inFlight, uri)
}

// fail records that an enumeration of uri failed, holding it for
// contextListHold, and forgets the holds that have run out. An invalidation
// does not lift it: the backend refused the context, whatever changed in it.
func (c *contextListCache) fail(uri string) {
	c.mu.Lock()
	defer c.mu.Unlock()

	now := c.now()
	for u, at := range c.failedAt {
		if now.Sub(at) >= contextListHold {
			delete(c.failedAt, u)
		}
	}
	c.failedAt[uri] = now
}

// held reports whether the last enumeration of uri failed less than
// contextListHold ago.
func (c *contextListCache) held(uri string) bool {
	if c == nil {
		return false
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	return c.heldLocked(uri)
}

func (c *contextListCache) heldLocked(uri string) bool {
	at, ok := c.failedAt[uri]
	return ok && c.now().Sub(at) < contextListHold
}

// metaExtensionKind returns the extended-metadata kind that describes the given
// uri, and whether the uri carries listable metadata at all. Anything else
// (local files, unexpected uri forms) has none.
func metaExtensionKind(uri string) (extmetadatapb.ExtensionKind, bool) {
	switch {
	case strings.HasPrefix(uri, "spotify:track:"):
		return extmetadatapb.ExtensionKind_TRACK_V4, true
	case strings.HasPrefix(uri, "spotify:episode:"):
		return extmetadatapb.ExtensionKind_EPISODE_V4, true
	}
	return 0, false
}

// isListableContextUri reports whether the uri names a context the listing
// endpoint should try to enumerate. Piggybacks on the item-type inference:
// any context whose items it can classify (playlist, album, artist, show, a
// user's Liked Songs collection, ...) is worth handing to the resolver, and
// anything it cannot classify would fail there anyway.
func isListableContextUri(uri string) bool {
	return librespot.InferSpotifyIdTypeFromContextUri(uri) != librespot.SpotifyIdTypeUnknown
}

const (
	// maxMetaBatch caps how many tracks a single extended-metadata request
	// asks for; the connect-state window (prev + current + next) fits.
	maxMetaBatch = 100

	// metaPrefetchDelay is how long a window fetch is held back after the
	// window changes. Skips come in bursts, and each one publishes a snapshot
	// and then a load; fetching per press would be a request per button.
	metaPrefetchDelay = time.Second

	// metaFetchTimeout bounds one window fetch.
	metaFetchTimeout = 30 * time.Second

	// metaSweepTimeout bounds a context enumeration and a full-context sweep.
	metaSweepTimeout = 2 * time.Minute

	// metaSweepBatchPause spaces the batches of a full-context sweep so it
	// never competes with the playback path for the radio or the account
	// budget.
	metaSweepBatchPause = time.Second

	// metaSweepHold is how long a context whose sweep failed is not swept
	// again. A client polls the listing every second or so, and each poll
	// would otherwise send the sweep straight back to the backend that just
	// refused it.
	metaSweepHold = 30 * time.Second

	// maxContextPages bounds how many pages an enumeration may fetch, as a
	// seek does: a generated context hands out pages forever.
	maxContextPages = 256
)

// metaFetcher resolves track metadata for a session, off the player loop. It
// owns the two network seams — the batched extended-metadata request and the
// context resolver — so tests can drive everything above them, the same way
// the state push lane takes its put.
type metaFetcher struct {
	log   librespot.Logger
	cache *trackMetaCache

	fetch   func(ctx context.Context, req *extmetadatapb.BatchedEntityRequest) (*extmetadatapb.BatchedExtensionResponse, error)
	resolve func(ctx context.Context, uri string) (tracks.ContextResolver, error)

	// inFlight single-flights the window fetch: a timer that fires while one
	// runs re-arms itself rather than starting another.
	inFlight atomic.Bool

	sweeps metaSweepQueue

	// held maps the label of each sweep that aborted on an error to when it
	// did, so that it is not swept again for metaSweepHold.
	heldMu sync.Mutex
	held   map[string]time.Time

	// now is the clock holds are timed by; replaced by tests.
	now func() time.Time
}

func newMetaFetcher(log librespot.Logger, cache *trackMetaCache, sp *spclient.Spclient) *metaFetcher {
	return &metaFetcher{
		log:   log,
		cache: cache,
		now:   time.Now,
		fetch: sp.ExtendedMetadata,
		resolve: func(ctx context.Context, uri string) (tracks.ContextResolver, error) {
			// A context of its own, never the playing one: the resolver behind
			// a track list mutates its pages as it walks, and is reachable only
			// from the loader lane.
			return spclient.NewContextResolver(ctx, log, sp, &connectpb.Context{Uri: uri})
		},
	}
}

// fetchBatch performs one batched extended-metadata request for the given
// track/episode URIs and fills the cache, returning how many were cached. Each
// uri is queried under its own kind (TRACK_V4 or EPISODE_V4), so a mixed
// context — or a show — resolves in the same single request. A uri the answer
// gives nothing usable for is marked failed in the cache, for metaFailureTTL,
// or for metaTransientFailureTTL when its entry is a server error or a rate
// limit; a request that fails as a whole marks nothing.
func (f *metaFetcher) fetchBatch(ctx context.Context, uris []string) (int, error) {
	req := &extmetadatapb.BatchedEntityRequest{}
	for _, uri := range uris {
		kind, ok := metaExtensionKind(uri)
		if !ok {
			continue
		}
		req.EntityRequest = append(req.EntityRequest, &extmetadatapb.EntityRequest{
			EntityUri: uri,
			Query: []*extmetadatapb.ExtensionQuery{{
				ExtensionKind: kind,
			}},
		})
	}
	if len(req.EntityRequest) == 0 {
		return 0, nil
	}

	resp, err := f.fetch(ctx, req)
	if err != nil {
		return 0, err
	}

	var cached int
	got := make(map[string]bool, len(req.EntityRequest))
	transient := map[string]bool{}
	for _, item := range resp.ExtendedMetadata {
		for _, extData := range item.ExtensionData {
			if extData.Header == nil || extData.Header.StatusCode != 200 || extData.ExtensionData == nil {
				if extData.Header != nil && transientMetaStatus(extData.Header.StatusCode) {
					transient[extData.EntityUri] = true
				}
				continue
			}

			var media *librespot.Media
			switch item.ExtensionKind {
			case extmetadatapb.ExtensionKind_TRACK_V4:
				var trackMeta metadatapb.Track
				if err := extData.ExtensionData.UnmarshalTo(&trackMeta); err != nil {
					continue
				}
				media = librespot.NewMediaFromTrack(&trackMeta)
			case extmetadatapb.ExtensionKind_EPISODE_V4:
				var episodeMeta metadatapb.Episode
				if err := extData.ExtensionData.UnmarshalTo(&episodeMeta); err != nil {
					continue
				}
				media = librespot.NewMediaFromEpisode(&episodeMeta)
			default:
				continue
			}

			f.cache.put(extData.EntityUri, media)
			got[extData.EntityUri] = true
			cached++
		}
	}

	// The backend answered, so what it refused, could not describe or left
	// out it has nothing for: asking again on the next poll would be a
	// request per poll for as long as the listing is polled. An entry that
	// is a server error or a rate limit says nothing about the track, and is
	// asked for again sooner.
	for _, entity := range req.EntityRequest {
		switch {
		case got[entity.EntityUri]:
		case transient[entity.EntityUri]:
			f.cache.markFailed(entity.EntityUri, metaTransientFailureTTL)
		default:
			f.cache.markFailed(entity.EntityUri, metaFailureTTL)
		}
	}

	return cached, nil
}

// transientMetaStatus reports whether the status of an entry in a batched
// answer is a fault of the moment, a server error or a rate limit, rather than
// an answer about the entity.
func transientMetaStatus(code int32) bool {
	return code == http.StatusTooManyRequests || code >= http.StatusInternalServerError
}

// sweep fetches metadata for the given URIs in paced batches. Any failure
// aborts the sweep and holds its label for metaSweepHold: it is best effort,
// and retrying against a backend that just refused is how a daemon earns a
// rate limit.
func (f *metaFetcher) sweep(ctx context.Context, missing []string, label string) {
	total := len(missing)
	var cached int
	for len(missing) > 0 {
		batch := missing[:min(len(missing), maxMetaBatch)]
		missing = missing[len(batch):]

		n, err := f.fetchBatch(ctx, batch)
		if err != nil {
			f.hold(label)
			f.log.WithError(err).Debugf("metadata sweep aborted for %s, holding it for %s", label, metaSweepHold)
			return
		}
		cached += n

		if len(missing) == 0 {
			break
		}

		pause := time.NewTimer(metaSweepBatchPause)
		select {
		case <-ctx.Done():
			pause.Stop()
			return
		case <-pause.C:
		}
	}

	f.log.Infof("swept metadata for %d/%d tracks in %s", cached, total, label)
}

// hold keeps label from being swept for metaSweepHold, forgetting the holds
// that have run out.
func (f *metaFetcher) hold(label string) {
	f.heldMu.Lock()
	defer f.heldMu.Unlock()

	now := f.now()
	for l, at := range f.held {
		if now.Sub(at) >= metaSweepHold {
			delete(f.held, l)
		}
	}
	if f.held == nil {
		f.held = map[string]time.Time{}
	}
	f.held[label] = now
}

// onHold reports whether a sweep of label aborted less than metaSweepHold ago.
func (f *metaFetcher) onHold(label string) bool {
	f.heldMu.Lock()
	defer f.heldMu.Unlock()

	at, ok := f.held[label]
	return ok && f.now().Sub(at) < metaSweepHold
}

// enumerateContextTracks walks every page of a context in its own order and
// returns the track and episode uris it holds, at most maxTracks of them. It
// stops at the end of the context, at the page cap, or on the first page that
// fails to load.
func enumerateContextTracks(ctx context.Context, resolver tracks.ContextResolver, maxTracks int) ([]string, error) {
	typ := resolver.Type()

	var uris []string
	for page := 0; page < maxContextPages; page++ {
		items, err := resolver.Page(ctx, page)
		if errors.Is(err, io.EOF) {
			return uris, nil
		} else if err != nil {
			return nil, fmt.Errorf("failed fetching page %d: %w", page, err)
		}

		for _, item := range items {
			uri := contextTrackUri(typ, item)
			if _, ok := metaExtensionKind(uri); !ok {
				continue
			}

			uris = append(uris, uri)
			if len(uris) == maxTracks {
				return uris, nil
			}
		}
	}

	return uris, nil
}

// contextTrackUri names a context track, deriving the uri from its gid when it
// carries only that. Malformed entries yield an empty uri rather than the panic
// ContextTrackToProvidedTrack reserves for them: this runs on data straight off
// the wire, on a goroutine nothing recovers.
func contextTrackUri(typ librespot.SpotifyIdType, track *connectpb.ContextTrack) string {
	if len(track.Uri) > 0 {
		return track.Uri
	} else if len(track.Gid) == 16 {
		return librespot.SpotifyIdFromGid(typ, track.Gid).Uri()
	}
	return ""
}

type metaSweepJob struct {
	uris  []string
	label string
}

// metaSweepQueue serialises the paced full-context sweeps: one runs at a time,
// and one waits. A sweep takes seconds (batches are spaced to stay polite), so
// a second context arriving mid-sweep is common, and dropping it would leave
// that context with only the moving window and nothing to trigger a retry.
//
// The waiting slot holds one job because only the newest matters: if a third
// context arrives, the user has moved on from the second before its metadata
// could have been of any use.
type metaSweepQueue struct {
	mu      sync.Mutex
	running bool
	pending *metaSweepJob

	// label names the job the worker took last, while it runs.
	label string
}

// enqueue submits a job, reporting whether the caller must start the worker.
func (q *metaSweepQueue) enqueue(job metaSweepJob) bool {
	q.mu.Lock()
	defer q.mu.Unlock()

	q.pending = &job
	if q.running {
		return false
	}
	q.running = true
	return true
}

// next hands the worker its next job, or reports that it should stop.
func (q *metaSweepQueue) next() (metaSweepJob, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()

	if q.pending == nil {
		q.running = false
		q.label = ""
		return metaSweepJob{}, false
	}
	job := *q.pending
	q.pending = nil
	q.label = job.label
	return job, true
}

// sweeping reports whether a job for label is running or waiting.
func (q *metaSweepQueue) sweeping(label string) bool {
	q.mu.Lock()
	defer q.mu.Unlock()

	return (q.running && q.label == label) || (q.pending != nil && q.pending.label == label)
}

// scheduleMetaPrefetch asks for the metadata of the current state window
// (prev + current + next) to be topped up, so /status can name the upcoming
// track before its stream loads. Runs on the Run goroutine: it only arms the
// timer, and the fire is what looks at the window, so a burst of skips costs
// one fetch for wherever they landed.
func (p *AppPlayer) scheduleMetaPrefetch() {
	if p.meta == nil {
		return
	}

	p.metaPrefetchTimer.Reset(metaPrefetchDelay)
}

// windowMetaUris lists the tracks of the state window that carry metadata.
func (p *AppPlayer) windowMetaUris() []string {
	var uris []string
	add := func(uri string) {
		if _, ok := metaExtensionKind(uri); ok {
			uris = append(uris, uri)
		}
	}
	if t := p.state.player.Track; t != nil {
		add(t.Uri)
	}
	for _, t := range p.state.player.PrevTracks {
		add(t.Uri)
	}
	for _, t := range p.state.player.NextTracks {
		add(t.Uri)
	}
	return uris
}

// prefetchWindowMetadata is the fire of the metadata timer. Runs on the Run
// goroutine; the fetch itself runs detached and is single-flighted, so a fire
// while one is in flight re-arms for whatever that fetch does not cover.
func (p *AppPlayer) prefetchWindowMetadata() {
	missing := p.meta.cache.missing(p.windowMetaUris())
	if len(missing) == 0 {
		return
	}
	missing = missing[:min(len(missing), maxMetaBatch)]

	if !p.meta.inFlight.CompareAndSwap(false, true) {
		p.metaPrefetchTimer.Reset(metaPrefetchDelay)
		return
	}

	p.goDetached(metaFetchTimeout, func(ctx context.Context) {
		defer p.meta.inFlight.Store(false)

		cached, err := p.meta.fetchBatch(ctx, missing)
		if err != nil {
			p.app.log.WithError(err).Warnf("failed prefetching metadata for %d tracks", len(missing))
			return
		}

		p.app.log.Debugf("prefetched metadata for %d/%d tracks", cached, len(missing))
	})
}

// scheduleContextMetaPrefetch warms the metadata of the WHOLE context that just
// started playing, so every track in it is known to /status (next_track) before
// the user skips anywhere. Opt-in via metadata.context_sweep; skipped when this
// context was already swept. Runs on the Run goroutine.
func (p *AppPlayer) scheduleContextMetaPrefetch(contextUri string) {
	if p.meta == nil || !p.app.cfg.Metadata.ContextSweep {
		return
	}
	if contextUri == "" || contextUri == p.lastFullMetaContext {
		return
	}

	p.lastFullMetaContext = contextUri
	p.scheduleContextEnumerate(contextUri, true)
}

// scheduleContextEnumerate enumerates a context and, if sweep is set, sweeps
// metadata for its tracks, detached from the player loop. Nothing on the
// playback path waits for it: the listing endpoint answers from whatever is
// already enumerated and cached, and a caller that finds neither gets an
// empty, not-ready listing rather than a blocked control loop. Without sweep
// an enumeration it starts schedules no sweep when it lands, even if a caller
// asked for one meanwhile; that caller's next poll does. An enumeration that
// fails holds the context for contextListHold. Safe from any goroutine.
func (p *AppPlayer) scheduleContextEnumerate(contextUri string, sweep bool) {
	if p.meta == nil || contextUri == "" {
		return
	}

	// Already enumerated: the tracks are known, so go straight to the sweep —
	// it may have been aborted, or the listing may have been enumerated by a
	// caller that never swept it. A fully cached listing costs nothing here.
	if uris, ok := p.app.contextLists.get(contextUri); ok {
		if sweep {
			p.scheduleMetaSweep(uris, contextUri)
		}
		return
	}
	gen, ok := p.app.contextLists.beginFetch(contextUri)
	if !ok {
		return
	}

	maxTracks := p.metaMaxTracks()
	p.goDetached(metaSweepTimeout, func(ctx context.Context) {
		defer p.app.contextLists.endFetch(contextUri)

		// A player that closed meanwhile (a session swap) cancelled the
		// enumeration; the backend refused nothing.
		failed := func(err error, msg string) {
			if errors.Is(ctx.Err(), context.Canceled) {
				return
			}
			p.app.contextLists.fail(contextUri)
			p.app.log.WithError(err).Warnf("%s, holding it for %s: %s", msg, contextListHold, contextUri)
		}

		resolver, err := p.meta.resolve(ctx, contextUri)
		if err != nil {
			failed(err, "failed resolving context for listing")
			return
		}

		uris, err := enumerateContextTracks(ctx, resolver, maxTracks)
		if err != nil {
			failed(err, "failed enumerating context")
			return
		}

		// The enumeration returns the moment it reaches the cap, so reaching
		// it is where it stopped.
		truncated := len(uris) >= maxTracks
		if truncated {
			p.app.log.Debugf("context listing truncated to %d tracks: %s", len(uris), contextUri)
		}

		p.app.contextLists.put(contextUri, contextListEntry{
			uris:      uris,
			revision:  resolver.Metadata()["playlist.revision"],
			truncated: truncated,
		}, gen)
		if sweep {
			p.scheduleMetaSweep(uris, contextUri)
		}
	})
}

// defaultMetaMaxTracks caps how many tracks of a context are enumerated and
// swept when metadata.max_tracks is not set, leaving cache headroom for the
// moving window of other contexts.
const defaultMetaMaxTracks = 800

// metaMaxTracks returns the configured enumeration/sweep cap.
func (p *AppPlayer) metaMaxTracks() int {
	return effectiveMetaMaxTracks(p.app.cfg.Metadata.MaxTracks)
}

// effectiveMetaMaxTracks applies the default to a configured metadata.max_tracks.
func effectiveMetaMaxTracks(configured int) int {
	if configured > 0 {
		return configured
	}
	return defaultMetaMaxTracks
}

// scheduleMetaSweep resolves metadata for the given track URIs detached from
// the player loop, in paced batches. Sweeps are serialised: one runs while at
// most one waits, and a job submitted while another is waiting replaces it.
// Nothing is submitted while label is on hold, or when nothing of uris is
// missing: either would only push a job that has work out of the waiting
// slot. Safe from any goroutine.
func (p *AppPlayer) scheduleMetaSweep(uris []string, label string) {
	if p.meta == nil || len(uris) == 0 {
		return
	}
	if p.meta.onHold(label) || len(p.meta.cache.missing(uris)) == 0 {
		return
	}

	if p.meta.sweeps.enqueue(metaSweepJob{uris: uris, label: label}) {
		p.runMetaSweep()
	}
}

// runMetaSweep runs the next queued sweep, then whatever queued up behind it.
// Each job gets a goroutine and deadline of its own rather than sharing one:
// a job that waited behind another must not inherit what is left of its time.
func (p *AppPlayer) runMetaSweep() {
	job, ok := p.meta.sweeps.next()
	if !ok {
		return
	}

	p.goDetached(metaSweepTimeout, func(ctx context.Context) {
		defer p.runMetaSweep()

		// Resolve what is missing when the job runs, not when it was queued: a
		// job that waited behind another sweep may have had part of its tracks
		// cached meanwhile, or failed, or its context put on hold.
		if p.meta.onHold(job.label) {
			return
		}
		missing := p.meta.cache.missing(job.uris)
		if len(missing) == 0 {
			return
		}

		p.meta.sweep(ctx, missing, job.label)
	})
}

// apiNextTrack describes the upcoming track when its metadata is cached, so a
// client can pre-warm its name and cover art before the user skips to it. Nil
// when it is not known, which is always the case with metadata disabled. Runs
// on the Run goroutine.
func (p *AppPlayer) apiNextTrack() *ApiTrack {
	next := p.state.player.NextTracks
	if len(next) == 0 || p.prodInfo == nil {
		return nil
	}

	media := p.app.metaCache.get(next[0].Uri)
	if media == nil {
		return nil
	}
	return p.newApiResponseStatusMedia(media, 0)
}

// contextTracksResponse describes a context listing from what the caches hold:
// ready reports whether the track list itself is enumerated, cached how many
// of those tracks carry metadata, failed how many the backend had none for,
// sweeping whether more is coming: a sweep running or waiting, or one held
// after an error, which the first poll after the hold sends again. The counts
// describe the whole listing; only the entries req selects are described one
// by one, and none for a summary, whose counting builds no track and leaves
// the cache's eviction order alone. Runs on the Run goroutine.
func (p *AppPlayer) contextTracksResponse(req ApiRequestDataContextTracks, listing contextListEntry, ready bool) *ApiContextTracks {
	resp := &ApiContextTracks{
		Uri:       req.Uri,
		Ready:     ready,
		Length:    len(listing.uris),
		Sweeping:  p.meta.sweeps.sweeping(req.Uri) || p.meta.onHold(req.Uri),
		Revision:  listing.revision,
		Truncated: listing.truncated,
	}
	if ready {
		resp.FetchedAt = listing.fetched.UnixMilli()
	}

	from, to := listingWindow(len(listing.uris), req.From, req.Limit)
	var tracks []ApiContextTrackItem
	if !req.Summary {
		tracks = make([]ApiContextTrackItem, 0, to-from)
	}
	for i, uri := range listing.uris {
		if req.Summary || i < from || i >= to {
			if p.meta.cache.has(uri) && p.prodInfo != nil {
				resp.Cached++
			} else if p.meta.cache.isFailed(uri) {
				resp.Failed++
			}
			continue
		}

		entry := ApiContextTrackItem{Uri: uri}
		if media := p.meta.cache.get(uri); media != nil && p.prodInfo != nil {
			entry.Track = p.newApiResponseStatusMedia(media, 0)
			resp.Cached++
		} else if p.meta.cache.isFailed(uri) {
			entry.Failed = true
			resp.Failed++
		}
		tracks = append(tracks, entry)
	}
	if !req.Summary {
		resp.Tracks = &tracks
	}
	return resp
}

// listingWindow clamps the entries [from, from+limit) to a listing of n; a nil
// limit runs to the end.
func listingWindow(n, from int, limit *int) (int, int) {
	start := min(max(from, 0), n)
	if limit == nil || *limit >= n-start {
		return start, n
	}
	return start, start + max(*limit, 0)
}
