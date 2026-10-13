# Encore

> **Vibecoded with Claude Opus.** Encore (the app, the Encore Bridge, the engine patches, the Windows installer and
> these docs) was written entirely by Claude Opus, Anthropic's AI. If you have a problem with that, this isn't for you.

**An unofficial Spotify client for iOS 6.**

Encore brings your Spotify library to a jailbroken iPhone or iPod touch on iOS 6 or iOS 5
([which models](#what-you-need)). A small program at home, the **Encore Bridge**, plays Spotify and streams it to the
app as AAC, which the phone decodes in hardware.

> Encore is not made, endorsed or supported by Spotify. It needs Spotify Premium and your own Spotify developer app, and
> it uses private Spotify interfaces that can break at any time. [Read the disclaimer](#disclaimer).

<!-- R6: add screenshots here, taken in Anonymous Mode and reviewed by the owner (docs/screenshots/): for example
     Home, Now Playing with lyrics, a playlist, Jam, Settings. -->

## Features

- **Your library:** Home (Jump back in, Made For You, top artists and songs, new releases), all your playlists with
  their covers, Liked Songs, saved albums, followed artists, Recently Played.
- **Search** songs, artists, albums, playlists and people.
- **In your language:** the app comes in English and Spanish, Portuguese (Brazil), French, German, Italian, Dutch, Polish, Russian, Turkish, Japanese, Korean and Chinese (Simplified) (Settings → Language; Automatic follows the phone).
- **Now Playing:** swipe-to-skip, synced lyrics, Up Next editing, lock-screen and headphone controls, background
  playback.
- **Edit playlists:** create, add to several at once, remove, reorder, pin favourites, sort by date added.
- **Spotify Connect:** Encore is a speaker in every Spotify app. Move music between it and your other devices.
- **Jam:** host or join a Spotify Jam with friends who use the normal Spotify app.
- **Profiles:** open anyone's profile and playlists, follow people.
- **Anonymous Mode:** hides your name, friends' names, devices and addresses, so you can show or film Encore.
- **Your own server:** sign-ins stay on your bridge at home. No central server, no telemetry.
- **Bridge on Linux (Docker) or Windows.** A **setup guide** in your browser takes you from install to your first song
  and ticks off each step by itself.
- **Install and update the app from Cydia:** add the Encore repo (`https://mbucc9000.github.io/slopkit/`) once.
- **Bridge updates:** the bridge checks GitHub for a new version once a day and sends nothing about you
  (`UPDATE_CHECK=0` turns the check off). On Windows, **Update now** downloads the update, verifies its signature and
  installs it after you approve Windows' prompt. On Docker, the admin page shows the commands to run.
- **Listen away from home:** the setup guide shows how to forward one port on your router and finds your public IP, so
  you know what to type into Encore's Away Address.

## What you need

- **Spotify Premium.**
- **Your own free Spotify developer app.** It takes five minutes. The bridge's setup guide walks you through it, and so
  does [the guide](docs/GUIDE.md#3-your-spotify-developer-app-and-account).
- **A jailbroken iPhone or iPod touch with Cydia:**
  - iOS 6: iPhone 5, 4S or 4; iPod touch 5th or 4th generation.
  - iOS 5 (5.0 to 5.1.1): iPhone 4S, 4 or 3GS; iPod touch 4th or 3rd generation.

  Encore is developed and tested on an iPhone 5 with iOS 6. The other models and iOS 5 are supported (4-inch and
  3.5-inch layouts) but not yet tested on real hardware. iPads and iOS 7 or later are not supported.
- **A computer that stays on** for the Encore Bridge: Linux with Docker (a NAS or home server works well), or a 64-bit
  Windows 10/11 PC.
- **For listening away from home:** access to your router's settings to forward one port (or a VPN server at home).

## Quick start

For a first setup, follow the tutorial for your computer: [Windows](docs/TUTORIAL-WINDOWS.md) or
[Docker](docs/TUTORIAL-DOCKER.md) ([help choosing](docs/TUTORIAL.md)). The [full guide](docs/GUIDE.md) covers every
detail.

1. **Install the Encore Bridge.**
   - **Windows:** download `EncoreBridge-<version>-setup.exe` and run it
     (SmartScreen: **More info → Run anyway**). The setup guide opens in your browser at the end.
   - **Linux (Docker):** unpack `Encore-<version>-source.tar.gz`, then build and start it. You need Docker Compose 2.24
     or newer. No settings file is needed.

     ```sh
     cd Encore-<version>/gateway
     docker compose up -d --build
     docker compose logs gateway | grep "setup code"
     ```

     Open the admin page, `http://<your-bridge-address>:8095/admin`. The setup guide starts there.
2. **Follow the setup guide.** It asks for an admin password (Docker: with the setup code from the log), helps you
   create your own Spotify developer app and saves its Client ID, connects your Spotify account, signs the engine in,
   and checks your network.
3. **On the phone:** in Cydia, add the Encore repo, `https://mbucc9000.github.io/slopkit/`, and install **Encore**
   from it. Never run `uicache` yourself.
4. **Pair at home:** type the address and the pairing code from the setup guide into the app. The setup guide ticks
   this off when it happens.
5. **Away from home:** use the setup guide's **Listen away from home** step. Forward TCP 8095 on your router to the
   bridge's computer, press **Find my public IP**, and type the Away address it shows into Encore
   (**Settings → Away Address**). Then play a song.
   [Listening away from home](docs/GUIDE.md#11-listening-away-from-home) also covers the iPhone's built-in VPN as the
   alternative.

All downloads (the app, the Windows installer and zip, the source and the GPL source bundle) are on the
[release page](https://github.com/mbucc9000/encore/releases/latest). Use the app's `.deb` from there to install with
Filza or SSH ([other ways to install](docs/GUIDE.md#93-other-ways-to-install-the-app)).

## Documentation

- Tutorials, from nothing to your first song: [Encore on Windows](docs/TUTORIAL-WINDOWS.md) and
  [Encore with Docker](docs/TUTORIAL-DOCKER.md) ([pick one](docs/TUTORIAL.md)).
- [The Encore guide](docs/GUIDE.md): installing, [the setup guide](docs/GUIDE.md#6-the-setup-guide),
  [installing the app from the Encore repo](docs/GUIDE.md#9-install-the-app-from-the-encore-repo),
  [listening away from home](docs/GUIDE.md#11-listening-away-from-home), features, Anonymous Mode, Jam,
  troubleshooting, updating, uninstalling, privacy, FAQ.
  - [Troubleshooting](docs/GUIDE.md#17-troubleshooting): every on-screen message, what it means and what to do.
  - [Updating](docs/GUIDE.md#18-updating): the bridge's update check, Windows' **Update now**, the Docker commands,
    and turning the check off.
  - Security: [the admin page and its password](docs/GUIDE.md#7-the-admin-page-and-your-admin-password),
    [pairing](docs/GUIDE.md#security-briefly) and [listening away from home](docs/GUIDE.md#11-listening-away-from-home).
  - [Privacy](docs/GUIDE.md#22-privacy-what-stays-home-and-what-leaves): what stays on your bridge and phone, and
    which hosts the bridge contacts (including the daily update check).
- [Building from source](docs/BUILDING.md): the app, the Docker images, the Windows engine, launcher and installer, the
  tests and the release scripts.
- [Architecture](docs/ARCHITECTURE.md): how the app, the bridge and the engine fit together.
- [Changelog](CHANGELOG.md)
- [Third-party notices](THIRD-PARTY-NOTICES.md)

## How it works

```
 Spotify  -->  engine ("Encore" speaker)  -->  Encore Bridge (AAC)  -->  Encore app (iOS 6)
               '------------- your computer at home -------------'      Wi-Fi or the internet
```

The engine is a patched [go-librespot](https://github.com/devgianlu/go-librespot), a Spotify Connect speaker. It hands
raw audio to the bridge (Node.js and ffmpeg). The bridge encodes AAC at the quality the phone asks for and serves the
app's API. Library, search and profiles come from Spotify's Web API (through your developer app) and the engine. No
audio is ever saved.

## Repository layout

| Path | What it is |
|---|---|
| `app/` | The iOS 6 app (Objective-C, built with Theos) |
| `gateway/` | The Encore Bridge: `src/` (Node.js, including the admin page and its setup guide), `test/`, Docker files, `windows/` (tray launcher, installer and build scripts) |
| `gateway/engine-src/` | go-librespot with Encore's patches (`ENCORE_PATCH.md`, `ENCORE_PATCH.diff`) |
| `docs/` | The tutorials, the guide, building and architecture notes |
| `tools/release/` | The release scripts: export, privacy scan, deb build, GPL source bundle, checksums and their signature |

## Disclaimer

Encore is an unofficial Spotify client for iOS 6. It is not affiliated with, endorsed, sponsored or supported by
Spotify AB. "Spotify" is a trademark of Spotify AB.

Besides the public Web API (used through your own developer app), Encore uses private, undocumented Spotify interfaces:
the Spotify Connect protocol through go-librespot, internal playlist, profile and Jam services. They may stop working at
any time, and using them may break Spotify's Terms of Use. Spotify could limit or close the account you use. **Use Encore
at your own risk.**

Encore requires Premium, never saves audio and never removes DRM into files: music is streamed live to your own device
only. Jailbreaking is your own decision. Encore is a hobby project, provided as is, without warranty or promise of
support. See [Legal and disclaimer](docs/GUIDE.md#25-legal-and-disclaimer).

## License

Encore is free software: you can redistribute it and/or modify it under the terms of the **GNU General Public License
as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version**
(GPL-3.0-or-later). See [`LICENSE`](LICENSE).

The engine is a modified copy of go-librespot, which is licensed under the GPL-3.0. Every release that contains an
engine binary comes with its complete corresponding source. Other components and their licenses are listed in
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).

## Credits

Thanks to devgianlu and the go-librespot contributors, the librespot community, FFmpeg, Node.js, LRCLIB, Theos,
Project Nayuki (QR codes) and the fyne.io systray authors.

Project page: [github.com/mbucc9000/encore](https://github.com/mbucc9000/encore).
