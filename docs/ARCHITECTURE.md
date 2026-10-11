# How Encore works

This page is for people who want to read or change Encore's code. It describes the three parts, how audio and data move
between them, and where state is kept. The [guide](GUIDE.md) covers installing and using Encore, and
[BUILDING.md](BUILDING.md) covers building it.

## The parts

```
                    Spotify (Web API, Spotify Connect, private services)
                       ^                          ^
                       | HTTPS                    | Spotify's own protocol
                       |                          |
 +---------------------|--------------------------|-------------------+
 | Encore Bridge       |                          |     home computer |
 |  gateway/src (Node) +------- HTTP + WS --------+ engine            |
 |                     |   127.0.0.1:3678         | (go-librespot     |
 |                     <------ raw PCM -----------+  + patches 1-6)   |
 |  ffmpeg x 4 (AAC)   |   FIFO (Linux) or                            |
 |                     |   named pipe (Windows)                       |
 +---------------------+----------------------------------------------+
                       |
                       | HTTP on port 8095: signed requests, AAC stream, long-poll events
                       v
               Encore app (iOS 6, app/)
```

| Part | Where | Language | Job |
|---|---|---|---|
| **App** | `app/` | Objective-C (Theos, iOS 6.1 SDK) | Everything the user sees: lists, Now Playing, Jam, Settings, Anonymous Mode. It talks only to the bridge. |
| **Bridge** | `gateway/src/` | Node.js 22, no npm packages | The phone's API, the AAC stream, the admin page, the Spotify Web API client, caches. The code calls it "gateway". |
| **Engine** | `gateway/engine-src/` | Go | go-librespot with Encore's patches: a Spotify Connect speaker named "Encore" that decodes music and writes raw audio to the bridge. It also serves song lists and Jam sessions to the bridge. |
| **Tray launcher** (Windows only) | `gateway/windows/launcher/` | Go | Starts the bridge without a console, shows its status in the notification area, keeps the PC awake while a phone listens. |

On Docker the bridge and the engine are two containers with host networking (`gateway/compose.yaml`). On Windows the
launcher starts the bridge (`runtime\node.exe gateway\src\main.js`) and the bridge starts the engine as its own child
process (`gateway/src/supervisor.js`).

## The audio path

1. Something starts playback: the app (`POST /v1/player/play` and friends), any Spotify app that picks the **Encore**
   speaker, or a Jam.
2. The engine decodes the song and writes 44.1 kHz, 16-bit stereo PCM (`s16le`) into a pipe: a FIFO on Linux
   (`/pipe/encore.pcm`), or on Windows a named pipe that the bridge serves under a new random name every run (engine
   patch 6; only a connection that writes is ever taken as the engine's, so another program that opens the pipe to
   read can't take the stream over). A full pipe blocks the engine's writes, which is what paces playback.
3. `pcm.js` turns that pipe into one clocked stream of samples. It lets real audio run up to a "lead" ahead of what the
   phone has heard (10 s at home, 20 s away, as the phone asks), fills pauses with silence, and freezes while the phone
   stalls.
4. `encoder.js` runs one ffmpeg AAC-LC encoder per quality tier (320, 256, 160 and 96 kbps) and keeps about 75 seconds
   of each in memory. Frames are numbered the same way in every tier, so a phone can switch quality between two frames.
   Nothing is written to disk.
5. `stream.js` serves `GET /v1/stream`: a small header, then records of ADTS AAC frames, track metadata, positions and an
   end-of-generation mark. Every play, skip or seek starts a new **generation**; the phone reopens the stream with the
   new number, and a phone that loses its connection resumes from the next frame number.
6. On the phone, `ENStreamPlayer` parses the records and plays the AAC through `AudioFileStream` and `AudioQueue`
   (iOS decodes AAC in hardware). It reports what it actually hears (`POST /v1/player/heard`), and the bridge passes
   the resulting delay to Spotify (engine patch 1), so other Spotify apps show the position the phone really plays.

When nobody listens for 45 seconds while music plays, the bridge pauses the engine (Jams have their own rules).

## The phone's API

All phone requests go to the bridge on port 8095 (`gateway/src/http.js`).

- **Pairing.** The admin page makes a six-digit code (valid 5 minutes, once). `POST /v1/pair` trades it for a device id
  and a random secret, which the app keeps in the iOS Keychain. The bridge answers pairing only from `ADMIN_ALLOW`
  addresses, because that reply is the only time the secret crosses the network.
- **Signing.** Every later request carries `X-Encore-Device`, `X-Encore-Time` and
  `X-Encore-Sig = HMAC-SHA256(secret, METHOD \n PATH?QUERY \n TIME \n SHA256(body))`. Unknown devices and bad or stale
  signatures get 401 (`auth.js`). Apart from a wrong pairing code, the bridge never answers 401 for anything else, because
  the app takes it to mean
  "this phone isn't paired any more" (after one retry with the bridge's clock, in case the phone's clock is off).
- **Routes.** `/v1/status`, `/v1/player/*`, `/v1/stream`, `/v1/events` (a long-poll of player, Jam and notice events),
  the catalog (`/v1/playlists`, `/v1/liked`, `/v1/albums/<id>`, `/v1/artists/<id>`, `/v1/search`, `/v1/library`),
  Home and Library (`/v1/home`, `/v1/recent`, `/v1/me…`), profiles (`/v1/users/<id>…`, `/v1/search/users`), lyrics
  (`/v1/lyrics`), cover pictures (`/v1/img/<token>`), Jams (`/v1/jam…`) and phone diagnostics (`/v1/diag`).
- **Caching.** Catalog answers are JSON with an ETag and gzip; the app sends `If-None-Match` and keeps its own disk copy,
  so screens draw from cache first and then refresh (`ENCatalog`).
- **Reachability.** `GET /` answers two plain lines starting with `Encore gateway`. The app's route check (`ENGateway`)
  tries the Home address (1.5 s timeout), then the Away address (6 s).

## Where the bridge gets its data

| Source | Used for | Code |
|---|---|---|
| The engine's local API (`127.0.0.1:3678`, HTTP and a `/events` WebSocket; it refuses requests a browser sends from another website, patch 6) | Playback commands and state, song lists of playlists, albums and Liked Songs (engine patch 2), Jams (patches 3-5), the device-code sign-in | `engine.js`, `player.js`, `catalog.js`, `jam.js` |
| The Spotify Web API, through the user's own developer app (OAuth PKCE, no client secret) | The library list, search, Home, saved albums, follows, playlist edits, what plays on other devices | `webapi.js`, `catalog.js`, `personal.js`, `membership.js` |
| Private Spotify services, with the engine's token | Other people's profiles, people search, following people | `social.js` |
| LRCLIB | Synced lyrics | `lyrics.js` |
| Spotify's image servers | Cover art and profile pictures, resized with ffmpeg and cached on disk (512 MB cap) | `image.js` |

`webapi.js` sends every Web API request through one queue (at most two at a time) and a 429 gate: when Spotify asks for
a pause, nothing reaches it until the pause is over, and the phone sees saved copies meanwhile.

## The admin page

`gateway/src/admin.html` is one static page served at `/admin`. It calls `/admin/api/*` for status, pairing codes, the
Spotify sign-in, the engine sign-in card, the Jam check, cache flushes and the Showcase switch. `adminauth.js` guards
it: the `ADMIN_ALLOW` address list (private ranges by default), refusal of proxied requests, HTTP Basic auth against
`ADMIN_PASSWORD` or a salted scrypt hash in `data/admin.json` (chosen on first run with a setup code from the log), a
lockout after repeated wrong passwords (with only a few password hashes running at once), and JSON-only writes from
the page's own origin. On Windows the first password can be chosen without the code only from a page opened at a
loopback address on the bridge's own computer, never from a website that reaches it by DNS rebinding. `showcase.js` trims names,
ids and other devices out of the admin answers while Showcase is on; the phone's API is never trimmed.

The page also holds the **setup guide**, the step-by-step first setup (`wizard.js`). It polls `GET /admin/api/wizard`
for each step's state, computed from the same sources as the cards, and keeps its own progress in `data/wizard.json`.
`POST /admin/api/wizard/client-id` saves the Client ID (`clientid.js`: into `settings.env` where there is one, else
`data/settings.json`) and applies it at once through `webapi.setClientId`. `GET /admin/api/wizard/network` is a
read-only network check (`netcheck.js`; on Windows one fixed PowerShell script in a hidden window).
`POST /admin/api/wizard/public-ip` finds the home's public IP for step 8's Away address, only when the user presses
**Find my public IP** (`netcheck.js`: three HTTPS IP-check services in turn, IPv4, 4 s each; the answer kept in memory
for 30 s, never logged or written; refused while Showcase is on). All four are admin routes with the same guards as the
rest. Step 8's tick comes from `http.js`: the first signed phone request from a non-private address sets
`away_seen_at` in `data/wizard.json` (the address itself is never kept).

The bridge doesn't serve the app: phones install it from the Encore repo in Cydia. Its address is one constant,
`DEFAULT_APP_REPO` in `config.js` (`ENCORE_APP_REPO` overrides it for forks); the setup guide and the Phone setup card
show it.

## Anonymous Mode

Anonymous Mode lives entirely in the app (`ENAnon`). The model getters mask at display time: names become stable
made-up first names (chosen by an HMAC of the person's id with a random per-install salt), pictures become initials,
devices become their kind, and your own playlists can become "My Playlist #n". Because the real values stay in the
models and caches, the switch works on cached screens and on a cold launch, and turning it off brings everything back.
The bridge only helps: it sends each remote device's type and the member id in Jam events, so the app can mask without
guessing.

## The Windows bridge

- `config.js` picks the Windows defaults: the data folder `%LOCALAPPDATA%\Encore` (or `ENCORE_HOME`) with
  `settings.env`, `data\`, `engine\` and `logs\`; the named-pipe audio source; the bundled ffmpeg; and an engine the
  bridge runs itself.
- `supervisor.js` copies the engine's `config.yml` from a template once, checks `encore-engine.exe --version` against
  the bridge's version, starts the engine without a console and with the pipe and a loopback-only API on its command
  line, restarts it with a back-off, and cleans its log lines (names, sign-in codes and the user's folder removed).
- The launcher and the bridge talk over stdin (`quit`) and loopback routes (`/local/v1/status`, `/shutdown`,
  `/showcase`, and `/update` for the update view) that need a per-start token. The status carries `setup.complete`, so
  the launcher opens the setup guide until setup is done. The interface is fixed in
  [`gateway/windows/CONTRACT.md`](../gateway/windows/CONTRACT.md).
- The launcher puts the bridge, the engine and ffmpeg in one Windows job object, so they all end with it.

## Updates

The bridge looks for a new Encore release once a day; it never installs anything without the user. The design is the
same on every platform, and only one side asks GitHub:

- **Who asks.** On Windows the tray launcher (`gateway/windows/launcher/internal/update`); the bridge there makes no
  request of its own, keeps the launcher's view in memory (`POST /local/v1/update`), and hands the admin page's
  **Check now**, **Update now** and **Cancel** back to the launcher as `update_request` in `/local/v1/status`. On Docker
  and other installs the bridge itself (`gateway/src/update.js`). The kind of install decides what the user is offered:
  `windows-installer` (the installer's uninstall entry points at the launcher's own folder), `windows-zip`, `docker`
  or `other`.
- **The request.** `GET https://api.github.com/repos/mbucc9000/encore/releases/latest` with only `User-Agent:
  EncoreBridge/<version>`, GitHub's fixed `Accept` and API-version headers, and, when stored, an ETag that looks like a
  content hash. No query string, no cookies, no token. At most one automatic request a day (the first evaluation ten
  minutes after start, then every 30 minutes; offline means another try after an hour), manual checks throttled to one
  a minute, and none at all with `UPDATE_CHECK=0` (manual checks still work) or in a development build.
- **What counts.** Only a `v<major>.<minor>.<patch>` tag that is newer than the running version, neither a draft nor a
  prerelease; `-rc` tags never. Nothing else from the answer is used, shown or stored except the publish time and the
  assets' names, sizes and ids.
- **Verified before announced.** Download links are built from constants
  (`https://github.com/mbucc9000/encore/releases/download/v<version>/<asset>`), with redirects allowed only to
  `github.com` and `*.githubusercontent.com`. `SHA256SUMS.txt` and `SHA256SUMS.txt.sig` are fetched, the Ed25519
  signature is checked against the embedded trust list (`gateway/src/updatekeys.js` and
  `launcher/internal/update/keys.go`, identical, at most three keys), the list is parsed strictly, and it must name this
  kind's asset for that version. Only then is the version shown; a release that fails is never offered.
- **Windows: Update now.** The launcher downloads the installer into `%LOCALAPPDATA%\Encore\updates\<version>\`
  (resumable), verifies the signature again, hashes the installer through a handle that no other process can write to or
  delete through, and starts it with `ShellExecuteEx` (verb `open`: the installer elevates itself, so Windows shows the
  UAC prompt and Setup still knows the signed-in user) and
  `/SILENT /SUPPRESSMSGBOXES /NORESTART /SP- /NOCANCEL /ENCOREUPDATE=1 /LOG=…`. Setup asks the launcher to quit, replaces the
  program folder, keeps the data folder and the Start with Windows choice, and starts the launcher again with
  `--updated`, or with `--update-failed` when it stopped the bridge but didn't finish.
- **Zip and Docker.** No download and no installer: the tray and the admin page link to the release page; the Docker
  card shows the commands to update, with the archive's SHA-256 from the verified list.
- **Admin routes.** `GET /admin/api/update` (also `update` in `/admin/api/status`) and
  `POST /admin/api/update/check`, `…/install` and `…/cancel`, behind the same guards as every admin route. **Update
  now** from the page is accepted only from the bridge's own computer, where the UAC prompt appears.
- **Logs and state.** Log lines carry versions and error codes only, never URLs beyond host names, addresses, ETags or
  GitHub's answers. State: `update.json` in the data root (Windows: the launcher's; Docker: `data/update.json`).
- **Tests** run against a local fake GitHub; nothing in the test suites contacts GitHub. The release scripts sign
  `SHA256SUMS.txt` ([BUILDING.md](BUILDING.md#release-signing)).

## State

| What | Where (Docker / Windows) | Notes |
|---|---|---|
| Paired phones | `data/devices.json` | Device id, name, secret, last contact. File mode 600. |
| Web API sign-in | `data/tokens.json` | Refresh token and the account's name and id |
| Admin password | `data/admin.json` | Salted scrypt hash |
| Showcase switch | `data/showcase.json` | |
| Client ID saved by the setup guide | `settings.env` (Windows) / `data/settings.json` (Docker) | Read after the environment and `settings.env` |
| Setup guide progress | `data/wizard.json` | Skipped steps, closed or finished, when a phone first came in from outside and when music first played; no names, addresses or codes |
| Jam access, last playback | `data/jam.json`, `data/last.json` | |
| Caches | `data/cache/` | Lists, covers, profiles, lyrics. Safe to delete. |
| Phone diagnostics | `data/diag/` | Rotated at 4 MB per phone |
| Update check | `data/update.json` / `update.json` and `updates\<version>\` in the data folder (written by the launcher) | Times, versions, asset ids and sizes, checksums, a content-hash ETag, error codes; the downloaded installer and its log |
| Engine sign-in | `engine/state.json` | The engine's own file |
| Settings | `.env` / `settings.env` | `settings.env` is read by the bridge itself on Windows; the environment wins over it |
| App settings and caches | the phone's `Preferences` and `Caches` folders, the Keychain | Pairing secret in the Keychain |

State files are written to a temporary file and renamed into place (retried on Windows while a scanner holds the old
file).

## Tests

`gateway/test/` holds the bridge's suite: unit tests per module against in-process models of the patched engine, stub
Spotify servers and fake phones, plus end-to-end tests that start the real `main.js`. Every name and id in it is made
up. See [BUILDING.md](BUILDING.md#tests).
