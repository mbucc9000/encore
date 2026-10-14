# Encore

> **Vibecoded with Claude Opus.** Encore (the app, the Encore Bridge, the engine patches, the Windows installer and
> these docs) was written entirely by Claude Opus, Anthropic's AI. If you have a problem with that, this isn't for you.

**An unofficial Spotify client for jailbroken iOS 5 and 6.** The **Encore Bridge** at home streams Spotify to it.

> Encore is not made, endorsed or supported by Spotify. It needs Spotify Premium and your own Spotify developer app.
> It uses private Spotify interfaces that can break at any time. [Read the disclaimer](#disclaimer).

<!-- R6: add owner-reviewed screenshots (Anonymous Mode, docs/screenshots/): Home, Now Playing, a playlist, Jam. -->
**Features:** your library and search, synced lyrics, lock-screen controls, playlist editing, Spotify Connect, Jam,
profiles, Anonymous Mode, 13 languages, optional Spotify app icons (Settings → Appearance → **App Icon**: needs
MobileSubstrate and one respring after installing). Sign-ins stay on your own bridge: no central server, no telemetry.

## What you need

- Spotify Premium and a free [Spotify developer app](https://developer.spotify.com/dashboard) (the setup guide helps you make it).
- A jailbroken iPhone or iPod touch with Cydia. iOS 6: iPhone 5, 4S, 4; iPod touch 5th or 4th gen. iOS 5.0 to 5.1.1:
  iPhone 4S, 4, 3GS; iPod touch 4th or 3rd gen. Only tested on an iPhone 5 with iOS 6. No iPads, no iOS 7 or later.
- A computer that stays on: a 64-bit Windows 10/11 PC, or 64-bit Linux with Docker (x86-64 or ARM64).

## Install

Step by step: the [Windows tutorial](docs/TUTORIAL-WINDOWS.md) or the [Docker tutorial](docs/TUTORIAL-DOCKER.md)
([which one?](docs/TUTORIAL.md)). Everything else: [the Encore guide](docs/GUIDE.md).
1. **Install the bridge** from the [release page](https://github.com/mbucc9000/encore/releases/latest).
   - **Windows:** run `EncoreBridge-<version>-setup.exe` (SmartScreen: **More info → Run anyway**).
   - **Docker** (or paste the compose file into Dockge or Portainer as a new stack):
     ```sh
     mkdir ~/encore && cd ~/encore
     curl -fL -o compose.yaml https://github.com/mbucc9000/encore/releases/latest/download/encore-docker-compose.yaml
     docker compose up -d
     docker compose logs gateway | grep "setup code"
     ```
     Then open `http://<bridge address>:8095/admin`.
2. **Follow the setup guide** on the admin page: **Protect this page** to **Play a song**, optional **Turn on Jam**.
3. **On the phone:** in Cydia, add the Encore repo `https://mbucc9000.github.io/slopkit/` and install **Encore**.

## Update and uninstall

- **Update:** the app in Cydia. The bridge: **Update now** on Windows, `docker compose pull && docker compose up -d`
  on Docker. The bridge checks GitHub once a day (`UPDATE_CHECK=0` turns that off).
- **Uninstall:** Cydia → **Installed** → **Encore** → **Modify** → **Remove**. Windows: **Settings → Apps → Installed
  apps → Encore Bridge → Uninstall**. Docker: `docker compose down --rmi all` in its folder, then delete the folder.

## Disclaimer

Encore is not affiliated with, endorsed or supported by Spotify AB. Spotify and its logos are trademarks of Spotify AB;
the optional app icons are included as provided. Besides the public Web API, Encore uses private Spotify interfaces
(Spotify Connect, playlist, profile and Jam services). They may stop working at any time, and using them may break
Spotify's Terms of Use: Spotify could limit or close your account. **Use at your own risk.** No audio is saved and no
DRM is removed. Provided as is, without warranty or support.

## License

GPL-3.0-or-later ([`LICENSE`](LICENSE)). The engine is a modified go-librespot (GPL-3.0): every release with it
includes its full source. See [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md), [building](docs/BUILDING.md),
[architecture](docs/ARCHITECTURE.md), [changelog](CHANGELOG.md). Thanks to go-librespot, librespot, FFmpeg, Node.js,
LRCLIB, Theos, Project Nayuki and fyne.io systray.
