# How Encore works

A map of the code for people who change it. Installing: [guide](GUIDE.md). Building and tests:
[BUILDING.md](BUILDING.md).

## The parts

```
 Spotify Web API, private services (HTTPS)          Spotify Connect, audio
              ^                                               ^
 Bridge (gateway/src, Node, ffmpeg) <---- raw PCM ----- Engine (go-librespot + Encore patches 1-8)
              |                     ---- HTTP + WS --->
              | HTTP on port 8095: signed requests, AAC stream, events
              v
 Encore app (iOS 6, app/)
```

- **App** (`app/`, Objective-C, Theos, iOS 6.1 SDK): everything the user sees. It talks only to the bridge.
- **Bridge** (`gateway/src/`, Node.js 22, no npm packages; the code calls it "gateway"): the phone's API, the AAC
  stream, the admin page, the Spotify Web API client, caches.
- **Engine** (`gateway/engine-src/`, Go, patches in `ENCORE_PATCH.md`): a Spotify Connect speaker named "Encore" that
  writes raw audio to the bridge. It also serves song lists and Jams on `127.0.0.1:3678`.
- **Tray launcher** (`gateway/windows/launcher/`, Go, Windows only): starts the bridge, shows its status, keeps the
  PC awake while a phone listens.

Docker: two containers with host networking. `docker/compose.yaml` runs the prebuilt images
(`ghcr.io/mbucc9000/encore-bridge`, `ghcr.io/mbucc9000/encore-engine`); `gateway/compose.yaml` builds them from source.
Windows: the launcher starts `runtime\node.exe gateway\src\main.js` (their interface is fixed in
[`gateway/windows/CONTRACT.md`](../gateway/windows/CONTRACT.md)). The bridge starts the engine (`supervisor.js`).

## The audio path

1. Playback starts from the app, from any Spotify app that picks the **Encore** speaker, or from a Jam.
2. The engine writes 44.1 kHz 16-bit stereo PCM into a pipe: `/pipe/encore.pcm` on Linux, a named pipe with a new
   random name each run on Windows.
3. `pcm.js` makes one clocked stream (up to 10 s ahead at home, 20 s away) and fills pauses with silence.
4. `encoder.js` runs one ffmpeg AAC encoder per tier (320, 256, 160, 96 kbps) and keeps about 75 s of each in memory.
5. `stream.js` serves `GET /v1/stream`. Every play, skip or seek starts a new generation.
6. The app's `ENStreamPlayer` plays it with `AudioQueue` and reports what it hears (`POST /v1/player/heard`).
7. When nobody listens for 45 seconds, the bridge pauses the engine (Jams have their own rules).

## The phone's API (`http.js`, port 8095)

- **Pairing:** the admin page makes a six-digit code (5 minutes, once). `POST /v1/pair` trades it for a device id and
  a secret, kept in the iOS Keychain. Only `ADMIN_ALLOW` addresses can pair.
- **Signing:** every request carries `X-Encore-Device`, `X-Encore-Time` and `X-Encore-Sig` (an HMAC, see `auth.js`).
  The bridge answers 401 only for "this phone isn't paired".
- **Routes:** `/v1/status`, `/v1/player/*`, `/v1/stream`, `/v1/events` (long-poll), the catalog, Home, profiles,
  lyrics, covers, Jams, `/v1/diag`. Catalog answers have an ETag and gzip; the app caches them (`ENCatalog`).
- **Reachability:** `GET /` starts with `Encore gateway`. The app tries Home (1.5 s), then Away (6 s).

## Where the bridge gets its data

- The engine's local API: playback, song lists, Liked Songs, Jams (`engine.js`, `player.js`, `catalog.js`, `jam.js`).
- The Spotify Web API through the user's own developer app (PKCE, no secret): library, search, Home, edits
  (`webapi.js`: one queue, a 429 gate). Private Spotify services: other people's profiles (`social.js`).
- LRCLIB for lyrics (`lyrics.js`); Spotify's image servers for covers, resized with ffmpeg (`image.js`).

## The admin page and setup guide

- `admin.html` is served at `/admin` and calls `/admin/api/*`. `adminauth.js` guards it: `ADMIN_ALLOW`, no proxied
  requests, the password (`ADMIN_PASSWORD` or `data/admin.json`), a lockout, same-origin JSON writes.
- The setup guide: `wizard.js` (`GET /admin/api/wizard`, progress in `data/wizard.json`), `clientid.js` (saves the
  Client ID), `netcheck.js` (network check, **Find my public IP**).
- The Encore repo address is `DEFAULT_APP_REPO` in `config.js` (`ENCORE_APP_REPO` overrides it).
- `showcase.js` hides names and ids on the admin page while Showcase is on. Anonymous Mode lives only in the app
  (`ENAnon`) and masks names, pictures and devices when drawing.

## Updates

- One check a day; nothing installs without the user. `UPDATE_CHECK=0` turns the automatic check off.
- Windows: the tray launcher asks (`launcher/internal/update`) and tells the bridge. Elsewhere the bridge asks
  (`update.js`): `GET https://api.github.com/repos/mbucc9000/encore/releases/latest`, no cookies, no token.
- Only a newer `vX.Y.Z` release whose signed file list verifies against the embedded keys (`gateway/src/updatekeys.js`
  and `launcher/internal/update/keys.go`, identical) is offered.
- Windows **Update now** downloads the installer to `%LOCALAPPDATA%\Encore\updates\<version>\`, checks it again and
  runs it with `/ENCOREUPDATE=1`. Zip and Docker installs only get a link or the commands.

## State

| What | Where (on Windows inside `%LOCALAPPDATA%\Encore`, or `ENCORE_HOME`) |
|---|---|
| Phones, Web API sign-in, admin password | `data/devices.json`, `data/tokens.json`, `data/admin.json` |
| Showcase, setup guide, Jam, last song | `showcase.json`, `wizard.json`, `jam.json`, `last.json` in `data/` |
| Caches (safe to delete), phone logs | `data/cache/`, `data/diag/` |
| Update check | `data/update.json` (Docker), `update.json` in the data folder (Windows) |
| Engine sign-in | `engine/state.json` |
| Settings | `.env` and `data/settings.json` (Docker), `settings.env` (Windows) |
| App settings, pairing secret | the phone's `Preferences` and `Caches` folders, the Keychain |
