# Encore patches to go-librespot

This directory is go-librespot at upstream commit **4dbc099**
("fix: tell liked tracks with the collection service's contains",
https://github.com/devgianlu/go-librespot), the exact source of the engine image
Encore ran before 0.4, plus nine patches: patch 1 (output delay, DESIGN-0.4.md
§4.1), patch 2 (catalog API, DESIGN-3.md §4.8), patch 3 (Jams, DESIGN-4b.md
§3), patch 4 (Jam host activation and diagnostics, DESIGN-JAM-WAIT.md §2.2),
patch 5 (Jam self-activation, DESIGN-JAM-SELF.md §2), patch 6 (Windows
named-pipe output, the engine's version stamp, and the control API refusing
cross-site browser requests; the release plan's D19, the last section),
patch 7 (early prefetch of the next track, so that a skip starts at once),
patch 8 (the Docker image: its version stamp, Encore's default config at the
first start and a zeroconf backend switch; DESIGN-DOCKER-IMAGES.md §2.4) and
patch 9 (Up Next you can rearrange: edits of a shuffled context, Play Next and
a jump to any upcoming row; DESIGN-QUEUE.md §3).
`ENCORE_PATCH.diff` (next to this file) is all nine together as one
`git diff` against 4dbc099.

The design references (DESIGN-*.md, the release plan, and their sections)
point to the author's internal design notes, which are not part of this
source. Each patch's "Checks run" records what was run when that patch was
written; the checks under patches 6, 7, 8 and 9 ran over the whole tree,
patches 1-6, 1-7, 1-8 and 1-9 together.

compose.yaml builds it: `build: ./engine-src`, `image: encore-engine:local`,
`pull_policy: build`, with the repo's `Dockerfile` as patch 8 changes it.
The prebuilt image `ghcr.io/mbucc9000/encore-engine` (from 1.3.0, built by
the release workflow `.github/workflows/docker-images.yml`) is built from
exactly this directory, with `--build-arg ENCORE_VERSION=<version>`. The
Windows engine, `encore-engine.exe`, is built from this tree by
`gateway/windows/build-engine/` (patch 6).

# Patch 1: output delay

## Why

go-librespot publishes the Spotify Connect position (`Timestamp` +
`PositionAsOfTimestamp`) from its decoder. With a sound card that is what you
hear. Encore's output is a pipe: the gateway reads it up to 10-30 s ahead of the
phone, and phone stalls add to that. So the Spotify app showed song changes
10-40 s early and the position drifted by every stall.

## What it does

1. **`POST /player/output_delay`** `{"delay_ms": 0..120000}` returns
   `200 {"delay_ms", "republished", "position_ms"}`. 400 if `delay_ms` is
   missing, null, not an integer or out of range. 204 with no session, like every
   player endpoint. The request goes through the normal ApiRequest channel, so
   it is handled on the player's own goroutine.
   - The delay is stored on the AppPlayer (`outputDelay`). A new session
     (zeroconf re-login) starts again at 0; the gateway re-sends it every 5 s.
   - If a track is loaded and playing (primary stream set, no load in flight,
     not buffering, not paused, not in the middle of a natural advance):
     `target = player.PositionMs() - delay` (what the listener hears now) and
     `cur = PositionAsOfTimestamp + (now - Timestamp)` (may be negative). If
     `|target - cur| >= 750 ms`: `target >= 0` publishes `Timestamp = now`,
     `PositionAsOfTimestamp = target`; `target < 0` (the listener has not reached
     this track yet) publishes `Timestamp = now - target` (in the future),
     `PositionAsOfTimestamp = 0`. Then `updateState()`, `republished: true`.
   - `position_ms` is the position the player now reports for the current track,
     the same number `/status` gives: 0 while the track has not reached the
     listener yet, never negative.
2. **Natural advance.** When a track plays to its end (`EventTypeNotPlaying`,
   the path into `advanceNext`), `naturalAdvanceAt` is set. The `commitLoad` of
   the load that follows, if it lands within 5 s and is not paused, publishes
   `Timestamp = now + outputDelay` (position stays at the load position, 0), so
   the Spotify app shows the new song at 0:00 until the listener actually gets
   there. Every `commitLoad` clears the flag, and so does every load that drops
   the output (a skip, play or transfer; the natural path never drops).
3. **Future-timestamp audit** (a `Timestamp` in the future must never give a
   negative position or a wrong "elapsed"):
   - `trackPosition` already returns `PositionAsOfTimestamp` when elapsed < 0:
     unchanged.
   - `updateTimestamp` (used by `loadCurrentTrack`) treats a future Timestamp as
     "not advanced" instead of subtracting it from the position.
   - `play()` when the state is already playing (`IsPlaying` and not paused,
     e.g. a stale controller sending "resume") seeks to the decoder's own
     position and leaves the published `Timestamp`/`PositionAsOfTimestamp` as
     they are. It used to seek to the published position, which now trails the
     decoder by the delay (or is 0 for a track not reached yet), which would
     have replayed audio or restarted the song. Then it published the decoder
     position, which would have dropped the correction (or a natural advance's
     future start) until the next `/player/output_delay`, up to 15 s later.
     Resuming from a pause is unchanged: it seeks to the published position
     and publishes the decoder's.
   - The cluster gate `activationTimestamp` (transfer and `takeOver`) is
     `activationTimestampAt(ts, now)`: the sender's own timestamp, as upstream,
     unless it is more than 3 s (`activationClockSkew`) in the future, which
     can only be this device's own future timestamp handed back. That one is
     taken as now, because gating on it would have ignored a real transfer
     away. A sender whose clock runs up to 3 s ahead keeps the #107
     protection: the stale update repeating its state is never newer. (Clamping
     every timestamp to now lost that protection whenever the sender's clock
     ran ahead of this one by more than the dealer delivery time.) Our own
     future timestamp at most 3 s ahead is not clamped. A transfer away within
     those 3 s would be ignored, the same exposure upstream has to a sender's
     clock skew.
   - `continuePlayback` (Jam/transfer continuation) already only adds
     elapsed > 0: unchanged. Volume pushes, events (the dummy event manager),
     mpris (`Position` field, never set) and the websocket `metadata`/`seek`
     events (decoder positions) do not read the published timestamp:
     unchanged.
4. **Pipe output: no command waits for a full pipe** (`output/driver-pipe.go`).
   Gateway 0.4 stops reading the pipe while the phone is stalled (frozen
   clock, DESIGN-0.4.md §2.3), so a write can block for the whole stall.
   Upstream's `outputLoop` held `out.lock` across that write, and `Pause`,
   `Resume` and `Close` take the same lock. The player's command loop calls
   them for pause, play, every track load (skip, prev, transfer in), seek and
   stop (transfer away), so a command from the Spotify app parked the whole
   player until the phone played again (`/status` and `/player/output_delay`
   timed out meanwhile). Now the loop reads and applies the volume under the
   lock and writes without it. `Pause`/`Resume` return at once and take effect
   at the next read. A `Close` during a write leaves closing the file to the
   loop, once the write returns, because `os.File.Close` would wait for it:
   the FIFO is opened `O_NONBLOCK`, so Go still treats it as a polled
   descriptor after `SetNonblock(false)`, and closing one waits for the I/O in
   progress (checked). That close is not reported as an error.
   - This is locking only: the samples, their order, the volume and the
     transform are unchanged, and nothing is buffered. The chunk being written
     (at most 4096 interleaved samples, 46 ms) still goes out when the pipe
     drains, as it did before. One difference: after a `Close` during a
     blocked write, that chunk can go out after the first writes of an output
     reopened in the meantime, instead of before them.
   - **Deviation from DESIGN-0.4.md §4.1** ("do not touch ... the audio
     path"). The pipe driver is the output end of the audio path. The change
     is still made here because the blocking pipe is §2.3's own mechanism for
     holding the decoder back. The alternative is for the gateway to keep
     draining the pipe while frozen, which would hold an unbounded amount of
     PCM in the gateway.

Nothing touches audio keys, playplay or decryption. Apart from item 4's locking
in the pipe output, nothing touches the audio path.

## Files

| File | Change |
|---|---|
| `api-spec.yml` | `outputDelay`, `outputDelayResult` schemas; `POST /player/output_delay` |
| `daemon/api_gen.go` | regenerated from the spec (oapi-codegen v2.5.0, as in `gen.go`); additions only |
| `daemon/api_server.go` | `ApiRequestTypeOutputDelay`, `PlayerOutputDelay` handler (validation) |
| `daemon/player.go` | `outputDelay`, `naturalAdvanceAt` fields; request case; transfer `activationTimestamp` via `activationTimestampAt` |
| `daemon/controls.go` | NotPlaying sets `naturalAdvanceAt`; `loadCurrentTrack` clears it on drop; `commitLoad` future Timestamp; `play()` while playing: decoder position, published position kept |
| `daemon/player_state.go` | `takeOver` via `activationTimestampAt`; `updateTimestamp` future-safe |
| `daemon/output_delay.go` | new: `setOutputDelay`, `naturalAdvancePending`, `State.applyOutputDelay`, `activationTimestampAt` |
| `daemon/output_delay_test.go` | new unit tests (`test_unit` tag) |
| `daemon/api_server_test.go` | route in `endpointMethods`, `TestApiOutputDelay` (`test_integration` tag) |
| `output/driver-pipe.go` | `outputLoop` writes without `out.lock`; `writing` flag; `Close` leaves a file mid-write to the loop |
| `output/driver-pipe_unix_test.go` | `TestPipeOutputControlsDoNotWaitForAFullPipe` (`test_unit` tag) |

## Checks run (2026-10-05, on the development server, never against the live stack)

- `docker build -t encore-engine:test .` (the repo Dockerfile): OK.
- In the build stage, `--network none`: `gofmt -l daemon player output` (clean),
  `go vet ./daemon/ ./output/ ./player/` and with
  `-tags "test_unit test_integration"` (clean),
  `go test -tags "test_unit test_integration" ./daemon/... ./output/... ./player/...`
  (ok), the new tests and the cluster, transfer, play and pipe tests again with
  `-race -count=3` (ok).
- The new tests fail with their fixes reverted (checked: the activation
  timestamp clamped to now, `play()` publishing the decoder position, and
  upstream's `driver-pipe.go`).
- `git apply` of `ENCORE_PATCH.diff` (then patch 1 alone) on a clean 4dbc099
  gives exactly this tree (then patch 1's).

## Re-applying on a newer go-librespot

1. `git clone https://github.com/devgianlu/go-librespot` and check out the new
   commit. Use LF line endings (`git -c core.autocrlf=false ...` on Windows).
2. `git apply --3way ENCORE_PATCH.diff`. `daemon/output_delay.go` and its test
   are new files and almost never conflict; the hooks in upstream files are
   small and listed above.
3. If `api_gen.go` conflicts, take upstream's version and regenerate it rather
   than merging by hand:
   `go run github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen@<version in gen.go> --config=api-codegen.yml api-spec.yml`.
4. Check what moved upstream:
   - every writer and reader of `Timestamp` / `PositionAsOfTimestamp`
     (`grep -rn "Timestamp\|PositionAsOfTimestamp\|trackPosition()" daemon/`):
     new readers must treat a future Timestamp as "not started";
   - that the natural end of a track still goes `EventTypeNotPlaying` →
     `advanceNext(false, false, ...)` → `loadCurrentTrack(drop=false)` →
     `commitLoad`, and that user-initiated loads still pass `drop=true`;
   - that `play()` still seeks before resuming;
   - that the cluster gate still compares against `activationTimestamp`;
   - that `output/driver-pipe.go` still has the one write in `outputLoop` and
     the `Pause`/`Resume`/`Close` it was patched against. If upstream rewrote
     it, re-check that no output command waits for a write to a full pipe.
5. Run the checks above (build, gofmt, vet, `go test -tags "test_unit
   test_integration" ./daemon/... ./output/... ./player/...`), then rebuild the
   image.

## Note for the gateway

`/status` `track.position` is the published (listener) position: while playing
it trails the decoder by `delay_ms` once a correction has been published, and
it is 0 while the track has not reached the listener. The websocket `metadata`
and `seek` events still carry decoder positions.

With item 4, holding the pipe full (frozen clock) no longer blocks engine
commands, `/status` or `/player/output_delay`. A pause still lets the chunk
being written (up to 46 ms) go out once the pipe drains.

# Patch 2: catalog API (listings, revisions, shuffle on play)

The contract is DESIGN-3.md §4.8. Every item is API surface or listing and
metadata bookkeeping. Nothing touches audio keys, playplay, decryption, the
stream path or the output. The one change on the playback path is item 4, in
the commit of the API's own play; `controls.go` is not part of patch 2. Items 6
and 8 also carry fixes from the 3a review that go beyond §4.8's text; they are
marked "(review)".

## Why

Encore 0.5 browses playlists, Liked Songs and albums through `/context/tracks`
and polls it while a list fills in. Upstream that cost too much and said too
little:
- every poll returned the whole listing with a track object per entry, and
  scheduled a metadata sweep of whatever was missing, even when nothing was;
- an entry Spotify has no metadata for (refused, or left out of the answer) was
  asked for again on every poll, forever, a sweep that failed was retried by
  the next poll, and an enumeration that failed was started over from its
  first page by the next poll;
- the listing could not say which revision of the playlist it was read at,
  whether a sweep was still coming, or whether it was cut at max_tracks;
- `/status` names the playing track by its media, which differs from the
  context entry when Spotify relinked it, so the gateway could not match it to
  a row;
- a shuffled play needed `/player/shuffle_context` first, which does nothing
  when nothing is loaded and otherwise reshuffles the old context, walking all
  of its pages;
- a rate limit on a like or an add answered 500, like a fault of the daemon.

## What it does

1. **Rootlist revisions.** Each `/library/playlists` item gains `revision`:
   lowercase hex of `MetaItem.revision`, "" when there is none. That is the
   encoding of the `playlist.revision` context metadata a playlist context
   carries (`spclient/playlist_context.go` `playlistMetadata`), so a listing
   can be checked against the rootlist.
2. **Explicit.** The track object gains `explicit`, always present: the
   track's `explicit` flag, false for episodes. It shows wherever track objects
   do (`/status` `track` and `next_track`, the `metadata` event,
   `/context/tracks` entries).
3. **Context track uri.** The track object gains `context_track_uri`:
   `stream.RequestedId.Uri()`, the context entry the stream was requested as.
   `uri` stays the media's, which differs when Spotify relinked the track. It
   is set in `newApiResponseStatusTrack` only, so it appears on the `/status`
   `track` and in the `metadata` event, and is omitted on `next_track`, on
   listing entries and for a stream without a requested id.
4. **Shuffle on play.** `POST /player/play` takes an optional
   `shuffle_context` (`ApiPlay.ShuffleContext *bool`); omitted keeps the
   current option. The play's commit calls `setPlayShuffle` right before
   `loadContext`: if the value differs from `Options.ShufflingContext`, it sets
   the option and emits the `shuffle_context` event. `loadContext` reads the
   option as it submits the resolve of the new context, so a shuffled play
   starts on a random track (or shuffles around `skip_to_uri`). Unlike `setOptions` it never
   submits the `ToggleShuffle` list job, so the context being replaced is left
   alone, and it works with nothing loaded (`setOptions` needs a track list).
   `loadContext` still turns shuffle off for a context that does not allow it,
   without an event, as for any play. The resolve, the walk to `skip_to_uri`,
   the paused and position handling and the track load are unchanged.
5. **Listing metadata.** `contextListEntry` keeps `revision` (the enumerating
   resolver's `playlist.revision` metadata, "" for other contexts), `fetched`
   (already there, set by `put`) and `truncated` (`len(uris) >= max_tracks`:
   `enumerateContextTracks` returns the moment it reaches the cap, so that is
   where it stopped; a context of exactly max_tracks entries reads truncated
   too). `contextListCache.put` takes the entry, the new `entry` returns it, and
   `get` is unchanged for its callers. `/context/tracks` returns them as
   `revision`, `fetched_at` (epoch ms) and `truncated`; while not ready they
   are "", 0 and false.
6. **Failure memory.**
   - `trackMetaCache` gains a second LRU, `failed` (uri → until when, the same
     capacity). After a request that succeeded as a whole, `fetchBatch` marks
     every uri it asked for and did not cache: status other than 200, no data,
     an unmarshal failure, an unexpected kind, or absent from the answer. A uri
     that is cached is never marked. A mark counts for `metaFailureTTL` (1 h),
     and `put` removes it; marks are read with `Peek`, so reads do not extend
     them. A request that fails as a whole marks nothing.
   - (review) An entry whose status is a server error (5xx) or a rate limit
     (429), `transientMetaStatus`, is marked for `metaTransientFailureTTL`
     (30 s, `metaSweepHold`) instead: a fault of the moment says nothing about
     the track. It still counts as failed, so a listing that holds one can
     finish, but a re-read half a minute later asks for it again instead of
     keeping it failed for the hour. A track whose entry keeps failing that way
     costs one request per 30 s while its listing is polled.
   - `missing()` leaves marked uris out, which covers the sweeps and the
     playing-window prefetch.
   - When `sweep` aborts on an error, the label (the context uri) is held:
     `metaFetcher.hold` records when, `scheduleMetaSweep` submits nothing for it
     for `metaSweepHold` (30 s), and a job for it that was already waiting does
     nothing when its turn comes (`runMetaSweep`). (review) The listing reports
     a held context as `sweeping`: the hold is a deferred retry, which the first
     poll after it that may sweep submits. Reported as not sweeping, its entries
     without metadata looked like ones that would never get any, and a client's
     stall rule would have finished the list without them.
   - (review) When an enumeration fails (the resolve, a page, or
     `metaSweepTimeout` running out), the context is held:
     `contextListCache.fail` records when, `beginFetch` refuses it for
     `contextListHold` (30 s), and `/context/tracks` answers it with 500
     meanwhile, unless a listing of it is cached. Every poll used to start the
     walk over from the first page, against the backend that had just refused
     it. An enumeration cancelled by its player closing (a session swap) holds
     nothing. An invalidation (`refresh`, the engine's own writes) does not lift
     a hold, so `refresh=1` on every poll cannot get around it either.
   - `scheduleMetaSweep` submits nothing when nothing of the listing is
     missing. It used to submit a job on every poll, which could push another
     context's job out of the queue's one waiting slot.
   - `/context/tracks` reports `failed` (entries marked and not cached) and
     `sweeping` (a job for the context is running or waiting:
     `metaSweepQueue.sweeping`, the queue now remembers the running job's
     label; or the context is held), and entries carry `failed: true` (omitted
     when false).
7. **Listing request options.** `GET /context/tracks` takes optional `refresh`
   (bool, default false), `meta` (bool, default true), `from` (int ≥ 0, default
   0), `limit` (int ≥ 0, default all) and `sweep` (bool, default true).
   Booleans take `1`/`0` as well as `true`/`false`. A negative `from` or `limit`,
   or a malformed value, answers 400. They reach the player loop as
   `ApiRequestDataContextTracks` `Refresh`, `Summary`, `From`, `Limit` and
   `NoSweep`, whose zero values are the defaults.
   - `refresh`: `contextLists.invalidate(uri)` before the lookup. An
     enumeration in flight then has its result dropped, and the next poll
     enumerates again.
   - `meta=false` (a summary): `tracks` is left out, and every entry is
     counted with `Contains`/`Peek`: no LRU reordering, no track object.
   - `from`, `limit`: `tracks` holds the entries [from, from+limit), clamped to
     the listing. Every count describes the whole listing; entries outside the
     window are counted as in a summary.
   - `sweep=false`: `scheduleContextEnumerate(uri, false)` enumerates if
     needed and schedules no sweep, also when the enumeration it started lands.

   Without options the answer is what it was, plus the new fields; `tracks` is
   still `[]` while the listing is not ready.
8. **Rate limits on library calls** (review). `libraryError` carries a 429 from
   the collection or playlist service (a `spclient.StatusError`; spclient never
   retries a 429) over as `ErrTooManyRequests`, so `GET`/`POST /library/liked`
   and `/library/playlists/add_tracks` answer 429 instead of 500. Retry-After
   is not passed on: `StatusError` does not carry it. The rootlist's errors are
   untyped (`spclient/rootlist.go` is not part of the patch) and still answer
   500.

## Files

| File | Change |
|---|---|
| `api-spec.yml` | track `explicit`, `context_track_uri`; `contextTrackItem.failed`; `contextTracks` `failed`, `sweeping`, `revision`, `fetched_at`, `truncated`, `tracks` no longer required; `libraryPlaylist.revision`; `play.shuffle_context`; `/context/tracks` parameters `refresh`, `meta`, `from`, `limit`, `sweep`, and its 500; 429 on `/library/liked` (both) and `/library/playlists/add_tracks` |
| `daemon/api_gen.go` | regenerated from the spec (oapi-codegen v2.5.0); additions, the reworded `cached` comment, and `ApiContextTracks.Tracks` becoming `*[]ApiContextTrackItem` (omitempty); the review's three reworded comments (`failed` twice, `sweeping`) |
| `daemon/api_server.go` | `ApiRequestDataContextTracks` options; `GetContextTracks` checks and forwards them; `explicit`; `context_track_uri` in `newApiResponseStatusTrack` |
| `daemon/library.go` | `libraryPlaylist` `Revision`; `libraryError` maps 429 |
| `daemon/player.go` | context tracks request: `refresh`, `entry`, the sweep flag, the error for a held enumeration; play commit calls `setPlayShuffle`; `setPlayShuffle` |
| `daemon/track_meta_cache.go` | `failed` LRU (`markFailed(uri, ttl)`, `isFailed`, `has`) and `missing`; `metaTransientFailureTTL`, `transientMetaStatus`; `contextListEntry` `revision`, `truncated`, `entry`, `put` of an entry; `contextListHold`, `contextListCache.failedAt`, `fail`, `held`, `beginFetch` refusing a held context; `metaFetcher` holds (`hold`, `onHold`, `now`); `fetchBatch` marks; `metaSweepQueue.label`, `sweeping`; `scheduleContextEnumerate(uri, sweep)` and its hold; `scheduleMetaSweep`/`runMetaSweep` hold and nothing-missing rules; `contextTracksResponse(req, listing, ready)` (held = sweeping), `listingWindow` |
| `daemon/track_meta_cache_test.go` | `put` call sites; `TestContextTracksHandler` and `TestMetaFetcherFetchBatch` extended; new: failures expire (both TTLs), passing faults held briefly, listing metadata, summary and window, without sweep, refresh, entries without metadata (one fetch over 20+ polls), sweep hold (reported sweeping), enumeration hold (20 polls after a failed resolve, then after a failed page, start nothing), no hold after a cancelled enumeration (`test_unit` tag) |
| `daemon/player_test.go` | shuffle on play: nothing loaded starts shuffled, the old context is left alone, only what is named changes (`test_unit` tag) |
| `daemon/api_track_uris_test.go` | `explicit`; `context_track_uri` of a relinked stream (`test_unit` tag) |
| `daemon/library_test.go` | `TestLibraryPlaylistRevision`; 429 in `TestLibraryErrorMapsStatuses` (`test_unit` tag) |
| `daemon/api_server_test.go` | status wire format with the new fields; `shuffle_context` decoding; library page `revision`; `TestApiContextTracks` (`test_integration` tag) |

## Checks run (2026-10-05, on the development server, never against the live stack)

- `api_gen.go` regenerated with
  `go run github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen@v2.5.0 --config=api-codegen.yml api-spec.yml`
  in the build image. That run had network, for the Go module proxy only;
  everything else below ran with `--network none`. Apart from patch 2's
  additions the file regenerates byte for byte.
- In the build stage (Go 1.25.10 from alpine:3.23): `gofmt -l daemon spclient
  tracks output player` (clean), `go vet ./daemon/ ./spclient/` and with
  `-tags "test_unit test_integration"` (clean),
  `go test -tags "test_unit test_integration" ./daemon/... ./spclient/... ./tracks/...`
  and `./output/... ./player/... .` (ok), the same three packages again with
  `-race` (ok), and the patch 2 tests with `-race -count=5` (ok).
- The new tests fail with their fixes reverted (checked one by one: no failure
  memory in `missing`, no marks in `fetchBatch`, no hold, shuffle through
  `setOptions`, `sweep`/`refresh`/`meta` ignored, no listing revision, no
  `context_track_uri`, no `explicit`, no rootlist revision, no `from`/`limit`
  check, no nothing-missing rule).
- `docker build -t encore-engine:test3a .` (the repo Dockerfile): OK.
- `git apply` of `ENCORE_PATCH.diff` (both patches) on a clean 4dbc099 gives
  exactly this tree, and patch 1's hunks in it are unchanged.

After the 3a review (same day, same place, `--network none` again):
- `api_gen.go`: only three comments changed. They were edited by hand to the
  spec's new descriptions (the generator writes each description, folded to one
  line, as the field's comment), and a script checked every schema property's
  description against its comment; it was not regenerated.
- `gofmt -l daemon spclient tracks` (clean); `go vet ./daemon/ ./spclient/`
  and with `-tags "test_unit test_integration"` (clean);
  `go test -tags "test_unit test_integration" ./daemon/... ./spclient/... ./tracks/...`
  and `./output/... ./player/... .` (ok); the first three again with `-race`
  (ok); the failure-memory, listing and library tests with `-race -count=5`
  (ok).
- The review's tests fail with their fixes reverted, one at a time: no
  enumeration hold, no 500 for a held context, held sweeps reported as not
  sweeping, passing faults marked for the hour, a cancelled enumeration held,
  no 429 mapping.
- `docker build -t encore-engine:test3a .`: OK (replaces the image above).
- `git apply` of the new `ENCORE_PATCH.diff` on a clean 4dbc099 gives exactly
  this tree, and patch 1's hunks in it are unchanged.

## Re-applying on a newer go-librespot

As for patch 1 (above), then check what moved upstream:
- that `fetchBatch` is still the one place extended-metadata answers are
  unpacked into the cache, and `sweep` still aborts on the first error;
- that `metaSweepQueue` still runs one job and keeps one waiting, and
  `runMetaSweep` still resolves what is missing when a job starts;
- that the listing handler still answers from the caches without waiting, and
  `scheduleContextEnumerate` is still its only way to the network;
- that `loadContext` still reads `Options.ShufflingContext` when it submits
  the resolve, and the API play's commit still ends in `loadContext`;
- that `newApiResponseStatusTrack` is still the only builder of the playing
  track's object (`/status` and the `metadata` event);
- that `playlistMetadata` still encodes `playlist.revision` as hex of the
  playlist's revision, the same bytes the rootlist's `MetaItem.revision` holds;
- that the collection and playlist calls still fail with `spclient.StatusError`
  (the 429 mapping relies on it), and the extended-metadata answer still
  carries a status per entry.

## Note for the gateway

- Poll with `meta=0`. A listing is complete when `ready` and
  `cached + failed == length`; read its entries then with
  `sweep=0&from=<i>&limit=<n>`, so a page read never schedules a sweep.
- `sweeping` stays true while the context's job waits behind another
  context's sweep, and `cached` stands still meanwhile.
- A `failed` entry stays failed for up to an hour, or 30 s when its entry was
  a server error or a rate limit. After a sweep that errored the context is
  held for 30 s: `sweeping` stays true and nothing moves until the first poll
  after the hold that may sweep (no `sweep=0`), which sends it again. So
  `ready && !sweeping` with entries still missing means nothing more is coming.
- After an enumeration that failed, `/context/tracks` answers 500 for that
  context for 30 s, unless a listing of it is cached, and no poll starts
  another one meanwhile. It is the engine failing, not an enumeration in
  flight.
- `/library/liked` (GET and POST) and `/library/playlists/add_tracks` answer
  429 when Spotify rate-limits them, without Retry-After.
- `revision` is "" for anything but a playlist, and may be "" for a playlist
  the playlist service would not serve (context resolve answers it then).
  `fetched_at` changes with every enumeration. `truncated` is also true for a
  context exactly `max_tracks` long.
- `refresh=1` during an enumeration answers not ready until that enumeration
  ends and the next one lands.
- `context_track_uri` is only on the `/status` `track` and in the `metadata`
  event.
- `shuffle_context` on a play emits the `shuffle_context` event when it
  changes the option. A context that does not allow shuffle turns it off again
  without one; `/status` `shuffle_context` is the truth.

# Patch 3: Jams (social-connect, Jam events, the Jam's end, Up Next edits)

The contract is DESIGN-4b.md §3, items 1, 2, 4, 5, 6, 8, 10 and 11, as revised
after the capture of the official client (C0, DESIGN-4b §11.1; the 4b-c round).
Items 7 and 9 (guest control, a guest's add) were not in the capture: their
routes do not exist and `/status` does not list them. Every item is API
surface, bookkeeping or events, except item 10 (one guard in the transfer
command) and item 11 (Up Next edits of the engine's own track list). Nothing
touches audio keys, playplay, decryption, the stream path, the output,
`continuePlayback`, pause and play, or how a transfer is handled beyond item
10.

## Why

A Jam started in Spotify already plays on the engine: social-connect drives it
with ordinary Connect commands from a virtual device `social-connect-<hex>`.
But nothing outside the engine could see one, and three things were wrong:
- A Jam's end replayed the Jam. It arrives as a transfer of the Jam's list with
  its pages and no track; the list was played from the top, the Jam's first
  song and its history for nobody. That transfer's options are empty and
  replaced the device's wholesale, so a `set_options` that had just switched the
  Jam off was back to unset one transfer later.
- The dealer panicked on a message with more than one payload, before any
  matching, and nothing recovers its receive loop: the engine exited. A payload
  sent as a JSON object rather than a base64 string was dropped even when a
  receiver wanted it, and a message nothing received was logged at debug only.
- Nothing could call social-connect, and the spclient senders were unfit for
  it: `Request` and `RequestOnce` both answer a 401 by forcing a full login5
  re-login and sending again, inside a backoff with no attempt limit. One
  refused call was about 7 sends and 7 re-logins in 15 s, ending as a timeout.

And for the iPhone to manage a Jam it hosts: removing a member needs the call
C0 captured, and Up Next needs remove and reorder. The engine is the playing
device, so those are edits of its own list. Upstream's `set_queue` cannot make
them for the context's own rows: it uses the rows after the queue only as a
hint for the one publish it makes (`NextTracks`' `nextHint`), while playback,
the prefetch and every later publish walk the context in its own order, so a
removed song came back and played.

## What it does

1. **social-connect client** (`spclient/social_connect.go`). Each call returns
   the body as `json.RawMessage` (a JSON object of at most 256 KB) or nil for
   204 or an empty body:

   | call | request | source |
   |---|---|---|
   | `SocialCurrent(ctx)` | `GET /social-connect/v2/sessions/current`, no query | 2021-22 path |
   | `SocialCurrentOrNew(ctx)` | `GET /social-connect/v2/sessions/current_or_new?activate=true` | C0, exactly |
   | `SocialInfo(ctx, token)` | `GET /social-connect/v2/sessions/info/<token>` | 2021-22 |
   | `SocialJoin(ctx, token, dev)` | `POST /social-connect/v2/sessions/join/<token>?join_type=deeplinking&local_device_id=<dev>&playback_control=listen_and_control` | 2021-22 |
   | `SocialLeave(ctx, sid)` | `POST /social-connect/v3/sessions/<sid>/leave`, no query | 2021-22 path |
   | `SocialEnd(ctx, sid)` | `DELETE /social-connect/v3/sessions/<sid>`, no query | 2021-22 path |
   | `SocialKick(ctx, sid, member)` | `POST /social-connect/v3/sessions/<sid>/member/<member>/kick`, no query, no body (`Content-Length: 0`) | C0, exactly |

   The 2026 client named no device on any call, `current_or_new` included
   (2021-22: `local_device_id` and `type=REMOTE`); the session's host device
   was the account's active one. So only `join` names this device
   (`dev` = the engine's device id): it is the one call that says which device
   is to play the Jam. No call sends the desktop's `app-platform` or
   `spotify-app-version`: the engine's other spclient calls never have, and any
   value would be a guess that disagrees with the client token it presents.
   `Client-Token`, the Bearer and `Accept: application/json` go as before.
   A status of 400 or more is a `StatusError{Op: "social-connect <op>"}`; a
   429 carries `RetryAfter` (a new `StatusError` field, a `time.Duration`,
   zero for every existing caller). A 2xx whose body is not a JSON object or
   is too large, and any other status below 400 (a redirect), is a
   `SocialResponseError` with the status. A token, session id or member id
   must match `^[A-Za-z0-9_-]{1,128}$`, else `ErrSocialArgument` and nothing is
   sent; it is path-escaped.
   - **`RequestSocial`** is the one sender. It sends once; a network error and
     every status come back as they are, with no backoff and no transient
     retry. Only a 401 is answered, by renewing the token once
     (`accessToken(ctx, true)`) and sending once more; a second 401 is the
     answer. So one call is at most 2 sends and 1 renewal. The renewal is a
     full login, so it is made only for a resend the gate will let out
     (`resendRefusal`, which does not wait): when the window's cap, a hold, or
     ctx ending before the 1 s spacing would stop the resend, the first 401 is
     the answer, nothing is renewed, and that is logged at info
     (`social-connect <op>: no renewal, the resend could not go out: …`).
     Redirects are not followed (the no-redirect client): each would be a send
     the gate did not see. Network errors come back as `SocialNetworkError`
     without the url, which holds the token or id. Each send is logged at info
     as `social-connect <op> -> <status> in <ms> ms` (`no answer` for a network
     error, ` after renewal` for the second send), with no ids or tokens.
   - **`SocialGate`** (held on `App`, set on each session's spclient with
     `SetSocialGate`, so a new session keeps the budget; without one nothing
     is sent). It counts HTTP sends, the one after a renewal included: one
     call in flight, holding the slot across its sends; at least 1 s between
     sends; at most 30 sends per rolling 5 min; nothing for max(Retry-After,
     60 s) after a 429. A call that finds the slot taken or the spacing not
     over waits in line, oldest first, for up to 5 s, then fails unsent with a
     `SocialGateError` (retry after 5 s). One made while the cap is reached or
     a hold is on fails at once, with the time left. A resend after a 401 is
     never refused this way: `RequestSocial` asks first, and answers with the
     401 rather than renew for a resend that cannot go out. The clock is
     injectable (`NewSocialGateWithClock`); the tests run the real one in
     synctest bubbles, whose clock is fake.
2. **Jam routes** (`daemon/jam.go`, `api_server.go`, the spec). `GET
   /jam/current`, `POST /jam/start`, `GET /jam/info?token=`, `POST /jam/join
   {"token"}`, `POST /jam/leave {"session_id"}`, `POST /jam/end
   {"session_id"}`, `POST /jam/remove {"session_id","member_id"}` (item 8):
   each one call, run detached under `socialTimeout` (20 s, the gate's line
   included), touching no player state. `session` in the answer is
   social-connect's JSON byte for byte; the engine reads nothing from it.
   `/jam/current` answers `{}` for no session (a 204, an empty body, or a 200
   with an empty object: `emptyObject`, never `{"session":{}}`) and
   `{"not_found":true}` for a 404 or 410; leave and end answer `{}`; remove
   answers the session the kick returned (C0: the session without the member),
   `{}` for an empty answer. The other routes pass an empty object on as it
   came. The HTTP handlers check the token, session id or member id first
   (400, the daemon never sees it). `POST /jam/forget` is local: if the jam
   mode is still "on" it becomes "off" through `setModes` on the player loop
   (the usual connect-state push follows), `{"changed":bool}`.
   - Errors: Spotify 401 (after the renewal, or without one when the resend
     could not go out) and 403 answer 403; 404 and 410 answer 404 (for remove:
     the member or the session is gone); 409 answers 409; a 429 answers 429
     with `Retry-After` = max(Retry-After, 60 s), the gate's hold; the gate's
     refusals answer 429 with `Retry-After` = the time left (rounded up to
     seconds); everything else (5xx, another status, an unusable body, no
     answer, the timeout) answers 502 (new `ErrUpstream`). Every error
     social-connect answered carries `X-Upstream-Status: <status>`; gate
     refusals and local errors do not. This goes through a new `apiError` (a
     status sentinel plus the wait and the upstream status), which
     `handleRequest` turns into the headers; `ErrConflict` (409) is new too. A
     refusal by the gate is logged at info ("<request> not sent: <reason>").
     Writes are never resent (the one resend is a 401's, after renewal).
3. **Dealer.**
   - The player loop receives `hm://social-connect/` and `social-connect/`
     messages (C0's pushes have no `hm://`: `social-connect/v2/session_update`
     and `social-connect/v2/broadcast_status_update`; a closed channel is set
     to nil: losing the session shows on the other receivers). Each is emitted
     as a `social_connect` event `{"uri", "payload"}` when the payload is JSON
     of at most 64 KB, else `{"uri", "payload_bytes"}`. The engine reads none
     of them: the gateway parses `session_update`. The uri is logged masked
     (`dealer.MaskIds`: every run of 12 or more letters, digits, `-` and `_`
     that has a digit or a capital in it, or 12 letters or digits in a row,
     becomes `*`; so every run of 12 or more hex or base62 characters does,
     and so do uuids and base64url tokens, while words joined by `-` or `_`,
     such as `social-connect` or `session_update`, stay readable) at info for
     the first 3 messages per masked uri in a session (64 uris at most), then
     at debug.
   - `dealer/recv.go handleMessage`, `dealer/msg.go`: the payloads are kept as
     `json.RawMessage`. A payload that is a JSON object or array (C0's
     pushes are `application/json`) is delivered **byte for byte** as it came,
     with no transfer encoding applied: its keys keep their order and its
     numbers stay exact (4b-a re-marshalled it through `interface{}`, which
     sorted the keys and rounded integers past 2^53). A base64 string is
     decoded and its transfer encoding applied as upstream did; anything else
     is dropped with upstream's warning, naming the JSON kind. No receiver got
     JSON payloads before patch 3. A message with more than one payload is
     dropped with a warning instead of panicking. A message nothing receives
     is logged at info the first time its masked uri (without the query) is
     seen, 64 uris at most, then at debug. Every line handleMessage logs
     carries the masked uri. Requests keep upstream's warning.
4. **Events.**
   - `jam` `{"mode", "origin", "context_uri"}`: the jam mode as the options
     hold it ("on", "off" or ""), `PlayOrigin.DeviceIdentifier`, and the
     context. Emitted when the mode changes, when the origin starts or stops
     having the prefix `social-connect-`, and when the context changes while
     the mode is set or the origin is social-connect's; compared with what it
     last emitted. Checked in `updateState` and `flushState`, which every
     state change passes through, and once in `stopPlayback` after `inactive`:
     the reset state is pushed there without either, and a client that was in
     a Jam knows by then the device lost it rather than saw it end.
   - `queue` `{}`: scheduled from `publishUpcoming` (every load, transfer,
     skip, queue edit and shuffle), and from `abandonTransfer` and
     `stopPlayback`, which empty the queue without it. A timer on the player
     loop sends one 500 ms after the first change, so a burst makes one.
   - `command` `{"endpoint", "from", "continues"?, "jam_end"?}`: every dealer
     player command, right before it is applied. `from` is
     `sent_by_device_id`. Transfers carry `continues` (what
     `transferContinues` said; false for one that never got that far: an empty
     transfer, an idle take-over, a Jam's end) and `jam_end: true` when item
     10 took it. API requests never emit it, so an Up Next edit made here
     emits none: every `command` is another device's.
5. **Reads.** `/status` gains `jam_mode` (omitted when unset), `jam_routes`
   (`current start info join leave end remove forget`), `social` `{"sends",
   "sends5m", "renewals", "held_until"?}` (epoch ms) from the gate, and
   `queue_edit: true` (item 11). New `GET /player/queue`, answered on the
   player loop from the state: `context_uri`, `context_name`
   (`context_description`), `rev` (item 11), `current` and up to 32 `next`
   entries, each `{"uri", "uid", "provider", "metadata"?, "track"?}`.
   `metadata` is the entry's map as provided (copied, omitted when empty);
   `track` is the metadata cache's object, only when cached. The route fetches
   nothing: `publishUpcoming` already asks for the window's metadata.
6. **A Jam's end leaves the device idle** (item 10). In the transfer command,
   after the empty-context fallback and before `transferContinues`: a transfer
   of a `spotify:list:jam-list:` context that names no track
   (`singleTrackContext(CurrentTrack) == nil` and no `CurrentUid`) is the Jam's
   end (`isJamEnd`), when it is the list of the Jam this device played: the
   last Jam's list the state named (`jamList`, remembered by `checkJamEvent`,
   which sees every state change, and kept when playback moves on, an API play
   in between say, or the track-only fallback after a 403). The list of any
   other Jam takes upstream's path like any other context without a track: a
   Jam with nothing played in it yet may reach a device joining it that way,
   and taking that for an end would leave the device idle and switch the mode
   just set "on" off. Logged at info ("a Jam's list arrived with no track:
   taken as the Jam's end, left idle"); its `command` event carries `jam_end`.
   Any load still on its way is superseded and dropped (a skip just before the
   end would otherwise put the Jam's song back on), a jam mode still "on"
   becomes "off" through `setModes`, then `setActive(true)`,
   `abandonTransfer()` and the `active` event, as for an empty transfer. The
   session is not applied: the options, the origin and the session id stay as
   they were, so a `set_options` off just before survives. Any other context
   without a track still plays from the top.
7. **Up Next edits** (item 11, `daemon/queue_edit.go`; no Spotify request of
   their own). `POST /player/queue/remove {"rev","uid"}` and `POST
   /player/queue/move {"rev","uid","before"}` → `{"rev"}`, the new revision.
   - **Revision.** `rev` is 16 lowercase hex digits of FNV-1a 64 over the
     current entry and each published `NextTracks` entry (at most 32), each by
     its uid, or its uri when it has none, in order, `\n`-separated, computed
     on the player loop. It changes when a row is added, removed or moved, or
     the song changes, and not when only metadata does.
   - **Checked on the player loop**, against the published rows: no list →
     204; `rev` not the current one → 409; the uid not among the upcoming rows
     → 409 (the current one is not upcoming); a row that is neither `queue`
     nor `context` (autoplay) → 400; `before` equal to `uid`, or a row of
     another section → 400; `before` not upcoming → 409; a `context` row while
     the options say shuffle → 400 (queue rows can still be edited). With two
     equal uids the first upcoming one is meant. `uid` and `before` are named
     by uid, never by uri. The HTTP handler answers 400 for a body that is not
     JSON, a `rev` or `uid` that is not a string, a `uid` empty or over 128
     bytes, and a `before` that is not a string, is over 128 bytes or equals
     the uid; an absent or null `before` is `""`, the end of the section.
   - **Made as a list job of class mutate** (never dropped, cancelling
     nothing), answered from its commit, which is `setQueue`'s as it is:
     `publishUpcoming`, `invalidateUpcoming`, `schedulePrefetchNext`,
     `updateState`. So the new rows go out in the usual connect-state push, a
     `queue` event follows, and a stream prefetched under the old order is
     never switched or faded into. `listJob` gains `listJobReply`, the same
     with the API reply on the loader job, so the lane answers the edit when it
     never reaches its commit (the lane closed or too far behind).
   - **Queued rows** go back through upstream's `List.SetQueue(nil, next)`
     unchanged, `next` being `UpcomingQueue()` with the edit applied, every
     entry still flagged `is_queued` (checked: one that is not would make
     SetQueue drop the rest, so the edit is refused with 409 instead).
   - **The context's own rows** are edited in the list itself:
     `List.RemoveAhead(uid)` and `List.MoveAhead(uid, before, span)` over
     `pagedList.removeAt(i)` and `moveTo(i, j)`, for loaded entries after the
     position only (the current entry and the history never move; queued and
     autoplay entries are not the context's and keep their places). Each entry
     keeps the page and index it was loaded with, so `Index()` stays right.
     `GoNext`, `PeekNext`, `NextTracks` and `PrevTracks` walk the edited list
     unchanged. Both refuse while the list is shuffled (`ErrShuffledContext`,
     400): unshuffling replays the shuffle's exchanges by position, so a move
     would scramble the order it restores, and a removal changes the length,
     which sends it to the in-order refetch that brings the song back.
   - **The end of a section** (`before` empty) is the end of what the client
     was shown: after the first span-1 other rows of the section, span being
     how many rows of it the published `next` holds. For the context that is
     before the autoplay tail and before any entry beyond the 32 shown.
   - **`pagedList.lastPage`**: `fetchNextPage` asks for the page after the
     last one fetched (-1 at first and after `clear()`, kept across the failed
     in-order refetch of `ToggleShuffle(false)`), instead of the page after the
     last entry's. A moved or removed last entry made that a refetch of a page
     already loaded: duplicates, or a removed song back. (It also stops a
     shuffled list, whose last entry is any page's, from fetching a loaded
     page again.)
   - A job whose row is no longer upcoming when it runs answers 409; one whose
     list a load or transfer replaced first answers 409 (superseded, nothing
     changed). Every edit and refusal is logged at info as
     `queue edit <remove|move> <section> -> <status>` (section `queue`,
     `context`, `autoplay` or `none`), with no uid or uri.
   - **A refusal that the rows shown are not the list's** (a row gone when the
     job runs, an unflagged queued entry, a controller's order, below;
     `queueEditRepublishes`) edits nothing, then publishes and pushes the
     list's own rows (`publishUpcoming`, `updateState`; the `queue` event
     follows) before it answers 409. What the client fetches on the 409 is
     then what its next edit applies to, so the refusal does not repeat
     against the rows it was made for. What plays next did not change, so the
     prefetch is kept.
   - A controller's `set_queue` is untouched: its order for the context's rows
     is still a one-publish hint. That publish is marked (`nextHinted`: set by
     `setQueue`'s commit, cleared by every other publish in `publishUpcoming`).
     While the mark stands, an edit of a context row first checks, on the lane,
     that the rows shown past the queue are, in order and by section, the
     first ones the list itself puts there (`listsOwnOrder`; fewer is fine, as
     a controller may send fewer, more is not). A controller that only
     reordered or removed queued rows lists them so, and the edit is made at
     once. Otherwise (the context's rows reordered, a queued row moved below
     the queue, autoplay rows sent back without their flag) it is refused
     with 409 (`errQueueHinted`) once, as above; edits of queued rows are never
     refused this way.
   - Like any local change an edit lasts until the list is rebuilt: a new
     context, or a transfer (in a Jam, social-connect's next transfer of the
     whole Jam, from any guest's add or skip, builds the list from its own
     copy). DESIGN-4b §13.4 steps 4a to 4c record whether that undoes Encore's
     edits; the fallback (no Edit in Jams) is the gateway's.
   - **A new context's queue.** `loadContext` keeps what is queued (4dbc099
     does); patch 3 reads it on the lane when the load runs (`carriedQueue`),
     not on the player loop when the load is asked for. The list is the
     lane's, so the loop's read raced with a running list job, and an add or
     an edit queued ahead of the load (mutations are never dropped) is in the
     list by then rather than undone by an older copy. It carries every queued
     entry but the one the state last published as playing (`playingQueued`,
     recorded by `publishSnapshot`), which has been jumped away from. The
     list's own idea of what plays is not used: an advance or a skip back
     queued before the load is never dropped, runs first and is superseded, so
     the list can name as playing a row that never played, or as upcoming one
     that did. Not covered (documented, not built): two or more steps the same
     load supersedes, or a skip to a queued row that the load cancels after
     its walk began, can still lose the queued rows they passed.

## Deviations from DESIGN-4b §3

- `StatusError.RetryAfter` is a `time.Duration`, not seconds.
- `RequestSocial(ctx, op, method, path, query, header)` takes no body: no call
  has one. The gate reaches it through `SetSocialGate` rather than a parameter.
- Not in the design, all small: redirects are not followed and answer 502 with
  their status; an unusable success body answers 502 with
  `X-Upstream-Status: 200`; a Spotify 429 answers `Retry-After` =
  max(Retry-After, 60 s); the `queue` event also comes from `abandonTransfer`
  and `stopPlayback`; the `jam` event is also checked in `stopPlayback`; item
  10 also supersedes loads in flight; `continues: false` on transfers that never
  reached `transferContinues`; every handleMessage log line carries the masked
  uri; `/jam/start` and `/jam/forget` take an absent body or any JSON;
  `resolvePlayContext` is a test seam on the API play, like `resolveTrackList`.
- From the review of 2026-10-06:
  - Item 10 takes only the list of the Jam this device played for the end
    (§3 item 10 names any Jam's list): the list of another Jam may be one
    starting with nothing played in it yet.
  - After a 401 whose resend the gate would refuse (the cap, a hold, too
    little time left), the 401 is the answer and no renewal is made, rather
    than a renewal and then the gate's 429: that answer said nothing was sent
    and dropped Spotify's 401.
  - `MaskIds` also masks ids with `-` or `_` in them (§3 item 4 says hex or
    base62 runs); §10 forbids session ids and join tokens in logs, and those
    can carry both.
- From 4b-c (C0):
  - §3 item 4 says a JSON payload is re-marshalled. It is passed on byte for
    byte instead (`RawMessage.Payloads` is `[]json.RawMessage`): the gateway
    reads `session_update` now, and re-marshalling sorted its keys and rounded
    integers past 2^53.
  - The revision keys the current entry by its uri too when it has no uid, as
    the upcoming ones (§3 item 11 says so for the upcoming ones only).
  - "The end of that section" (`before` `""`) is the end of the rows of that
    section the client was shown (span), not of the loaded list: a playlist
    longer than the window would otherwise take the row out of sight.
  - The checks the design lists as the engine's 400s and 409s are made on the
    player loop against the published rows, and again (409, 400 for a
    shuffled list) when the job runs on the list itself. A move to the end of
    a section with no other row in it is answered 200 and changes nothing.
  - `lastPage` is kept across the failed in-order refetch of
    `ToggleShuffle(false)` too (it restores the list and the position).
  - `listJobReply` (the lane answers an edit it drops) is not in the design.
- From the reviews of the 4b-c engine (2026-10-06), none in the design:
  - A context-row edit made against a controller's `set_queue` order is
    refused with 409 when that order is not the list's own (§3 item 11 says
    `set_queue` stays a one-publish hint, and says nothing of edits made
    against it). After a `set_queue` that reordered the context's rows, the
    first such edit is therefore a 409 (DESIGN-4b §13.4 step 4b).
  - A 409 for rows that are not the list's (that one, a row gone when the job
    runs, an unflagged queued entry) publishes and pushes the list's own rows
    before it answers.
  - The queue a new context carries over is read on the lane, and leaves out
    the entry the state published as playing rather than the one the list
    says plays (4dbc099 read `UpcomingQueue` on the player loop).
  - `List.Queue` (every queued entry, a playing one included) is new in
    `tracks`.
- The `command` event test uses a guest's pause rather than a skip: a skip
  reports to the session's event manager, which the unit-test player has not.
  The event is emitted the same way for every command but transfers.

## Files

| File | Change |
|---|---|
| `api-spec.yml` | `status` `jam_mode`, `jam_routes`, `social`, `queue_edit`; schemas `socialStats`, `jamToken`, `jamSessionRef`, `jamMemberRef`, `jamSession` (`session` as `json.RawMessage`), `jamForget`, `queueEntry`, `playerQueue` (with `rev`), `queueRemove`, `queueMove`, `queueRevision`; paths `/player/queue`, `/player/queue/remove`, `/player/queue/move`, `/jam/current`, `/jam/start`, `/jam/info`, `/jam/join`, `/jam/leave`, `/jam/end`, `/jam/remove`, `/jam/forget`; the new events in the `/events` description |
| `daemon/api_gen.go` | regenerated from the spec (oapi-codegen v2.5.0); additions only |
| `daemon/api_server.go` | `ErrConflict`, `ErrUpstream`, `apiError` and the `Retry-After` / `X-Upstream-Status` headers in `handleRequest`; request types, `ApiRequestDataJam` (with `MemberId`) and `ApiRequestDataQueueEdit`; event types `jam`, `queue`, `command`, `social_connect` and their data; handlers `GetPlayerQueue`, `PlayerQueueRemove`, `PlayerQueueMove` (`queueEdit`'s checks), `GetJamCurrent`, `JamStart`, `GetJamInfo`, `JamJoin`, `JamLeave`, `JamEnd`, `JamRemove`, `JamForget` |
| `daemon/jam.go` | new: the Jam routes (remove included) and their error mapping, `forgetJam`, `jamStatus` (with `queue_edit`), `playerQueue` (with `rev`), the `jam`, `command`, `queue` and `social_connect` events (`checkJamEvent` also remembers `jamList`), `isJamEnd`, `takeJamEnd`, `emptyObject` |
| `daemon/queue_edit.go` | new: `queueRev`, `publishedNext`, the Up Next edit checks, the list job and its commit, `editQueue`, `editRows`, the log line; `errQueueHinted`, `pastQueue` and `listsOwnOrder` (an edit against a controller's order), `queueEditRepublishes` and the refusal's publish |
| `daemon/loader.go` | `listJob` through the new `listJobReply`, which puts the API reply on the loader job |
| `daemon/player.go` | fields `resolvePlayContext`, `social`, `jamSent`, `jamList`, `queueEventTimer`, `queueEventPending`, `nextHinted`, `playingQueued`, `socialLogged`; `command` events and item 10 in `handlePlayerCommand`; `/status` jam fields; the API play's resolve through `resolvePlayContext`; the new requests; the social-connect receiver and the queue timer in `Run`; `flushState` checks the `jam` event |
| `daemon/player_state.go` | `publishUpcoming` schedules the `queue` event and clears `nextHinted`; `publishSnapshot` records `playingQueued`; `updateState` checks the `jam` event |
| `daemon/controls.go` | `abandonTransfer` and `stopPlayback` schedule the `queue` event; `stopPlayback` checks the `jam` event after `inactive`; `loadContext` reads the queue it carries over on the lane (`carriedQueue`); `setQueue`'s commit sets `nextHinted` |
| `daemon/app.go` | `App.socialGate`; the queue timer; `SetSocialGate` on each session's spclient |
| `spclient/social_connect.go` | new: `RequestSocial`, the seven calls (C0's query parameters, `SocialKick`), `SocialGate` (with `resendRefusal`), `SocialGateError`, `SocialResponseError`, `SocialNetworkError`, `ErrSocialArgument`, `ValidSocialId`, `SocialMinHold` |
| `spclient/spclient.go` | `Spclient.socialGate` |
| `spclient/library_write.go` | `StatusError.RetryAfter` |
| `tracks/tracks.go` | `List.RemoveAhead`, `List.MoveAhead`, `List.Queue`, `ErrNotAhead`, `ErrShuffledContext`; the failed in-order refetch of `ToggleShuffle(false)` restores `lastPage` too |
| `tracks/paged-list.go` | `lastPage` (`fetchNextPage`, `clear`), `removeAt`, `moveTo` |
| `dealer/mask.go` | new: `MaskIds` |
| `dealer/msg.go` | `RawMessage.Payloads` as `[]json.RawMessage` |
| `dealer/recv.go`, `dealer/dealer.go` | `handleMessage` as in item 3 (`jsonKind`); `logUnmatched` and its bounded set |
| `spclient/social_connect_test.go` | new (`test_unit`, synctest): each call's method, path, query and headers (C0's `current_or_new` and kick, no device but join's, no `app-platform` or `spotify-app-version`, no body); the kick on the wire (`Content-Length: 0`, nothing after the headers); bad ids, member ids included, unsent; no gate, nothing sent; 503 and a network error sent once, the url not in the error; always 401 = 2 sends and 1 renewal, 401 then 200 = success; bodies, sizes, a redirect, statuses and Retry-After; the gate: one call in flight and Join's info then join, the spacing, the line giving up after 5 s unsent, a cancelled waiter, the 31st send refused (401 pairs counting 2); a resend the cap or the deadline would stop is not made and nothing is renewed for it, the 401 being the answer; the hold after a 429 (none, 5 s and 120 s advice) and a waiting call refused with it |
| `dealer/recv_test.go` | new (`test_unit`): a JSON object payload on C0's uri delivered byte for byte (key order, an integer past 2^53, an escape) and an array; base64 unchanged, with an escaped `/`, and gzipped; other JSON kinds dropped with a warning; two payloads dropped without a panic, unmatched uris at info once and masked, `MaskIds` (base62, a uuid, base64url tokens, a username with digits, words joined by `-` or `_` kept, the 12-character threshold) |
| `daemon/jam_test.go` | new (`test_unit`): the `jam` event (set_options on and off, a jamEdit once, an API play replacing the social origin, ordinary playback, playback moving away), upstream's end sequence leaving the mode off and the context empty, the end without set_options (and the emptied queue announced), a load in flight dropped, a current uid not taken for the end, a Jam's list this device did not play not taken for the end (idle, and after another Jam's end), the end still taken after an API play in between, `command` events, `queue` coalescing (5 adds within 100 ms, one event), `/jam/forget`, `/status` jam fields and `queue_edit`, `/player/queue` (with `rev`), `social_connect` events and masked logging, a C0-shaped `session_update` passed on byte for byte, the routes' calls (only join with the device; remove as the kick), bodies and errors (remove's included), `/jam/current` 404 and 410, `/jam/current`'s empty object (`{}`, also through a real spclient), and the whole way through a real spclient and the gate |
| `daemon/queue_edit_test.go` | new (`test_unit`): the revision (by hand, stable across metadata, changing on an add, a removal, a move, a song change, by uri without a uid); a queued row removed and moved (published, pushed, announced, played in that order); a context row removed (gone from what is published, peeked and played, and from a later publish; its index kept) and moved (the order holding through playback and a republish; to the end before the autoplay tail); the prefetched stream dropped; every refusal on the player loop (stale rev, not upcoming, the current row, autoplay, another section, itself, a row gone, shuffled), queue rows still editable while shuffled; a shuffled list refused when the job runs; a row gone when the job runs (queue and context: 409 after the list's own rows are published and pushed, and not asked for again); nothing loaded; a closed lane answering; an edit superseded by a transfer; the next Jam transfer undoing an edit (documented); a controller's `set_queue` still a one-publish hint; an edit against it: of the context's reordered rows (refused once, the list's rows pushed, then made), of queued rows (made at once), of a row only the controller showed (refused once), of the context's rows in their own order after a `set_queue` that reordered or removed queued rows or sent fewer (made at once, the end of the section the end shown), shown in other sections or with a row past them (refused); edits queued ahead of a new context carried over; what a new context carries after a Next it supersedes (onto the queue, and from a queued row), with a queued row playing, and as a second context while the first loads; `carriedQueue` (a step onto the queue or back from it, the same song queued again, entries without uids); `editRows` |
| `tracks/tracks_internal_test.go` | `RemoveAhead` of the last loaded entry (the next page fetched once, the entry not back) and of the next entry (skipped by `PeekNext` and `GoNext`, `Index` and `PrevTracks` right); `MoveAhead` to the end across a page (no page fetched twice), to the end of what was shown (before autoplay, a span of 1), before a row both ways; refusals (played, current, queued, autoplay, unknown, the first of two alike, shuffled); a failed in-order unshuffle keeping the next page |
| `tracks/paged-list_internal_test.go` | `removeAt` and `moveTo`: both directions, no-op moves, pages and indexes kept, the panics |
| `daemon/player_test.go` | the queue timer in the test player; the tests of a context without a track use a playlist (`listTransfer`) where the Jam's list now means its end; upstream's end test split into the playlist twin (plays from the top) and the Jam's list reaching a device in that Jam (idle) |
| `daemon/api_server_test.go` | the new routes in `endpointMethods`; status wire format with the jam fields and `queue_edit`; 409 and 502; `/player/queue` with `rev`; Jam routes forwarded (remove included), validated (remove's member id included), bodies byte for byte, error statuses and headers; items 7 and 9 absent, remove present; the Up Next edit routes forwarded (an absent or null `before`), validated, and their errors |
| `daemon/track_meta_cache_test.go` | the queue timer in its test players |

## Checks run

On the development server, never against the live stack: in the dev image
(`encore-engine-dev:4b`, alpine 3.23, Go 1.25.10, the repo's build packages,
oapi-codegen v2.5.0), with `--network none`, over a scratch copy.

2026-10-05 and 2026-10-06 (4b-a and its review):
- `api_gen.go` regenerated with `oapi-codegen --config=api-codegen.yml
  api-spec.yml`: apart from patch 3's additions it regenerates byte for byte.
- `gofmt -l daemon spclient dealer tracks output player` (clean);
  `go vet ./daemon/ ./spclient/ ./dealer/` and with
  `-tags "test_unit test_integration"` (clean);
  `go test -tags "test_unit test_integration" ./daemon/... ./spclient/...
  ./dealer/... ./tracks/...` and `./output/... ./player/... .` (ok); the new
  tests again with `-race -count=3` (ok).
- The new tests fail with their fixes reverted, 33 reverts one at a time (a
  script edits a copy and runs the tests).
- `docker build -t encore-engine:test4b .` (the repo Dockerfile): OK.

2026-10-06 (4b-c, the C0 revisions):
- `api_gen.go` regenerated the same way: additions only (`ApiJamMemberRef`,
  `ApiQueueRemove`, `ApiQueueMove`, `ApiQueueRevision`, `rev`, `queue_edit`,
  the three routes).
- `gofmt -l daemon spclient dealer tracks output player` (clean);
  `go vet ./daemon/ ./spclient/ ./dealer/ ./tracks/` without and with the
  tags (clean); `go test -tags "test_unit test_integration" ./daemon/...
  ./spclient/... ./dealer/... ./tracks/... ./output/... ./player/... .` (ok);
  the Jam, social-connect, dealer, queue edit, API and track list tests again
  with `-race -count=3` (ok).
- 35 reverts of the 4b-c fixes, one at a time, each failing its tests: the
  device named on current, current_or_new, leave and end; the kick's path and
  its member id unchecked; a desktop header sent; remove answering `{}`, not
  listed, its member id unchecked at the handler; JSON payloads re-marshalled
  and dropped; a push's payload not passed on; the revision by uri, absent from
  `/player/queue`, `queue_edit` false, the rev unchecked; autoplay editable;
  `before` in any section; a context edit while shuffled; an empty uid let
  through; the commit without `invalidateUpcoming`, `updateState` or
  `publishUpcoming`; a superseded edit not a conflict; the lane's reply
  missing; `editRows` ignoring the span; `RemoveAhead` not removing, a gone
  row taken as done, a shuffled list edited (tracks and daemon), the end as
  the whole list's; the next page from the last entry, a failed unshuffle
  forgetting it; `moveTo` off by one. The 4b-a revert script run again on this
  tree: all still fail, except its "JSON payload dropped", whose code is gone
  (the same revert on the new switch is in the 35).
- `docker build -t encore-engine:test4c .` (the repo Dockerfile): OK.
- `git apply` of `ENCORE_PATCH.diff` (all three patches) on a clean 4dbc099
  gives exactly this tree.

2026-10-06 (the two review rounds of 4b-c: the controller's-order refusal,
the refusal's publish, the carried queue read on the lane; then the order
compared rather than assumed, and the carried queue told by the state):
- `gofmt -l daemon spclient dealer tracks output player` (clean);
  `go vet ./daemon/ ./spclient/ ./dealer/ ./tracks/` without and with the
  tags (clean); `go test -tags "test_unit test_integration" ./daemon/...
  ./spclient/... ./dealer/... ./tracks/... ./output/... ./player/... .` (ok);
  the queue edit, set_queue, carry-over, `/player/queue`, Jam, social-connect
  and dealer tests, and `./tracks/...` and `./dealer/...` whole, again with
  `-race -count=3` (ok).
- 14 reverts of the two rounds, one at a time, each failing its tests:
  `set_queue` not marking its hint; the mark outliving the next publish; a
  refusal publishing nothing, or not pushed; a gone row answered without the
  list's rows; a hinted context edit applied; the carried queue read on the
  loop; the list saying which queued row played; the playing queued row not
  recorded, or told by uri; a hint in the list's own order refused; a
  shorter hint taken for another order, a longer one for the list's; the
  sections not compared. The 35 reverts of 4b-c run again on this tree: all
  still fail.
- `docker build -t encore-engine:test4c .`: OK.
- `ENCORE_PATCH.diff` regenerated (`git -c core.autocrlf=false diff
  4dbc099`); `git apply` of it on a clean 4dbc099 gives exactly this tree.

## Re-applying on a newer go-librespot

As for patch 1, then check what moved upstream:
- that `handlePlayerCommand`'s transfer still falls back for an empty context
  before deciding whether it continues, and that `abandonTransfer` still
  leaves the device idle, active and logged in; item 10 sits between the two;
- that `applyTransferSession` still replaces `Options` wholesale (item 10's
  reason not to apply the end's session);
- that every state change still goes through `updateState` or `flushState`,
  and the window through `publishUpcoming` (the `jam` and `queue` events, and
  the `jamList` item 10 compares with);
- that `dealer/recv.go` still decodes payloads in `handleMessage`, and whether
  upstream fixed the several-payloads panic itself;
- that `innerRequestWith` still renews the token on a 401 in a loop, which is
  why `RequestSocial` does not use it;
- that `setQueue`'s commit is still `publishUpcoming`, `invalidateUpcoming`,
  `schedulePrefetchNext`, `updateState` (the Up Next edit's commit is a copy),
  that `List.SetQueue` still keeps the queue's leading `is_queued` entries,
  and that `NextTracks` still takes the rows after the queue from `nextHint`
  only for that publish; if upstream made `set_queue` reorder the context for
  good, the context edits could go through it, and `nextHinted` would go;
- that `publishSnapshot` is still the only place the list's current entry is
  published (`playingQueued`), and that steps and jumps still take the queue
  from the front while `SetQueue` keeps a playing head (`carriedQueue` looks
  at the head only);
- that `pagedList` still has no other way to know the next page than
  `fetchNextPage`, and that nothing else rearranges its `list` (only shuffle,
  unshuffle, `moveInjected`, and now `removeAt` and `moveTo` do);
- that the social-connect paths and parameters still match what the official
  client sends (DESIGN-4b §11).

## Note for the gateway

- Read `X-Upstream-Status` to tell Spotify's 401 from its 403, and Spotify's 404
  from a route missing here; `jam_routes` says which routes exist (`remove`
  since 4b-c), `queue_edit` whether the Up Next edit routes do.
- A 429 without `X-Upstream-Status` is the gate: nothing was sent. With it,
  Spotify refused, and the gate now holds every call for `Retry-After`.
- A 403 with `X-Upstream-Status: 401` is Spotify refusing the token: after
  the one renewal, or, when the gate could not have let a resend out (the
  window's cap, a hold, too little time left), without a renewal.
- `jam_mode` and the `jam` event say what the options hold, not whether a Jam
  is on: after a Jam's end through item 10 the context is empty and the mode
  "off"; after an end item 10 did not recognise the mode can be "" or stay
  "on"; `/jam/forget` switches a leftover "on" off.
- `/player/queue` answers from the state: entries without a `track` get one
  once the window's prefetch lands, so ask again a moment later.
- `/jam/remove` takes the member's `id` (32 hex in C0), not its username, and
  answers the session the kick returned; `{}` means social-connect answered
  without one (read once). It is a write: never resend it.
- `/player/queue/remove` and `/player/queue/move` take the `rev` of the
  `/player/queue` answer the user saw; a 409 means the rows changed (or the
  row went, or a transfer replaced the list): fetch `/player/queue` again. A
  400 is a row that cannot be edited that way (autoplay, another section, the
  context while shuffled), or a malformed body; a 204 is no list. An edit
  sends no `command` event; the `queue` event follows it.
- A 409 because the rows shown were not the list's (a row gone, or a
  controller's `set_queue` order of the context's rows that is not the
  list's) comes after the list's own rows were published, so the refetch
  shows what the next edit applies to. After the desktop reorders a Jam's
  context rows through `set_queue`, the first edit of one of them from the
  phone is such a 409; the edit made again goes through.
- The `social_connect` event's `uri` is unmasked; mask it before logging, ids
  with `-` or `_` in them included, as `dealer.MaskIds` does. Its `payload` is
  the push as Spotify sent it, byte for byte.
- A `command` with `jam_end` comes only for the Jam this device played. A
  Jam's list with no track from another Jam is applied like any transfer.

# Patch 4: Jam host activation and diagnostics

The contract is DESIGN-JAM-WAIT.md §2.2 (E1 to E6) and its engine tests (§3.1,
items 1 to 17). It adds one social-connect call pair, the Jam broadcast, and
diagnostics that send nothing. Nothing touches audio keys, playplay,
decryption, the stream path, the output, how a transfer or a cluster update is
applied, or the gate: every new send goes through `RequestSocial` and the
`SocialGate` of patch 3, unchanged (at most 2 sends per call, one call in
flight, 1 s between sends, 30 per 5 min, the hold after a 429).

## Why

A Jam started from Encore (`/jam/start`, social-connect's `current_or_new`) is
booked by Spotify with Encore as its host, but Spotify never sends Encore the
`set_options jam:on` and the transfer of the Jam's list that put the engine in
Jam mode: the gateway waits ("wait", DESIGN-JAM-WAIT §1.1). The one start seen
working, the desktop app's in the capture C0, made a call Encore never makes:
`POST /social-connect/v2/devices/set_broadcast_status` with `BROADCAST_ON` for
the host device (C0 `requests[2]`, 17:07:16.731), one second before its
`current_or_new` (C0 `requests[4]`, 17:07:17.743); it also read
`GET /social-connect/v2/devices/<id>/jam_status` (C0 `requests[0]`, `[1]`).
Which difference matters is not known (DESIGN-JAM-WAIT §1.2, C2), so the
engine gains the call and the read, and the gateway decides when to make them.

And the engine had blind spots where a hand-over could be lost without a
trace outside its own log (DESIGN-JAM-WAIT §1.3): a transfer that failed to
unmarshal, or carried neither a context nor a track, returned before the
`command` event; connect-state messages other than cluster, volume and logout
were dropped without a word; a cluster update's devices and player state were
never looked at.

## What it does

1. **The broadcast calls** (`spclient/social_connect.go`). Each answers a
   `*BroadcastStatus{Status, Self}`: the answer's `broadcast_status` when it is
   an enum (`^[A-Z][A-Z_]{2,39}$`, else ""), and whether its `device_id` is the
   device asked about. Nothing else of the answer is kept: its `link_token` and
   `social_radar_token` (C0 `requests[2]` reply) never leave `broadcastOf`. No
   answer (204, an empty body) is the zero value.

   | call | request | source |
   |---|---|---|
   | `SocialSetBroadcastStatus(ctx, dev, status)` | `POST /social-connect/v2/devices/set_broadcast_status`, no query, `Content-Type: application/json`, body `{"device_broadcast_status":{"timestamp":"<Unix ms>","broadcast_status":"BROADCAST_ON\|BROADCAST_OFF","device_id":"<dev>"}}` | C0 `requests[2]`: the keys in its order, the timestamp a 13-digit string |
   | `SocialJamStatus(ctx, dev)` | `GET /social-connect/v2/devices/<dev>/jam_status`, no query, no body | C0 `requests[0]` |

   `dev` must be 40 lowercase hex (`daemon/app.go` makes the device id from 20
   random bytes) and the status `BROADCAST_ON` or `BROADCAST_OFF`, else
   `ErrSocialArgument` (its text now names a device id and a broadcast status)
   and nothing is sent. The timestamp is the time the body is built, before
   the gate. Like the other calls, no `app-platform` or `spotify-app-version`.
   - **`RequestSocial` takes a body** (`[]byte`, nil for none). A body goes
     with every send through a fresh reader (`Body`, `GetBody`,
     `ContentLength`), so the one resend after a 401 carries the same bytes.
     A nil body changes nothing: the kick still sends `Content-Length: 0` and
     no body. `socialCall` adds `Content-Type: application/json` only when
     there is a body; the seven calls of patch 3 pass nil.
   - Logged as every call: `social-connect set_broadcast_status -> 200 in N ms`,
     `social-connect jam_status -> …`, op only. The jam_status path holds this
     device's id; the log never shows the url and `SocialNetworkError` drops it.
2. **`/jam/broadcast`** (`daemon/jam.go`, `api_server.go`, the spec).
   `GET /jam/broadcast` reads (`jam_status`), `POST /jam/broadcast
   {"status":"on"|"off"}` sets (`BROADCAST_ON` / `BROADCAST_OFF`). Both name
   this device (`p.app.deviceId`), never one a client gives: the request
   carries only the status. Run detached under `socialTimeout` like every Jam
   route; the answer is `{"broadcast_status": "<enum or empty>", "self":
   bool}`. Errors map as for the other Jam routes (`socialApiError`): 403, 404,
   409, 429 with `Retry-After`, 502, `X-Upstream-Status` whenever Spotify
   answered, and 400 for `ErrSocialArgument` (a configured `device_id` that is
   not 40 hex). The handler answers 400 before anything is sent for any other
   body: none, `{}`, `null`, `"ON"`, `"BROADCAST_ON"`, `true`, not JSON. A gate
   refusal is logged at info (`jam_broadcast_set not sent: <reason>`).
   `jam_routes` gains `broadcast` (at the end).
3. **Diagnostics, no sends.**
   - **`command` `error`.** A transfer that fails to unmarshal now emits its
     `command` event with `continues: false` and `error: "unmarshal"`, one with
     neither a context nor a track (and no `always_play_something`)
     `error: "nothing_to_play"` (`emitCommandFailed`), before the error goes
     back as before (the warn "failed handling dealer request", `Reply(false)`).
     Every other command's event is unchanged and has no `error`.
   - **`cluster` event** `{"active", "social_devices", "jam_context",
     "jam_mode", "social_origin"}` (`checkClusterEvent`, called right after a
     cluster update is unmarshalled, before anything else it does): the kind of
     device the cluster names active (`self`, `social`, `other`, `none`), how
     many of its devices are social-connect's (an id, map key or
     `DeviceInfo.device_id`, starting `social-connect-`, or
     `DeviceInfo.is_social_connect`), and whether its player state's context
     is a `spotify:list:jam-list:`, its jam mode, and whether its play origin
     is social-connect's. Emitted only when that differs from what it last
     emitted (`clusterSent`). Kinds, a count and booleans: no id. Nil-safe
     getters throughout. Whether this device stops being active is decided
     after it, exactly as before.
   - **Unhandled connect-state messages.** Any `hm://connect-state/v1/` message
     other than cluster, volume and logout is logged at info the first time
     its masked uri (`dealer.MaskIds`) is seen, 16 uris at most, then at debug:
     `connect-state message <masked uri> not handled (<n> bytes)`
     (`noteConnectMessage`, `connectLogged`). It is still not applied.

## Deviations from DESIGN-JAM-WAIT §2.2 and §3.1

- `broadcastOf` reads `broadcast_status` and `device_id` as raw JSON values,
  so a `device_id` of another JSON kind leaves the status kept with `self`
  false (the design's typed struct would have dropped the whole answer). A
  status of another kind is dropped as designed.
- `isSocialDevice` also counts a device whose `DeviceInfo.device_id` has the
  prefix, not only its map key.
- `noteConnectMessage` is in `jam.go` beside `handleSocialMessage`; the final
  branch of `handleDealerMessage` calls it for `hm://connect-state/v1/` uris
  only (the only other uris that reach it are the pusher's, handled first).
  Past 16 uris a new one is logged at debug.
- Test 13 is a new `TestJamBroadcastThroughTheGate` rather than an extension
  of `TestJamRoutesThroughTheGate`, which ends holding the gate after a 429 and
  pins its send counts.
- `TestSocialCallShapes` gains one assertion (no body recorded for the seven
  calls); the fake transport now records bodies. Added beyond §3.1:
  `TestClusterEventBeforeATransferAway` (the event comes first and playback
  still stops) and `TestApiJamBroadcast` (the body byte for byte, the error
  statuses and headers on both methods).
- The spec's enum makes oapi-codegen generate `JamBroadcastRequestStatus`;
  the handler compares `string(data.Status)` with `"on"` and `"off"`, so it
  does not depend on the enum constants' generated names.

## Files

| File | Change |
|---|---|
| `spclient/social_connect.go` | `RequestSocial` and `socialCall` take a body (`Content-Type` only with one); the seven calls pass nil; `SocialSetBroadcastStatus`, `SocialJamStatus`, `broadcastOf`, `BroadcastStatus`, `BroadcastOn`, `BroadcastOff`, `socialDevicePattern`, `broadcastEnum`; `ErrSocialArgument`'s text |
| `daemon/jam.go` | `jamRoutes` + `broadcast`; the `socialConnect` interface + the two calls; `jamRequest` handles the broadcast types, `jamBroadcastAnswer`; `emitCommandFailed`, `isSocialDevice`, `clusterSummary`, `checkClusterEvent`, `noteConnectMessage`, `connectLogUris` |
| `daemon/player.go` | fields `clusterSent`, `connectLogged`; `checkClusterEvent` in the cluster branch; `noteConnectMessage` in the last branch of `handleDealerMessage`; `emitCommandFailed` on the transfer's two early failures; the dispatch of the two request types |
| `daemon/api_server.go` | `ApiRequestTypeJamBroadcastGet` / `Set`, `ApiRequestDataJam.Broadcast`; `ApiEventTypeCluster`, `ApiEventDataCluster`; `ApiEventDataCommand.Error`; handlers `GetJamBroadcast`, `JamBroadcast` |
| `api-spec.yml` | schemas `jamBroadcastRequest` (`status` enum `on`, `off`), `jamBroadcast`; path `/jam/broadcast` (get `getJamBroadcast`, post `jamBroadcast`); the `/events` description (`command.error`, `cluster`) |
| `daemon/api_gen.go` | `ApiJamBroadcast`, `ApiJamBroadcastRequest`, `JamBroadcastRequestStatus` and its values, `JamBroadcastJSONRequestBody`, the two handlers, wrappers and routes (additions only; written by hand to match oapi-codegen v2.5.0's layout, to be regenerated: see Checks run) |
| `spclient/social_connect_test.go` | the fake transport records bodies; `TestSocialSetBroadcastStatusShape` (ON and OFF: method, path, no query, exactly 4 headers, the body byte for byte with the capture's key order and a string timestamp equal to the send time), `…Answer` (C0's reply, another device, none, 204, empty, non-enum, numeric, absent, not an object; no token in what is kept; a 403), `TestSocialBroadcastRefusesBadArguments`, `…ResendsTheSameBody` (401 then 200: 2 sends a second apart, 1 renewal, identical bodies and lengths), `…OnTheWire` (`DumpRequestOut`), `TestSocialJamStatusShape` (and the id not in a network error), `TestBroadcastThenCurrentOrNewThroughTheGate`, `TestSocialBroadcastLogsNoIds` |
| `daemon/jam_test.go` | `fakeSocial` gains the two calls; `TestJamBroadcastRoutes` (this device always, the answer and its JSON), `TestJamBroadcastErrors`, `TestJamBroadcastThroughTheGate` (real spclient and gate: the body, then `current_or_new` a second later, 2 sends, no token in the answer), `TestCommandEventForAFailedTransfer`; `TestJamStatus` expects `broadcast` |
| `daemon/cluster_test.go` | `TestClusterEvent` (self, unchanged, social with 2 social devices by id and by info, the JSON without ids, other, none, an empty cluster), `TestClusterEventBeforeATransferAway`, `TestUnhandledConnectStateMessageIsLoggedOnce` (masked, once at info, then debug; a cluster update not logged so; 16 uris) |
| `daemon/api_server_test.go` | `/jam/broadcast` in `endpointMethods` (GET, POST); forwarded (GET, on, off); 400 and no request for the bad bodies; `TestApiJamBroadcast`; the status wire format lists `broadcast` |

## Checks run

None yet: patch 4 was written on a machine without Go, never compiled or
run. Before the deploy, on the development server, in the dev image (`encore-engine-dev:4b`)
with `--network none`, over a scratch copy, as for patch 3:
- `oapi-codegen --config=api-codegen.yml api-spec.yml`: `daemon/api_gen.go`
  should come out byte for byte as written here. If it differs, keep the
  generated file; if a type name differs, only `api_server.go` (which uses
  `ApiJamBroadcastRequest`, `ApiJamBroadcast`) and the tests could need it.
- `gofmt -l daemon spclient dealer tracks output player` (clean); `go vet
  ./daemon/ ./spclient/ ./dealer/ ./tracks/` without and with
  `-tags "test_unit test_integration"`; `go test -tags "test_unit
  test_integration" ./daemon/... ./spclient/... ./dealer/... ./tracks/...
  ./output/... ./player/... .`; the new tests again with `-race -count=3`.
- The reverts, one at a time, each failing its test: the body not attached,
  or one reader for both sends (`…ResendsTheSameBody`); `Content-Type` on
  every call (`TestSocialCallShapes`) or on none, the timestamp a number, the
  keys reordered (`…Shape`); the device pattern or the status check dropped
  (`…RefusesBadArguments`); a non-enum status kept, `self` always true
  (`…Answer`); the jam_status path (`TestSocialJamStatusShape`); `broadcast`
  not in `jamRoutes` (`TestJamStatus`, the status wire format); the dispatch
  missing, or a device other than this one (`TestJamBroadcastRoutes`); the
  error mapping (`TestJamBroadcastErrors`); each `emitCommandFailed`
  (`TestCommandEventForAFailedTransfer`); `checkClusterEvent` not called,
  emitting every time, or not counting `is_social_connect` (`TestClusterEvent`);
  `noteConnectMessage` not called or uncapped (`TestUnhandled…`); the handler
  taking `"ON"` or mapping on/off wrongly (`TestApiJamRoutesValidate`,
  `…Forward`).
- `docker build -t encore-engine:test4d .` (the repo Dockerfile).

Done where it was written (no network, no Go): `ENCORE_PATCH.diff`
regenerated with `git -c core.autocrlf=false diff` against a 4dbc099 rebuilt by
reverse-applying the patch 1-3 diff (its base blob hashes match the diff's
`index` lines, and regenerating the patch 1-3 diff from it gave the old file
byte for byte); `git apply` of the new diff on that base gives exactly this
tree.

## Re-applying on a newer go-librespot

As for patch 3, then check:
- that `handlePlayerCommand`'s transfer still returns early only on the
  unmarshal and on neither a context nor a track (`emitCommandFailed`), and
  still emits `command` before applying anything else;
- that `handleDealerMessage` still unmarshals a cluster update before deciding
  whether this device stops being active (`checkClusterEvent` sits between),
  and still receives every `hm://connect-state/v1/` message;
- that the social-connect paths, the body's shape and key order, and the
  timestamp's type still match what the official client sends (C0
  `requests[0]`, `[2]`).

## Note for the gateway

- `/jam/broadcast` answers `{"broadcast_status", "self"}`: an enum (or "")
  and a boolean. The tokens of Spotify's answer never reach the API.
- `POST /jam/broadcast` is a write: never resend it. The device is always the
  engine's own; there is nothing to pass but `{"status":"on"|"off"}`. A 400
  means the body, or a configured `device_id` that is not 40 hex; nothing was
  sent.
- `jam_routes` lists `broadcast` from patch 4 on: an engine without it has no
  `/jam/broadcast` (404 from the router).
- `cluster` events come on change only, with kinds and booleans, no ids.
- `command.error` marks a transfer the engine could not apply (`unmarshal`,
  `nothing_to_play`), with `continues: false`: a hand-over that arrived and was
  dropped. Nothing moved, so a client that takes a non-continuing transfer for
  a song change must skip one with `error` (gateway player.js `onCommand` does).

# Patch 5: Jam self-activation

The contract is DESIGN-JAM-SELF.md §2 (E1 to E4) and its engine tests (§2.7,
items 1 to 10). It adds one local route, `POST /jam/activate`, which sends
nothing but the connect-state push every state change makes. Nothing touches
audio keys, playplay, decryption, the stream path, the output, the
social-connect calls or their gate, how a transfer or a cluster update is
applied, or the device announcement.

## Why

The live findings of 2026-10-07 (gateway and engine logs, DESIGN-JAM-SELF
§1.1):
- Encore's own Start (broadcast on, then `current_or_new?activate=true`)
  succeeds at Spotify: a SESSION_ACTIVATED push, the session's
  host_device_info is Encore. Spotify then sends Encore neither a
  `set_options jam:on` nor a social-connect transfer, so the gateway waits.
  The same with device_type speaker, and from a clean BROADCAST_OFF → ON.
- A Jam started on the PC while Encore was the active device made the PC
  itself the active device, in Jam mode (`k=cluster active=other mode=on
  social=0`). Spotify sent Encore nothing.
- The gateway then took the playback back with a Web API transfer
  (`k=command ep=transfer from=webapi-* continues=0`). Its state carried the
  options' `modes jam:on` around the PC's playlist context (`k=jam mode=on
  social=0 ctx=playlist`), and the gateway took Encore for the Jam's host.

So the device that starts a Jam switches itself into Jam mode: its own
options' `modes.jam = "on"`, its own context and playback, announced in its
Connect state. Spotify never hands that to the host. The engine could not get
there by itself: the mode went "on" only through a received `set_options`
(`daemon/player.go` `case "set_options"` → `setModes`, `daemon/controls.go`)
or a transfer's options (`applyTransferSession`), and every path of the
engine's own only ever switched it off (`forgetJam`, `takeJamEnd`, the
`state.reset()` of `stopPlayback`). Every Start from Encore ended in "wait".

## What it does

1. **`activateJam`** (`daemon/jam.go`, beside `forgetJam`, its inverse). On
   the player loop:
   - It is refused with `ErrConflict` (409), after the info line
     `jam mode not switched on: <why>`, when this device is not the active
     one (`this device is not the active one`), has no context or no list
     (`nothing is loaded`), or plays a Jam's list (`spotify:list:jam-list:`)
     or playback whose origin is social-connect's (`the playback is a Jam's
     already`): those are Jams Spotify drives. The refusals come before the
     next check, so a Jam's list with the mode on is still a 409.
   - It answers `{"changed": false}` when the mode is "on" already, and
     calls, emits and pushes nothing.
   - Otherwise it logs `jam mode switched on for a Jam this device started`
     and calls `setModes({"jam":"on"})`: the call a received `set_options
     {"modes":{"jam":"on"}}` makes once `setOptions` has had its three nil
     pointers. `setModes` changes the mode and runs `updateState`: the `jam`
     event (`{"mode":"on","origin":<the play origin's device, "" after an
     API play>,"context_uri":<the context>}`), and a PLAYER_STATE_CHANGED
     push with `IsActive` and the options, at once when the 200 ms budget
     allows, else on the coalescing timer. It answers `{"changed": true}`.
   - Nothing else moves: not the context, the track, the queue, the
     position, the session id, the origin or the device info, and nothing
     loads. `lastCommand` is not set and no `command` event is emitted, since
     no other device sent anything. No network, no disk.
   - The log lines are fixed text: no device id, context uri or session id.
2. **`POST /jam/activate`** (`daemon/api_server.go`, `daemon/player.go`, the
   spec). Request type `ApiRequestTypeJamActivate` (`"jam_activate"`);
   handler `JamActivate`: a body, if any, must be JSON, else 400 before
   anything reaches the player, as for `/jam/forget`. Dispatched on the player
   loop; a refusal goes back as a nil interface, never a typed nil. The answer
   is `ApiJamActivate {"changed": bool}`, or 204 without a session as for
   every route. `jam_routes` gains `activate` (at the end).
3. **The spec.** Schema `jamActivate`, path `/jam/activate` (200, 204, 400,
   409). `/jam/current`'s note now reads "every Jam route but /jam/forget and
   /jam/activate" is one call to social-connect, and `/status` `jam_mode`
   names `/jam/activate` as the other way the mode goes "on".

The inverse needs no engine change (DESIGN-JAM-SELF §2.5). `/jam/forget`
switches a self-set mode off (`setModes` off: the event and the push);
another device taking the playback resets it (`stopPlayback`), and a later
transfer replaces the options. `/jam/end` still only sends the DELETE: the
engine cannot tell whether the session it ended is the Jam it plays, the
gateway can.

## Deviations from DESIGN-JAM-SELF §2

- `/status`'s `jam_mode` description names `/jam/activate`. Its copy on
  `ApiStatus.JamMode` in `api_gen.go` changes with it: the one change there
  that is not an addition.
- The 200 response's description says that `changed` false means the mode
  was on already, and that no `jam` event follows.
- Tests beyond §2.7: `TestActivateJamRefused` has an "inactive with a
  playlist" case, so dropping the active check fails on the error and not
  only on the log line (a fresh player is then refused as "nothing is
  loaded"); `TestActivateJamOnce` also asserts that nothing waits to be pushed
  (`stateDirty`); `TestActivateJamLogs` also covers the refusal lines; item
  10's 409 is a new `TestApiJamActivateRefused` (409, an empty body, neither
  `Retry-After` nor `X-Upstream-Status`, and the request did reach the
  daemon) rather than a row of an existing table.
- `playingPlaylist` runs the two jobs §2.7 expected: the play's resolve, then
  the context's load (`loadContext`); its first track's load is dropped.

## Files

| File | Change |
|---|---|
| `daemon/jam.go` | `jamRoutes` + `activate`; `activateJam` |
| `daemon/player.go` | the dispatch of `ApiRequestTypeJamActivate` |
| `daemon/api_server.go` | `ApiRequestTypeJamActivate`; handler `JamActivate` |
| `api-spec.yml` | schema `jamActivate`; path `/jam/activate` (post `jamActivate`); the descriptions of `/jam/current` and of `/status` `jam_mode` |
| `daemon/api_gen.go` | `ApiJamActivate`, `JamActivate` in `ServerInterface`, its wrapper and route (additions), and the comment on `ApiStatus.JamMode`; written by hand to match oapi-codegen v2.5.0's layout, to be regenerated: see Checks run |
| `daemon/jam_test.go` | `playingPlaylist`, `quietPushes`; `TestActivateJam`, `TestActivateJamIsTheSetOptionsPath`, `TestActivateJamOnce`, `TestActivateJamRefused` (inactive, inactive with a playlist, nothing loaded, a Jam's list, social-connect's playback), `TestJamActivateRoute`, `TestForgetAfterActivate`, `TestActivateJamLogs`; `TestJamStatus` expects `activate` |
| `daemon/cluster_test.go` | `TestClusterEchoOfAnActivatedJam` (`{"active":"self","jam_mode":"on"}`, still active, no `inactive`) |
| `daemon/api_server_test.go` | `/jam/activate` in `endpointMethods` (POST); forwarded (no body, `{}`); 400 and no request for `{` and `not json`; the bodies `{"changed":true}` and `{"changed":false}`; `TestApiJamActivateRefused`; the status wire format lists `activate` |

## Checks run

None yet: patch 5 was written on a machine without Go, never compiled or
run. Before the deploy, on the development server, in the dev image (`encore-engine-dev:4b`)
with `--network none`, over a scratch copy, as for patches 3 and 4:
- `oapi-codegen --config=api-codegen.yml api-spec.yml`: `daemon/api_gen.go`
  should come out byte for byte as written here. If it differs, keep the
  generated file; if a type name differs, only `jam.go` and `api_server.go`
  (which use `ApiJamActivate`) and the tests could need it.
- `gofmt -l daemon spclient dealer tracks output player` (clean); `go vet
  ./daemon/ ./spclient/ ./dealer/ ./tracks/` without and with
  `-tags "test_unit test_integration"`; `go test -tags "test_unit
  test_integration" ./daemon/... ./spclient/... ./dealer/... ./tracks/...
  ./output/... ./player/... .`; the new tests again with `-race -count=3`
  (`-run 'Activate|ClusterEcho|JamStatus|ApiJam|ApiStatusWireFormat|ApiRejectsWrongMethod'`).
- The reverts, one at a time, each failing its test: the active check
  dropped (`TestActivateJamRefused`); the context check dropped (the same);
  the jam-list or the social check dropped (the same); `setModes` replaced by
  a direct `Options.Modes["jam"] = "on"` that skips `updateState`
  (`TestActivateJam`: no event, no push); "off" for "on" (the same); the
  "already on" check dropped (`TestActivateJamOnce`: `changed` true);
  `activate` not in `jamRoutes` (`TestJamStatus`, the status wire format);
  the dispatch missing, or a typed nil on a refusal (`TestJamActivateRoute`);
  the handler taking a body that is not JSON (`TestApiJamRoutesValidate`);
  the route missing from `api_gen.go` (`TestApiJamRoutesForward`,
  `TestApiRejectsWrongMethod`).
- `docker build -t encore-engine:test5 .` (the repo Dockerfile).

Done where it was written (no network, no Go): `ENCORE_PATCH.diff`
regenerated with `git -c core.autocrlf=false diff` against a 4dbc099 rebuilt
by reverse-applying the patch 1-4 diff (every base blob hash matches the
diff's `index` lines); `git apply` of the new diff on that base gives exactly
this tree. The tree's `daemon/jam_test.go` had changed after the patch 1-4
diff was written (`socialTransport.RoundTrip`: the answer's `body` renamed
`reply`, since `body` already named the request's bytes there); the new diff
carries the tree as it is.

## Re-applying on a newer go-librespot

As for patch 4, then check:
- that the `set_options` case of `handlePlayerCommand` still calls
  `setModes`, and that `setOptions` with three nil pointers still changes
  nothing;
- that `setModes` still reaches `updateState`, and only on a change;
- that `updateState` still runs `checkJamEvent` and hands the state to the
  push lane, and that `buildStateRequest` still carries `IsActive` and the
  player state with its options.

## Note for the gateway

- `/jam/activate` is local: never a social-connect send, nothing in the gate
  or in `/status` `social`.
- A 409 means not the active device, nothing loaded, or a Jam's playback
  already; nothing changed.
- `changed: false` means the mode was on already: no `jam` event follows.
  `changed: true` comes with the `jam` event `{"mode":"on"}` (the event and
  the answer travel separately, either may arrive first) and the connect
  state with the mode on its way to Spotify.
- `/jam/forget` is the inverse. Nothing in the engine switches a self-set
  mode off at a Jam's end.
- `jam_routes` lists `activate` from patch 5 on: an engine without it has no
  `/jam/activate` (404 from the router).

# Patch 6: Windows named-pipe output and the engine's version stamp

The contract is the release plan's D19 and its R3e phase. On Windows the
Encore Bridge runs the engine as a child process on the same PC. The gateway
serves a named pipe (a fresh random name for each run) and the engine writes
its PCM into it: the Windows counterpart of the FIFO the Docker engine writes
to. Upstream's pipe backend refused Windows (`output/driver-pipe-stub.go`:
"pipe output is not supported on Windows"). Patch 6 also stamps the Windows
build with its Encore version and, as 6b, keeps the interactive login's
callback on loopback on Windows. 6c, on every platform, makes the control API
refuse requests that a browser sends from another website.

Everything else here is Windows-only or inert on Linux. On Linux, `output` and
`session` compile from the same files as before, and the Docker engine behaves
as before apart from 6c: it is not stamped, and the visible additions are the
`--version` option and the 403 for a cross-site browser request.

## Why

- The transport. A named pipe with the gateway as the server and the engine as
  the client keeps what the FIFO gives on Linux: a full pipe blocks the
  engine's write and so holds the decoder back; the PCM never mixes with the
  engine's logs; an output with no reader fails at once. The alternatives were
  rejected: the engine's stdout (one stray byte from any library shifts the
  s16le stream by a byte, which is loud static until restart) and loopback TCP
  (buffers of unknown size, and any local process could connect and inject
  audio).
- The stamp. The bridge has to know that the engine next to it is the one it
  was built for (patches 1-6 change the engine's API). go-librespot's own
  `version` cannot carry that: it goes to Spotify as the client-token
  request's client version, decides the access point's "dev build" product
  flag, and is part of the user agent and the device's software version. The
  Windows engine keeps the Docker engine's values for all of those.
- 6b. The callback server listened on every interface, which makes Windows
  ask for a firewall exception and opens the port to the LAN, although the
  redirect URI always names 127.0.0.1.
- 6c. The control API has no authentication; it relies on listening on
  loopback (the bridge sets `server.address: 127.0.0.1`). A web page in a
  browser on the same computer can still reach loopback. rs/cors with an empty
  `allow_origin` only keeps such a page from reading the answers: a "simple"
  cross-site request (a form post, or `fetch` with `mode: "no-cors"`, whose
  `text/plain` body `jsonDecode` reads all the same) still reached the
  handler, so any website could skip, pause or start a Jam. On Windows the
  bridge, and so a browser, always runs on the same computer as the engine.

## What it does

1. **`output/driver-pipe-windows.go`** (new, `//go:build windows`) replaces
   `output/driver-pipe-stub.go` (deleted). It builds the same `pipeOutput`
   with the same transform and `outputLoop` as the Unix driver
   (`driver-pipe.go`, unchanged), so patch 1's locking applies as it is: no
   command waits for a full pipe. Only the open differs:
   - `audio_output_pipe` must name a local named pipe, `\\.\pipe\<name>` (the
     prefix in any case). A file path or a remote pipe (`\\server\pipe\...`)
     is refused before anything is opened.
   - The pipe is opened with a plain `os.OpenFile(path, O_WRONLY)`, which
     gives a synchronous handle: a write blocks while the pipe's buffer quota
     is full, as a write to a full FIFO does.
   - With no server the open fails at once with `ERROR_FILE_NOT_FOUND`, as the
     Unix driver's non-blocking open of a FIFO without a reader fails with
     `ENXIO`. With `audio_output_pipe_wait_for_reader: true` it waits for a
     server instead, trying again every 10 ms, as the blocking FIFO open waits
     for a reader.
   - With every instance of the pipe connected (`ERROR_PIPE_BUSY`) it tries
     again every 10 ms for up to 2 s (`pipeBusyTimeout`), then fails; with
     `audio_output_pipe_wait_for_reader` it keeps trying. (`x/sys/windows` has
     no `WaitNamedPipe`; the short loop does its job.)
   - A `Close` during a blocked write leaves the file to the loop, as on Unix:
     on Windows too, Go's `File.Close` waits for the write in progress.
   - A reader that goes away (the server closes its end) fails the blocked
     write, and the output reports the error on `Error()`, as a FIFO's `EPIPE`
     does on Unix. The player then drops the output ("output device failed")
     and opens a new one at the next play.
2. **The version stamp** (`cmd/daemon/encore_version.go`, new;
   `cmd/daemon/cli_config.go`; `cmd/daemon/main.go`):
   - `encorePatchLevel` is the last Encore patch in the tree (6). It is a
     constant, so every build knows it; raise it with every new patch.
   - `encoreVersion` is the Encore release, set only by the Windows build:
     `-ldflags "-X main.encoreVersion=<version>"`. It never reaches Spotify.
   - `--version` prints one line and exits, before the config directory is
     created or locked:
     `encore-engine 1.1.0 (go-librespot dev, Encore patches 1-6)`, or for a
     build without the stamp (the Docker image)
     `go-librespot dev (Encore patches 1-6, unstamped)`.
   - A stamped engine also logs `running encore-engine ...` at start, after
     upstream's `running go-librespot ...` line. An unstamped one logs nothing
     new.
3. **6b: the login callback on loopback on Windows** (`session/oauth2.go`).
   `NewOAuth2Server` listens on `oauthCallbackAddr(port)`: `127.0.0.1:<port>`
   on Windows, upstream's `:<port>` elsewhere. It is used only with
   `credentials.type: interactive`.
4. **The upstream test that pinned the old stub** (`output/output_test.go`):
   `TestPipeBackendUnsupportedOnWindows` becomes
   `TestPipeBackendWantsANamedPipeOnWindows` (the backend now reaches the
   named-pipe driver, which refuses a plain path).
5. **6c: no cross-site browser requests** (`daemon/api_server.go`, every
   platform). `serve()` wraps rs/cors in `refuseCrossSite`: a request with an
   `Origin` header gets `403 cross-site request refused` and never reaches the
   daemon, unless the origin is the API's own (`Origin` host = `Host`) or
   rs/cors's `OriginAllowed` accepts it (an `allow_origin` the user set,
   including `*`). Browsers send `Origin` with every cross-site POST and every
   websocket handshake; the Encore gateway (Node's fetch and WebSocket) and
   command-line clients send none, so they are unaffected.

Nothing touches audio keys, playplay, decryption, the stream path, the
player, the transform, the samples or any call to Spotify.

## Files

| File | Change |
|---|---|
| `output/driver-pipe-windows.go` | new: `newPipeOutput` for Windows; `openNamedPipe`, `isNamedPipePath`, `pipeBusyTimeout`, `pipeRetryInterval` |
| `output/driver-pipe-stub.go` | deleted |
| `output/driver-pipe_windows_test.go` | new (`test_unit && windows`): no server, paths that are not local pipes, the prefix in any case, waiting for a server, waiting for and giving up on a busy pipe, the stream byte for byte, `TestPipeOutputControlsDoNotWaitForAFullPipe` (the Windows twin of patch 1's, which also asserts that the loop is blocked in its write), a reader that goes away |
| `output/output_test.go` | `TestPipeBackendWantsANamedPipeOnWindows` replaces `TestPipeBackendUnsupportedOnWindows` |
| `cmd/daemon/encore_version.go` | new: `encorePatchLevel`, `encoreVersion`, `encoreVersionString` |
| `cmd/daemon/encore_version_test.go` | new (`test_unit`): `TestEncoreVersionString`, `TestVersionFlag` (runs the test binary again with `--version`: one line, exit 0, no config directory) |
| `cmd/daemon/cli_config.go` | `--version` |
| `cmd/daemon/main.go` | the start line of a stamped engine |
| `session/oauth2.go` | `oauthCallbackAddr`; `NewOAuth2Server` listens on it |
| `session/oauth2_test.go` | new (`test_unit`): `TestOAuthCallbackAddr`, `TestOAuth2ServerTakesTheCodeOnLoopback` |
| `daemon/api_server.go` | 6c: `refuseCrossSite`, `sameOrigin`; `serve()` uses them |
| `daemon/api_crosssite_test.go` | new (`test_integration`): `TestApiRefusesCrossSiteRequests`, `TestApiAllowOriginStillPasses` |

The Windows build itself lives outside this directory, in
`gateway/windows/build-engine/` (Dockerfile, `build.sh`, `inside.sh`,
README). It cross-compiles this tree on Linux with Go, MinGW-w64 and vcpkg's
static `x64-mingw-static` libraries (upstream's `windows-vcpkg` CI recipe,
this tree's `vcpkg.json`, `vcpkg-configuration.json` and `vcpkg-triplets/`),
with `-trimpath` and the stamp, and checks that the exe imports only Windows
system DLLs.

## Checks run (2026-10-07, on the development server, never against the live stack)

Linux, in the dev image (`encore-engine-dev:4b`, alpine 3.23, Go 1.25.10)
with `--network none`, over a scratch copy of this tree (patches 1-6):
- `oapi-codegen --config=api-codegen.yml api-spec.yml`: `daemon/api_gen.go`
  comes out byte for byte as it is here.
- `gofmt -l daemon spclient dealer tracks output player session cmd` (clean).
- `go vet ./daemon/ ./spclient/ ./dealer/ ./tracks/ ./output/ ./session/
  ./cmd/daemon/`, without and with `-tags "test_unit test_integration"`
  (clean).
- `go test -tags "test_unit test_integration" ./daemon/... ./spclient/...
  ./dealer/... ./tracks/... ./output/... ./player/... ./session/...
  ./cmd/daemon/... .` (ok); the pipe output, the new tests and the Jam,
  cluster and API tests again with `-race -count=3` (ok).
- `go list -f '{{.GoFiles}} {{.CgoFiles}}'` on Linux, before and after patch
  6: `./output` and `./session` identical; `./cmd/daemon` gains
  `encore_version.go`.
- `docker build -t encore-engine:test6 .` (the repo Dockerfile), then
  `go-librespot --version` in it: `go-librespot dev (Encore patches 1-6,
  unstamped)`.

Windows, built by `gateway/windows/build-engine/` (Go 1.26.8, MinGW-w64 GCC
14, vcpkg 2025.09.17) and run on a Windows 11 x64 PC:
- `go vet` of `output`, `session` and `cmd/daemon` for `windows/amd64`,
  without and with the test tags (clean).
- `encore-engine.exe` imports only `KERNEL32`, `msvcrt`, `ADVAPI32` and
  `SHLWAPI`. Two builds, the second in a rebuilt build image, are byte for
  byte the same.
- The test executables (`test_unit test_integration`) of `output`,
  `session`, `cmd/daemon`, `daemon`, `spclient`, `dealer`, `tracks` and
  `player`: all pass, including every test in
  `driver-pipe_windows_test.go`. (`player` reads a fixture by a relative
  path, so it runs from its package directory.)
- `encore-engine.exe --version` prints
  `encore-engine 1.1.0 (go-librespot dev, Encore patches 1-6)`, and creates
  no config directory. The exe was not run against Spotify.

`git apply` of `ENCORE_PATCH.diff` on a clean 4dbc099 gives exactly this tree.

6c, later the same day, in the same Linux dev image with `--network none`
over a scratch copy of this tree: `oapi-codegen` gives the same
`daemon/api_gen.go`; gofmt and vet (with and without the test tags) are
clean; `go test -tags "test_unit test_integration"` over `daemon`,
`spclient`, `dealer`, `tracks`, `output`, `player`, `session`, `cmd/daemon`
and the root package passes, including `TestApiRefusesCrossSiteRequests` and
`TestApiAllowOriginStillPasses`; the API, Jam and cluster tests pass again
with `-race -count=2`; the test image builds and `--version` prints the
unstamped line. `ENCORE_PATCH.diff` was regenerated the same way as before
(the method reproduced the previous diff byte for byte first), and applied to
a clean 4dbc099 it gives exactly this tree. `encore-engine.exe` was rebuilt
from this tree with `gateway/windows/build-engine/`.

## Re-applying on a newer go-librespot

1. If upstream has its own Windows pipe output by then, compare it with this
   one (local pipes only, a blocking write, no server = an error, busy = try
   again) and prefer upstream's if it does the same; keep the tests.
2. Check that `output/driver-pipe.go` still builds one `pipeOutput` that both
   drivers fill, and that `newPipeOutput` still has the same signature on
   every platform.
3. Check that `loadCLIConfig` still parses its flags before it creates and
   locks the config directory (the `--version` check goes right after the
   parse), and that `main` still logs `running go-librespot`.
4. Check that `NewOAuth2Server` still listens for a redirect URI on
   127.0.0.1.
5. Raise `encorePatchLevel` with the next Encore patch.
6. Run the checks above, then the Windows build and its tests
   (`gateway/windows/build-engine/README.md`).

## Note for the gateway

- Configure the engine with `audio_backend: pipe`, `audio_output_pipe_format:
  s16le` and the pipe's name, for example
  `-c audio_output_pipe=\\.\pipe\encore-pcm-<random>`. Serve the pipe before
  the engine first plays: an output opened with no server fails at once.
- The engine opens a new connection for every output session (the first play
  after a stop or an output error, and a change of audio device) and closes
  it at the session's end. A new connection means the older ones belong to closed
  outputs: at most the one chunk being written (4096 samples, 46 ms) can still
  arrive on them. Read and drop it, or close them; closing an older
  connection is no error for the engine.
- Stop reading to hold the decoder back; read again to let it go on. Closing
  the current connection fails the engine's output: the player stops ("output
  device failed") and opens a new connection at the next play.
- Run `encore-engine.exe --version` before starting it. The first word is
  `encore-engine` and the second is the release it was built for; `Encore
  patches 1-<n>` gives the patch level. Any other answer, or a non-zero exit,
  is an engine from another build.

# Patch 7: early prefetch of the next track

A skip starts the next song as soon as the song it leaves has played for
`early_prefetch_ms` (default 5 s): by then the next song has been fetched
ahead, as it is today only in the last 30 s of a song. While the listener
goes forward, the engine opens no more streams and asks for no more audio
keys than before: the stream fetched early is the one the skip, or the end
of the song, plays. Nothing changes with `early_prefetch_ms: 0`.

## Why

Measured on the live stack (bridge 1.1.0, engine patches 1-5; 2026-10-08,
gateway and engine logs, numbers and flags only):
- 28 of 29 skips (`next`) loaded the next song from scratch (`loaded track
  ... prefetched: false`): an audio key, a storage resolve and the first
  chunks. They started it 0.32-1.28 s after the command at the bridge (median
  0.41 s; about 0.6 s at the phone). The one skip that came in the last 40 s
  of a song found it prefetched and took 0.11 s.
- Upstream prefetches the next song 30 s before the current one ends
  (`schedulePrefetchNext`, `daemon/controls.go`). Of 217 loads in 48 h, 15
  were prefetched: every one a song's natural end or a skip in its last 40 s.
- Spotify refused audio keys once after about 60 loads in 15 minutes. So the
  early prefetch must not add keys while the listener goes forward, and adds
  at most one per song otherwise.

## What it does

1. **The option** (`cmd/daemon/cli_config.go`, `daemon/config.go`,
   `daemon/app.go`, `config_schema.json`, `README.md`): `early_prefetch_ms`
   (default 5000) becomes `Config.EarlyPrefetch` and `AppPlayer.earlyPrefetch`.
   0, or a negative value, keeps upstream's timing: every change below is
   then inert (the timer, the fire, the step forward and its wait, the aged
   stream), and the engine behaves exactly as before.
2. **The timer** (`schedulePrefetchNext`, `earlyPrefetchDelay` in the new
   `daemon/early_prefetch.go`). Where upstream sets the prefetch timer for 30 s
   before the end, it is set for `early_prefetch_ms` instead when all of these
   hold:
   - upstream's time is later than that (with less than 40 s left, upstream
     prefetches at once, as before);
   - upstream's time is at most 15 minutes away (`earlyPrefetchMaxLead`): the
     CDN address of a prefetched stream is never renewed, so a stream built
     long before it plays risks having its later chunks refused. This bounds
     how long an early stream waits while its track plays; a pause can hold it
     longer, which item 5 handles;
   - the track is not on repeat (what plays next is the same track, while a
     skip goes elsewhere);
   - the timer has not fired for this primary stream yet
     (`prefetchFiredFor`, a weak pointer, so an old stream is not kept alive
     by it).

   It counts from the latest arming while playing, as upstream's does: a load
   that lands playing, a play, a seek, a change to what plays next. A pause
   stops it. The bridge's skip (pause, next, seek 0, play) so counts from the
   play. `prefetchArmedEarly` says the timer is set early.
3. **The fire** (`prefetchTimerFired`, called by the timer's case in `Run`
   instead of `prefetchNext`):
   - It records the primary stream: the timer fires early at most once per
     track. Every later prefetch for that track (after a queue edit, say)
     waits for upstream's time, which upstream would have spent anyway.
   - When a prefetch of the current generation is queued or running
     (`loaderLane.hasPrefetch`, which covers the "peek next" job and the
     prefetch job), it does nothing: that prefetch fetches the same track,
     and a second one would cancel it and ask for the same audio key again.
     Any change to what plays next moves `prefetchGen`, so a stale prefetch
     never blocks its replacement.
   - Otherwise it calls upstream's `prefetchNext` (the peek on the loader
     lane, then the prefetch job, unchanged).
   - After an early fire the timer is armed again for upstream's time, so a
     prefetch that failed is tried again then, as upstream would have tried
     it. One that worked is found there (`secondaryStream.Is`) and nothing is
     fetched. Not when upstream's time has come by the early fire (under 40 s
     left, `upstreamPrefetchDue`: armed with 40-45 s left): that fire was
     upstream's prefetch at once. Armed again, the timer would fire straight
     away, and the peek just queued could have finished with its result not
     yet read, which `hasPrefetch` cannot see: the same track would be
     fetched twice.
4. **A step forward lets the prefetch in flight finish** (`forwardStep`,
   `loaderLane.keepsRunningPrefetch`, `dropLoadsLocked`). `advanceNext`'s job
   (a skip to the next track, a song's end, the walk past an unplayable
   track) is marked with the current `prefetchGen`. When it is submitted while
   the prefetch job of that generation is running (the job `submitPrefetch`
   queues, marked `opensStream`; not the peek), and no other load or step is
   pending, the prefetch is not cancelled: it is fetching the track the step
   lands on, and its audio key has been asked for already. The lane runs one
   job at a time and its results come back in order, so the prefetch's result
   is applied first (`commitPrefetch`), and the load the step ends in finds it
   (`loadCurrentTrack`'s `secondaryStream.Is`, upstream's) and plays it:
   `prefetched: true`. A prefetch that has not finished `keptPrefetchGrace`
   (3 s) after the step is cancelled after all, and the step loads from
   scratch, as before. Everything else cancels the prefetch in flight as
   upstream does: a skip back, a jump to a chosen track (a skip that names
   its track included, see below), a play, a transfer, a second step behind
   the first, a step with the track on repeat, a stale prefetch, early
   prefetch off.

   **While the step waits, the loop treats it as a load in flight**
   (`loaderJob.kept`, `stepKept`, `stepLanded`, `keptStep`). Upstream's step
   leaves the loop with the track it moves away from as the current one for a
   few milliseconds; this wait can last up to the grace. `submit` tells the
   loop when it keeps the prefetch, and from then until the step's result has
   been applied, what arrives takes the path it takes during a load:
   - the player's events are held (`deferPlayerEvent`). The end of the track
     being left is not taken for a second step forward, which would cancel
     the kept prefetch, land on the track after the one it fetched and fetch
     that from scratch; the load the step starts forgets it, as any load
     forgets the end of the stream it replaces (`forgetReplacedStreamEvents`);
   - a play or a pause is recorded (`play`, `pause`, `recordPlayback`), shown
     at once, and applied to the track the step lands on, once its load is in
     flight. Applied to the track being left, the step's commit would start
     the new track playing over the pause (`IsPaused = !hasNextTrack`). A pause
     that came before the step is the step's, as upstream: a skip plays (the
     bridge pauses again itself, then seeks to 0);
   - a prev is a second press (`prevMayRestart`, split out of `skipPrev`): the
     track before, not a restart of the one being left.

   A step superseded while it waits (a prev, a play, a transfer) ends the
   wait when its result comes back thrown away: the end of the track being
   left, held meanwhile, is forgotten as the replacing load would forget it,
   and the rest is handled. A stop or a Jam's end ends it at once with the
   load they drop (`stopPlayback`, `takeJamEnd`). The bridge's own commands
   are serialized and send nothing between `next` and its metadata, so its
   skip (pause, next, pause, seek 0, play) is unchanged.
5. **An early stream a long pause has aged is fetched again**
   (`noteEarlyPrefetch`, `dropAgedPrefetch`, `earlyPrefetchAt`).
   `commitPrefetch` stamps a stream fetched ahead of upstream's time (with 40
   s or more of the track left). Where it would start to play after waiting
   more than `earlyPrefetchMaxLead`, which only a pause makes possible, it is
   thrown away (`invalidateUpcoming`) instead:
   - a play (the track's end would switch to it): it is fetched again at
     upstream's time, or at once with under 40 s left;
   - the load a skip, a play or a transfer ends in (`loadCurrentTrack` with
     `drop`): that load fetches the track afresh.
   Not the advance past a track that played to its end: the player has
   switched to that stream already. A stream fetched at upstream's time is
   not stamped: upstream holds it just as long. The early stream thrown away
   is the one extra stream per track this patch allows.
6. **The patch level** (`cmd/daemon/encore_version.go`): `encorePatchLevel`
   is 7, so `--version` says `Encore patches 1-7`.

Unchanged: what throws a prefetched stream away (a load that is not that
track, `invalidateUpcoming` on add to queue, set_queue, an Up Next edit, a
shuffle or repeat change and a Jam edit's transfer continuation, a stop, an
abandoned transfer), `NewStream`, audio keys, the storage resolve, chunks,
decryption, the player, the output and crossfade. The new log lines are debug
or trace, with no names and no uris. Upstream's info line `prefetched track
"<name>"` is unchanged; it now comes a few seconds into a song instead of near
its end.

## Audio keys, streams and memory

| What the listener does after the early fire | Streams opened |
|---|---|
| Skips to the next track, or lets the song end | the same as before: the early stream plays |
| Skips while the early prefetch is still fetching | the same: the step waits for it (at most 3 s) |
| Skips, naming the next track, while the early prefetch is still fetching (a Connect `skip_next` that carries its track, as some Spotify clients and Jam guests send; `POST /player/next` with a uri; never the bridge's `next`) | at most one more: a jump to a chosen track cancels the prefetch, as upstream, and loads the track from scratch |
| Skips before the timer fires | the same as before: the load fetches from scratch |
| Goes back, picks another track or context, transfers, stops, edits what plays next, changes shuffle or repeat, or a Jam guest edits the queue | at most one more per track: the early stream is thrown away, and its replacement waits for upstream's time |
| Pauses for more than 15 minutes after the early fire, then plays or skips | at most one more: the early stream is thrown away (item 5), and the track is fetched again |

A prefetched stream holds chunk 0 and the three that follow (about 2 MB)
until it plays, now for most of a song rather than 30 s. A stream thrown away
is not closed (upstream's behaviour): it finishes those chunks and is
collected. Narration in DJ contexts is fetched with the prefetch, so earlier
too. Jams are not excluded: a guest's edit throws the early stream away like
any other change to what plays next, at most once per song.

## Deviations from the speed plan

- The default is 5000 ms, as the engine step asked. The measurements behind
  the plan suggested about 1 s: of 29 skips, 22 came 1.5 s or more into a
  song, 16 after 2 s, 13 after 3 s and 9 after 5 s, and skipping through
  songs came in bursts 1.1-3.8 s apart. A lower `early_prefetch_ms` covers
  more of those at no cost while the listener goes forward; the cost is the
  extra stream when he does something else after the fire.
- Jams are not excluded (the plan suggested upstream's timing while
  `modes.jam` is on): the step treats Jam edits as one more change to what
  plays next, and the once-per-track rule bounds what they waste.
- Added: the step forward's grace (3 s), so a stuck prefetch cannot hold a
  skip for the job's 30 s timeout; the timer armed again for upstream's time
  after an early fire, which keeps upstream's one attempt at that time.
- The in-flight check is made when the timer fires, not in `submitPrefetch`:
  the peek job is itself a prefetch job, and submitting it would cancel the
  running prefetch before `submitPrefetch` saw the uri.
- `prefetchFiredFor` is a weak pointer rather than a `*player.Stream`.
- Review fixes (2026-10-09), all within the plan's guarantees:
  - the step's wait made visible to the loop (item 4). Reproduced before the
    fix: a track's end during the wait landed the step on the track after
    next (two audio keys where upstream used one), a pause during it was lost
    (the next track loaded playing), and a prev restarted the track being
    left before the step played the next one anyway. The plan's simpler
    alternative, keeping the prefetch only while paused (the bridge's own
    skip), would have left the prev case to Connect controllers;
  - no second fire right after an early fire that was upstream's (item 3);
  - an early stream aged by a long pause fetched again (item 5); before, the
    15-minute cap bounded only how long it waited while its track played;
  - not changed: a skip that names its track still cancels the prefetch in
    flight (the table above). Letting it wait too would widen the window the
    fix above closes, for a case the bridge never sends.

## Files

| File | Change |
|---|---|
| `daemon/early_prefetch.go` | new: `earlyPrefetchMaxLead`, `keptPrefetchGrace`, `earlyPrefetchDelay`, `prefetchTimerFired`, `upstreamPrefetchDue`, `noteEarlyPrefetch`, `dropAgedPrefetch`, `forwardStep`, `stepKept`, `stepLanded`, `recordPlayback` |
| `daemon/controls.go` | `schedulePrefetchNext` arms the early time; `submitPrefetch`'s job is `opensStream`; `commitPrefetch` stamps (`noteEarlyPrefetch`); `loadCurrentTrack` and `play` drop an aged early stream; `play` and `pause` record while a step waits; `prevMayRestart` (split out of `skipPrev`); `stopPlayback` ends the wait; `advanceNext`'s step takes `forwardStep()` |
| `daemon/player.go` | `AppPlayer.earlyPrefetch`, `prefetchArmedEarly`, `prefetchFiredFor`, `keptStep`, `keptStepGen`, `keptStepPaused`, `earlyPrefetchAt`; the timer's case calls `prefetchTimerFired` |
| `daemon/loader.go` | `listJob`/`listJobReply` take options for the job; `loaderJob.opensStream`, `keepPrefetch`, `prefetchGen`, `kept`; `runningJob.gen`, `opensStream` (set by `next`); `loaderLane.keptGrace`; `submit` (calls `kept`) and `dropLoadsLocked(keepPrefetch)`; `keepsRunningPrefetch`; `hasPrefetch`; `applyLoaderResult` ends the step's wait; `deferPlayerEvent` holds events during it |
| `daemon/jam.go` | `takeJamEnd` ends the wait |
| `daemon/app.go` | `earlyPrefetch` from the config |
| `daemon/config.go` | `Config.EarlyPrefetch` |
| `cmd/daemon/cli_config.go` | `early_prefetch_ms`, default 5000, negative = 0 |
| `cmd/daemon/encore_version.go` | `encorePatchLevel` 7 |
| `config_schema.json`, `README.md` | `early_prefetch_ms` |
| `daemon/early_prefetch_test.go` | new (`test_unit`): `TestEarlyPrefetchDelay`, `TestEarlyPrefetchTimerFiresSoonAfterTheTrackStarts` (and paused, and played again), `TestEarlyPrefetchOffKeepsUpstreamsTime`, `TestEarlyPrefetchFiresOncePerTrack` (re-armed for upstream's time), `TestEarlyPrefetchKeepsOnePrefetchInFlight` (queued, running, replaced after a change), `TestSkipDuringTheEarlyPrefetchPlaysIt` (the step waits, the prefetch lands first, the load hands its stream to the player), `TestOtherStepsCancelTheEarlyPrefetch` (a second step, repeat, off, stale), `TestChangesToWhatPlaysNextDropTheEarlyPrefetch` (add to queue, an Up Next edit, repeat, shuffle), `TestJamEditDropsTheEarlyPrefetch`, `TestEarlyPrefetchOffFiresAsUpstream`, `TestLoaderStepForwardKeepsOnlyTheRightPrefetch`, `TestLoaderStepForwardRunsAfterTheKeptPrefetch` and `TestLoaderKeptPrefetchIsCancelledAfterItsGrace` (a running lane), `TestLoaderHasPrefetch`, `TestLoaderRunningJobKeepsGenAndStream`; review fixes: `TestTheEndOfTheTrackLeftWhileTheStepWaitsIsHeld`, `TestPlayAndPauseWhileTheStepWaitsAreForTheTrackItLandsOn` (nothing, a pause, a pause then a play, paused before the step, and a pause after), `TestAPrevWhileTheStepWaitsGoesBack`, `TestASupersededStepForgetsTheEndItHeld`, `TestAStopEndsTheStepsWait`, `TestAJamEndEndsTheStepsWait`, `TestTheEarlyFireWithUnder40sLeftIsUpstreamsPrefetch`, `TestAnEarlyPrefetchAgedByAPauseIsFetchedAgain` (a play, a skip, a track's end, fresh), `TestOnlyAnEarlyPrefetchIsStamped`; `TestLoaderStepForwardKeepsOnlyTheRightPrefetch` checks that `submit` reports keeping |
| `cmd/daemon/cli_config_test.go` | `TestEarlyPrefetchMapping`, `TestLoadCLIConfigEarlyPrefetch` (default, 0, set) |

## Checks run (2026-10-08, on the development server, never against the live stack)

In the dev image (`encore-engine-dev:4b`, Go 1.25.10) with `--network none`,
over a new scratch copy of this tree (patches 1-7):
- `oapi-codegen --config=api-codegen.yml api-spec.yml`: `daemon/api_gen.go`
  comes out byte for byte as it is here (patch 7 does not touch the API).
- `gofmt -l daemon spclient dealer tracks output player session cmd` (clean).
- `go vet` of `daemon`, `spclient`, `dealer`, `tracks`, `output`, `session`
  and `cmd/daemon`, without and with `-tags "test_unit test_integration"`
  (clean).
- `go test -count=1 -tags "test_unit test_integration"` over `daemon`,
  `spclient`, `dealer`, `tracks`, `output`, `player`, `session`,
  `cmd/daemon` and the root package (ok); patch 7's tests, the loader's, and
  the queue edit, transfer, Jam edit, cluster and API status tests again with
  `-race -count=3` (ok).
- The reverts, one at a time in a scratch copy, each failing a test: the step
  never keeping the prefetch; no in-flight check; no once-per-track rule; no
  re-arm after an early fire; early with the track on repeat; keeping a stale
  prefetch, the peek, or a prefetch behind another step; keeping every
  running prefetch; the grace never cancelling; the prefetch job not marked
  `opensStream`; `next` not recording the job's generation and mark; the
  timer never set early; a default other than 5000; a negative value kept.
- `docker build -t encore-engine:test7 .` (the repo Dockerfile), then
  `go-librespot --version` in it: `go-librespot dev (Encore patches 1-7,
  unstamped)`.

Windows, built by `gateway/windows/build-engine/` (`TESTS=1`, version 1.1.0)
on the development server, and run on a Windows 11 x64 PC: the build's own
checks pass (vet for windows/amd64, system DLLs only, the stamp, no user
paths); `encore-engine.exe --version` prints `encore-engine 1.1.0
(go-librespot dev, Encore patches 1-7)`; `daemon.test.exe` and
`cmd-daemon.test.exe` pass, patch 7's tests three times over. That exe was
not run against Spotify and was not shipped.

Not run: anything against Spotify (no track was loaded). `daemon/app.go`'s
one line that hands the option to the player is not reached by a unit test
(`newAppPlayer` opens a session).

After the review fixes (2026-10-10), the same Linux checks over the fixed
tree, with the new tests added to the `-race -count=3` run: regen identical,
gofmt and vet clean, every package ok, race ok, `encore-engine:test7`
rebuilt, `--version` as above. Each fix undone on its own in a scratch copy
(20 reverts: the events not held, a play or a pause not recorded or not
applied, a prev restarting, a superseded step's end kept, the loop never
told, a stop or a Jam's end not ending the wait, the wait never ending, the
re-arm after a fire that was upstream's, no re-arm at all, an aged stream
kept by a play or a skip, dropped at a track's end, stamped at upstream's
time or with the option off, never stamped, dropped however fresh) fails at
least one test. The Windows build above predates the review fixes and was
not rebuilt.

`ENCORE_PATCH.diff` was regenerated the same way as for patch 6 (a clean
clone of 4dbc099, this tree copied over it without `ENCORE_PATCH.md` and
`ENCORE_PATCH.diff`, `git add -A`, `git -c core.autocrlf=false diff
--cached`; the method reproduced the patch 1-6 diff byte for byte first), and
applied to a clean 4dbc099 it gives exactly this tree.

## Re-applying on a newer go-librespot

1. Check that `schedulePrefetchNext` is still the only place that arms the
   prefetch timer, that `Run`'s timer case still calls `prefetchNext`, and
   that a pause still stops the timer.
2. Check that the prefetch still runs on the loader lane as a peek job and a
   prefetch job of `classPrefetch` stamped with `prefetchGen`, that every
   change to what plays next still moves `prefetchGen`, and that a prefetch
   result is still committed only for the current `prefetchGen`.
3. Check that the lane still runs one job at a time and returns results in
   order, that `advanceNext` still walks forward in one `classNav` job without
   moving `prefetchGen`, and that `loadCurrentTrack` still takes a secondary
   stream that `Is` the track it loads.
4. Check that a load in flight (`loadInFlight`) still holds the player's
   events (`deferPlayerEvent`), has `play` and `pause` record the state for
   `commitLoad` to apply, and makes a prev the track before (`skipPrev`): the
   step's wait (`keptStep`) takes the same paths. Check that `stopPlayback`
   and `takeJamEnd` still clear `pendingPlayerEvents` (they end the wait with
   it), and that a load that lands still forgets the ends of older streams
   (`forgetReplacedStreamEvents`).
5. Check that `loadCurrentTrack`'s `drop` still marks a load that drops the
   output, never the advance past a track that played to its end.
6. Raise `encorePatchLevel` with the next Encore patch.
7. Run the checks above.

## Note for the gateway

- Nothing to call: the engine prefetches by itself. `early_prefetch_ms` in
  the engine's `config.yml` sets the delay; without it the default (5000)
  applies, and 0 turns patch 7 off.
- A skip that comes at least `early_prefetch_ms` (plus the prefetch's own
  0.3-1 s) into a song finds the next song prefetched, and one that comes
  while it is being fetched waits for it: the engine logs `prefetched: true`
  for its load. The bridge's skip sequence (pause, next,
  seek 0, play) needs no change; the delay counts from the play.
- The engine's `/status` and API are unchanged.

# Patch 8: Docker image (version stamp, default config, first start, zeroconf backend switch)

From 1.3.0 Encore publishes ready-made images (DESIGN-DOCKER-IMAGES.md §2.4):
`ghcr.io/mbucc9000/encore-engine`, built from exactly this directory, next to
the bridge's `ghcr.io/mbucc9000/encore-bridge`. A user of the images has one
compose file and no source tree, so the engine image has to bring what the
source tree's `gateway/engine/` folder used to. Patch 8 changes no Go code
apart from the patch level.

## Why

- The version stamp. A published image should say which Encore release it
  belongs to, as the Windows engine does (patch 6). The Docker engine was
  unstamped: `go-librespot dev (Encore patches 1-7, unstamped)`.
- The default config. A source install mounts `gateway/engine/`, which holds
  Encore's `config.yml`. A prebuilt install starts from an empty folder, and
  without a `config.yml` upstream's defaults apply (the ALSA output, no pipe,
  no control API, no metadata): the bridge can't work with that engine.
- The zeroconf backend switch. On hosts where avahi-daemon already owns the
  mDNS port (most NAS systems) the engine needs `zeroconf_backend: avahi`. In
  a prebuilt install `engine/config.yml` is written by the container and
  belongs to root, and Dockge or Portainer users have no shell to edit it. A
  setting in the stack's `.env` does the job without touching the file.

## What it does

1. **`Dockerfile`**:
   - `ARG ENCORE_VERSION=` and `-ldflags "-X main.encoreVersion=${ENCORE_VERSION}"`
     on the `go build`. The release workflow passes the release
     (`--build-arg ENCORE_VERSION=1.3.0`), and the image's engine prints
     `encore-engine 1.3.0 (go-librespot dev, Encore patches 1-8)`. A build
     without the argument (gateway/compose.yaml's build from source) stays
     unstamped: `go-librespot dev (Encore patches 1-8, unstamped)`.
   - The runtime stage writes `/usr/share/encore/packages.txt` (`apk info -v`,
     sorted): the exact Alpine packages in the image, for the source lookup
     in THIRD-PARTY-NOTICES.
   - It copies `encore-docker/config.yml` to `/usr/share/encore/config.yml`
     and `encore-docker/entrypoint.sh` to `/usr/share/encore/entrypoint.sh`,
     and starts through the script:
     `ENTRYPOINT ["/bin/sh", "/usr/share/encore/entrypoint.sh"]`. `CMD` is
     unchanged (`/usr/bin/go-librespot --config_dir /config`), so
     `--entrypoint` overrides and custom commands still work. Run through
     `/bin/sh`, the script needs no exec bit (a Windows working copy and the
     release's tar lose it). No `COPY --chmod`, so the legacy builder still
     builds it.
2. **`encore-docker/config.yml`**: a byte-for-byte copy of the bridge's
   `gateway/engine/config.yml` (the release selftest keeps them identical).
   The build from source still mounts `gateway/engine/`; the image carries
   the copy.
3. **`encore-docker/entrypoint.sh`** (POSIX sh, busybox):
   - When `/config` holds neither `config.yml` nor `config.yaml`
     (go-librespot reads `config.yaml` when there is one), it copies the
     default there: to a temporary name first, then `mv -n` onto
     `config.yml`, so the engine never reads half a file and a file that
     appeared in the meantime is not replaced. An existing file, or a link by
     either name, is never changed. A folder it can't write to ends the
     start (exit 1, with a message).
   - `ZEROCONF_BACKEND=builtin|avahi` adds `-c zeroconf_backend=<value>`
     (go-librespot's own override, applied after the file) to the command
     for this start, when the command is `/usr/bin/go-librespot`. Empty:
     `config.yml` decides. Any other value ends the start (exit 64). The
     avahi backend also needs the host's D-Bus socket in the container (the
     compose file's commented line).
   - Then it runs the command (`exec`). It prints fixed texts only.
4. **`cmd/daemon/encore_version.go`**: `encorePatchLevel` 8, and the comment
   names the image's stamp.

Nothing touches the engine's Go code paths, its API, the audio or any call
to Spotify.

## Files

| File | Change |
|---|---|
| `Dockerfile` | `ARG ENCORE_VERSION` and the stamp; `packages.txt`; the default config and the entrypoint script copied in; `ENTRYPOINT` |
| `encore-docker/config.yml` | new: Encore's default engine config (identical to `gateway/engine/config.yml`) |
| `encore-docker/entrypoint.sh` | new: the first start and `ZEROCONF_BACKEND` |
| `cmd/daemon/encore_version.go` | `encorePatchLevel` 8; comment |

## Checks run (2026-10-13, on the development server, never against the live stack)

Over a staging copy of this tree (patches 1-8). The images were built by
`.github/scripts/build-images.sh load` (linux/amd64, `ENCORE_VERSION` set to
the working copy's version, 1.2.1) and tagged on that machine only:
- In the image's build stage (Alpine 3.23, Go 1.25.10) with
  `--network none`: `gofmt -l daemon spclient dealer tracks output player
  session cmd` (clean); `go vet ./cmd/daemon/`, without and with
  `-tags "test_unit test_integration"` (clean); `go test -count=1
  -tags "test_unit test_integration"` over `daemon`, `spclient`, `dealer`,
  `tracks`, `output`, `player`, `session`, `cmd/daemon` and the root
  package (ok; `TestEncoreVersionString` and `TestVersionFlag` use the
  constant).
- `--version`: the stamped image prints `encore-engine 1.2.1 (go-librespot
  dev, Encore patches 1-8)`; a plain `docker build .` prints `go-librespot
  dev (Encore patches 1-8, unstamped)`.
- `.github/scripts/smoke-images.sh`, the release workflow's smoke test:
  `smoke: OK`. For the engine it checks the stamp, the default config in the
  image against `gateway/engine/config.yml`, `packages.txt`, the first start
  writing `config.yml`, a changed `config.yml` kept over a second start, no
  `config.yml` next to a `config.yaml`, a `config.yml` link left alone,
  `ZEROCONF_BACKEND=avahi` passing `-c zeroconf_backend=avahi` (and nothing
  passed without it), `bogus` refused, the image's entrypoint and command,
  then both images started from the shipped compose file (cut off from the
  network), the engine's `/status` answering, its `config.yml` written at
  the first start and unchanged after a restart.
- The reverts, one at a time on top of the built image, each failing the
  smoke test: the script overwriting an existing `config.yml`; ignoring
  `config.yaml`; dropping the `ZEROCONF_BACKEND` switch; announcing it
  without passing `-c`.
- Not run: linux/arm64 (the development server has no arm64 emulation; the
  release workflow builds it on GitHub's arm64 runner and runs the same
  smoke test there), and anything against Spotify.

`ENCORE_PATCH.diff` was regenerated the same way as for patch 7 (the method
reproduced the patch 1-7 diff byte for byte first). Compared with that one,
only four sections are new or changed: `Dockerfile`,
`cmd/daemon/encore_version.go`, `encore-docker/config.yml` and
`encore-docker/entrypoint.sh`. It reverse-applies to this tree
(`git apply -R --check`), and applied to a clean 4dbc099 it gives exactly
this tree.

## Re-applying on a newer go-librespot

1. Compare upstream's `Dockerfile` with this one: take its build stage and
   runtime packages, and add back the build argument and the stamp,
   `packages.txt`, the two copies and the `ENTRYPOINT`.
2. Check that go-librespot still prefers `config.yaml` to `config.yml` in
   the config directory (`loadCLIConfig`), and that `-c field=value` still
   overrides the file.
3. Keep `encore-docker/config.yml` identical to `gateway/engine/config.yml`.
4. Raise `encorePatchLevel` with the next Encore patch.
5. Run the checks above: build both images with
   `.github/scripts/build-images.sh load` and run
   `.github/scripts/smoke-images.sh`.

## Note for the gateway

- Nothing to change: the engine's API and `/status` are the same.
- In a prebuilt install `engine/config.yml` exists from the first start on
  and is the user's from then on (owned by root, since the container writes
  it); a new image never replaces it. `ZEROCONF_BACKEND` overrides only
  `zeroconf_backend`, and only while it is set.

# Patch 9: Up Next you can rearrange

The contract is DESIGN-QUEUE.md §3 (items 1 to 6). It builds on patch 3 item 11
(Up Next edits, `daemon/queue_edit.go`). Every item is a change to the
engine's own track list or its bookkeeping: none sends a Spotify request of its
own. The jump costs what a skip costs (one track load, the metadata of the rows
that enter the window, a connect-state push), and an edit no more than before,
often less (item 4).

## Why

Up Next on the phone could only remove and reorder the queue, and the
context's rows while the context was not shuffled:
- A shuffled playlist or Liked Songs could not be edited at all.
  `RemoveAhead` and `MoveAhead` refused (`ErrShuffledContext`): unshuffling
  replays the shuffle's exchanges by position, so a move would scramble the
  order it restores, and a removal changes the length, which sends it to the
  in-order refetch that brings the song back.
- Moving a song to the top was a second copy at the end of the queue (the
  phone's swipe was an add to queue). Moving one of the context's rows into the
  queue took an add, a move and a removal: three revisions, three publishes.
- Tapping a row could not play it. `/player/next {uri}` names the song by uri
  only: it lands on a queued copy first, walks the context from its start, so
  an earlier copy in the history wins, and injects the song when it does not
  find it.
- Every edit dropped the stream prefetched for the next song, even when the
  next song had not changed: a burst of edits near the end of a song opened a
  stream (an audio key) per edit.
- Rows without a uid could not be named. Playlists carry uids, other
  contexts may not.

## What it does

1. **Edits of a shuffled list** (`tracks/tracks.go`, `tracks/paged-list.go`).
   - `RemoveAhead`, `MoveAhead` and the new `TakeAhead` (item 2) work while the
     list is shuffled, and each sets `List.shuffleEdited` when it is.
     `ErrShuffledContext` is gone, and with it the 400 for it.
   - `ToggleShuffle(false)` with `shuffleEdited` set sorts the list back into
     the context's order instead (`pagedList.sortByOrigin`): a stable sort by
     (page, index in the page), an injected entry (page -1) first, the position
     kept on the entry it was on, `lastPage` kept, nothing fetched. The removed
     and taken entries stay out; a manual order made while shuffled is not
     kept (shuffle off means the context's order). Then `shuffled` and
     `shuffleEdited` go false. `ToggleShuffle(true)` clears `shuffleEdited`.
   - Without an edit, unshuffling is upstream's as before: the seed replayed
     when the length is unchanged, the in-order refetch otherwise.
   - `queueEdit` no longer refuses a `context` row while the options say
     shuffle.
2. **Play Next: `POST /player/queue/top {"rev","uid"}` → `{"rev","uid"}`**
   (`daemon/queue_edit.go`). The body is checked as a removal's
   (`before` is ignored), the request type is `queue_top`, and it is made by
   `queueEdit` like the other edits: checked on the loop (no list 204, a stale
   rev 409, a row not upcoming 409 — the current one is not), then a list job
   of class mutate answered from its commit. Unlike remove and move, a row of
   any section is accepted: `queue`, `context` or `autoplay`.
   - A **queued row** moves to the head of the queue and keeps its uid, back
     through `SetQueue(nil, edited)`. One that is first already is answered
     200 with its uid, and nothing changes, is published or pushed.
   - A **row of the context or autoplay** is taken out of the list
     (`List.TakeAhead(uid)`: the first entry ahead of the position with that
     uid that is not queued; `ErrNotAhead` otherwise) and queued at the head as
     a new entry: a copy (`proto.Clone`; the entry taken is shared with the
     context's pages, which a refetch hands out again), its uid `q<n>`
     reserved on the loop from `state.queueID` as `addToQueue` does, flagged
     `is_queued`, without `autoplay.is_autoplay`, every other metadata key kept
     (a Jam's "added by"). Then `SetQueue(nil, [copy, queued rows...])`, which
     keeps a queued row playing. It has left the context's order for good.
   - Every queued entry must be flagged first (`errQueueUnflagged`, 409); a
     context or autoplay row shown in a controller's order (`nextHinted`) gets
     the `listsOwnOrder` check. Both refusals publish the list's own rows
     first, as for the other edits.
   - The answer is the new rev and the row's uid now: the same for a queued
     row, the new `q<n>` otherwise. Logged at info as
     `queue edit top <section> -> <status>`, with no uid or uri.
3. **The jump: `POST /player/queue/jump {"uid"}` → `{"rev"}`**
   (`daemon/queue_jump.go`, request type `queue_jump`). No rev: the uid names
   exactly one row, and the engine changes song often, so a rev would refuse
   good taps. Not `/player/next` with a uid: an older engine ignores fields it
   does not know and would only skip one song.
   - Checked on the loop: no list 204; the uid not among the published next
     rows 409 (the current row included). The handler answers 400 for a body
     that is not JSON or a uid that is not a string of 1 to 128 bytes.
   - Then skipNext's with a track: `OnPlayerSkipForward(…, true)`, the skip
     debounce (`noteSkip`), `narrationJumped`, `loadGen++`, a list job of class
     load, so it supersedes whatever load or step was out.
   - The job calls `List.JumpAhead(uid)`: a queued entry after the one playing
     with that uid first (the queued entries before it are dropped and it
     becomes the queued entry playing; the context stays: seekQueue's rule);
     otherwise the first entry ahead in the context, its own or autoplay's
     (a queued entry playing is dropped, the position moves there, the rows
     between become the history, and the queue stays and plays after it:
     TrySeekTo's rule, probe P4). Matched on the uid alone, never the uri; it
     never walks the history, fetches a page or injects a song.
   - The commit is skipNext's: `publishSnapshot`, the timestamp now and the
     position 0, `loadCurrentTrack(paused, drop)`: one track load. It answers
     `{rev}` once the new rows are published, before the audio lands. The
     window of 32 is walked again from the new position, so it refills by
     itself: a shuffled list is all in memory, an unshuffled one fetches the
     next page when the window reaches it, as before.
   - A newer load or a transfer supersedes it: 409. Logged at info as
     `queue jump <section> -> <status>`, with no uid or uri.
   - A row gone by the time the job runs (`ErrNotAhead`): nothing of the jump
     changes, and the answer is 409 after the list's own rows are published.
     See Deviations for what is loaded then.
   - A context or autoplay row shown in a controller's order (`nextHinted`)
     gets the edits' `listsOwnOrder` check on the lane: the jump goes by the
     list's own order, and would pass over rows shown below the one tapped.
     Refused the same way (`errQueueHinted`, 409 once the list's own rows are
     published). A queued row is the list's own in any order shown.
4. **The prefetch is kept when the next song is the same**
   (`prefetchAfterEdit`, `schedulePrefetchNextAfter`). The commit of remove,
   move and top compares the uri of the first published next row before and
   after `publishUpcoming`:
   - The same: the prefetched stream, or a prefetch of it still running, is
     kept, and the timer is left alone. With the track on repeat it is always
     kept: that stream is the current song.
   - Different, or the rows before were a controller's order (which need not
     have begun with what the list plays next, the song prefetched): the
     stream is dropped (`invalidateUpcoming`) and the prefetch timer is armed
     no sooner than `editPrefetchHold` (3 s) from now. Each edit of a burst
     arms it again, so a burst opens one stream. `schedulePrefetchNext` is
     `schedulePrefetchNextAfter(0)`, unchanged for every other caller.
   - `addToQueue`, a controller's `set_queue` and the jump handle the stream
     as before.
5. **Uids for context entries without one** (`tracks/uids.go`). The list
   reads its pages through `pagesWithUids`: an entry the context hands out
   with no uid gets `enc-<page>-<song>-<n>` in a copy of the entry (the
   resolver hands out its own entries again on a refetch): `<song>` is FNV-1a
   64 of its uri (else its gid) in hex, `<n>` the copies of that song before
   it in the page. A uid Spotify gave is never changed. These uids are the
   same on a refetch, unique in the list, and without the `q` prefix
   (`highestQueueID` ignores them). Made from the song, never from the place
   alone: a context resolved again can hand out other songs in the same
   places (a like puts a song at the top of Liked Songs), and a uid matched
   before the uri (`ContextTrackComparator`, a transfer's seek) would then
   name another song, as would a rev or a jump by that uid.
   - They stay in the engine (`tracks.SpotifyUid`). The connect state pushed
     to Spotify (`buildStateRequest` → `spotifyPlayerState`) has those entries
     without a uid, as before this patch: a copy of the state is sent, and
     only when there is one to leave out. `/player/queue` and the API keep
     them. `transferContinues` compares a transfer's uid with the playing
     one as Spotify knows it.
6. **The capability**: `/status` gains `queue_ops: ["shuffled", "top",
   "jump"]` (always present; `queue_edit` stays). The spec has both routes and
   the schemas `queueTop`, `queueTopResult` and `queueJump`; the remove and
   move 400 texts no longer mention shuffle; `daemon/api_gen.go` is
   regenerated. `encorePatchLevel` is 9.

## Deviations from DESIGN-QUEUE §3

- **A jump refused on the lane.** The design has nothing change. But the jump
  is a load: it superseded what was out before it, and a step forward's walk
  ran on the list all the same, before it, while its commit never comes; a
  load that was out never lands. Left so, the player would sit on a track that
  never loads, or the state would describe a track the list has left. So the
  refusal publishes the list's current entry and loads it when it is not the
  one the state played (a step ran onto it: position 0, as a skip) or a load
  of it was out when the jump was taken (the position kept). Otherwise only
  the rows around it are published, as the design says. Either way the answer
  is 409; a step that ran onto the row tapped leaves that row playing, which
  the bridge's 409 path restarts at 0:00.
- **Hinted rows and the prefetch.** Item 4 also drops the stream when the rows
  before the edit were a controller's order, even if their first row stays.
  When the first row is the same, the timer is not touched at all.
- **`TakeAhead` returns the list's own entry**; the copy is made by the job
  (`topRow`), which is the only caller.
- `ErrShuffledContext` is removed rather than left unused.
- `API.md` is unchanged: it is upstream's, documents the websocket events and
  points to the spec for the REST routes, and no Encore patch has edited it.
  Both routes are in `api-spec.yml`.
- The jump's skip-forward event is sent only when the session has an event
  manager (always, outside the tests' players).
- Not covered, as for skipNext with a track: a jump dropped unrun by a newer
  load is answered 409 without its log line, and a jump drops a context load
  or transfer still queued before it (a load's newest destination wins).
- **Item 5's uids** are `enc-<page>-<song>-<n>`, not the design's
  `enc-<page>-<index>`, and are not pushed to Spotify (review, 2026-10-14): a
  uid by place named another song once the context was resolved again with
  an entry inserted, and the design had not checked how Spotify's clients
  and Jam service take uids they never produced.
- **The jump gets the edits' hint check** (item 3), which §3.3 does not
  list (review, 2026-10-14).

## Files

| File | Change |
|---|---|
| `tracks/tracks.go` | `shuffleEdited`; `ToggleShuffle` sorts an edited shuffled list back; `RemoveAhead`/`MoveAhead` allowed while shuffled; `TakeAhead`; `JumpAhead`; `aheadIndexOf`, `isUnqueued`, `noteShuffledEdit`; `ErrShuffledContext` removed; the pages read through `pagesWithUids` |
| `tracks/paged-list.go` | `sortByOrigin`, `moveAhead` |
| `tracks/uids.go` | new: `pagesWithUids`, `withUids`, `entrySong`, `contextUid`, `SpotifyUid` |
| `tracks/tracks_internal_test.go` | shuffled edits then shuffle off; shuffle off without edits; `TakeAhead`; `JumpAhead` (P1, P3/P4, queued, from a queued entry, not found, P2); uid fill; a made-up uid after the context is resolved again with an entry put first; `TestEditsAheadRefused` updated |
| `tracks/paged-list_internal_test.go` | `sortByOrigin`, `moveAhead` |
| `daemon/queue_edit.go` | top (`queueEditOp`, `topRow`); no shuffled refusal; `prefetchAfterEdit`, `nextUri`; `queueOps`, `editPrefetchHold`, `queueSectionAutoplay` |
| `daemon/queue_jump.go` | new: `queueJump` (with the hint check), `jumpRefused`, `logQueueJump` |
| `daemon/player_state.go` | `spotifyPlayerState`: the connect state without made-up uids |
| `daemon/controls.go` | `schedulePrefetchNextAfter` (`schedulePrefetchNext` calls it with 0) |
| `daemon/api_server.go` | `ApiRequestTypeQueueTop`, `ApiRequestTypeQueueJump`, `ApiRequestDataQueueJump`, the handlers `PlayerQueueTop` and `PlayerQueueJump` |
| `daemon/player.go` | dispatch of top and jump; `transferContinues` compares the uid Spotify knows |
| `daemon/jam.go` | `/status` `queue_ops` |
| `api-spec.yml` | `/player/queue/top`, `/player/queue/jump`, `queueTop`, `queueTopResult`, `queueJump`, `queue_ops`; the remove and move 400 texts |
| `daemon/api_gen.go` | regenerated from the spec (oapi-codegen v2.5.0); additions only |
| `daemon/queue_edit_test.go` | top; shuffled edits; the prefetch rule (the old prefetch test split in two, and a third for hints and repeat); refusals updated |
| `daemon/queue_jump_test.go` | new: the jump, also in a controller's order |
| `daemon/player_state_test.go`, `daemon/player_test.go` | made-up uids left out of the connect state; a Jam transfer against one carries the stream on |
| `daemon/api_server_test.go`, `daemon/jam_test.go` | the routes, bodies and answers; `queue_ops` |
| `cmd/daemon/encore_version.go` | `encorePatchLevel` 9 |

## Checks run (2026-10-14, on the development server, never against the live stack)

In the dev image (`encore-engine-dev:4b`, Go 1.25.10) with `--network none`,
over a staging copy of this tree (patches 1-9):
- `oapi-codegen --config=api-codegen.yml api-spec.yml`: `daemon/api_gen.go`
  comes out byte for byte as it is here.
- `gofmt -l daemon spclient dealer tracks output player session cmd` (clean).
- `go vet` of `daemon`, `spclient`, `dealer`, `tracks`, `output`, `session`
  and `cmd/daemon`, without and with `-tags "test_unit test_integration"`
  (clean).
- `go test -count=1 -tags "test_unit test_integration"` over `daemon`,
  `spclient`, `dealer`, `tracks`, `output`, `player`, `session`,
  `cmd/daemon` and the root package (ok). With `-race -count=3`: patch 9's
  tests (`-run` Queue, Jump, Top, Shuffle) with the loader's, the early
  prefetch's, the skip, transfer, Jam edit, cluster and status tests, the
  whole `tracks` package, and `cmd/daemon`'s (ok).
- The reverts, 34, one at a time in a scratch copy, each failing at least one
  test: unshuffling an edited list without the sort; edits not noted while
  shuffled; the sort losing the position, or ignoring the index in the page;
  the jump walking the history, keeping a queued entry playing, or keeping
  the queued entries before a queued target; `TakeAhead` refusing autoplay;
  uids written into the context's own entries, numbered by list position, or
  not given at all; Play Next queuing the context's entry itself, keeping its
  autoplay flag or its old uid, publishing for a row first already, skipping
  the flag check or the hint check; the prefetch always dropped, kept after a
  controller's order, dropped on repeat, not held, or not held near the end
  of a song; shuffled context edits refused again; the jump as a mutation,
  superseding nothing, never loading, or keeping the old position; a refused
  jump never loading, always loading, or forgetting a load that was out; a
  jump to the current row; `queue_ops` missing or shared; the jump's body
  unchecked. After review (2026-10-14), four more: uids by place again; the
  made-up uids pushed to Spotify; `transferContinues` comparing the engine's
  own uid; the jump without the hint check.
- `docker build -t encore-engine:queue-test .` (the repo Dockerfile), then
  `go-librespot --version` in it: `go-librespot dev (Encore patches 1-9,
  unstamped)`. Nothing else was started from it; it was not deployed.

Not run: anything against Spotify (no track was loaded, no request was sent),
the Windows build, and linux/arm64.

`ENCORE_PATCH.diff` was regenerated the same way as for patch 8 (the method
reproduced the patch 1-8 diff byte for byte first). Compared with that one,
only the sections of the files in the table above are new or changed. It
reverse-applies to this tree (`git apply -R --check`), and applied to a clean
4dbc099 it gives exactly this tree.

## Re-applying on a newer go-librespot

1. Check that `ToggleShuffle` still has the seed replay and the in-order
   refetch as its two unshuffle paths, and put the `shuffleEdited` branch
   before them. Check that `pagedListItem` still records the page and index an
   entry was loaded with, and that `removeAt`, `moveTo` and a shuffle keep
   them.
2. Check that `seekQueue` and `TrySeekTo` still drop the queued entries before
   a queued target and a queued entry playing before a context target:
   `JumpAhead` follows the same rules, by uid only.
3. Check that `skipNext` with a track is still `OnPlayerSkipForward`,
   `noteSkip`, `narrationJumped`, `loadGen++`, a class-load list job, and a
   commit of `publishSnapshot` and `loadCurrentTrack`: `queueJump` copies it.
4. Check that `schedulePrefetchNext` is still the only place that arms the
   prefetch timer, and keep `schedulePrefetchNextAfter` its body.
5. Check that the context resolver still hands out its own entries for a
   page, again on a refetch, so `withUids` copies the entries it gives a uid,
   and that `buildStateRequest` is still the only place the player state goes
   to Spotify (`spotifyPlayerState`).
6. Regenerate `api_gen.go`, raise `encorePatchLevel`, and run the checks above.

## Note for the gateway

- `/status` `queue_ops` lists `shuffled`, `top` and `jump`; an older engine has
  no `queue_ops` (and answers 404 on the two new routes). Feature-detect, and
  never send a uid to `/player/next`.
- With `shuffled`, the context's rows can be removed and moved while it is
  shuffled; shuffle off then gives the playlist's order without the songs
  removed or played next.
- `POST /player/queue/top {rev, uid}` answers `{rev, uid}`: the uid of the row
  now first in the queue (new for a context or autoplay row). 204 no list, 400
  a malformed body, 409 a stale rev, a row not upcoming, or one the edit could
  not be made against (the list's own rows are published first, as for remove
  and move).
- `POST /player/queue/jump {uid}` answers `{rev}` once the new rows are
  published, before the track has loaded (it loads from 0:00, as a skip). 204
  no list, 400 a malformed body, 409 a row not upcoming (the current one
  included) or a jump superseded. On a 409, read `/player/queue`: if
  `current.uid` is the uid, the engine had already reached the row, so
  restart it at 0:00.
- Rows of contexts that give no uid now have one, `enc-…`: opaque, like any
  uid, and it names that song (never another one in its place after the
  context is resolved again). Spotify is not told it.
- A jump to a context or autoplay row shown in a controller's order is a 409
  once the list's own rows are published, as for the edits.
- An edit no longer drops the next song's prefetch unless the next song
  changed; then its prefetch waits at least 3 s, held again by each edit.
