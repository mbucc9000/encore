# Changelog

All notable changes to Encore are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/).

Since the first public release, the **Encore app** and the **Encore Bridge** share one version number. Keep them on the
same version, and update the bridge first.

Features marked *(private API)* depend on undocumented Spotify interfaces and may stop working if Spotify changes them.

## [1.1.0] - 2026-10-11

The first public release. App and bridge are built fresh from the published source.

### Added

- **Setup guide** on the bridge's admin page: nine steps from a freshly installed bridge to the first song (protect
  the admin page with a password, create your own Spotify developer app with a **Copy** button for every value, save
  its Client ID, connect your Spotify account, sign the engine in, check your network, put Encore on the phone from the
  Encore repo, pair it, listen away from home, play a song). Each step ticks itself off as it happens. The Windows
  installer opens it at the end; on Docker it shows on the first visit to the admin page. The **Setup guide** button
  on the admin page (and **Setup guide…** in the Windows tray menu) reopens it at any time. A bridge that is already
  set up is never pushed through it, and Showcase hides its addresses, codes, Client ID and public IP.
- **The Client ID without a text editor:** the setup guide checks the Client ID, saves it (Windows: in `settings.env`;
  Docker: in `data/settings.json`) and uses it at once, without a restart. A Client ID in the environment (Docker's
  `.env`) still wins. Changing it later asks first, because it disconnects the Spotify account.
- **Listen away from home**, a step of its own in the setup guide: how to forward TCP 8095 on your router (with this
  computer's home-network address to forward to, and a reminder to reserve it), a **Find my public IP** button that
  builds the Away address to type into Encore, and a check that ticks when a paired phone gets in from outside the home
  network. It warns when the public IP is a shared (carrier-grade NAT) or non-public address. The bridge asks a public
  IP-check service only when the button is pressed (with a generic User-Agent), keeps the answer in memory only, for
  30 seconds, never logs it, and refuses while Showcase is on. The admin page's **Phone setup** card has a **Listen away from home** button for later.
- **The Encore repo:** the app is installed from the Encore repo in Cydia (`https://mbucc9000.github.io/slopkit/`),
  and its updates come from there too. The setup guide's step 6 and the **Phone setup** card show the address.
  `ENCORE_APP_REPO` changes the address they show, for forks.
- **Network check** in the setup guide: the bridge's address on the home network and whether it answers there; on
  Windows also the network profile (Public or Private) and Windows Firewall, read-only, with what to do about each
  problem.
- **Anonymous Mode** (Settings → Privacy): hides your name and picture, other people's names and pictures (stable
  made-up names and initials; real pictures aren't even downloaded), follower counts, other people's playlist
  descriptions, device names, bridge addresses, the device id and the Jam invite (behind **Show Invite**), while the
  music stays visible. Bridge messages that would name someone are replaced by the app's own wording. Optional **Hide
  My Playlist Names** renames your own playlists **My Playlist #n** and hides their descriptions and folders. Blends
  show as **Blend**.
- **Showcase** switch on the bridge (admin page header and the Windows tray's **Showcase mode**): hides your Spotify
  name, phone names and ids, other devices' names and the bridge's address on the computer's screen, shows the pairing
  and sign-in codes as dots (press and hold to see them), and refuses phone diagnostics. It stays on across restarts.
- **Encore Bridge for Windows** 10/11 (x64): installer and portable zip with a tray program, its own Node.js 22, the
  engine, and a minimal LGPL build of FFmpeg made for Encore (only AAC encoding and cover conversion; its source ships
  in the GPL source bundle). The installer adds the **Encore Bridge (phone)** firewall rule for TCP 8095 on Private and
  Domain networks, and its last page offers **Start Encore Bridge and open the setup guide**; it asks nothing about
  Spotify (the setup guide does).
  The tray shows the status and the phone's Home address, and has **Setup guide…**, Start with Windows, Keep this PC
  awake while streaming (on by default), Showcase mode, and a Troubleshooting menu (logs, settings, data folder, **Fix
  firewall…**, restart).
- On Windows, the bridge catches the Spotify sign-in's return address itself, so connecting the account from a browser
  on the same PC needs no copy and paste.
- **3.5-inch devices:** iPhone 4, iPhone 4S and iPod touch (4th generation) on iOS 6, besides the iPhone 5 and iPod touch
  (5th generation), with launch images for both screen sizes.
- **iOS 5:** the app also runs on iOS 5.0 to 5.1.1 (iPhone 3GS, 4 and 4S, iPod touch 3rd and 4th generation); iOS 6
  behaves exactly as before. Not tested on a real iOS 5 device yet.
- **Engine sign-in** card on the admin page, and sign-in with a code approved on Spotify's website (the Windows
  default; Docker keeps discovery and can switch to the code).
- **First-run admin password:** choose it in the setup guide's first step, with a one-time setup code from the bridge's
  log (no code needed on the Windows PC itself). It is stored as a salted hash in `data/admin.json`.
- **Phone setup** card on the admin page showing the address to type into the app and the Encore repo's address.
- `/v1/status` reports the bridge's name, its version and the oldest app version it serves.
- The bridge's **test suite** (`gateway/test`), with made-up test data.
- Engine **patch 6**: a Windows named-pipe audio output and an Encore version stamp (`encore-engine.exe --version`), so
  the engine runs natively on Windows and the bridge only starts a matching engine. As 6b, the interactive sign-in's
  callback listens on 127.0.0.1 only on Windows.
- Jam QR codes on Windows through a built-in QR encoder (Docker keeps `qrencode`, and falls back to the built-in one
  when it is missing).
- **Update check for the bridge:** once a day, and when you choose **Check for updates** in the Windows tray menu or
  **Check now** on the admin page, Encore Bridge asks GitHub for the newest Encore release. It sends nothing but
  `EncoreBridge/<version>`. A newer final version is announced only after its signed checksum list checks out: in the
  Windows tray menu (**Encore Bridge … is available**) and on the admin page (a banner and a new **Updates** section).
  Release candidates and older versions are never offered. `UPDATE_CHECK=0` turns the daily check off.
- **Update now on Windows:** downloads the new installer from GitHub, checks it, and runs it once you approve Windows'
  permission prompt. The installer upgrades in place, keeps everything in `%LOCALAPPDATA%\Encore` and your **Start
  with Windows** choice, and starts Encore Bridge again (the old version, if the update doesn't finish). The portable
  zip gets the notice with a download link and the new zip's checksum; on Docker the admin page shows the exact
  commands to update, with the archive's checksum (a container never updates itself).

### Changed

- The server part is called **Encore Bridge** everywhere you see it (code and folder names keep "gateway").
- **Faster skipping:** the engine starts loading the next song a few seconds into the current one, and the bridge
  prepares the covers around the current song, so swiping to the next or previous song on Now Playing starts it
  and shows its cover sooner.
- Docker: `.env` is optional (Docker Compose 2.24 or newer). The setup guide asks for the admin password and the Client
  ID.
- Without a Client ID, the admin page's **Spotify account** card and the bridge's log point to the setup guide instead
  of asking you to edit a settings file and restart.
- The tutorial is now two short tutorials, for Windows and for Docker, built around the setup guide.
- Listening away from home: the guide now puts forwarding one port on your router first (set up in the setup guide's
  step 8), with the iPhone's built-in VPN as the encrypted alternative.
- One message, **Update your Encore Bridge.**, replaces the app's per-feature "update the gateway" messages.
- The setup screen's subtitle and the About section say Encore is an unofficial Spotify client, not made by,
  affiliated with or endorsed by Spotify.
- New installs start with **empty** Home and Away addresses; the app opens Setup until it is paired and has a Home
  address.
- The admin page only answers addresses on an allow-list (`ADMIN_ALLOW`; default: private ranges, loopback,
  `100.64.0.0/10` and the IPv6 local ranges), refuses admin requests that come through a proxy, locks an address out
  for 15 minutes after 10 wrong passwords (only a few password checks run at once), and only accepts changes sent by
  the admin page itself. On Windows, choosing the first password without a code works only on the bridge's own
  computer, never from a website that reaches it.
- The engine's control API (on the bridge's own computer only) refuses requests that a web page sends from another
  site.
- Bridge logs show whether a phone streamed from home or away, never its address.
- **Pairing only works from the home network** (the allow-list), so a phone's key never crosses the internet.
- Bridge logs never contain the names of people, devices or songs, in any mode. On Windows the engine's log lines are
  cleaned the same way before they reach the bridge's log.
- The bridge exits with a clear message when its port is taken or not allowed, or a setting is invalid, instead of
  running without a web server.
- Developer Jam tools (Fake Jam, flags, trace) moved into an **Advanced** section of the admin page (`?dev=1`).
- Docker: the engine uses its built-in discovery by default; using the host's avahi-daemon is now an option.
- The fake Jam's own member shows your Spotify name, or "You".
- The lyrics requests identify themselves as `Encore/<version>`.

### Removed

- The unused `ugc-image-upload` permission from the Spotify sign-in.
- The **Open Spotify Links** setting is hidden until the companion EncoreLinks tweak is released.

### Security

- **Signed checksums:** every release has `SHA256SUMS.txt.sig`, an Ed25519 signature over `SHA256SUMS.txt`. Encore
  Bridge and its Windows tray program have Encore's public release key built in, and never offer or run an update whose
  signature or checksum doesn't match. The README and the guide show how to check a download by hand with OpenSSL.

## Before the public release

Encore was developed in private builds (app up to 1.0.0, bridge up to 0.10.3). None of them were distributed, and
none ever will be. The main steps were:

- **App 1.0 / bridge 0.10:** a restyled app with iOS 6 green chrome everywhere, a new Now Playing (swipe the cover to
  skip, everything on one bottom bar), Up Next on the flip side, a Listening-on bar, a real Settings screen, Text
  Size, and **profiles**: search people, open anyone's profile and playlists, follow people *(private API)*.
  "Playing from …" opens its source.
- **0.9:** save albums, pin playlists to the top, a "Saved in" sheet that adds a song to several playlists at once,
  Remove from This Playlist, sorting by title, artist, album and date added.
- **0.8:** synced lyrics on Now Playing, from LRCLIB.
- **0.7:** the Home tab built from your listening, a full Library (Liked Songs, Albums, Artists, Recently Played) and
  your profile.
- **0.6:** **Spotify Jam**: start, join, invite by QR code or message, Up Next, guest controls *(private API)*.
- **0.5:** browsing: playlists, albums, artists, search, likes and swipe-to-queue, with song lists from the engine
  *(private API)*.
- **Earlier:** the streaming player (AAC over HTTP with lock-screen, headphone and AirPods controls and background
  audio), pairing with signed requests, the admin page and Spotify Connect take-over.

### Engine

The engine is go-librespot at upstream commit `4dbc099` with Encore's patches:

1. **Output delay:** Spotify apps show the song and position the phone actually hears, despite the stream's buffer;
   controls never wait for a full audio pipe.
2. **Catalog API:** cheaper playlist and library listings with revisions, and shuffle on play.
3. **Jams:** the social-connect service, Jam events, the Jam's end, Up Next edits.
4. **Jam host activation** and diagnostics.
5. **Jam self-activation.**
6. **Windows named-pipe output and the engine's version stamp** (new in 1.1.0), with 6b: the interactive login's
   callback on loopback on Windows.

Details are in `gateway/engine-src/ENCORE_PATCH.md`; the complete change is `gateway/engine-src/ENCORE_PATCH.diff`.
