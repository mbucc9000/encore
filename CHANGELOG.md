# Changelog

All notable changes to Encore. The format follows [Keep a Changelog](https://keepachangelog.com/).

The Encore app and Encore Bridge share one version number.

## [1.5.0] - 2026-10-14

- Settings → Appearance → **App Icon**: Encore, Classic, Round, 2013, Flat or Disco on the home screen, changed at once.
- App Icon needs MobileSubstrate and one respring after installing; its add-on ships inside the Encore package.

## [1.4.1] - 2026-10-14

- Step 8 of the setup guide has an **Open your router** button: Encore Bridge finds your router's address itself.
- The guide's VPN, carrier-grade NAT and changing-IP sections are gone.

## [1.4.0] - 2026-10-13

- The app tells you once when a new Encore or Encore Bridge is out, with **Open Cydia** and an Update Available row
  at the top of Settings.
- The setup guide has a new optional step 10, **Turn on Jam** (or press **Skip Jam**).
- Much shorter README, guide and tutorials.

## [1.3.0] - 2026-10-13

- Docker: ready-made images for Encore Bridge and its engine (64-bit x86 and ARM), so nothing is built on your machine.
- Docker setup is one file from the release page, `encore-docker-compose.yaml`, and one command, `docker compose up -d`.
  The same file works as a Dockge or Portainer stack.
- To update on Docker, run `docker compose pull && docker compose up -d` (Dockge: **Update**).
- Building the images yourself still works (`docker compose up -d --build` in `gateway/`).

## [1.2.1] - 2026-10-13

- Windows: the admin page opens in your browser each time Encore Bridge starts. Untick **Open admin page on start** in
  the tray menu to turn it off.
- Windows: **Update now** always installs the newest release.

## [1.2.0] - 2026-10-13

- The app in 12 more languages: pick one in **Settings → Appearance → Language** (Automatic follows the phone).
- The bridge's admin page, setup guide, messages to the app, and the Windows tray menu and installer in the same 12
  languages.
- A shorter guide.

## [1.1.1] - 2026-10-11

- A simpler **Updates** card on the admin page.
- Shorter, plainer docs.
- The README says up front that Encore was vibecoded with Claude Opus.

## [1.1.0] - 2026-10-11

The first public release.

- A setup guide on the bridge's admin page takes you from a fresh bridge to the first song, step by step.
- Encore Bridge for Windows 10/11, as an installer or a portable zip with a tray menu. It checks for updates once a
  day, and **Update now** installs them.
- The app installs and updates from the Encore repo in Cydia (`https://mbucc9000.github.io/slopkit/`).
- Listen away from home by forwarding one port on your router; the setup guide finds your public IP for you.
- Anonymous Mode in the app and Showcase on the bridge hide names, pictures and addresses on screen.
- The app also runs on 3.5-inch devices (iPhone 4, 4S, iPod touch 4th generation) and on iOS 5.

## Before 1.1.0

Private builds (app up to 1.0.0, bridge up to 0.10.3), never distributed.

- A streaming player with lock-screen, headphone and AirPods controls, pairing, and the bridge's admin page.
- Browsing, search, likes, swipe-to-queue, a full Library and a Home tab built from your listening.
- Spotify Jam: start, join, and invite by QR code or message.
- Synced lyrics, saved albums, pinned playlists and sorting.
- An iOS 6 green restyle, a new Now Playing, and profiles: search people, open their playlists, follow them.
