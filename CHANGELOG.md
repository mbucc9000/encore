# Changelog

All notable changes to Encore are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/).

Since the first public release, the **Encore app** and the **Encore Bridge** share one version number. Keep both on the
same version, and update the bridge first.

Features marked *(private API)* depend on undocumented Spotify interfaces and may stop working if Spotify changes them.

## [1.2.1] - 2026-10-13

### Added

- **Windows: the admin page opens at every start.** Each time Encore Bridge starts (the Start menu, Start with
  Windows, or after an update), the admin page opens in your browser once the bridge is ready. It's one tab: on a new
  install it is the setup guide. Starting Encore Bridge again while it runs brings the page up too. To turn it off,
  untick **Open admin page on start** in the tray menu.

### Fixed

- Windows: **Update now** always installs the newest release (it asks GitHub again first).

## [1.2.0] - 2026-10-13

### Added

- **The app in 12 more languages:** Spanish, Portuguese (Brazil), French, German, Italian, Dutch, Polish, Russian, Turkish, Japanese, Korean and Chinese (Simplified). Pick it in Encore's **Settings → Appearance → Language**; it switches at once.
  **Automatic** follows the phone's language. Song, playlist and artist names stay as Spotify sends them.
- **The bridge in the same 12 languages:** the admin page and its setup guide (pick the language at the top of the
  page), the messages the bridge sends to the app (in the app's language), and on Windows the tray menu and the
  installer.

### Changed

- **A shorter guide:** `docs/GUIDE.md` starts with a short install path and is about a third shorter.
- The bridge's update messages say "signed by Encore" and no longer talk about checksums.

## [1.1.1] - 2026-10-11

### Changed

- The admin page's **Updates** card is simpler: the Docker commands are shorter, and the Windows zip text just says
  where to download it. The bridge still checks each release's signature before it offers it.
- The docs are shorter and plainer, and no longer ask you to check downloads by hand.
- The README says up front that Encore was vibecoded with Claude Opus.

## [1.1.0] - 2026-10-11

The first public release. The app and the bridge are built fresh from the published source.

### Added

- **Setup guide** on the bridge's admin page: nine steps from a fresh bridge to the first song (protect the admin page
  with a password, create your own Spotify developer app with a **Copy** button for every value, save its Client ID,
  connect your Spotify account, sign the engine in, check your network, put Encore on the phone from the Encore repo,
  pair it, listen away from home, play a song). Each step ticks itself off. The Windows installer opens the guide at the
  end; on Docker it opens on the first visit to the admin page. The **Setup guide** button on the admin page and
  **Setup guide…** in the Windows tray menu reopen it. A bridge that is already set up is never pushed through it.
  Showcase hides its addresses, codes, Client ID and public IP.
- **Client ID without a text editor:** the setup guide checks the Client ID, saves it (Windows: `settings.env`;
  Docker: `data/settings.json`) and uses it at once, without a restart. A Client ID in the environment (Docker's
  `.env`) still wins. Changing it later asks first, because it disconnects the Spotify account.
- **Listen away from home**, its own step in the setup guide: how to forward TCP 8095 on your router (with this
  computer's home-network address and a reminder to reserve it), a **Find my public IP** button that builds the Away
  address for Encore, and a check that ticks when a paired phone connects from outside the home network. It warns when
  the public IP is shared (carrier-grade NAT) or not public. The bridge asks a public IP-check service only when the
  button is pressed (with a generic User-Agent). It keeps the answer in memory only, for 30 seconds, never logs it, and
  refuses while Showcase is on. The admin page's **Phone setup** card has a **Listen away from home** button for later.
- **The Encore repo:** the app installs and updates from the Encore repo in Cydia
  (`https://mbucc9000.github.io/slopkit/`). The setup guide's step 6 and the **Phone setup** card show the address.
  `ENCORE_APP_REPO` changes the address they show, for forks.
- **Network check** in the setup guide: the bridge's home-network address and whether it answers there. On Windows also
  the network profile (Public or Private) and Windows Firewall, read-only, with what to do about each problem.
- **Anonymous Mode** (Settings → Privacy): hides your name and picture, other people's names and pictures (stable
  made-up names and initials; real pictures aren't downloaded), follower counts, other people's playlist descriptions,
  device names, bridge addresses, the device id and the Jam invite (behind **Show Invite**). The music stays visible.
  Bridge messages that would name someone are replaced by the app's own wording. Optional **Hide My Playlist Names**
  renames your own playlists **My Playlist #n** and hides their descriptions and folders. Blends show as **Blend**.
- **Showcase** switch on the bridge (admin page header and the Windows tray's **Showcase mode**): hides your Spotify
  name, phone names and ids, other devices' names and the bridge's address on the computer's screen. It shows the
  pairing and sign-in codes as dots (press and hold to see them) and refuses phone diagnostics. It stays on across
  restarts.
- **Encore Bridge for Windows** 10/11 (x64): installer and portable zip with a tray program, its own Node.js 22, the
  engine, and a minimal LGPL build of FFmpeg made for Encore (only AAC encoding and cover conversion; its source ships
  in the GPL source bundle). The installer adds the **Encore Bridge (phone)** firewall rule for TCP 8095 on Private and
  Domain networks. Its last page offers **Start Encore Bridge and open the setup guide**. It asks nothing about Spotify
  (the setup guide does).
  The tray shows the status and the phone's Home address. Its menu has **Setup guide…**, Start with Windows, Keep this
  PC awake while streaming (on by default), Showcase mode, and a Troubleshooting menu (logs, settings, data folder,
  **Fix firewall…**, restart).
- On Windows, the bridge catches the Spotify sign-in's return address itself. Connecting the account from a browser on
  the same PC needs no copy and paste.
- **3.5-inch devices:** iPhone 4, iPhone 4S and iPod touch (4th generation) on iOS 6, besides the iPhone 5 and iPod
  touch (5th generation), with launch images for both screen sizes.
- **iOS 5:** the app also runs on iOS 5.0 to 5.1.1 (iPhone 3GS, 4 and 4S, iPod touch 3rd and 4th generation). iOS 6
  behaves as before. Not yet tested on a real iOS 5 device.
- **Engine sign-in** card on the admin page, and sign-in with a code approved on Spotify's website (the Windows
  default; Docker keeps discovery and can switch to the code).
- **First-run admin password:** set in the setup guide's first step, with a one-time setup code from the bridge's log
  (no code needed on the Windows PC itself). Stored in `data/admin.json` only in a form that can't be turned back into
  the password.
- **Phone setup** card on the admin page with the address to type into the app and the Encore repo's address.
- `/v1/status` reports the bridge's name, its version and the oldest app version it serves.
- The bridge's **test suite** (`gateway/test`), with made-up test data.
- Engine **patch 6**: a Windows named-pipe audio output and an Encore version stamp (`encore-engine.exe --version`). The
  engine runs natively on Windows, and the bridge only starts a matching engine. Patch 6b: on Windows the interactive
  sign-in's callback listens on 127.0.0.1 only.
- Jam QR codes on Windows through a built-in QR encoder. Docker keeps `qrencode` and falls back to the built-in one when
  it is missing.
- **Update check for the bridge:** once a day, and on **Check for updates** in the Windows tray menu or **Check now** on
  the admin page, Encore Bridge asks GitHub for the newest Encore release. It sends nothing but
  `EncoreBridge/<version>`. A newer final version is announced in the Windows tray menu (**Encore Bridge … is
  available**) and on the admin page (a banner and a new **Updates** section). Release candidates and older versions
  are never offered. `UPDATE_CHECK=0` turns the daily check off.
- **Update now on Windows:** downloads the new installer from GitHub and runs it once you approve Windows' permission
  prompt. The installer upgrades in place, keeps everything in `%LOCALAPPDATA%\Encore` and your **Start with Windows**
  choice, and starts Encore Bridge again (the old version, if the update doesn't finish). The portable zip gets the
  notice with a download link. On Docker the admin page shows the commands to update (a container never updates
  itself).

### Changed

- The server part is called **Encore Bridge** everywhere you see it (code and folder names keep "gateway").
- **Faster skipping:** the engine starts loading the next song a few seconds into the current one, and the bridge
  prepares the covers around the current song. Swiping to the next or previous song on Now Playing starts it and shows
  its cover sooner.
- Docker: `.env` is optional (Docker Compose 2.24 or newer). The setup guide asks for the admin password and the Client
  ID.
- Without a Client ID, the admin page's **Spotify account** card and the bridge's log point to the setup guide instead
  of asking you to edit a settings file and restart.
- The tutorial is now two short tutorials, for Windows and for Docker, built around the setup guide.
- Listening away from home: the guide now puts forwarding one port on your router first (setup guide step 8), with the
  iPhone's built-in VPN as the encrypted alternative.
- One message, **Update your Encore Bridge.**, replaces the app's per-feature "update the gateway" messages.
- The setup screen's subtitle and the About section say Encore is an unofficial Spotify client, not made by, affiliated
  with or endorsed by Spotify.
- New installs start with empty Home and Away addresses. The app opens Setup until it is paired and has a Home address.
- The admin page only answers addresses on an allow-list (`ADMIN_ALLOW`; default: private ranges, loopback,
  `100.64.0.0/10` and the IPv6 local ranges). It refuses admin requests that come through a proxy, locks an address
  out for 15 minutes after 10 wrong passwords (only a few password checks run at once), and only accepts changes sent
  by the admin page itself. On Windows, choosing the first password without a code works only on the bridge's own
  computer, never from a website that reaches it.
- The engine's control API (on the bridge's own computer only) refuses requests that a web page sends from another
  site.
- Bridge logs show whether a phone streamed from home or away, never its address.
- **Pairing only works from the home network** (the allow-list), so a phone's key never crosses the internet.
- Bridge logs never contain the names of people, devices or songs, in any mode. On Windows the engine's log lines are
  cleaned the same way before they reach the bridge's log.
- The bridge exits with a clear message when its port is taken or not allowed, or a setting is invalid. It no longer
  keeps running without a web server.
- Developer Jam tools (Fake Jam, flags, trace) moved into an **Advanced** section of the admin page (`?dev=1`).
- Docker: the engine uses its built-in discovery by default. Using the host's avahi-daemon is now an option.
- The fake Jam's own member shows your Spotify name, or "You".
- Lyrics requests identify themselves as `Encore/<version>`.

### Removed

- The unused `ugc-image-upload` permission from the Spotify sign-in.
- The **Open Spotify Links** setting is hidden until the companion EncoreLinks tweak is released.

### Security

- **Signed releases:** Encore Bridge only installs updates signed with Encore's release key.

## Before the public release

Encore was developed in private builds (app up to 1.0.0, bridge up to 0.10.3). None were distributed, and none ever
will be. The main steps:

- **App 1.0 / bridge 0.10:** a restyled app with iOS 6 green chrome everywhere, a new Now Playing (swipe the cover to
  skip, everything on one bottom bar), Up Next on the flip side, a Listening-on bar, a real Settings screen, Text Size,
  and **profiles**: search people, open anyone's profile and playlists, follow people *(private API)*. "Playing from …"
  opens its source.
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

1. **Output delay:** Spotify apps show the song and position the phone actually hears, despite the stream's buffer.
   Controls never wait for a full audio pipe.
2. **Catalog API:** cheaper playlist and library listings with revisions, and shuffle on play.
3. **Jams:** the social-connect service, Jam events, the Jam's end, Up Next edits.
4. **Jam host activation** and diagnostics.
5. **Jam self-activation.**
6. **Windows named-pipe output and the engine's version stamp** (new in 1.1.0), with 6b: the interactive login's
   callback on loopback on Windows.

Details are in `gateway/engine-src/ENCORE_PATCH.md`. The complete change is `gateway/engine-src/ENCORE_PATCH.diff`.
