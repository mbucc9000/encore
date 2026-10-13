# Encore Bridge tests

The bridge's test suite. It uses Node's built-in test runner and needs no npm packages and no network: every engine,
Spotify endpoint, LRCLIB answer and phone is a stub or a fake inside the test, and every name, id, playlist and
picture in it is made up.

## Requirements

- **Node.js 22** or newer (the version the bridge runs on).
- **ffmpeg** on `PATH` for the image tests and the two end-to-end tests. Set `FFMPEG` to its full path if it is
  somewhere else. Without it those tests are reported as skipped. The image tests also use it to make their test
  pictures (`-f lavfi`), so it must be a full build; to test the Windows bundle's minimal FFmpeg
  (`gateway/windows/build-ffmpeg`, `LINUX=1`), point `FFMPEG` at a small wrapper script that sends `lavfi` runs to a
  full ffmpeg and everything else to the minimal one.
- **Linux or macOS** for the two end-to-end tests that start the real bridge (`bridge-*.test.js`): the bridge reads
  its audio from a FIFO. On Windows they are reported as skipped; everything else runs.

## Running it

From `gateway/test`:

```sh
node --test          # or: npm test
```

From the repository root (Node expands the quoted pattern itself, so this is the same in sh, PowerShell and cmd):

```sh
node --test "gateway/test/*.test.js"
```

In the bridge's Docker image, with no network at all (from `gateway/`, after `docker compose build gateway`):

```sh
docker run --rm --network none -v "$PWD:/g" -w /g/test --entrypoint node encore-gateway:local --test
```

One file: `node --test gateway/test/catalog.test.js`, or `node gateway/test/added.test.js` for the script-style
files (below). Add `--test-name-pattern="latch"` to run only the tests whose name matches.

The whole suite takes about two minutes. `bridge-jam.test.js` takes about ten more and runs only when asked:

```sh
ENCORE_SLOW_TESTS=1 node --test           # sh
$env:ENCORE_SLOW_TESTS = "1"; node --test # PowerShell
npm run test:slow                         # from gateway/test
```

`LIVE=1` makes the end-to-end tests print the bridge's own log, and `VERBOSE=1` does the same for
`context.test.js` and `profiles.test.js`.

## What is covered

| File | What it tests |
|---|---|
| `adminauth.test.js` | The admin password (first-run setup, stored hash, `ADMIN_PASSWORD`), `ADMIN_ALLOW`, proxy headers, the failure limit and the cap on parallel password hashes, Windows' code-less setup refusing a DNS-rebinding page, pairing only from allowed addresses, and logs without names |
| `catalog.test.js` | The library, playlist and Liked lists against a model of the patched engine: listing, sweeps, stalls, revisions, adds, removes, likes, ETags |
| `engine.test.js` | The engine client's status, `Retry-After` and upstream status handling |
| `image.test.js`, `image-jam.test.js` | Cover and picture resizing with ffmpeg, the host allowlist, the disk cache and its cap, Spotify Codes, the warming lanes (order, holds, 2 jobs / one ffmpeg run at a time, a search's rows replacing the last search's), ETag and 304 |
| `coverwarm.test.js` | The covers around the playing song: which songs (next 2, previous, current) from the engine's queue or `next_track`, when (after a song change or a generation start, never while one is pending, only with a phone around), one more look for missing metadata |
| `jam.test.js`, `jam-4c.test.js`, `jam-self.test.js`, `jam-wait.test.js` | Jams against a scripted engine: start, join, leave, end, members, Up Next, guests, the gate between sends, idle rules |
| `jamlink.test.js` | Every Jam link form, and short-link expansion over a fake fetch |
| `player.test.js` | Play, shuffle, the queue and taking playback over |
| `pcm-source.test.js` | Where the audio comes from: the FIFO (Docker) and the named-pipe server (Windows): backpressure, a new output session taking over once it writes, a connection that only reads never taking over |
| `webapi.test.js` | The Web API client: token refresh, the 429 gate, error mapping |
| `webapi-login.test.js` | A sign-in whose `GET /me` Spotify refuses (the account isn't under User Management) leaves the bridge not connected, or on the account it had, with nothing saved |
| `added.test.js` | Sorting a playlist by date added |
| `context.test.js` | "Playing from": each song carries its own context |
| `lyrics.test.js` | Lyrics from a fake LRCLIB, the cache and the User-Agent |
| `membership.test.js` | "Saved in": which of your playlists hold a song |
| `personal.test.js` | Home, Your Library's albums and artists, recently played, your profile, saving albums |
| `profiles.test.js` | Other people's profiles, search and follow, with a fake Spotify and web player |
| `bridge-catalog.test.js` | The real bridge (`src/main.js`) against a stub engine and a stub Spotify Web API: signed requests, the library, lists, writes, likes, gzip and ETags, and no names or tokens in its log |
| `bridge-jam.test.js` | The real bridge through whole Jams against a stub engine (slow, see above) |
| `showcase*.test.js` | The bridge's Showcase switch and its helpers for the app's Anonymous Mode |
| `wizard.test.js`, `wizard-http.test.js` | The setup guide on the admin page: what ticks each of its nine steps, a bridge that is already set up completing it by itself, skip / dismiss / finish in `data/wizard.json` (an older file still loads), the Encore repo address for step 6, step 8's tick (a signed phone request from outside the home network, never from a private address, and the address never logged or saved), its routes behind the admin password (and closed before one is chosen), the `setup` fields in the admin and launcher status, Showcase trimming, `/repo/` being an ordinary unknown path, and no names, codes, IDs or public IPs in its answers |
| `clientid.test.js` | The Spotify Client ID the setup guide saves: the `settings.env` editing cases (replace mode, the only one), `data/settings.json`, the order the bridge reads it in (environment, `settings.env`, `data/settings.json`), the save route's answers, and a log that never has the ID; also the Encore repo address (`DEFAULT_APP_REPO`, `ENCORE_APP_REPO`) |
| `netcheck.test.js` | The setup guide's network check: each problem it reports, the one read-only PowerShell run on Windows (never started here: it is replaced by a stub), nothing of its output in the log, and how long a result is reused |
| `public-ip.test.js` | The setup guide's **Find my public IP** (step 8): the three IP-check services one after another over a fake `https.get` (timeouts, HTTP errors, redirects never followed, answers that aren't a strict IPv4), IPv4 only with the bridge's User-Agent and a 4 s timer, the shared (CGNAT) and not-public warnings, Showcase refusing before anything is contacted, the admin route's rules, one lookup at a time and the reuse times, nothing written to disk, and a log that never has the IP |
| `update.test.js` | The update check (`src/update.js`) against a local fake GitHub (`support/fakegithub.js`, through the test-only `UPDATE_*` settings; the real GitHub is never contacted): the shared vectors (`fixtures/update-vectors.json`: versions, tags, parsing the signed file list, Ed25519 signatures with the RFC 8032 test keys), a newer release offered only after its signature verified, older / equal / release-candidate / prerelease / draft / malformed tags never, a development build never asking, bad signatures, a missing entry or asset, the small files fetched once per release, the ETag and 304, rate limits, the 60 s manual throttle, offline / timeout / unusable answers / refused redirects, the schedule over a simulated week, `UPDATE_CHECK=0`, a clock that goes back, the exact request headers, and a log and state file without addresses, URLs, ETags or paths |
| `update-http.test.js` | The update routes: `/admin/api/update*` behind the admin password and the cross-site check, `update` in the admin status (the same in Showcase), Docker's Check now, and on Windows the tray launcher's `POST /local/v1/update` (hidden like the other launcher routes, validated, memory only), `update_request` until handled or 2 minutes old, Update now only from the PC itself, and nothing written to the data folder |
| `admin-page.test.js` | The admin page parses, loads nothing from outside the bridge, and has the setup guide's and the Updates section's texts the guides quote; the Updates section drawn for each kind (Docker commands, the portable zip, the Windows installer's progress and errors) with links only from checked versions |
| `i18n.test.js` | The bridge's languages (`src/i18n.js`): which language a request gets (`X-Encore-Lang`, then `Accept-Language`, else English), `{name}` values and the English fallback, the modules' English messages translated on the way out, `GET /admin/i18n/<code>.json` behind the admin page's rules (setup mode too, unknown codes 404), the phone's and the admin page's messages (refusals, errors, the event log's notices, the Spotify card, the sign-in page, Showcase's device words and "Phone n") in the language asked for and English byte for byte otherwise, every `t(…)` text a literal, and the shipped dictionaries' `{names}` (with made-up dictionaries) |
| `syntax.test.js` | Every file in `src/` parses (`node --check`) |

Most files use `node:test`. Six of them (`added`, `context`, `lyrics`, `membership`, `personal`, `profiles`) and the
two `bridge-*` files are plain scripts: they print one line per check and exit with 1 on the first failure (or, for
`context` and the `bridge-*` files, after all checks with the failed ones listed), and the runner reports the file as
one test.

`support/` holds the shared pieces: in-process models of the patched engine (`engine-model.js`, `jam-engine.js`), the
stub servers for the end-to-end tests (`stub-*.js`), the fake GitHub for the update tests (`fakegithub.js`), small
helpers, and the platform checks (`platform.js`). `fixtures/` holds a synthetic rootlist and Jam session payloads in the
engine's shapes, and the update check's shared test vectors (`update-vectors.json`; the Windows launcher's tests keep a
byte-identical copy, and its keys are the RFC 8032 test keys: public test data, never trusted by a release).

Comments refer to design notes (`DESIGN-*.md`, section numbers) and milestone names. Those are the author's internal
working notes and are not part of the source release.

## Writing tests

- **Made-up data only.** No real names, usernames, ids, playlist names, covers, addresses or anything copied from a
  real account or a real capture. Use `example` hosts, the documentation address ranges (192.0.2.0/24,
  198.51.100.0/24, 203.0.113.0/24) or the private example `192.168.1.20` where an address is needed.
- **No network.** Every test must pass with `--network none`. Listen on `127.0.0.1` port `0` and read the port back.
- **No fixed paths.** Temporary files go under `os.tmpdir()` (`support/helpers.js` has `tmp()`), so the suite also runs
  on Windows.
- **Skip, don't pass.** A test that needs ffmpeg, a FIFO or a long run uses `needs()` from `support/platform.js` as
  its `skip` option.
- New test files are named `*.test.js` and sit in this folder; shared code goes in `support/`.
- A few Jam tests use short real timers. On a very busy machine, `node --test --test-concurrency=1` runs the files
  one at a time.
