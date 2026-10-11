# The Encore guide

Encore is an unofficial Spotify client for iOS 6 (iOS 5 works too). This guide is the full reference: setup, the
Encore Bridge on Linux (Docker) or Windows, the app, listening away from home, and troubleshooting.

**New here?** Follow the tutorial for your computer: [Windows](TUTORIAL-WINDOWS.md) or [Docker](TUTORIAL-DOCKER.md).
You install the bridge, and its setup guide takes you to your first song.

> **Unofficial.** Encore is not made, endorsed or supported by Spotify. It uses your own Spotify Premium account, your
> own Spotify developer app, and private Spotify interfaces that can change or break at any time. Read
> [Legal and disclaimer](#25-legal-and-disclaimer) before you start. Use it at your own risk.

This guide describes Encore **1.1.0** (the app and the bridge share one version number).

## Contents

**Getting started**
1. [What Encore is](#1-what-encore-is)
2. [What you need](#2-what-you-need)
3. [Your Spotify developer app and account](#3-your-spotify-developer-app-and-account)
4. [Install the Encore Bridge with Docker (Linux)](#4-install-the-encore-bridge-with-docker-linux)
5. [Install the Encore Bridge on Windows](#5-install-the-encore-bridge-on-windows)
6. [The setup guide](#6-the-setup-guide)
7. [The admin page and your admin password](#7-the-admin-page-and-your-admin-password)
8. [Sign the engine in to Spotify](#8-sign-the-engine-in-to-spotify)
9. [Install the app from the Encore repo](#9-install-the-app-from-the-encore-repo)
10. [Pair your phone (at home)](#10-pair-your-phone-at-home)

**Using Encore**

11. [Listening away from home](#11-listening-away-from-home)
12. [Anonymous Mode and Showcase](#12-anonymous-mode-and-showcase)
13. [Feature tour](#13-feature-tour)
14. [Jam with friends](#14-jam-with-friends)
15. [Settings reference](#15-settings-reference)
16. [Admin page reference](#16-admin-page-reference)

**Keeping it running**

17. [Troubleshooting](#17-troubleshooting)
18. [Updating](#18-updating)
19. [Backing up or moving the bridge](#19-backing-up-or-moving-the-bridge)
20. [Running a second bridge](#20-running-a-second-bridge)
21. [Uninstalling](#21-uninstalling)

**Reference**

22. [Privacy: what stays home and what leaves](#22-privacy-what-stays-home-and-what-leaves)
23. [FAQ](#23-faq)
24. [Building from source](#24-building-from-source)
25. [Legal and disclaimer](#25-legal-and-disclaimer)
26. [Credits and licenses](#26-credits-and-licenses)

### How to read this guide

- Text in `<angle brackets>` is a placeholder. Replace it with your own value, without the brackets.
  - `<your-bridge-address>`: the local network address of the computer that runs the Encore Bridge, for example
    `192.168.1.20`.
  - `<your-public-ip>`: your home's public IP address (the one the internet sees), for example `203.0.113.7`. The
    setup guide's step 8 finds it ([chapter 11](#11-listening-away-from-home)).
  - `<your-client-id>`: the Client ID of your Spotify developer app
    ([chapter 3](#3-your-spotify-developer-app-and-account)).
  - `<version>`: the Encore version you downloaded, for example `1.1.0`.
- **Bridge** and **Encore Bridge** mean the same thing. In the source code the bridge lives in the `gateway/` folder,
  so file and folder names use that word.
- The **setup guide** is the step-by-step page built into the bridge's admin page ([chapter 6](#6-the-setup-guide)).
  This guide names its steps by number and title, for example step 2, **Your Spotify developer app**.
- Steps marked **Docker** are for the Linux route, steps marked **Windows** for the Windows route. Everything else
  applies to both.

---

## 1. What Encore is

Encore has three parts:

| Part | Where it runs | What it does |
|---|---|---|
| **Encore app** | Your jailbroken iPhone or iPod touch (iOS 6 or iOS 5) | The Spotify-style app you use: Home, Search, Playlists, Library, Now Playing, lyrics, Jam, Settings. |
| **Encore Bridge** | A computer at home that stays on (Linux with Docker, or Windows) | Talks to Spotify for you, turns the music into a stream your phone can play, and answers the app. It has a web **admin page** with a **setup guide**. |
| **Engine** | Inside the bridge | A patched copy of [go-librespot](https://github.com/devgianlu/go-librespot): a Spotify Connect speaker called **Encore** that plays your music. |

### Why a bridge?

iOS 6 can't run Spotify's current apps. It doesn't speak today's encryption, codecs or Spotify's protocols. The bridge
does that work on a modern computer. It sends your phone plain AAC audio, which the iPhone's hardware decoder plays
with very little battery.

### The audio path

```
 Spotify's servers
        |
        v
 Engine ("Encore" speaker)  --raw audio-->  Encore Bridge (re-encodes to AAC)  --HTTP-->  Encore app on iOS 6
 '---------------- on your home computer ----------------'                    your Wi-Fi, or the internet
```

1. The engine plays a song from Spotify, like any Spotify Connect speaker.
2. Instead of a loudspeaker, it hands the raw audio (44.1 kHz, 16-bit stereo) to the bridge.
3. The bridge encodes it to AAC at the quality your phone asked for (320, 256, 160 or 96 kbps).
4. The app plays the stream and shows the song on the lock screen.

Song lists, your library, search, profiles and Jams come from Spotify two ways: the official **Web API** (through
*your own* developer app, [chapter 3](#3-your-spotify-developer-app-and-account)) and the engine's own connection to
Spotify.

### What is saved, and where

- **No music is ever saved.** The bridge keeps about 75 seconds of encoded audio per quality level **in memory**, so a
  phone that drops for a moment can pick up where it left off. No audio file is written on the bridge or the phone.
- The phone caches song lists and cover pictures, so screens open fast and still show something when you're offline.
- The bridge keeps your Spotify sign-ins, the paired phones and its caches on its own disk
  ([Privacy](#22-privacy-what-stays-home-and-what-leaves)).

### One bridge, one Spotify account

A bridge plays one Spotify account. Several phones can pair with it, and they all use that account. For a second
account, run a second bridge ([chapter 20](#20-running-a-second-bridge)).

---

## 2. What you need

### Checklist

- [ ] **Spotify Premium.** It is needed twice: the engine only plays for Premium accounts, and Spotify requires the
      owner of a developer app to have Premium.
- [ ] **A free Spotify developer app of your own** ([chapter 3](#3-your-spotify-developer-app-and-account)). Encore never
      ships one. Each person makes their own; the setup guide walks you through it.
- [ ] **A supported device on iOS 6 or iOS 5, jailbroken, with Cydia** (table below).
- [ ] **A computer for the bridge that stays on**: a Linux machine with Docker, or a Windows 10/11 PC.
- [ ] **Your home network**, with the phone and the bridge on it for setup.
- [ ] **For listening away from home:** access to your router's settings to forward one port (the setup guide's step 8
      walks you through it), or a VPN server at home ([chapter 11](#11-listening-away-from-home)).

### Supported devices

| Device | iOS | Status |
|---|---|---|
| iPhone 5 | 6.0 – 6.1.x | Supported (4-inch screen). Encore is developed and tested on it. |
| iPod touch (5th generation) | 6.0 – 6.1.x | Supported (4-inch screen, the same layouts as the iPhone 5). Not tested on a real device yet. |
| iPhone 4S | 5.0 – 5.1.1, 6.0 – 6.1.x | Supported (3.5-inch screen). Not tested on a real device yet. |
| iPhone 4 | 5.0 – 5.1.1, 6.0 – 6.1.x | Supported (3.5-inch screen). Not tested on a real device yet. |
| iPod touch (4th generation) | 5.0 – 5.1.1, 6.0 – 6.1.x | Supported (3.5-inch screen). Not tested on a real device yet. |
| iPhone 3GS | 5.0 – 5.1.1 | Supported (3.5-inch screen). Not tested on a real device yet. |
| iPhone 3GS | 6.x | Not targeted. It may install, but nothing is tested or fixed for it. |
| iPod touch (3rd generation) | 5.0 – 5.1.1 | Supported (3.5-inch screen). Not tested on a real device yet. |
| iPad (any) | — | Not supported |
| Any device on iOS 7 or later | — | Not supported |

Every screen lays itself out for both the 4-inch (320 × 568) and the 3.5-inch (320 × 480) screen, and the app ships
launch images for both. If something looks wrong on an untested model or on iOS 5, report it
([17.9](#179-asking-for-help)).

- **Jailbreak:** required. Encore installs as a regular app in `/Applications`. The easy way is **Cydia**: add the
  Encore repo once and install Encore from it ([chapter 9](#9-install-the-app-from-the-encore-repo)). Filza, iFile or
  SSH work too, and so do iOS 6 dual-boot setups. MobileSubstrate and AppSync are **not** needed.
- **Free space:** a few megabytes for the app, plus its caches (lists and cover pictures).

### The bridge machine

Pick one route:

| | **Docker (Linux)** | **Windows** |
|---|---|---|
| Runs on | A Linux computer or NAS with Docker Engine and Docker Compose 2.24 or newer: a home server, a NAS that runs Docker containers, a spare PC, probably a 64-bit Raspberry Pi 4 or 5 (untested) | Windows 10 or 11, 64-bit (x64). Windows on Arm may run it through x64 emulation (untested). |
| You install | The source code, built locally with `docker compose` | An installer, or a portable zip |
| Runs when | Always (it starts with the machine) | While you are signed in to Windows (it starts with Windows if you leave that option on) |
| Needs | Host networking (the containers share the machine's network) | A **Private** network profile on Windows |

**Not supported in this release:** Docker Desktop on Windows or macOS (and Docker inside WSL), a macOS bridge, and
running the bridge behind a reverse proxy. Docker Desktop hides the containers behind its own network: Spotify Connect
discovery doesn't reach your LAN, and the admin page can't tell local visitors from strangers. On a Windows PC, use
the Windows bridge.

**The machine must stay on and awake while you listen.** If it sleeps, the music stops and the phone can't reach it.

**Rough resource use:** while a phone is connected, the bridge runs up to four AAC encoders (one per quality level) and
resizes cover pictures with ffmpeg. Any recent desktop CPU or NAS handles that. Disk: the cover cache is capped at
512 MB, plus small JSON caches.

### Mobile data use

Roughly what each streaming quality uses over mobile data:

| Streaming Quality | Bitrate | Per hour |
|---|---|---|
| Very High (default) | 320 kbps | about 145 MB |
| High | 256 kbps | about 115 MB |
| Normal | 160 kbps | about 72 MB |
| Low | 96 kbps | about 43 MB |

With **Auto-Reduce Quality** on (the default), the app steps down by itself when the network is slow.

---

## 3. Your Spotify developer app and account

Encore reads your playlists, library and search results through Spotify's official Web API. Spotify only allows that
through a "developer app". You create your own for free in a few minutes, give the bridge its **Client ID**, and
connect your Spotify account. Encore never uses a client secret.

The setup guide does this with you in step 2 (**Your Spotify developer app**) and step 3 (**Connect your Spotify
account**), with a **Copy** button for every value ([chapter 6](#6-the-setup-guide)).

### 3.1 Create the app

1. Open <https://developer.spotify.com/dashboard> (the setup guide's **Open the Spotify developer dashboard** button).
   Log in with the Spotify account you will use with Encore (the Premium one). Accept the Developer Terms if Spotify
   asks.
2. Press **Create app** and fill in:
   - **App name:** anything, for example `Encore`.
   - **App description:** anything, for example `My iOS 6 player`.
   - **Website:** leave it empty.
   - **Redirect URIs:** type exactly `http://127.0.0.1:8888/callback` and press **Add**. It must match character for
     character: `127.0.0.1`, not `localhost`; port `8888`; path `/callback`; no slash at the end.
   - **Which API/SDKs are you planning to use?** tick **Web API**.
3. Accept the terms and press **Save**.
4. Open the app's **Settings**, then **User Management** inside Settings. Add the name and e-mail address of the
   Spotify account you will use with Encore. Apps in Spotify's development mode only answer for their owner and the
   accounts on this list, and Spotify keeps the list short (a handful of people). If it is the account that owns the
   app and the dashboard says it is already there, or won't add it, that's fine.
5. Under **Settings → Basic Information**, copy the **Client ID** (32 letters and digits) and give it to the bridge
   (3.2). Ignore the client secret: Encore doesn't need it, so don't copy it anywhere.

Spotify changes its dashboard now and then. If a button or page has another name, look for the same step: create an
app, add a Redirect URI, choose the Web API, add users, copy the Client ID.

### 3.2 Give the bridge the Client ID

**The usual way:** the setup guide's step 2, **Your Spotify developer app**. Paste the Client ID into the box and press
**Save Client ID**. The page checks that it looks like a Client ID (32 characters: digits and the letters `a` to `f`).
The bridge saves it and uses it at once, without a restart. The step then shows **✓ Client ID saved** with the last
four characters.

**By hand:** set `SPOTIFY_CLIENT_ID=<your-client-id>` in `settings.env` on Windows
([5.9](#59-edit-settingsenv-by-hand)) or in `.env` on Docker ([4.3](#43-a-settings-file-optional)), then restart the
bridge. The Windows installer doesn't ask for it; the setup guide does.

**Where it is kept, and which one counts.** The bridge checks these places in order and uses the first one that has a
value:

| | Where | Written by |
|---|---|---|
| 1 | The bridge's environment. On Docker that is `SPOTIFY_CLIENT_ID` in `.env`. | You |
| 2 | `settings.env`: on Windows `%LOCALAPPDATA%\Encore\settings.env` (any bridge started with `ENCORE_HOME` has one too) | The setup guide, or you |
| 3 | `data/settings.json` in the bridge's data folder (on Docker `gateway/data/settings.json`) | The setup guide, on a bridge without `settings.env` |

On Windows the setup guide saves the Client ID into `settings.env`; on Docker, into `data/settings.json`.

- A Client ID in the environment (Docker's `.env`) always wins, and the setup guide can't change it. Step 2 then says
  that your Client ID comes from the bridge's environment. Change it there: on Docker, edit `.env`, then run
  `docker compose up -d` in the `gateway` folder.
- A value in `data/settings.json` that isn't a valid Client ID is ignored, with a warning in the bridge's log.

The Client ID isn't a password, but it is tied to your Spotify account. Don't publish it, and don't use someone
else's: each person makes their own app. The bridge never writes it into its log.

### 3.3 Change the Client ID

1. Open the setup guide: the **Setup guide** button on the admin page, or **Setup guide…** in the Windows tray menu.
2. Go to step 2 and press **Change**.
3. If your Spotify account is connected, the page asks first: "Changing the Client ID disconnects your Spotify
   account. You'll connect it again in the next step. Change it?" The account's sign-in belongs to the old developer
   app, so the bridge disconnects it. Connect it again in step 3.

On Windows, close Notepad first if it has `settings.env` open. If Notepad saves the file later, it puts the old Client
ID back.

### 3.4 Connect your Spotify account

This lets the bridge read your library and search through your developer app. Use the setup guide's step 3, **Connect
your Spotify account**, or the **Spotify account** card on the admin page.

1. Press **Connect**. (Without a Client ID the page says "Add your Spotify Client ID in the setup guide (step 2)
   first.")
2. A new tab opens on Spotify. Log in with the **same Premium account** you added in 3.1, and press **Agree**.
3. Spotify sends that tab to `http://127.0.0.1:8888/callback?code=…`:
   - **Windows, with the browser on the PC that runs Encore Bridge:** the bridge catches this address itself. The tab
     says **Spotify account connected**. Close it.
   - **Docker, or a browser on another computer:** the tab shows an error such as **"This site can't be reached"**.
     That is expected. Copy the tab's **whole address** from the address bar, paste it into the box, and press
     **Use this address** in the setup guide (**Finish** on the admin page's Spotify account card).
4. The setup guide says **✓ Connected**, and the Spotify account card says **Connected as** your Spotify name.

Finish soon after you press **Connect**. The bridge forgets an unfinished sign-in after 15 minutes, and Spotify's code
in the address can expire sooner. If it expired, press **Connect** again. On Windows the bridge listens for the address
on `127.0.0.1:8888` only, and only while a sign-in is unfinished. If another program already uses that port, paste the
address as on Docker.

Only a **refresh token** is stored, in the bridge's `data` folder. Your Spotify password never reaches the bridge or
the phone. While Showcase is on, the connect steps are hidden, because Spotify's page shows your account.

If something goes wrong, see [Spotify account problems](#174-spotify-account-and-sign-in).

### 3.5 What Encore asks Spotify for

When you connect, Spotify asks you to allow these permissions:

| Permission | Why Encore asks |
|---|---|
| `playlist-read-private`, `playlist-read-collaborative` | Show all your playlists, including private and collaborative ones |
| `playlist-modify-private`, `playlist-modify-public` | New Playlist, Add to Playlist, Remove from This Playlist, reordering |
| `user-library-read`, `user-library-modify` | Liked Songs, saved albums, the heart buttons |
| `user-follow-read` | Followed artists in Library |
| `user-read-playback-state`, `user-modify-playback-state`, `user-read-currently-playing` | See what plays on your other devices and take playback over ("Play on Encore?") |
| `user-read-recently-played`, `user-top-read` | Home (Jump back in, top artists and songs) and Recently Played |
| `user-read-private` | Your profile name and picture, and your country for search results |

Encore asks for nothing else, and never for permission to upload pictures.

---

## 4. Install the Encore Bridge with Docker (Linux)

On Windows, skip to [chapter 5](#5-install-the-encore-bridge-on-windows). For a first install, the
[Docker tutorial](TUTORIAL-DOCKER.md) walks through the same steps.

### 4.1 Install Docker

Install Docker Engine and the Compose plugin for your distribution: follow <https://docs.docker.com/engine/install/>.
Many NAS systems have Docker built in or as an app. Check that it works:

```sh
docker compose version
```

It must say **2.24** or newer. Encore's `compose.yaml` uses an optional settings file, which older versions can't read
(they stop with an error that mentions `env_file`).

### 4.2 Get the Encore source

Download the release's source archive, `Encore-<version>-source.tar.gz`, from the release page
([github.com/mbucc9000/encore/releases](https://github.com/mbucc9000/encore/releases/latest)). Unpack it (or clone the
repository) and go into the bridge folder:

```sh
tar -xzf Encore-<version>-source.tar.gz
cd Encore-<version>/gateway
```

The folder holds:

| Path | What it is |
|---|---|
| `compose.yaml` | Starts two containers: `encore-gateway` (the bridge) and `encore-engine` |
| `Dockerfile` | Builds the bridge image: Node 22, ffmpeg and qrencode |
| `src/` | The bridge's code |
| `engine-src/` | The engine's full source (go-librespot with Encore's patches), built on your machine |
| `engine/config.yml` | The engine's settings |
| `.env.example` | A template for an optional settings file |
| `test/` | The bridge's test suite (not needed to run the bridge) |
| `windows/` | The Windows bridge's sources (not used on Docker) |

When the bridge runs, it also creates `data/` (sign-ins, pairings, the admin password, the Client ID the setup guide
saved, caches), `pipe/` (the audio pipe between the containers) and files inside `engine/` (the engine's saved
sign-in).

### 4.3 A settings file (optional)

You don't need one. The setup guide asks for the admin password and the Client ID, and the bridge keeps them in
`data/`. Create `.env` only to set something the setup guide doesn't, such as `ADMIN_ALLOW`, or to fix the Client ID or
the password from outside the admin page:

```sh
cp .env.example .env
chmod 600 .env
```

Open `.env` in a text editor. It has four settings, each with a short explanation above it:

```ini
SPOTIFY_CLIENT_ID=
ADMIN_PASSWORD=
#ADMIN_ALLOW=private
#UPDATE_CHECK=1
```

- `SPOTIFY_CLIENT_ID`: leave it empty and use the setup guide. A value here wins over the one the setup guide saved,
  and the setup guide can't change it ([3.2](#32-give-the-bridge-the-client-id)).
- `ADMIN_PASSWORD`: leave it empty. You choose the admin password in your browser (the setup guide's step 1), and the
  bridge keeps only a salted hash of it. A value here always wins over the one chosen in the browser.
- `ADMIN_ALLOW`: leave the line commented out. The default (`private`) lets your home network, the bridge machine
  itself and VPN overlay addresses open the admin page and pair phones ([16.4](#164-bridge-settings)).
- `UPDATE_CHECK`: leave the line commented out. The bridge then looks for a new Encore version on GitHub once a day and
  shows it on the admin page. `UPDATE_CHECK=0` turns that off ([chapter 18](#18-updating)).

After you change `.env`, apply it with `docker compose up -d` in the `gateway` folder. A plain `docker compose restart`
doesn't read `.env` again. All bridge settings are listed in [16.4 Bridge settings](#164-bridge-settings).

### 4.4 Check the engine's settings

Open `engine/config.yml`. The defaults suit most people:

| Setting | Default | Change it when |
|---|---|---|
| `device_name` | `Encore` | You run two bridges, or want another speaker name in Spotify |
| `zeroconf_backend` | `builtin` | **Your machine already runs avahi-daemon** (see below) |
| `credentials.type` | `zeroconf` | You prefer the code sign-in ([chapter 8](#8-sign-the-engine-in-to-spotify)) |
| `bitrate` | `320` | Never: the bridge always asks Spotify for the best quality and encodes per phone |
| `metadata.enabled` | `true` | Never: song lists need it |
| `metadata.max_tracks` | `5000` | Your longest playlist (or Liked Songs) has more songs than this |

**If your machine runs avahi-daemon.** Many NAS systems and desktop Linux distributions do. Check with:

```sh
systemctl is-active avahi-daemon
```

If it says `active`, two programs would fight over the same network port for discovery. Switch the engine to avahi:

1. In `engine/config.yml`, set `zeroconf_backend: avahi`.
2. In `compose.yaml`, under the `engine` service's `volumes:`, remove the `# ` in front of this line, so it reads:

   ```yaml
         - /run/dbus/system_bus_socket:/run/dbus/system_bus_socket
   ```

**If the bridge machine has a firewall.** Discovery uses UDP 5353 and one TCP port that the engine picks at random. To
fix that port so you can allow it, add a line such as `zeroconf_port: 45678` to `engine/config.yml` (any free port).
Then allow that TCP port from your home network ([4.7](#47-network-ports-docker)).

### 4.5 Build and start

```sh
docker compose up -d --build
```

The first build downloads the base images and compiles the engine. It takes a few minutes. Later starts take seconds.

Check that both containers run:

```sh
docker compose ps
docker compose logs -f gateway
```

Lines like these mean the bridge is up. Each line starts with the container name and the time. Press Ctrl+C to stop
following the log; the bridge keeps running.

```
I Encore Bridge 1.1.0 starting
W no admin password yet: open http://<this computer's address>:8095/admin and choose one with the setup code ABCD-EFGH-JKMN (a new code at every start; or set ADMIN_PASSWORD)
W no Spotify Client ID yet: the setup guide on the admin page asks for it
I reading PCM from /pipe/encore.pcm
I encoder very_high (320 kbps AAC) started at sample 0 (frame 0)
I listening on :8095
I player events connected
```

- The `W no admin password yet` line carries the one-time **setup code** for the setup guide's step 1. It appears
  only until you choose an admin password, and the code changes every time the bridge starts.
- `W no Spotify Client ID yet` disappears once the setup guide's step 2 saves your Client ID.
- A line saying `could not shrink the … pipe buffer` is harmless.

From another device on your network, open `http://<your-bridge-address>:8095/` in a browser. If it shows two short
lines, `Encore gateway` and `Encore Bridge: the admin page is at /admin`, the phone can reach the bridge too.

Then open `http://<your-bridge-address>:8095/admin` from a computer on your home network. The setup guide starts at its
first step ([chapter 6](#6-the-setup-guide)).

### 4.6 Find and fix the bridge's address

The phone needs the bridge machine's **local IP address**. The setup guide (steps 5, 7 and 8) and the admin page's
**Phone setup** card show it, ready to type into the app. You can also find it with `hostname -I`, or in your router's
list of connected devices.

In your router, give that machine a **fixed address** (often called a "DHCP reservation"). Otherwise it can change and
break the phone's Home address and the port forward for listening away from home
([chapter 11](#11-listening-away-from-home)).

### 4.7 Network ports (Docker)

| Port | Who uses it | Open it to |
|---|---|---|
| TCP 8095 | The phones (the Encore app) and the admin page | Your home network, and the internet through the port forward on your router for listening away from home ([chapter 11](#11-listening-away-from-home)). The admin page and pairing still answer only your home network. |
| TCP 3678 on 127.0.0.1 | The bridge talking to the engine | Nobody: it only listens on the machine itself. **Never forward it.** |
| UDP 5353 + one TCP port of the engine | Spotify Connect discovery ("zeroconf"), so Spotify apps on your network can see the **Encore** speaker | Your home network only. The engine picks a random TCP port unless you set `zeroconf_port` in `engine/config.yml` |

If the machine runs a firewall (ufw, firewalld, a NAS firewall):

- Allow TCP 8095 from your home network, and from anywhere once you forward the port for listening away from home
  ([11.1](#111-forward-the-port-setup-guide-step-8)).
- For discovery, allow UDP 5353. Set a fixed `zeroconf_port` and allow it too (home network only).

The setup guide's network check can't see a firewall on a Linux machine.

Next: [the setup guide](#6-the-setup-guide).

---

## 5. Install the Encore Bridge on Windows

The Windows bridge is one package: a small tray program (`Encore Bridge.exe`), the bridge itself (with its own copy of
Node.js in `runtime\`), the engine (`engine\encore-engine.exe`) and ffmpeg. Nothing else needs to be installed. The
tray program starts the bridge without a console window, and the bridge starts the engine. For a first install, follow
the [Windows tutorial](TUTORIAL-WINDOWS.md).

### 5.1 Download the files

From the release page ([github.com/mbucc9000/encore/releases](https://github.com/mbucc9000/encore/releases/latest)),
download **one** of:

- `EncoreBridge-<version>-setup.exe`: the installer (**recommended**). It sets up the firewall for you and opens the
  setup guide at the end.
- `EncoreBridge-<version>-win64.zip`: the portable version. No admin rights needed; you handle a firewall prompt
  yourself.

### 5.2 "Windows protected your PC" (SmartScreen)

Encore's Windows files are **not code-signed** in this release (signing certificates cost money every year). Windows
SmartScreen warns about them the first time:

1. In the blue "Windows protected your PC" window, click **More info**.
2. Check that the app name is the file you downloaded, then click **Run anyway**.

Only do this for a file you downloaded from Encore's release page.

Microsoft Defender may also flag a new unsigned program by mistake. The release files are submitted to Microsoft as
false positives before each release. If Defender still quarantines a file from the release page, restore it from
**Windows Security → Virus & threat protection → Protection history**.

### 5.3a Install with the installer

1. Run `EncoreBridge-<version>-setup.exe` and accept the administrator prompt.
2. Follow the pages. The installer suggests `C:\Program Files\Encore Bridge`. On **Select Additional Tasks**:
   - **Start Encore Bridge when I sign in to Windows** is ticked (recommended: phones can only play while it runs). You
     can change it later in the tray menu.
   - **Create a desktop shortcut** is not ticked.
3. Press **Install**. The installer:
   - installs Encore Bridge for all users of this PC,
   - adds a Windows Firewall rule named **Encore Bridge (phone)** that lets phones reach TCP port 8095 on **Private**
     and **Domain** networks only (it also lets in the port forward for listening away from home,
     [chapter 11](#11-listening-away-from-home)),
   - adds a Start-menu entry,
   - quits a running Encore Bridge first when you install a newer version over it.

   The installer asks nothing about Spotify. The setup guide's step 2 does that
   ([3.2](#32-give-the-bridge-the-client-id)).
4. On the last page, leave **Start Encore Bridge and open the setup guide** ticked and press **Finish**. (On an upgrade
   it says **Start Encore Bridge now**.) The icon (a black record on a green square) appears in the notification area
   near the clock. If you can't see it, click the `^` arrow there.
5. The setup guide opens in your browser ([chapter 6](#6-the-setup-guide)). Until setup is finished, the admin page
   opens again when you start Encore Bridge yourself (not when it starts with Windows). **Setup guide…** in the tray
   menu opens the setup guide at any time.

### 5.3b Or use the portable zip

1. Right-click the zip → **Properties**. If there is an **Unblock** box at the bottom, tick it and press **OK**. This
   avoids a SmartScreen warning for every file inside.
2. Extract it to a folder you own, for example `C:\Users\<you>\Encore Bridge`. Avoid `Program Files`: it is read-only
   for normal programs.
3. Run `Encore Bridge.exe` in that folder. Its icon appears in the notification area. The first time, the setup guide
   opens in your browser ([chapter 6](#6-the-setup-guide)).
4. The first time, **Windows Defender Firewall** asks about **Node.js JavaScript Runtime**. That is the bridge.
   - Tick **Private networks** only, and press **Allow access**.
   - **Don't press Cancel.** Cancel quietly creates a rule that blocks the bridge, and the phone will never reach it.
     If that happened, see [5.6](#56-fix-the-firewall). The setup guide's step 5 notices it too.
5. The zip doesn't start the bridge with Windows by itself. In the tray menu, tick **Start with Windows** so phones can
   still play after the PC restarts.

The zip keeps your data in the same place as the installer (`%LOCALAPPDATA%\Encore`,
[5.8](#58-where-windows-keeps-encores-data)), not in the program folder. Run only one copy at a time: starting a second
one only opens the admin page of the one that runs.

### 5.4 The tray menu

Click (or right-click) the Encore Bridge icon:

| Item | What it does |
|---|---|
| **Encore Bridge 1.1.0** | The version (not clickable) |
| Status line | **Starting…**, **Ready**, **Ready: pair your phone**, **Streaming to 1 phone**, or a problem to fix, such as **Set your admin password**, **Sign in to Spotify**, **Connect your Spotify account** or **Port 8095 is in use**. When it names a problem, click it to see what to do. |
| **Open Encore Bridge** | Opens the admin page in your browser (`http://127.0.0.1:8095/admin`) |
| **Setup guide…** | Opens the setup guide (`http://127.0.0.1:8095/admin?setup=1`, [chapter 6](#6-the-setup-guide)) |
| **Sign in to Spotify…** | Only while the engine needs it: shows the engine's sign-in code ([chapter 8](#8-sign-the-engine-in-to-spotify)) |
| **Phone address: http://…:8095** | The Home address to type into the app. Click it for the steps. While Showcase mode is on it reads **Phone address: hidden (Showcase)**. |
| **Encore Bridge 1.2.0 is available** ▸ | Only when a newer, checked version is out (the number is the new version's): **Update now…** (installer) or **Download…** (zip), and **What's new**, the release notes. While an update runs, this line shows its progress, with **Cancel update** ([chapter 18](#18-updating)). |
| **Showcase mode** | Hides the phone address and the sign-in code here, and names, addresses and codes on the admin page ([chapter 12](#12-anonymous-mode-and-showcase)) |
| **Keep this PC awake while streaming** | On by default: Windows doesn't sleep while a phone is listening |
| **Start with Windows** | Starts Encore Bridge when you sign in to Windows. The installer ticks it if you leave its option on; with the zip, tick it yourself |
| **Troubleshooting** ▸ | **Open log**, **Open logs folder**, **Edit settings…** (`settings.env` in Notepad), **Open data folder**, **Fix firewall…**, **Restart bridge** |
| **Check for updates** | Asks GitHub for a newer Encore Bridge now and tells you the answer. Encore Bridge also checks by itself once a day, quietly ([chapter 18](#18-updating)). |
| **About Encore Bridge** | Versions of the launcher, the bridge and the engine, where your data is, the license, and the update status (for example **Updates: up to date (checked 10 Oct 2026)**) |
| **Quit Encore Bridge** | Stops the bridge, the engine and ffmpeg, and removes the icon |

### 5.5 Set the network to Private

Windows treats networks marked **Public** as hostile and blocks incoming connections, so your phone can't reach the
bridge. Your home network must be **Private**. The setup guide's step 5, **Check your network**, tells you when it
isn't.

1. **Settings → Network & internet → Wi-Fi** (or **Ethernet**) → click your network.
2. Under **Network profile type**, choose **Private network**.

To check in PowerShell: `Get-NetConnectionProfile` should show `NetworkCategory : Private` for your home network.

Never allow the bridge on Public networks (cafés, hotels, airports).

### 5.6 Fix the firewall

If the phone can't reach the bridge even though the network is Private, use **Troubleshooting → Fix firewall…** in the
tray menu. The setup guide's step 5 sends you here when it finds a firewall problem. **Fix firewall…** first only looks,
and tells you what it found:

- **Block rules** for the bridge's `node.exe`. Windows creates these when its firewall prompt is cancelled.
- Whether an **Allow** rule lets phones reach the bridge's port on Private networks.
- Whether a network this PC uses is set to **Public** ([5.5](#55-set-the-network-to-private)).

If something needs fixing, it asks first, then Windows asks for administrator permission. It removes the Block rules
and adds the **Encore Bridge (phone)** rule for the bridge's current port, Private and Domain networks only. If
everything already looks right, it says so and changes nothing.

To do it by hand:

1. Press Win+R, type `wf.msc`, press Enter, and open **Inbound Rules**.
2. Look for rules named **Node.js JavaScript Runtime** or **Encore Bridge (phone)** with a red "no entry" icon (Block).
   Delete those Block rules.
3. Quit and restart Encore Bridge, and allow it on Private networks.

### 5.7 Sleep, sign-out and laptops

- The bridge only runs while you are **signed in** to Windows. Locking the screen is fine. Signing out or restarting
  stops it until you sign in again. (A Windows-service mode for PCs nobody signs in to may come later.)
- With **Keep this PC awake while streaming** on (the default), Windows won't sleep while a phone is listening. It can
  still sleep when nobody listens, and Encore Bridge can't wake a sleeping PC: the phone can't start a new song until
  the PC is awake again. To start listening from your phone at any time, set **Settings → System → Power & battery →
  Screen and sleep → When plugged in, put my device to sleep after → Never**.
- Laptops: keep it plugged in. If you close the lid, set the lid action to **Do nothing** when plugged in (Control
  Panel → Power Options → Choose what closing the lid does).

### 5.8 Where Windows keeps Encore's data

Your data lives in `%LOCALAPPDATA%\Encore` (paste that into the Explorer address bar):

| Path | What it holds |
|---|---|
| `settings.env` | Your settings, including the Client ID. Encore Bridge creates it from a template the first time it runs and never overwrites it; the setup guide only changes its `SPOTIFY_CLIENT_ID` line. |
| `data\` | Spotify sign-in, paired phones, the admin password (hashed), the Showcase switch, the setup guide's progress, Jam state, caches, phone diagnostics |
| `engine\` | The engine's settings (`config.yml`) and its saved Spotify sign-in (`state.json`) |
| `logs\` | The bridge log, `bridge.log` (5 MB, then rotated to `bridge.log.1` … `.3`) |
| `launcher.json` | The tray's own choices, such as Keep this PC awake |
| `update.json` | The update check's last result: times, version numbers, checksums and error codes, nothing about you ([chapter 18](#18-updating)) |
| `updates\` | Downloaded updates (the installer and its signed checksum list) and the installer's log (`setup.log`), one folder per version. A folder is removed once Encore Bridge runs that version (or a newer one), or after 30 days. |

The tray's **Troubleshooting → Open data folder** opens it. The program folder holds no personal data. On Windows,
only your user account (and administrators) can read `%LOCALAPPDATA%`; that keeps these files private. To keep the
data somewhere else, set the environment variable `ENCORE_HOME` to that folder before Encore Bridge starts.

### 5.9 Edit settings.env by hand

The setup guide saves your Client ID. Change the other settings in `settings.env` (the port, `ADMIN_ALLOW`, an
`ADMIN_PASSWORD`, [16.4](#164-bridge-settings)) by hand:

1. Tray menu → **Troubleshooting → Edit settings…**. Notepad opens `settings.env`.
2. Change the line, for example `PORT=8096`, and save. One setting per line; no quotes, and no notes on the same line.
3. Tray menu → **Troubleshooting → Restart bridge**. The bridge reads the file when it starts.

The Client ID can go here too (`SPOTIFY_CLIENT_ID=<your-client-id>`, then **Restart bridge**). Close Notepad before you
use the setup guide's step 2. If Notepad saves the file later, it puts back the Client ID it had open.

### 5.10 Find the PC's address

The phone needs the PC's **local IP address**. The setup guide (steps 5, 7 and 8), the tray menu
(**Phone address: http://…:8095**) and the admin page's **Phone setup** card all show it, ready to type into the app.
They skip virtual and VPN adapters. You can also run `ipconfig` and use the **IPv4 Address** of your Wi-Fi or
Ethernet adapter (not a "vEthernet", VPN or Tailscale adapter).

Give the PC a fixed address in your router (a "DHCP reservation") so it doesn't change. The phone's Home address and
the port forward for listening away from home ([chapter 11](#11-listening-away-from-home)) both point at it.

### 5.11 Port already in use

If the tray's status says **Port 8095 is in use** or **Port 8095 is blocked by Windows**, another program has the
port, or Windows reserved it (Hyper-V, WSL and Docker reserve port ranges). Click the status line for the details.

- To see reserved ranges: `netsh int ipv4 show excludedportrange protocol=tcp`
- To use another port:
  1. **Troubleshooting → Edit settings…**: change `PORT=8095` to another port, for example `PORT=8096`, and save.
  2. **Troubleshooting → Restart bridge**.
  3. **Troubleshooting → Fix firewall…**. The installer's rule only covers 8095; this adds the rule for the new port.
  4. In the app, use the new port in the Home address. If you forward a port for listening away from home, change
     both the external and the internal port of the forward to the new port. The setup guide's step 8 then shows the
     matching values and Away address. Update the Away Address in Encore
     ([11.1](#111-forward-the-port-setup-guide-step-8)).

Next: [the setup guide](#6-the-setup-guide).

---

## 6. The setup guide

The setup guide is a step-by-step page inside the bridge's admin page. It takes you from a new bridge to music on your
phone. It ticks off each step (✓) as soon as the bridge sees it done. The tutorials ([Windows](TUTORIAL-WINDOWS.md),
[Docker](TUTORIAL-DOCKER.md)) follow it.

### 6.1 Opening it

- **Windows:** the installer's last page, **Start Encore Bridge and open the setup guide**, opens it. Until setup is
  finished, starting Encore Bridge yourself (not when it starts with Windows) opens the admin page again. It shows the
  setup guide, or, if you closed the guide, the **Continue setup** banner (6.4).
- **Docker:** the first visit to `http://<your-bridge-address>:8095/admin` shows it.
- **At any time:** the **Setup guide** button in the admin page's header, **Setup guide…** in the Windows tray menu,
  or the admin page's address with `?setup=1` at the end (`/admin?setup=1`).

Until the bridge has an admin password, the guide shows step 1, **Protect this page**. The other steps are listed as
locked ("Choose your admin password first"), and nothing else on the admin page works
([chapter 7](#7-the-admin-page-and-your-admin-password)).

### 6.2 The nine steps

Each step's page says **Step 3 of 9** (and so on) above its title.

| Step | Title | What you do | It ticks itself when | More |
|---|---|---|---|---|
| 1 | **Protect this page** | Choose the admin password (Docker: with the setup code from the log) | the password is set | [Chapter 7](#7-the-admin-page-and-your-admin-password) |
| 2 | **Your Spotify developer app** | Create your developer app, paste its Client ID, press **Save Client ID** | the bridge has a Client ID | [3.1](#31-create-the-app), [3.2](#32-give-the-bridge-the-client-id) |
| 3 | **Connect your Spotify account** | Press **Connect**, then **Agree** on Spotify (Docker: paste the address, **Use this address**) | the account is connected | [3.4](#34-connect-your-spotify-account) |
| 4 | **Sign in the Encore engine** | Windows: approve the code at spotify.com/pair. Docker: pick **Encore** once in a Spotify app | the engine is signed in | [Chapter 8](#8-sign-the-engine-in-to-spotify) |
| 5 | **Check your network** | Read the checks, fix what has a ✗, press **Check again** | every check passes, or a phone is paired | [6.5](#65-the-network-check) |
| 6 | **Put Encore on your phone** | Add the Encore repo in Cydia on the phone, install **Encore**, press **I've installed it** | a phone is paired (the bridge can't see Cydia) | [Chapter 9](#9-install-the-app-from-the-encore-repo) |
| 7 | **Pair your phone** | Type the Home address and the code into the app | a phone pairs | [Chapter 10](#10-pair-your-phone-at-home) |
| 8 | **Listen away from home** | Forward TCP 8095 on your router, press **Find my public IP**, type the Away address into Encore, test on mobile data | a paired phone reaches the bridge from outside your home network | [6.6](#66-listen-away-from-home-step-8), [chapter 11](#11-listening-away-from-home) |
| 9 | **Play a song** | Play a song from the app | about a second of music reached the phone | [Chapter 13](#13-feature-tour) |

Step 3 needs step 2 (without a Client ID it says "Save your Client ID first."). Every other step works on its own.

Steps 3, 4, 7, 8 and 9 wait for something outside the page. Their waiting line turns into a ✓ line by itself:
"Waiting for Spotify…", "Waiting for you to approve the sign-in…", "Waiting for Encore to be picked in a Spotify app…",
"Waiting for your phone…", "Waiting for your phone to connect from outside your home network…" or "Waiting for music
on your phone…".

Step 7 gets a pairing code when you open it, and a new one when that code's 5 minutes run out. It does this only while
the page is on screen, up to three times in a row, and not once a phone has paired at this step, so a valid code never
lingers in a forgotten browser tab. Otherwise it says **This code has run out. Press New code for another one.**
**New code** makes one at once. If phones were paired before, the step says how many and ticks when another one pairs.

### 6.3 Moving around

- **The step list** shows each step's number, title, and ✓ or **Skipped**. On a wide screen it sits beside the steps;
  on a narrow one it is behind **All steps**. Click a step to go there.
- **Back** and **Next** move one step. **Next** always works; a step that isn't done stays unticked.
- **Skip for now** (on step 6: **I've installed it**) marks a step skipped and moves on. Step 1 can't be skipped. A
  skipped step that gets done later shows ✓. You can go back to it at any time.
- **Copy** copies a value and reads **Copied** for a moment. Some browsers don't allow copying from a plain `http://`
  page. The page then selects the text and asks you to press Ctrl+C (⌘C on a Mac).
- **Finish** on step 9 always ends the guide, whatever isn't done yet. The **Setup complete** page then shows every
  step with ✓, **Skipped** or **Not done yet**, a **Go to step** link for the unfinished ones, and **Open the admin
  page**. While step 8 isn't done, a highlighted note under the list says **Listen away from home** isn't set up yet,
  so Encore plays only on your home Wi-Fi.

### 6.4 Closing it, and coming back

The ✕ at the top (**Close the guide**) takes you to the admin page's cards. While setup isn't finished, the admin page
then shows a **Setup isn't finished.** banner with a **Continue setup** button, and the guide stops opening by itself.
Step 1 has no ✕ while there is no admin password, because there is nothing else to show yet.

**Already set up?** A bridge with an admin password, a Client ID, a connected Spotify account and at least one paired
phone counts as set up, also right after an update from an earlier version. There the guide never opens by itself.
Opened with **Setup guide**, it shows each step's current state (review mode): nothing changes unless you act, and
changing the Client ID asks first ([3.3](#33-change-the-client-id)). A finished setup stays finished, even if you later
unpair every phone.

### 6.5 The network check

Step 5, **Check your network**, runs when you open it and when you press **Check again**. It only looks; it changes
nothing. It checks:

- **This computer's address** on your home network: the same address the admin page's **Phone setup** card shows.
- **Encore Bridge is listening on port 8095**: the bridge tries to reach itself at that address.
- **Windows only:** the **network profile** (Private, Public or Domain) of the connection that holds that address.
- **Windows only:** **Windows Firewall**: whether a rule blocks the bridge's `node.exe`, and whether an Allow rule lets
  phones reach its port on Private networks. The installer's **Encore Bridge (phone)** rule counts but isn't required.
  The portable zip has none, and any other Allow rule for the port works as well.

On Windows the bridge reads the profile and the firewall rules with one fixed PowerShell command, in a hidden window,
without administrator rights. It never reads your Wi-Fi network's name. Only **Fix firewall…** in the tray menu changes
firewall rules.

On Docker (and other Linux machines) the step lists this machine's home-network addresses (the one Encore uses first)
and checks the port. It can't see a firewall on the machine ([4.7](#47-network-ports-docker)). Under the list it
says: "Your phone must be on the same network as this computer: the same Wi-Fi, not a guest network."

When all is well, the lines read "This computer's address: 192.168.1.20", "Encore Bridge is listening on port 8095",
"Network profile: Private" and "Windows Firewall lets your phone in". For the problems it can report and how to fix
each, see [17.1](#171-setup-and-pairing).

### 6.6 Listen away from home (step 8)

Step 8 sets up a **port forward** on your router so your phone can reach the bridge away from home. It is optional:
skip it if you only listen at home, but then Encore plays only on your home Wi-Fi. It has three parts;
[11.1](#111-forward-the-port-setup-guide-step-8) explains each in detail.

1. **Forward the port on your router.** The step shows the rule to add: **Protocol** `TCP`, **External port** `8095`,
   **Forward to (internal address)** this computer's home-network address (for example `192.168.1.20`, with a
   **Copy** button), **Internal port** `8095`. It asks for a DHCP reservation, so that address stays this computer's.
   If the computer has more than one home-network address, a line lists the others: use the one your router lists for
   this computer. It also says what this computer's firewall needs, and that your router's admin page is at this
   computer's default gateway.
2. **Find your Away address.** **Find my public IP** asks a public IP-check service for your home's public IP
   ("Finding your public IP…", at most about 12 seconds). It shows **Your Away address:**
   `http://<your-public-ip>:8095` with a **Copy** button, and where it goes: Encore → **Settings** → **Away Address**
   (on Encore's setup screen, the **Away** field). The button then reads **Check again**. If the IP can't work for a
   port forward, you get **Your public IP:** and a warning instead of an Away address
   ([carrier-grade NAT and double NAT](#carrier-grade-nat-and-double-nat)). Below, the step reminds you that a home's
   public IP can change, and how to check for carrier-grade NAT by hand.
3. **Test it.** With the phone's Wi-Fi off, Encore → **Settings** → **Status** should say **Away**. The step then
   says **✓ Your phone reached Encore Bridge from outside your home network.** Under **Is this safe?**, it asks you
   to check once, from outside, that the admin page says **Not from this address.**
   ([11.2](#112-what-a-port-forward-exposes)).

**What ticks it:** the first request from a paired phone (signed with its key) from an address outside the private
ranges: a public address, not your home network, not a VPN. Requests over your home Wi-Fi (even to the Away address)
and over the iPhone's VPN don't count. If you use the VPN instead of a port forward
([11.3](#113-alternative-your-iphones-built-in-vpn)), this step never ticks: skip it. The bridge keeps only the time,
never the address.

**The public IP:** the bridge looks it up only when you press the button. It keeps the answer in memory for 30 seconds
and never writes it to disk or the log ([where the bridge connects](#where-the-bridge-connects)). While Showcase is on,
the button is gone and the step says "Showcase is on, so your public IP stays hidden. Turn Showcase off to find it."

**Coming back later** (a new public IP, a new router): open this step with **Listen away from home** on the admin
page's **Phone setup** card, or with **Setup guide**. This also works on a bridge set up before step 8 existed.

### 6.7 Showcase

With Showcase on ([chapter 12](#12-anonymous-mode-and-showcase)), the setup guide hides the same things as the rest of
the admin page:

- Home-network addresses: steps 5, 7 and 8 say **Hidden (Showcase)** and "Turn Showcase off to see the address".
- The public IP: step 8 doesn't look it up, and one already shown disappears at once.
- Every part of the Client ID.
- Codes: they show as dots. Press and hold them to see them.
- Step 3's connect flow, because Spotify's page shows your account.

The Encore repo's address (step 6) is public and stays. Songs may show. Switching Showcase on redraws the page at once.

### 6.8 What it remembers

`data/wizard.json` in the bridge's data folder keeps which steps you skipped, whether you closed or finished the guide,
and when a phone first reached the bridge from outside your home network and music first played. It holds no names, no
addresses (neither a phone's nor your home's public IP) and no codes. Deleting it only makes the guide start over (a
bridge that is already set up marks itself finished again).

---

## 7. The admin page and your admin password

The admin page is the bridge's control panel. It holds the setup guide and the cards you use later
([chapter 16](#16-admin-page-reference)): the Spotify account, the engine's sign-in, pairing codes for phones, and
checks that everything works.

- **Docker:** open `http://<your-bridge-address>:8095/admin` from a computer on your home network.
- **Windows:** tray menu → **Open Encore Bridge** (`http://127.0.0.1:8095/admin`). After the installer, it opens by
  itself.

### Who can open it

The admin page answers only requests that come from an address in `ADMIN_ALLOW` **and** carry the **admin password**.
The default `ADMIN_ALLOW`, `private`, means your home network (the private ranges `10.x`, `172.16–31.x` and
`192.168.x`), the bridge machine itself, VPN overlay addresses such as Tailscale's (`100.64.0.0/10`), and the IPv6
local ranges.

Anything else gets **Not from this address.**, even if you forward port 8095 on your router. Requests that come through
a proxy are refused too, with a message saying so ([chapter 11](#11-listening-away-from-home)).

### First visit: Protect this page

If you didn't put `ADMIN_PASSWORD` in your settings, the first visit opens the setup guide at step 1, **Protect this
page**. Type the new password twice (at least 8 characters). In most cases you also need a one-time **setup code**:

- **Windows, on the PC that runs Encore Bridge:** no code. The installer and the tray open the page on the PC itself,
  which is enough.
- **Docker, or Windows from another device:** the code is in the bridge's log. It looks like `ABCD-EFGH-JKMN`. The
  bridge prints a new one every time it starts, until a password is chosen.
  - Docker (the step shows this command with a **Copy** button):

    ```sh
    docker compose logs gateway | grep "setup code"
    ```

  - Windows: tray menu → **Troubleshooting → Open log**, and look for "setup code".

Press **Save password**. The page reloads into step 2 and your browser asks for the password. **Any user name works**;
only the password counts. The browser asks again on every new visit.

Use a long, unique password: anyone on your home network, guests included, can reach the admin page's login.

- The password is stored as a salted hash in `data/admin.json` (Windows: `%LOCALAPPDATA%\Encore\data\admin.json`),
  never in clear.
- 10 wrong passwords (or wrong setup codes) from one address within 15 minutes lock that address out for 15 minutes.
  The page then says **Too many wrong passwords. Try again later.**
- `ADMIN_PASSWORD` in `.env` / `settings.env` always wins over the stored one. The setup guide's step 1 then says
  your password is set in the bridge's settings.

**Forgot the password?** Stop the bridge (Windows: **Quit Encore Bridge**), delete `admin.json` from the bridge's
`data` folder, and start it again. On Docker, in the `gateway` folder: `docker compose down`, then
`sudo rm data/admin.json` (the bridge's files belong to root), then `docker compose up -d`. The admin page shows step 1,
**Protect this page**, again, with a new setup code in the log. Everything else stays: the Client ID, your sign-ins,
the paired phones. Or set `ADMIN_PASSWORD` in your settings and restart. That password then works, and the stored one
is ignored while it is set.

---

## 8. Sign the engine in to Spotify

The engine is a Spotify Connect speaker named **Encore**. It signs in to your Spotify account once and remembers the
sign-in, also after restarts. Until then, every song list in the app fails with *"Encore's player is reconnecting to
Spotify."*

**Use the same Spotify account as the bridge's Spotify account ([3.4](#34-connect-your-spotify-account)).** Encore's
library comes from both, and nothing stops you from mixing two accounts by mistake.

The setup guide's step 4, **Sign in the Encore engine**, and the admin page's **Engine sign-in** card show whether the
engine is signed in, and what to do next:

| The page says | Meaning |
|---|---|
| **Signed in.** "Encore" shows up as a speaker in your Spotify apps. | Done. Below it: **The same Spotify account as the card above**, or a warning if the engine uses **another Spotify account** than the bridge's Spotify account. Use one account for both. |
| **Not signed in yet.** Song lists and playback need this once. | Follow the steps for your platform below. The page shows them too. |
| **Waiting for you to approve the sign-in.** | A code sign-in is running: open the link and enter the code. |
| **The engine is starting…** | Windows: wait a moment. |
| **The engine isn't answering.** | It may still be starting. Docker: `docker compose ps` and `docker compose logs engine`. Windows: the log ([17.6](#176-the-bridge-machine)). |
| **The engine program is missing.** / **The engine doesn't match this Encore Bridge, so it isn't started.** / **The engine keeps stopping right after it starts.** | Windows only: see [17.6](#176-the-bridge-machine). |

### Docker: pick "Encore" once in Spotify (default)

1. On a phone, tablet or computer **on the same home network**, open the normal Spotify app, signed in to the same
   account.
2. Play any song.
3. Open the devices menu (the speaker icon, "Connect to a device") and pick **Encore**.
4. After a few seconds the song plays on Encore, and the setup guide (or the Engine sign-in card) shows the engine as
   signed in. You can switch back to your own device now.

This uses "zeroconf" discovery on your network. If **Encore** doesn't appear in the list, see
["Encore" is missing from Spotify's device list](#176-the-bridge-machine).

**Alternative: sign in with a code.** If discovery can't work on your network (separate VLANs, guest Wi-Fi, a NAS that
blocks it), switch the engine to the code sign-in:

1. In `engine/config.yml`, set:

   ```yaml
   credentials:
     type: device_auth
   ```

2. Restart the engine: `docker compose restart engine`
3. The setup guide's step 4 (and the Engine sign-in card) says **Waiting for you to approve the sign-in** and shows a
   link and a code. They are also in `docker compose logs engine`.
4. Follow the Windows steps below from step 2.

### Windows: sign in with a code (default)

The Windows engine doesn't use discovery, so it opens no port that other devices could reach. It signs in with a code
that you approve on Spotify's website.

1. The setup guide's step 4 shows the sign-in page's address and a short code, in large type. (The tray's **Sign in to
   Spotify…** and the admin page's Engine sign-in card show the same link and code.)
2. Open that page (on the PC or on your phone) and log in with the same Spotify account as in 3.4.
3. If it asks for a code, type the code, and approve.
4. After a few seconds the setup guide says **✓ Signed in.**, and the tray's status moves on.

A code works for a few minutes. When it runs out, a new one appears by itself.

**If Spotify doesn't accept the code sign-in** (the page reports an error, or the step never gets past **Waiting for
you to approve the sign-in**), switch the Windows engine to discovery, as on Docker:

1. Tray menu → **Troubleshooting → Open data folder**, then open `engine\config.yml` with Notepad.
2. Change `zeroconf_enabled: false` to `zeroconf_enabled: true`, and replace the `credentials:` block with:

   ```yaml
   credentials:
     type: zeroconf
     zeroconf:
       persist_credentials: true
   ```

3. Save, then **Troubleshooting → Restart bridge**. If Windows Firewall asks about the engine (`encore-engine.exe`),
   allow it on **Private networks** only.
4. Pick **Encore** once in a Spotify app on the same network
   ([Docker steps](#docker-pick-encore-once-in-spotify-default) above).

Discovery makes the Encore speaker visible to everyone on your home network. That is why it is off by default on
Windows.

### Where the engine's sign-in is kept

- Docker: `engine/state.json` next to `compose.yaml`.
- Windows: `%LOCALAPPDATA%\Encore\engine\state.json`.

Treat it like a password. To sign the engine out, stop the bridge and delete that file. Or use "Sign out everywhere" on
your Spotify account page, which signs out all your devices.

---

## 9. Install the app from the Encore repo

The app is a Debian package, `Encore_<version>_iphoneos-arm.deb`. You install it from the **Encore repo**, a Cydia
repo on the internet. Add the repo to Cydia once; Cydia then installs Encore, and later its updates, from it. The
bridge itself doesn't hand out the app. The setup guide's step 6, **Put Encore on your phone**, and the admin page's
**Phone setup** card show the repo's address with a **Copy** button. The address:

```
https://mbucc9000.github.io/slopkit/
```

### 9.1 Add the repo and install

This works on any Wi-Fi or mobile data; the phone doesn't need to be at home.

1. On the phone, open **Cydia** → **Sources** → **Edit** → **Add**.
2. Type the address exactly, with `https://` and the `/` at the end: `https://mbucc9000.github.io/slopkit/`. Tap
   **Add Source**, and wait while Cydia loads it.
3. Tap the new source in the list of sources, then **All Packages** (Cydia lists a source's sections first), then
   **Encore**, then **Install** and **Confirm**. You only need **Encore** from it.
4. When Cydia is done, tap **Return to Cydia**.
5. In the setup guide, press **I've installed it**. The bridge can't see Cydia, so step 6 gets its ✓ when the phone
   pairs in step 7.

On the first install, the package refreshes the home screen so the Encore icon appears.

> **Never run `uicache` yourself, and never as root.** Running it as root can make other sideloaded apps disappear from
> the home screen. If the Encore icon doesn't appear, **respring** instead (for example from your jailbreak tool's
> menu, or with `killall SpringBoard`).

If Cydia can't add the repo, check the address letter by letter and check that the phone is online. Then try again. If
it still fails, install the app as in [9.3](#93-other-ways-to-install-the-app).

### 9.2 Updates

New versions of Encore come to the Encore repo. Open Cydia → **Changes** → **Refresh**; a new Encore shows up as an
update. Keep Encore and Encore Bridge on the same version
([which versions work together](#which-versions-work-together)): update the bridge first ([chapter 18](#18-updating)),
then the app.

### 9.3 Other ways to install the app

Without Cydia, or if Cydia can't load the Encore repo, download `Encore_<version>_iphoneos-arm.deb` from the project's
release page and install it:

- **With Filza or iFile:** copy the `.deb` to the phone (for example by downloading it in Safari and opening it in
  Filza, or over USB with a file manager), tap it, and tap **Install**.
- **Over SSH or a terminal on the phone:** as root:

  ```sh
  dpkg -i Encore_<version>_iphoneos-arm.deb
  ```

Then press **I've installed it** in the setup guide's step 6. You don't need MobileSubstrate, AppSync or any other
tweak. The `uicache` warning in 9.1 applies here too. To update, download the new `.deb` and install it over the old
one.

---

## 10. Pair your phone (at home)

Pairing gives your phone its own secret key for the bridge. **Pair at home, on your home Wi-Fi.** The bridge refuses
pairing requests from the internet. The setup guide's step 7, **Pair your phone**, shows the address and a code.

1. Connect the phone to your **home Wi-Fi**.
2. Open **Encore**. The setup screen ("An unofficial Spotify client for iOS 6") shows three fields: **Home**, **Away**
   and **Code**.
3. **Home:** the bridge's local address and port, for example `192.168.1.20:8095`. The setup guide's step 7, the admin
   page's **Phone setup** card and, on Windows, the tray's **Phone address** show the exact value. You can leave out
   `http://`; Encore adds it. **Don't leave out `:8095`**: Encore doesn't add the port.
4. **Away:** leave it empty for now. The setup guide's next step, **Listen away from home**, finds that address
   ([chapter 11](#11-listening-away-from-home)).
5. **Code:** the six digits from the setup guide's step 7, or from **New pairing code** on the admin page's **Pair a
   device** card. A code works once, for 5 minutes.
6. Tap **Connect**.
7. "Pairing…" turns into **Connected**, and Encore opens on Home. The setup guide says **✓ Your phone is paired.**

The admin page's paired-devices list now shows your phone by the name in **Settings → General → About → Name**. If
[Anonymous Mode](#12-anonymous-mode-and-showcase) was on while you paired, it shows only the model, such as "iPhone".

### How Encore picks an address

Encore checks the route when it starts, comes back to the foreground, or loses the connection. It tries **Home** first
with a short timeout (1.5 seconds), then **Away** with a longer one (6 seconds), and uses the one that answered.
Settings shows the route in use: **Status: Home · 14 ms** or **Away · 88 ms**.

### Security, briefly

- Every request after pairing is **signed** with the phone's key. Without that key, a stranger who reaches your bridge
  can't control it, read your library or play anything.
- The key travels over the network only once, in the pairing answer. That is why pairing only works at home.
- A lost or sold phone: **Unpair** it on the admin page. That revokes its key. Unpairing *in the app* only makes the
  phone forget the bridge; the bridge trusts that key until you unpair it on the admin page.

---

## 11. Listening away from home

At home, the phone reaches the bridge over your Wi-Fi. Away from home (on mobile data or someone else's Wi-Fi), it
needs a way back in:

- **A port forward** on your router: the main way. The setup guide's step 8, **Listen away from home**, walks you
  through it and finds the address to type into Encore ([11.1](#111-forward-the-port-setup-guide-step-8)).
- **Your iPhone's built-in VPN**, if you want the stream encrypted ([11.3](#113-alternative-your-iphones-built-in-vpn)).

Both need a public IP at home. Behind carrier-grade NAT, neither can reach you
([carrier-grade NAT and double NAT](#carrier-grade-nat-and-double-nat)).

> **Not possible on iOS 6:** Tailscale, WireGuard, ZeroTier and similar overlay-VPN apps have no iOS 6 version. They
> still help you reach the **admin page** from a laptop, because the admin page accepts their addresses.
>
> **Not supported in this release:** HTTPS reverse proxies and tunnels (Caddy, nginx, Traefik, Cloudflare Tunnel,
> ngrok and so on). iOS 6's old TLS support is untested against them, and a proxy on the bridge machine makes every
> internet request look local to the bridge. The bridge refuses admin requests that arrive through a proxy.

### 11.1 Forward the port (setup guide step 8)

Your router passes TCP port 8095 from the internet to the computer that runs the bridge. Keep the setup guide's step 8
open while you set it up (**Setup guide**, or **Listen away from home** on the admin page's **Phone setup** card): it
shows the values for your network.

**1. Give the bridge's computer a fixed address.** The forward points at the computer's address on your home network,
the one the setup guide shows in steps 5, 7 and 8 (for example `192.168.1.20`). In the router, look for **DHCP
reservation** (or **Address reservation**, **Static lease**) and reserve that address for this computer
([4.6](#46-find-and-fix-the-bridges-address), [5.10](#510-find-the-pcs-address)). Otherwise the computer may get
another address one day, and the forward then points at nothing.

**2. Add the port forward.** Open your router's admin page in a browser and sign in. Its address and password are often
printed on the router or in its manual. Its address is the computer's **default gateway**:

- Windows: run `ipconfig` in Command Prompt and use the **Default Gateway**.
- Linux: run `ip route` and use the address after `default via`.

Find **Port forwarding**. Routers also call it **Virtual server**, **NAT**, **Port mapping** or **Applications &
gaming**, often under **Advanced**, **Firewall** or **NAT**. Add one rule:

| In the router | Value |
|---|---|
| Protocol | `TCP` ("TCP/UDP" or "Both" works too) |
| External port (also "public port", "WAN port") | `8095` |
| Forward to (also "internal address", "LAN IP", "server IP", or the computer picked from a list) | the bridge computer's address, for example `192.168.1.20` |
| Internal port (also "private port", "LAN port") | `8095` |

Save it. Some routers also want the rule switched on. Forward **this one port only**. Don't use the router's **DMZ**
("exposed host") option: it passes every port of the computer to the internet. Encore doesn't use UPnP, so you don't
need to switch it on.

You can pick another external port, for example external `18095` → internal `8095` (for a second bridge, or when your
provider blocks a port). The Away address then uses the external port: `http://<your-public-ip>:18095`. The setup guide
builds the Away address with the bridge's own port, so change the port when you type it into Encore.

**3. Let the connections in on the bridge's computer.**

- **Windows:** nothing to do. The installer's firewall rule **Encore Bridge (phone)** (and the one **Fix firewall…**
  makes) lets the forwarded connections in while the network is set to **Private**
  ([5.5](#55-set-the-network-to-private)). The setup guide's step 5 checks this. With the portable zip, the rule
  Windows made when you allowed **Node.js JavaScript Runtime** on Private networks does the same.
- **Docker:** the bridge uses the machine's own network (host networking), so the forward points at the machine's
  address. If the machine runs a firewall (ufw, firewalld, a NAS firewall), allow TCP 8095 from anywhere, not only from
  your home network. For example `sudo ufw allow 8095/tcp`, or `sudo firewall-cmd --permanent --add-port=8095/tcp`
  followed by `sudo firewall-cmd --reload`.

**4. Find your Away address.** Your Away address is your home's public IP plus Encore's port. In the setup guide's
step 8, press **Find my public IP**. The bridge asks a public IP-check service
([where the bridge connects](#where-the-bridge-connects)). After a few seconds it shows **Your Away address:**
`http://203.0.113.7:8095` (yours is different) with a **Copy** button. Without the setup guide: your router's status
page shows the same IP as its **Internet** (or WAN) address, and the Away address is `http://<your-public-ip>:8095`.

If no service answers, the step says "Couldn't find your public IP: no IP-check service answered. Check that this
computer is online and press Find my public IP again, or look it up in your router's admin page (its Internet or WAN
address)."

**5. Type it into Encore.** On the phone: Encore → **Settings** → **Away Address**, type the address and tap **Save**.
On the setup screen of a phone that isn't paired yet, it goes in the **Away** field. You can leave out `http://`, but
not the port. In Anonymous Mode the addresses read **Hidden** and can't be edited: switch the mode off while you type
([chapter 12](#12-anonymous-mode-and-showcase)).

**6. Test it.** Turn the phone's Wi-Fi off so it uses mobile data. (An iPod touch has none: join another Wi-Fi
instead, for example your phone's hotspot.) Open Encore → **Settings**. **Status** should say **Away** with a delay,
for example **Away · 88 ms**. Play a song to be sure. The setup guide's step 8 then says **✓ Your phone reached Encore
Bridge from outside your home network.**

Test on mobile data, never on your home Wi-Fi. Many routers can't reach their own public IP from inside (they lack
"NAT loopback", also called "hairpin NAT"), so a test at home can fail although the forward works. A router that can do
it lets the phone in from a home address, which doesn't tick step 8. Back home, Encore uses the Home address again by
itself ([how Encore picks an address](#how-encore-picks-an-address)).

#### When your public IP changes

Most home internet connections get a public IP that changes now and then, for example when the router restarts or the
provider renews it. Encore then stops connecting away from home (**Status: Offline**). Open the setup guide's step 8,
press **Find my public IP** again, and update the Away Address on each phone.

To avoid this, use a **dynamic DNS** name: a name that always points at your current public IP. Many routers have it
built in (look for **DDNS** or **Dynamic DNS**), with a free name from the router's maker or a dynamic DNS provider.
Type `http://<that name>:8095` as the Away address once; the name follows your IP.

#### Carrier-grade NAT and double NAT

A port forward only works when your router has a public IP of its own. Two set-ups stop it:

- **Carrier-grade NAT (CGNAT):** your internet provider shares one public IP between many homes, so nothing from the
  internet can reach your router. It is common with mobile (4G or 5G) home internet and satellite, and some cable and
  fibre providers use it too.
- **Double NAT:** another router sits in front of yours, often the provider's modem-router with your own router behind
  it.

**How to tell:** find your router's **Internet** (WAN) address on its status page. Compare it with the IP **Find my
public IP** found:

- The same IP: fine.
- A different one, and the bridge's computer runs a VPN app: turn the VPN app off and press **Check again**. With it
  on, the IP-check service sees the VPN's address.
- Still a different one, or one that starts with 10., 100.64 to 100.127, 172.16 to 172.31 or 192.168.: CGNAT
  (providers use 100.64 to 100.127, `100.64.0.0/10`, for it) or double NAT (a private address from the router in
  front).

This comparison is the real test. Behind CGNAT the IP-check service usually sees your provider's shared public IP,
which looks like any other. The setup guide warns by itself only when the IP it finds is a shared or non-public
address. It then shows **Your public IP:** without an Away address, and one of these:

- "This IP (100.64 to 100.127) is a shared address of your internet provider (carrier-grade NAT), so a port forward
  can't reach your home through it. Remove the port forward you added: here it would only let your provider's other
  customers in. Ask your provider for a public IPv4 address: without one, a VPN server at home can't be reached
  either."
- "This isn't a public IP, so a port forward can't reach your home through it. Check your router's Internet (WAN)
  address, or use a VPN instead (see the guide)."

**What to do:**

- **CGNAT:** first **remove the port forward** you added. It can't reach you from the internet. But on many CGNAT
  networks your provider's other customers can reach your router, and their addresses (100.64 to 100.127) count as
  home to the admin page and pairing. (The default `ADMIN_ALLOW` lets that range in for VPN overlays such as
  Tailscale.) Then ask your provider for a public IPv4 address. Many give one on request, some for a fee (sometimes
  sold as a "public IP" or "static IP" option).
- **Double NAT:** put the box in front into bridge (modem-only) mode, so your own router gets the public IP. Or add
  the same forward on the box in front too, pointing at your router's Internet (WAN) address, port 8095.
- **A VPN instead** ([11.3](#113-alternative-your-iphones-built-in-vpn)): a VPN server at home must be reachable from
  the internet too. Behind double NAT, the box in front has to forward the VPN's ports. Behind CGNAT, it needs a
  public IPv4 address, like a port forward.

### 11.2 What a port forward exposes

| Reachable from the internet | Not reachable |
|---|---|
| The bridge's signed phone API: useless without a paired phone's key | The admin page: it answers **Not from this address.** to internet addresses, even with the port open |
| Two plain-text lines at `/`, starting with "Encore gateway" (they tell a scanner that an Encore Bridge lives here) | Pairing: it only answers your home network, so a phone's key never crosses the internet |
|  | The setup guide's public-IP check: it is part of the admin page |
|  | The engine (port 3678 listens on the machine itself only) |

**Before you forward, read this:**

- **Every phone request is signed** with the key the phone got when you paired it. Without that key, nobody can
  control your bridge, read your library or play anything.
- **The admin page and pairing answer only your home network**, with the port open or not
  ([chapter 7](#7-the-admin-page-and-your-admin-password), [chapter 10](#10-pair-your-phone-at-home)). (They also
  answer VPN-overlay addresses, 100.64 to 100.127: behind carrier-grade NAT, remove the forward,
  [see above](#carrier-grade-nat-and-double-nat).) This relies on your router passing on where each connection comes
  from. Almost all do. **Check it once:** from outside your home network (on mobile data), open your Away address with
  `/admin` at the end in Safari. It must say **Not from this address.** If the admin page asks for a password instead,
  your router hides internet addresses from the bridge: remove the port forward and use the VPN
  ([11.3](#113-alternative-your-iphones-built-in-vpn)).
- **Everything is plain HTTP.** On public Wi-Fi or a mobile network, someone on the path can see which songs you play
  and the cover pictures, and could record the audio. They can't control your bridge, but a recorded request could be
  replayed for up to five minutes.
- Forward **only** TCP 8095 (or your chosen external port). **Never** forward 3678, the engine's discovery ports, or
  anything else, and don't use the router's DMZ.
- Use a strong admin password ([chapter 7](#7-the-admin-page-and-your-admin-password)), and pair only at home.
- Unpair lost phones on the admin page right away.
- Keep the bridge updated.
- On Windows, a port forward exposes your everyday PC's port 8095 to the internet. Keep Windows updated, and set only
  your home network to **Private** (the firewall rule lets phones in only on Private networks).
- **Never post your public IP or your Away address**, for example in a bug report: it tells strangers where your bridge
  is.

### 11.3 Alternative: your iPhone's built-in VPN

iOS 6 has a built-in VPN client. If your home router or NAS can run a VPN server, the phone joins your home network
from anywhere, encrypted, and the bridge's port stays closed to the internet. It takes more setting up than a port
forward. The VPN server itself must be reachable from the internet: its router forwards the VPN's ports (many routers'
built-in VPN servers do that themselves).

1. **At home:** set up an **L2TP over IPsec** VPN server (with a pre-shared key) on your router or NAS. Many routers and
   NAS systems have one built in; follow their manual. Avoid **PPTP**: its encryption is broken.
2. **On the phone:** **Settings → General → VPN → Add VPN Configuration… → L2TP**, and fill in your server's public
   address (or dynamic-DNS name), your VPN account, password and the shared secret. (iOS 6 also offers Cisco IPsec if
   your server speaks that.)
3. In Encore, set **Away** to the **same address as Home** (Settings → Encore Bridge → Away Address). Over the VPN the
   bridge is reached at its home address. The Away try gives slow connections the longer 6-second timeout.
4. Away from home: turn the VPN on in Settings (iOS 6 doesn't do it by itself), then open Encore.

Over the VPN, Settings → Status usually reads **Home**, not **Away**, because Encore tries the Home address first and
the VPN reaches it. That is expected; the music plays the same. The setup guide's step 8 doesn't tick over a VPN,
because the phone comes in from a home address. Press **Skip for now** there.

### 11.4 How Encore behaves away from home

On the Away route the app asks the bridge for a bigger buffer (20 seconds instead of 10) and waits longer before it
gives up. Short dead spots on mobile data then don't stop the music.

---

## 12. Anonymous Mode and Showcase

To show Encore to someone, film it, or post screenshots without showing who you are, turn on **Anonymous Mode**. It
hides your identity and keeps the music.

### Turn it on

**Settings → Privacy → Anonymous Mode** ("Hides names, pictures, addresses and devices. Music stays."). It takes effect
at once on every screen. It stays on after you restart the app or unpair the phone. Nothing is deleted: turn it off to
see everything again.

While it is on, a second switch appears: **Hide My Playlist Names** (see below).

### What it hides

| Where | What you see instead |
|---|---|
| Your name and profile picture | "You", and a plain picture. Home's greeting drops your name. |
| Other people's names (profiles, followers, playlist owners, Jam members) | Made-up first names (with a letter, such as "Mila R.", once the list of names runs out). The same person always gets the same made-up name on every screen and, for the first 600 people, after a restart too; two people never share one. |
| Other people's pictures | Initials in a coloured circle. Real pictures aren't downloaded while the mode is on. |
| Follower and following counts | Hidden |
| Other people's playlist descriptions | Hidden (Spotify's own descriptions stay) |
| Other devices' names ("Listening on …", device messages) | What kind of device it is: "your computer", "your phone", "a speaker", "your TV" and so on, or "another device" |
| This iPhone's name (Settings → This Device) | The model, for example "iPhone". Pairing while the mode is on sends the model too, so the bridge never learns the phone's name. |
| Your Spotify name (Settings → Spotify) | "Signed in" |
| Bridge addresses in Settings | "Hidden". Editing them is blocked until you turn the mode off. |
| The Home, Away and Code fields on the setup screen (Anonymous Mode stays on after an Unpair) | Typed as hidden dots, like a password, and still editable: pairing works. To fix a mistake, retype the whole address (a hidden field is cleared when you start typing in it again). The hint under them doesn't name the address. |
| Bridge address and device id (Diagnostics) | Hidden |
| Jam | "Your Jam" instead of your name. The invite (link, QR code and Spotify Code) sits behind a **Show Invite** button, because an invite on a video lets anyone join. A shared invite says "Join this Jam on Spotify". |
| Bridge messages that name people, devices or playlists | Encore's own wording without names, for example "Only the Jam's host can control its playback." |
| People in Recent searches | Not shown |

### What it keeps

Songs, albums, artists and covers, other people's playlist names, lyrics, and the lock screen's Now Playing (it only
ever shows the song). Your music taste stays visible.

### Hide My Playlist Names

Your own playlists' names can be personal. This second switch renames them **My Playlist #1, #2, …** and hides their
descriptions and folder names. The numbers start from the bottom of your library, so the newest has the highest
number. It is off by default. Covers you uploaded yourself still show in this release.

Blends (playlists Spotify mixes from two people's taste) show as **Blend**, without their cover or description, even
with this switch off.

### Showcase on the bridge

The admin page has its own **Showcase** switch at the top right, for when the computer screen is on camera too. The
Windows tray's **Showcase mode** is the same switch. With Showcase on, the line under the page's header turns amber,
and:

- the **Spotify account** card says only **Connected**, without your name, and hides the connect steps,
- phones are listed as **Phone 1**, **Phone 2** … without ids, and their **Unpair** buttons are hidden,
- other devices show by their kind ("your computer"), never by name,
- the pairing code and the engine's sign-in code show as dots: press and hold them (or Space / Enter) to see them,
- the **Phone setup** card and the tray hide the bridge's address (the Encore repo's address stays: it is public),
- the setup guide hides addresses, any part of the Client ID, codes, your public IP and the Spotify connect steps
  ([6.7](#67-showcase)),
- the tray's **Sign in to Spotify…** shows the steps without the code,
- phone diagnostics can't be read.

Showcase stays on after a restart until you switch it off. It doesn't switch on Anonymous Mode on your phones; each
phone has its own switch. The bridge's log never contains people's or devices' names, in any mode.

### Tips for a clean demo

- Turn Anonymous Mode on before you start recording. Then close and reopen Encore once, so even the first screen you
  film comes up masked.
- To demo a Jam without real friends, use the **Fake Jam** in the admin page's **Advanced** section. It has made-up
  members and never talks to Spotify ([chapter 16](#16-admin-page-reference)).
- Crop or hide your browser's address bar when you film the admin page: it shows the bridge's address.
- Anonymous Mode only changes what **Encore** shows. Spotify's own apps on your other devices still show your account,
  and your Spotify profile is still yours.

---

## 13. Feature tour

Encore has five tabs: **Home**, **Search**, **Playlists**, **Library** and **Settings**. A mini player sits above the
tabs while something plays; tap it for **Now Playing**.

### Home

A greeting and shelves built from your listening: **Jump back in**, **Made For You**, your top artists, **New releases
for you**, your top songs, and recently played artists. The round picture opens your profile.

### Search

- Results are grouped into **Top Result**, **Songs**, **Artists**, **Profiles**, **Albums** and **Playlists**, with
  **See all songs** and **See all profiles**. When a person's name is exactly what you typed, **Profiles** comes right
  under the Top Result.
- **Recent searches** remembers what you tapped (on this phone only; **Clear** empties it).
- Spotify returns search results in pages of 10 for developer apps; See all loads more as you scroll.

### Playlists

- All your playlists, including the ones you follow, with their real covers.
- **Pin** favourites to the top: touch and hold a playlist → **Pin Playlist**.
- **New Playlist**, **Sort** (Title, Artist, Album, Custom order, Date added newest or oldest first) and **Filter**.
- In a playlist you own: edit and reorder, and **Remove from This Playlist** (via •••).
- Offline or when Spotify is busy, lists show a **Showing a saved copy** banner and still work.

### Library

**Liked Songs**, saved **Albums**, followed **Artists**, **Recently Played** and your **Profile**.

### Albums, artists and playlists

**Play** and **Shuffle**; on artists, **Popular** songs and their albums. The heart saves an album to your Library. The
"by …" line under a playlist opens its owner's profile.

### Song actions (•••)

- **Add to Queue** (or **Add to Jam** while you are in one). You can also swipe a song row to queue it.
- **Add to Playlist…** opens a "Saved in" sheet that shows which of your playlists (and Liked Songs) already have the
  song; tick or untick several at once.
- Save to or remove from **Liked Songs**.
- **Go to Album**, **Go to Artist**, **Remove from This Playlist**.

### Now Playing

- Swipe the cover left or right to skip.
- **Lyrics**: tap the cover or **Lyrics**. Synced lyrics follow the song; tap a line to jump there. They come from
  [LRCLIB](https://lrclib.net), a free community lyrics database, so some songs have none.
- One bottom bar: volume (with AirPlay), **Lyrics**, **Album**, **Artist**, **Jam** (while Jam is available) and
  **More** (the song's actions).
- Flip to **Up Next** to see, remove or move what plays next.
- **Playing from …** opens the playlist, album or artist the song came from.
- When another of your devices plays Spotify, a **Listening on …** bar appears. Tap **Play** in Encore to bring the
  music back to your phone.

### In the background

Music keeps playing when you leave the app or lock the phone. The lock screen and the multitasking bar's music controls
show the song and work, as do headphone and AirPods buttons. **Pause on Unplug** pauses when headphones disconnect.

### Profiles

Search for people, open anyone's profile, see their public playlists, followers and following, **Follow** or
**Unfollow** them, and follow their playlists. Your own profile shows only your public playlists, the way others see
it. The Playlists tab and Library show all of yours.

### Spotify Connect

The engine is a Spotify Connect speaker called **Encore**. In any Spotify app (desktop, web, a modern phone), pick
**Encore** in the devices menu and the music plays on your phone. Tapping Play in Encore takes playback back from your
other devices.

### Play a Link

**Settings → Play a Link…**: paste an `open.spotify.com/…` or `spotify:…` link to a song, album, playlist or artist and
it plays. A Jam link offers to join the Jam.

### Not included

Podcasts and audiobooks, offline downloads, dark mode, iPad layouts.

---

## 14. Jam with friends

A Spotify Jam is a shared queue: friends join from their own Spotify apps and add songs, and everyone hears the same
music. Encore can host a Jam or join one.

### What you need

- **Premium**, for you as the host. Friends need Premium to join from anywhere (free accounts can only join in person).
- A one-time Jam check on the admin page (below). Until then, Encore's Jam buttons are greyed out.

### The one-time Jam check

1. On a computer or modern phone, start a Jam **in the normal Spotify app**, with **Encore** selected as the speaker.
2. On the admin page, in the **Jam** card, press **Check Jam access**. It sends one request to Spotify's Jam service.
3. The answer should be **accepted**. Encore remembers it, and the Jam buttons in the app turn on.
4. You can end that Jam now.

If Spotify refuses, Encore waits 30 minutes before it considers the check again.

### Host a Jam

1. Play something on Encore first.
2. **Settings → Jam** (or the Jam bar) → **Start a Jam**.
3. Invite friends with the **QR code**, **Message**, or **Copy Link**. They open the link in their own Spotify app.
   (In Anonymous Mode, tap **Show Invite** first.)
4. As the host you can remove people, edit **Up Next**, and **End** the Jam (everyone leaves; your queue stays).

### Join a Jam

- **Settings → Jam → Join a Jam…** and paste the link a friend sent you, or
- copy the link, then open Encore: a **Jam Link Copied** alert offers to join it.

As a guest you can add songs. Play, pause and skip only work if the host allows it.

### Jam safety rules

These keep a forgotten Jam from playing to nobody for hours:

- As a guest, Encore leaves a Jam after **10 minutes** with nobody listening on your phone ("Encore left the Jam: nobody
  was listening").
- As the host, if nobody listens on your phone, the Jam is **paused** ("Nobody was listening to your Jam on Encore, so
  it's paused.").
- Any Jam ends on Encore after **3 hours** without anyone listening.
- If Spotify refuses to play, Encore leaves (as a guest) or pauses (as the host).

Jams use a private Spotify interface (see [Legal](#25-legal-and-disclaimer)); they may stop working if Spotify changes
it.

---

## 15. Settings reference

Settings is the fifth tab. Its sections, from top to bottom:

| Section | Setting | What it does | Default |
|---|---|---|---|
| **Encore Bridge** | Home Address | The bridge's local address, tried first (1.5 s timeout). Tap to change it. | What you typed on the setup screen |
| | Away Address | Tried when Home doesn't answer (6 s timeout): your home's public IP and port, for example `http://203.0.113.7:8095`. The setup guide's step 8 finds it. See [chapter 11](#11-listening-away-from-home). | None |
| | Status | The route in use and its delay ("Home · 14 ms", "Away · 88 ms"), **Checking…**, or **Offline** | — |
| | Engine | **Connected**, **Not connected** or **Unknown**. Tap it for an explanation and the bridge's version. | — |
| **Playback** | Jam | Start, join or open a Jam. Shows **Update your Encore Bridge** if the bridge is too old for Jams. | — |
| | Streaming Quality | Very High (320 kbps), High (256), Normal (160), Low (96), the same at home and away | Very High |
| | Auto-Reduce Quality | Steps down when the network is slow | On |
| | Pause on Unplug | Pauses when headphones or AirPods disconnect | On |
| | Explicit Badges | Shows the **E** badge on explicit songs | On |
| | Play a Link… | Plays a pasted song, album, playlist or artist link; offers to join a Jam link | — |
| **Appearance** | Text Size | Small, Default or Large | Default |
| **Privacy** | Anonymous Mode | [Chapter 12](#12-anonymous-mode-and-showcase) | Off |
| | Hide My Playlist Names | Only shown while Anonymous Mode is on | Off |
| **Account** | Spotify | Your Spotify name ("Signed in" in Anonymous Mode). Your sign-in lives on the bridge; switch accounts on its admin page. | — |
| | This Device | This phone's name (the model in Anonymous Mode) | — |
| (no title) | **Unpair This iPhone** | Forgets the bridge on this phone, after asking. You'll need a new pairing code to connect again. | — |
| **About** | Version | The app's version | — |
| | Encore Bridge | The bridge's version | — |
| | Diagnostics | A technical screen for troubleshooting: the stream, the quality in use, the connection, and a test player | — |

The About section's footer repeats that Encore is an unofficial client, not made by, affiliated with or endorsed by
Spotify.

The phone also keeps per-phone choices that are not in Settings: pinned playlists, recent searches and the Playlists
sort order.

---

## 16. Admin page reference

### 16.1 Cards

The header shows:

- a green dot while the bridge talks to the engine,
- the bridge's version and uptime,
- the **Setup guide** button ([chapter 6](#6-the-setup-guide)),
- the **Showcase** switch at the top right ([chapter 12](#12-anonymous-mode-and-showcase)).

Banners under the header:

- While setup isn't finished and you closed the setup guide: **Setup isn't finished.**, with a **Continue setup**
  button ([6.4](#64-closing-it-and-coming-back)).
- When a newer Encore Bridge is out: **Encore Bridge … is available.**, with **What's new** (the release notes on
  GitHub) and **Update…**, which takes you to the **Updates** section. This banner stays hidden while the setup guide
  is open.

The cards, from top to bottom:

| Card | What it's for |
|---|---|
| **Now playing** | The current song, with ⏮ Prev, ⏸ Pause, ▶ Resume, Next ⏭ and +30 s. When another of your devices plays, it says so; Resume brings the music to Encore. |
| **Play something** | Paste a Spotify link (Share → Copy Link) or URI and press **▶ Play on Encore** |
| **Listen here (test)** | Plays the same AAC stream the phone gets, in your browser, at a quality you choose. Nothing is saved. Good for checking the bridge without a phone. |
| **Spotify account** | **Not set up yet:** add your Client ID in the setup guide (step 2), with a **Setup guide** button; **Not connected** with the **Connect** steps (a paste box and **Finish** for the address); or **Connected as** your name with a **Disconnect** button ([3.4](#34-connect-your-spotify-account)) |
| **Engine sign-in** | Whether the engine is signed in, and how to do it ([chapter 8](#8-sign-the-engine-in-to-spotify)) |
| **Phone setup** | This computer's address on your home network, as the app's Home address (for example `192.168.1.20:8095`); "Encore's Cydia repo:" with the Encore repo's address, `https://mbucc9000.github.io/slopkit/` ([chapter 9](#9-install-the-app-from-the-encore-repo)); and "Away from home: step 8 of the setup guide finds the address to type into Encore." with a **Listen away from home** button that opens that step ([chapter 11](#11-listening-away-from-home)) |
| **Pair a device** | **New pairing code**, and the list of paired phones with their id, last contact and an **Unpair** button |
| **Engine & stream** | Engine connection, audio clock and buffer, what the phone reports hearing, the encoders. On Windows also the engine process and the audio pipe. For troubleshooting. |
| **Updates** | Whether a newer Encore Bridge is out (**Encore Bridge 1.1.0 · up to date (checked …)**, or **Encore Bridge … is available (you have …)** with **What's new**), and **Check now**. Then what to do for your kind of install: **Update now** with a progress bar and **Cancel** (Windows installer, on the PC itself), the file to download (Windows zip), or the commands to run (Docker). A note at the bottom says what the check sends and how to turn it off ([chapter 18](#18-updating)). |
| **Jam** | The Jam's state, whether Jam access is usable, and **Check Jam access** ([chapter 14](#14-jam-with-friends)) |
| **Catalog** | Counts of cached lists and covers, Spotify request counters (including when Spotify is limiting requests), and **Flush lists / Flush covers / Flush all**. A flush only costs a re-download. |

### 16.2 Advanced

Add `?dev=1` to the end of the admin page's address (for example `http://<your-bridge-address>:8095/admin?dev=1`) to
show the **Advanced (developer)** section. It holds developer tools you don't need for normal use:

- **Fake host / Fake guest / Fake off**: a pretend Jam with 1 to 12 made-up members, for demos and testing. It never
  talks to Spotify and ends by itself after 30 minutes. Your own member shows your Spotify name, or "You".
- **Jam flags** (host add, host jump, guest transport, Jam edits, then **Apply flags**): experimental Jam behaviours.
  They reset when the bridge restarts.
- **Jam trace** (**Reset trace**, **Save trace**): a technical log of Jam events (no ids, tokens or names), to attach to
  a bug report.

### 16.3 Diagnostics from phones

Each paired phone sends a small diagnostics log to the bridge every 30 seconds (playback events, stalls and errors).
The bridge keeps it in `data/diag/` (up to 4 MB per phone, then one older file). Stalls, failures and errors from it
also appear in the bridge's log, marked with the phone's id, never its name. It never leaves the bridge unless you
send it to someone. While Showcase is on, the admin page refuses to read it.

### 16.4 Bridge settings

Put these in `.env` (Docker) or `settings.env` (Windows), one `NAME=value` per line, then restart the bridge (Docker:
`docker compose up -d`; Windows: **Troubleshooting → Restart bridge**). An empty value means "use the default". The
Client ID is the exception: the setup guide saves it for you and uses it at once, without a restart
([3.2](#32-give-the-bridge-the-client-id)).

| Setting | What it does | Default |
|---|---|---|
| `SPOTIFY_CLIENT_ID` | Your developer app's Client ID. Usually the setup guide saves it (Windows: in `settings.env`; Docker: in `data/settings.json`). A value in the environment (Docker: `.env`) wins over both, and the setup guide can't change it ([3.2](#32-give-the-bridge-the-client-id)). Without a Client ID, account features (library, search, Home, profiles) are off. | empty |
| `ADMIN_PASSWORD` | Admin password. Overrides the one chosen on the admin page. | empty (choose it on the admin page) |
| `ADMIN_ALLOW` | Who may open the admin page and pair phones: addresses and CIDR ranges, separated by commas, for example `192.168.1.0/24` or `private,203.0.113.7`. The word `private` stands for the default set. The bridge machine itself is always allowed. Entries that aren't addresses are ignored (the log says how many); if none is usable, only the bridge machine itself is allowed. | `private`: loopback, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10`, `fc00::/7`, `fe80::/10` |
| `PORT` | The bridge's port | `8095` |
| `FFMPEG` | Path to a different ffmpeg | Docker: the image's ffmpeg; Windows: the bundled `ffmpeg\ffmpeg.exe` |
| `ENCORE_APP_REPO` | Advanced, for forks: the Cydia repo address the setup guide's step 6 and the **Phone setup** card show for installing the app. It must be an `http://` or `https://` address (a missing `/` at the end is added); anything else is ignored, with a line in the log, and the default is used. | The Encore repo, `https://mbucc9000.github.io/slopkit/` |
| `SPOTIFY_CALLBACK_CATCHER` | `1`: catch the Spotify sign-in's return address on `127.0.0.1:8888`, so a browser on the bridge machine needs no paste ([3.4](#34-connect-your-spotify-account)). `0`: always paste. | `1` on Windows, `0` on Docker |
| `ADMIN_SETUP_LOOPBACK` | `1`: the first admin password can be chosen from the bridge machine itself without the setup code (from a page opened at `127.0.0.1` or `localhost`, as the tray does; a website's page that reaches the bridge never counts). | `1` on Windows, `0` on Docker (where "the machine itself" can be any container on it) |
| `UPDATE_CHECK` | `1`: look for a new Encore Bridge on GitHub once a day ([chapter 18](#18-updating)). `0` (or `false`, `no`, `off`): no automatic look; **Check for updates** and **Check now** still work when you choose them. On Windows the tray reads it before each daily look, so no restart is needed; on Docker run `docker compose up -d`. | `1` |

`ADMIN_TRUST_PROXY=1` exists for experiments: the bridge then believes the proxy headers it otherwise refuses. Reverse
proxies are not supported in this release ([chapter 11](#11-listening-away-from-home)), so leave it unset.

**Docker note:** `compose.yaml` sets `PORT`, `DATA_DIR`, `PCM_FIFO` and `ENGINE_URL` itself, and those values win over
`.env`. To change the port on Docker, edit `PORT` in `compose.yaml`. The engine's settings are in `engine/config.yml`
([4.4](#44-check-the-engines-settings)).

**Windows note:** the data folder is `%LOCALAPPDATA%\Encore` unless the environment variable `ENCORE_HOME` names
another folder ([5.8](#58-where-windows-keeps-encores-data)). The engine's settings are in `engine\config.yml` there.

---

## 17. Troubleshooting

Search this page for the message you see, or a few words of it. Messages are quoted as Encore 1.1.0 shows them. In
Anonymous Mode, messages that would name a person or a device read slightly differently
([chapter 12](#12-anonymous-mode-and-showcase)).

### 17.1 Setup and pairing

| You see | What it means | What to do |
|---|---|---|
| **Enter the 6-digit code from the admin page.** | The code field doesn't have six digits. | Make a new code on the admin page and type all six digits. |
| **The home address should look like http://192.168.1.20:8095** | The Home field is empty. | Type the bridge's local IP and port, like `192.168.1.20:8095`. |
| **Can't reach your Encore Bridge at either address.** | Neither address answered. | Check, in order: the phone is on your **home Wi-Fi** (not mobile data or a guest network); the address and the `:8095` port are right; the bridge is running; in the phone's Safari, `http://<your-bridge-address>:8095/` shows two lines starting with "Encore gateway". If Safari can't open it either, the network or the firewall is the problem: Windows needs a **Private** network and an allow rule ([5.5](#55-set-the-network-to-private), [5.6](#56-fix-the-firewall)); Linux firewalls must allow TCP 8095. |
| **wrong or expired pairing code** | The code was mistyped, already used, or is older than 5 minutes. | Press **New pairing code** and use it right away. |
| **too many attempts, wait a minute** | Ten wrong codes within a minute. The bridge pauses pairing for everyone. | Wait a minute, make a new code, try again. |
| **Pairing only works on your home network. Connect this iPhone to the same Wi-Fi as your Encore Bridge and try again.** | The phone came from an address outside `ADMIN_ALLOW`: from the internet (mobile data or another network, through your port forward), or `ADMIN_ALLOW` leaves your home network out. (Without a port forward, a phone on mobile data or an isolated guest Wi-Fi can't reach the bridge at all and sees **Can't reach your Encore Bridge at either address.**) | Join your home Wi-Fi and pair again. If you changed `ADMIN_ALLOW`, make sure it includes your home network ([16.4](#164-bridge-settings)). |
| **The admin page and pairing don't work through a proxy. Open the bridge's own address on your home network.** | The request came through a proxy (it carried a `Forwarded` or `X-Forwarded-For` header). | Use the bridge's own address, not a proxy or tunnel address. Proxies aren't supported in this release. |
| **Couldn't save the pairing.** | The phone couldn't store its key. | Restart the phone and pair again. If it keeps happening, reinstall Encore. |
| **Pairing failed.** | Something else went wrong. | Look in the bridge log for a line about pairing. Make sure you're pairing **at home**. |

**In the setup guide**

| You see | What it means | What to do |
|---|---|---|
| **Choose your admin password first** (steps 2 to 9 locked) | The bridge has no admin password yet. | Do step 1, **Protect this page** ([chapter 7](#7-the-admin-page-and-your-admin-password)). |
| **That isn't a Client ID. It is 32 letters (a-f) and digits, under Settings → Basic Information in your developer app. (Not the client secret.)** | What you pasted isn't 32 letters and digits, often only part of the ID. (The client secret looks like an ID and is accepted; it fails later in step 3 with **INVALID_CLIENT: Invalid client**.) | Copy the **Client ID** from your developer app's **Settings → Basic Information** ([3.1](#31-create-the-app)). |
| **This bridge's Client ID is set in its environment (.env on Docker), so it can't be changed here. Change it there and restart the bridge.** | `SPOTIFY_CLIENT_ID` is set in the bridge's environment (Docker: `.env`), which always wins ([3.2](#32-give-the-bridge-the-client-id)). | Change it in `.env`, then run `docker compose up -d` in the `gateway` folder. Or empty it there; then the setup guide can save one. |
| **The Client ID couldn't be saved (…).** | The bridge couldn't write `settings.env` (Windows) or `data/settings.json` (Docker). The code in brackets says why, for example `EACCES`: no permission. | Windows: free some disk space and make sure nothing locks `%LOCALAPPDATA%\Encore\settings.env`. Docker: make sure the container can write to `data/`. Then press **Save Client ID** again. |
| **Changing the Client ID disconnects your Spotify account. …** | Not an error: your account's sign-in belongs to the old developer app ([3.3](#33-change-the-client-id)). | Confirm, then connect the account again in step 3. |
| **Save your Client ID first.** (step 3) | Connecting needs the Client ID. | Do step 2. |
| **Showcase is on, so connecting is hidden: …** (step 3) | Spotify's page would show your account on screen. | Turn **Showcase** off to connect. |
| **Spotify refused your account. Add your account under User Management in your developer app (step 2), then press Connect again.** (step 3, Windows) | The sign-in came back to this computer, but Spotify won't let this account use your developer app. | Add the account under **User Management** in the dashboard ([3.1](#31-create-the-app)), then press **Connect** again. |
| **Spotify's page was cancelled, so nothing was connected. Press Connect again.** (step 3, Windows) | You pressed **Cancel** on Spotify's page. | Press **Connect** again and **Agree**. |
| **Your Spotify account wasn't connected: the tab Spotify opened says why. Press Connect again.** (step 3, Windows) | The sign-in came back to this computer and failed for another reason. | Read the tab Spotify opened ([17.4](#174-spotify-account-and-sign-in) explains its messages), then press **Connect** again. |
| **Couldn't find your public IP: no IP-check service answered. …** (step 8) | None of the public IP-check services answered. The bridge log says why: `public IP check: failed (…)`. | Check that the bridge's computer is online and press **Find my public IP** again. Or read your router's Internet (WAN) address on its admin page: the Away address is `http://<that address>:8095`. |
| **Showcase is on, so your public IP stays hidden. Turn Showcase off to find it.** (step 8) | Showcase hides your public IP, so the bridge doesn't look it up. | Turn **Showcase** off, then press **Find my public IP**. |
| **This IP (100.64 to 100.127) is a shared address of your internet provider (carrier-grade NAT), …** (step 8) | Your internet provider shares one public IP between many homes. | Remove the port forward you added, and ask your provider for a public IPv4 address ([carrier-grade NAT and double NAT](#carrier-grade-nat-and-double-nat)). |
| **This isn't a public IP, so a port forward can't reach your home through it. …** (step 8) | The IP found is a private or reserved address. | Check your router's Internet (WAN) address ([carrier-grade NAT and double NAT](#carrier-grade-nat-and-double-nat)). |
| **Waiting for your phone to connect from outside your home network…** stays (step 8) | No paired phone has reached the bridge from outside your home network yet. | Test on mobile data, not your home Wi-Fi (an iPod touch: another Wi-Fi, such as your phone's hotspot), with the Away Address set in Encore. If Settings says **Status: Offline**, see [17.2](#172-connection). Over the iPhone's VPN this step never ticks: press **Skip for now**. |
| A step stays on its waiting line, such as **Waiting for your phone…** | The bridge hasn't seen that step happen yet. | Do it on the phone (or in Spotify). If you did a step another way, press **Skip for now**. |

**From the network check (setup guide step 5)**

| You see | What it means | What to do |
|---|---|---|
| **Couldn't tell this computer's address on your home network.** … | The bridge found no home-network address on this computer (for example, only a VPN or virtual adapter). | Find the address in your router's list of connected devices and use it on the phone. |
| **Encore Bridge doesn't answer on its home-network address.** … | The bridge couldn't reach itself at that address. | Restart it. Windows: **Troubleshooting → Restart bridge** in the tray menu. Docker: `docker compose restart gateway`. |
| **This computer's network is set to Public, and Windows keeps your phone out on Public networks.** … | The connection that holds the address has the Public profile. | If it is your home network, set it to Private ([5.5](#55-set-the-network-to-private)), then press **Check again**. |
| **Windows Firewall has a rule that blocks Encore Bridge** … | A Block rule for the bridge's `node.exe`, usually from a cancelled firewall prompt. | Tray menu → **Troubleshooting → Fix firewall…** ([5.6](#56-fix-the-firewall)). |
| **No Windows Firewall rule lets your phone reach Encore Bridge on port 8095.** … | No Allow rule covers the bridge's port on Private networks. | Tray menu → **Troubleshooting → Fix firewall…** ([5.6](#56-fix-the-firewall)). |
| **Couldn't read the Windows network settings.** … | The read-only check didn't work (for example, security software stopped it). | Nothing to fix now. If the phone can't connect later, use **Troubleshooting → Fix firewall…**. |

**In Cydia**

| You see | What it means | What to do |
|---|---|---|
| Cydia can't add the Encore repo, or shows an error for it while it refreshes | The address is mistyped, or the phone isn't online. | Type it exactly, with `https://` and the `/` at the end: `https://mbucc9000.github.io/slopkit/`. Check that the phone is online (Safari opens a page). Try again later. If it still fails, install the app another way ([9.3](#93-other-ways-to-install-the-app)). |
| No Encore update in **Changes** after you updated the bridge | Cydia hasn't refreshed its sources yet, or the new version isn't in the Encore repo yet. | **Changes** → **Refresh**. If it still isn't there, try again later, or install the new `.deb` from the release page ([9.3](#93-other-ways-to-install-the-app)). |

### 17.2 Connection

| You see | What it means | What to do |
|---|---|---|
| **Can't reach your Encore Bridge.** / Settings **Status: Offline** | The phone can't reach the bridge on either route. | At home: as in 17.1. Away: see the next row. Check that the bridge machine is awake. |
| Away from home: **Status: Offline**, or **Can't reach your Encore Bridge at either address.** | The Away address doesn't reach the bridge. | Check, in order: the Away Address is set in Encore (Settings) and ends in the port; the router forwards TCP 8095 to the bridge computer's **current** address (the setup guide's step 8 shows it; a DHCP reservation keeps it); your public IP hasn't changed (step 8 → **Find my public IP**, or use a dynamic DNS name, [11.1](#when-your-public-ip-changes)); on Windows the network is still **Private** (step 5); on Docker a firewall on the machine allows TCP 8095 from anywhere; your router has its own public IP ([CGNAT or double NAT](#carrier-grade-nat-and-double-nat)). Test on mobile data: many routers can't reach their own public IP from your home Wi-Fi. With the VPN: check that it is switched on. |
| **Lost the stream (Encore Bridge unreachable).** | The stream kept failing to reconnect. | Usually the network dropped. Play again when you have signal. |
| **No audio from your Encore Bridge.** | The stream connected but no sound arrived. | Check the engine (**Settings → Engine**). Try **Listen here** on the admin page: if that is silent too, the engine or ffmpeg has a problem (see the bridge log). |
| **Your Encore Bridge doesn't know this phone any more. Unpair and pair again.** | The bridge rejected the phone's key. The phone was unpaired on the admin page, or the bridge lost its `data` folder. | **Settings → Unpair This iPhone**, then pair again with a new code. |
| **Your Encore Bridge sent an answer Encore can't read.** | Something other than the bridge answered: often a hotel or café Wi-Fi login page, or a wrong address. | Open Safari first and finish any Wi-Fi login page. Check the addresses. |
| **Update your Encore Bridge.** (as a banner, in Settings → Jam, or in Up Next) | The bridge is older than the app and lacks something the app asked for. | Update the bridge ([chapter 18](#18-updating)). |
| **Encore Bridge error N.** | The bridge answered with an error the app has no text for (N is the HTTP status). | Look in the bridge log at that time. |

### 17.3 Playback

| You see | What it means | What to do |
|---|---|---|
| **Encore isn't playing anything. Paste a link, pick Encore in Spotify, or connect your Spotify account on the Encore Bridge admin page.** / **Nothing is playing on Encore.** | Nothing is loaded yet, so there's nothing to pause, skip or queue. | Play a song, album or playlist from the app. |
| **Encore's player is reconnecting to Spotify. Try again in a moment.** | The engine has no Spotify session. Right after another device took playback, this clears in seconds. If it stays, the engine was never signed in. | [Sign the engine in](#8-sign-the-engine-in-to-spotify) (the setup guide's step 4). Check the admin page's Engine sign-in card. |
| **Encore's player isn't reachable.** / **Encore's player didn't answer in time.** / **Encore's player didn't answer. Try again in a moment.** / Settings **Engine: Not connected** | The bridge can't talk to the engine. | Docker: `docker compose ps` and `docker compose logs engine`. Windows: check the tray's status line and the admin page's Engine sign-in card, then **Troubleshooting → Restart bridge**. |
| **Spotify is refusing to play right now (it may be limiting requests). Try again in a minute or two.** / **Spotify is refusing to play right now. Try again in N s.** | Spotify refused to hand out the keys for the audio. Encore pauses and waits 60 seconds. | Wait and try again. If it happens constantly, see the [FAQ](#23-faq): some accounts get this with every librespot-based player, and Encore can't fix it. |
| **Play on Encore?** (Spotify is playing on another device) | Not an error: your account is playing elsewhere. | **Play** moves the music to your phone. |
| Music pauses by itself about 45 seconds after you close the app | By design: with nobody listening, the bridge pauses instead of playing to an empty room. | Nothing to fix. |
| Stutters or gaps | The network is too slow for the quality. | Keep **Auto-Reduce Quality** on, or choose a lower **Streaming Quality**. At home, check the Wi-Fi signal. The admin page's **Engine & stream** card shows stalls. |

### 17.4 Spotify account and sign-in

| You see | What it means | What to do |
|---|---|---|
| **Connect your Spotify account on the Encore Bridge admin page first** | The account isn't connected, or was disconnected (for example after a Client ID change). | Connect it: the setup guide's step 3, or the Spotify account card ([3.4](#34-connect-your-spotify-account)). |
| **Spotify sign-in expired: reconnect on the Encore Bridge admin page** | Spotify no longer accepts the saved sign-in (you changed your password, removed the app's access, or signed out everywhere). Encore retries at most every 10 minutes. | Admin page → Spotify account → **Connect** again. |
| **Add your Spotify Client ID in the setup guide (step 2) first.** / Spotify account card: **Not set up yet:** add your Client ID in the setup guide (step 2). | The bridge has no Client ID. | The setup guide's step 2, **Your Spotify developer app** ([3.2](#32-give-the-bridge-the-client-id)). |
| Spotify's page says **INVALID_CLIENT: Invalid redirect URI** | The Redirect URI in your developer app doesn't match exactly. | In the dashboard, set it to exactly `http://127.0.0.1:8888/callback`, press **Add**, and save ([3.1](#31-create-the-app)). Then press **Connect** again. |
| Spotify's page says **INVALID_CLIENT: Invalid client** | The bridge's Client ID isn't your developer app's. Usually the client secret was pasted (it looks like an ID, so it is accepted), or the app was deleted. | Copy the **Client ID** from **Settings → Basic Information** ([3.1](#31-create-the-app)), then the setup guide's step 2 → **Change** → paste it ([3.3](#33-change-the-client-id)). Then press **Connect** again. |
| **paste the whole address from the browser (it starts with http://127.0.0.1:8888/callback)** | What you pasted isn't the callback address. | Copy the whole address from the tab that shows "can't be reached", including `?code=`. |
| **that login link is old or from another tab; press Connect again** / Windows tab: **This sign-in link is old or from another tab. Go back to the Encore Bridge admin page and press Connect again.** | The address belongs to an older Connect attempt, or the bridge restarted in between. | Press **Connect** again and use the new tab. |
| **Spotify said: access_denied** | You pressed **Cancel** on Spotify's page. | Press **Connect** again and **Agree**. |
| **Spotify refused this (GET /me: …)** | Spotify won't let this account use your developer app. | Add the account under **User Management** in the dashboard ([3.1](#31-create-the-app)), and check that the app owner has Premium. Then press **Connect** again. |
| **Spotify login: invalid_grant** (or another reason) | Spotify rejected the sign-in code or token. | **Connect** again. |
| **Spotify sign-in didn't answer. Try again in a moment.** / **Spotify sign-in failed (N). Try again in a moment.** | Spotify's sign-in service didn't respond, or answered with an error. | Try again later. Check the bridge machine's internet connection. |
| Bridge log: **COULD NOT SAVE the rotated Spotify refresh token** | The bridge can't write to its `data` folder. Your sign-in will be lost at the next restart. | Docker: check that the container can write to `data/`. Windows: check free disk space and that nothing locks `%LOCALAPPDATA%\Encore\data`. Then connect again. |

### 17.5 Lists, search, lyrics and profiles

| You see | What it means | What to do |
|---|---|---|
| **Spotify is limiting requests. Try again in N s.** / **Spotify is limiting requests right now. Try again in a minute.** | Spotify answered "too many requests". Encore stops asking until Spotify's wait is over. | Wait. It clears by itself. Meanwhile saved copies are shown. |
| **Spotify is busy. Try again in a moment.** / **Encore is loading other lists. Try again in a moment.** / **Encore is busy loading profiles. Try again in a moment.** | Encore spaces out its requests to Spotify, and this one had to wait too long. | Try again in a few seconds. |
| **Showing a saved copy** | Spotify didn't answer, so you see the last copy Encore kept. | Nothing. It refreshes when Spotify answers. |
| **Your playlists will show here once your Encore Bridge answers.** / **Home fills up once your Encore Bridge answers.** | The first load hasn't finished, or it failed. | Pull down to refresh. Check the connection. |
| **Song lists are turned off on the Encore player (metadata.enabled).** | The engine's song lists are switched off. | Set `metadata: enabled: true` in the engine's config and restart. |
| **Encore's player couldn't list your playlists.** | The engine failed to list them. | Try again. Check the engine log. |
| **Spotify doesn't share when songs were added to this playlist.** | Sorting by **Date added** isn't possible for this playlist. | Use another sort order. |
| **You can't change this playlist.** | It belongs to someone else (or Spotify). | — |
| **The playlist kept changing. Try again.** | Someone else edited the playlist at the same moment. | Try again. |
| **This song is already in …** | Not added twice. | — |
| **This playlist doesn't exist anymore.** | It was deleted. | Pull to refresh. |
| **Lyrics aren't available right now.** | LRCLIB didn't answer. | Try later. Some songs have no lyrics on LRCLIB. |
| **Profile not available** / **This profile isn't available on Spotify.** | Spotify doesn't show this profile (private or removed). | — |
| **Profiles aren't available right now.** / **Following people isn't available right now.** / **Saving other people's playlists isn't available right now.** | Spotify refused the private interface Encore uses for this. Encore switches the feature off for a while. | Try again later. Update Encore if a new release fixes it. |
| **Not a Spotify link** … **Podcasts aren't supported.** | The pasted text isn't a song, album, playlist or artist link. | Use Share → Copy Link in Spotify. |

### 17.6 The bridge machine

| Problem | What to do |
|---|---|
| **"Encore" is missing from Spotify's device list** | Discovery needs the Spotify app and the bridge on the **same network**: not a guest Wi-Fi, not a separate VLAN, no "AP isolation". On Docker, if the host runs avahi-daemon, switch the engine to avahi ([4.4](#44-check-the-engines-settings)), and check that firewalls allow UDP 5353 and the engine's zeroconf port. Once the engine is signed in, Encore also appears for your account on other networks. Or use the code sign-in ([chapter 8](#8-sign-the-engine-in-to-spotify)). |
| Admin page: **Not from this address.** | You're not on an allowed address (for example, you came in from the internet through a port forward, or `ADMIN_ALLOW` leaves your network out). Open it from your home network or on the bridge machine itself. |
| Admin page: **The admin page and pairing don't work through a proxy. …** | A proxy or tunnel is in between. Open the bridge's own address on your home network. |
| **The password prompt keeps coming back** | The password is wrong (any user name works). To reset it, see [chapter 7](#7-the-admin-page-and-your-admin-password). |
| Admin page: **Too many wrong passwords. Try again later.** | 10 wrong passwords or setup codes from your address within 15 minutes. Wait 15 minutes. |
| Admin page: **That isn't the setup code from the bridge's log.** | The setup code is mistyped, or the bridge restarted and printed a new one. Use the newest "setup code" line ([chapter 7](#7-the-admin-page-and-your-admin-password)). |
| Admin page: **Use at least 8 characters.** | Choose a longer password. |
| Admin page: **Use the admin page itself.** | The request didn't come from the admin page (another website, or a tool that doesn't send JSON). Use the admin page in your browser. |
| Admin page: **Showcase is on: turn it off to read phone diagnostics.** | Switch Showcase off first. |
| Bridge log: **ADMIN_ALLOW has no usable entry: the admin page and pairing only answer this computer** | None of the entries in `ADMIN_ALLOW` is an address or range. Fix it ([16.4](#164-bridge-settings)). |
| Bridge log: **no Spotify Client ID yet: the setup guide on the admin page asks for it** | Save your Client ID in the setup guide's step 2 ([3.2](#32-give-the-bridge-the-client-id)). |
| Bridge log: **data/settings.json: the saved Spotify Client ID isn't valid and is ignored** | The file was changed by hand or damaged. Save the Client ID again in the setup guide's step 2. |
| Bridge log: **public IP check: failed (…)** | None of the public IP-check services answered when you pressed **Find my public IP**. The brackets name each service and why (`timeout`, `http_<status>`, `bad_answer` or `network`). Check the bridge machine's internet connection, or read your router's Internet (WAN) address instead ([11.1](#111-forward-the-port-setup-guide-step-8)). |
| Bridge log: **ENCORE_APP_REPO isn't an http(s) address, so the default Encore repo is used** | Fix or remove `ENCORE_APP_REPO` in your settings ([16.4](#164-bridge-settings)). |
| Bridge log: **port 8095 is in use by another program (choose another PORT, or stop that program)** | Another program has the port. Docker: change `PORT` in `compose.yaml`. Windows: see [5.11](#511-port-already-in-use). |
| **`docker compose up --build` fails** | Read the first error. Common causes: no internet on the host (the build downloads base images and Go modules), too little disk space, or a 32-bit system (use a 64-bit OS). |
| **Bridge log: `could not shrink the … pipe buffer`** | Harmless. |
| **Bridge log: `player events disconnected`** | The engine restarted or stopped. It reconnects by itself. If it repeats, check `docker compose logs engine` (Windows: the log). |
| **Couldn't make the QR code.** (Jam) | Rare: the bridge couldn't draw the invite's QR code. The bridge log has a `jam qr:` line saying why. Copy Link and Message still work. |
| Windows tray: **Port 8095 is in use** / **Port 8095 is blocked by Windows** | See [5.11](#511-port-already-in-use). |
| Windows tray: **Settings problem** | A value in `settings.env` isn't valid (for example `PORT`). **Troubleshooting → Open log** says which one. Fix it with **Edit settings…**, then **Restart bridge**. |
| Windows tray: **Keeps stopping** / **Stopped** | The bridge stopped several times right after starting. **Troubleshooting → Open log** says why. Then **Restart bridge**. |
| Windows tray: **Couldn't start** | Windows couldn't start the bundled `runtime\node.exe`. Antivirus software may have removed it: check its quarantine, or reinstall Encore Bridge. |
| Windows tray: **Engine missing** | `engine\encore-engine.exe` is gone, usually quarantined by antivirus software. Restore it, or reinstall Encore Bridge (or unzip the whole package again). |
| Windows tray: **Engine version mismatch** / **Version mismatch** | Parts of two different Encore Bridge versions are mixed. Reinstall Encore Bridge (or unzip the whole package again into an empty folder). |
| Windows tray: **Engine stopped** | The engine stopped and the bridge gave up restarting it. **Troubleshooting → Open log** says why. Then **Restart bridge**. |
| Windows: **the phone can't connect** | The setup guide's step 5 checks the network and the firewall. Then check: Private network ([5.5](#55-set-the-network-to-private)), firewall ([5.6](#56-fix-the-firewall)), PC awake ([5.7](#57-sleep-sign-out-and-laptops)). |
| Windows: **"Encore" lingers in Spotify's device list after you quit** | Normal for a minute or so after the engine stops. |

### 17.7 Jam

| You see | What it means | What to do |
|---|---|---|
| Jam buttons greyed, note about **a one-time check** | The Jam check wasn't done yet. | Do the [one-time Jam check](#the-one-time-jam-check). |
| **Encore can't start or join Jams yet. Start a Jam in Spotify on your computer with Encore selected.** | Same: Jam access is unknown or was refused. | As above. |
| **Play Something First** | A Jam starts from what's playing. | Play a song, then start the Jam. |
| **Spotify didn't let Encore start a Jam. …** | Spotify refused. | Start the Jam in the Spotify app on your computer with Encore selected. It shows up in Encore. |
| **Spotify didn't let Encore join this Jam. It may be full, or the host may have turned joining off.** | — | Ask the host. |
| **Jam Not Found** — **This Jam has ended, or the link is wrong.** | — | Ask for a new link. |
| **Not a Jam Link** — **That isn't a Jam link. Paste the link a friend sent you.** | — | Paste the invite link exactly. |
| **You're already in a Jam on another device. End or leave it in Spotify first.** | Your account is in a Jam elsewhere. | End or leave it in Spotify. |
| **A Jam is playing on Encore. End it in Spotify on your computer first.** | — | End it where it was started. |
| **Your Jam is playing on …. Play it here from Spotify on that device.** | The Jam moved to another speaker. | Pick Encore in Spotify on that device. |
| **Leave …'s Jam to play something else.** | You're a guest. | Leave the Jam first. |
| **Only … can control the Jam's playback. You can still add songs.** | The host hasn't allowed guests to control playback. | Add songs instead, or ask the host. |
| **Spotify didn't start the Jam.** | Spotify said yes, but no Jam appeared. | Try again. |
| **Spotify started the Jam on …. Play it on Encore from there, or end it.** | Spotify put the Jam on another of your devices. | Pick Encore there, or end it. |
| **Encore left the Jam: nobody was listening** / **Nobody was listening to your Jam on Encore, so it's paused.** | The [Jam safety rules](#jam-safety-rules). | — |
| **Encore left the Jam: Spotify is refusing to play right now** | See "Spotify is refusing" above. | Wait a minute or two. |
| **Spotify is limiting Jam requests. Try again in N s.** | — | Wait. |
| **Adding songs to this Jam from Encore isn't possible yet.** | Spotify didn't give Encore a way to add to this Jam. | Add from the Spotify app. |
| **Encore's player can't do this. Update the Encore player.** / **Up Next needs the updated Encore player.** | The engine is older than the bridge. | Rebuild or reinstall the bridge so both match ([chapter 18](#18-updating)). |
| **Turn shuffle off to change these songs.** / **Autoplay songs can't be moved or removed.** / **Songs can only move within their own section.** / **Up Next changed, so it was refreshed.** | Up Next editing limits. | — |

### 17.8 Updates

These messages appear in the admin page's **Updates** section. After **Check for updates** or **Update now…** in the
Windows tray, they also appear in a window ([chapter 18](#18-updating)). A failed update check changes nothing: the
bridge keeps running the version it has.

**Looking for a new version**

| You see | What it means | What to do |
|---|---|---|
| **Couldn't reach GitHub. Check that this computer is online; Encore Bridge tries again later.** | The bridge's computer couldn't connect to GitHub at all: it is offline, or a firewall or a proxy is in the way. (The check uses no proxy, except on Windows one set in the `HTTPS_PROXY` environment variable.) | Check the computer's internet connection. Encore Bridge tries again by itself an hour later. |
| **GitHub didn't answer in time. Try again in a minute.** | GitHub or the connection was too slow. | Press **Check now** (or **Check for updates**) again in a minute, or wait for the next daily check. |
| **GitHub asked Encore Bridge to wait (too many requests from your network). It tries again after ….** | GitHub answers 60 requests an hour from one public IP address without a sign-in. Programs on your network (or other homes behind the same address) used them up. | Nothing. Until that time, **Check now** (or **Check for updates**) shows this same answer without asking GitHub; after it, they ask GitHub again. The automatic check tries again the next day. |
| **GitHub answered with an error (HTTP N). Encore Bridge tries again tomorrow.** | GitHub had a problem. | Nothing, or **Check now** later. |
| **GitHub's answer couldn't be read. Encore Bridge tries again tomorrow.** | Something other than GitHub answered (for example a Wi-Fi login page or a filtering proxy), or the answer was damaged. | Nothing, or **Check now** later. If it stays, look at the release page yourself. |
| **No Encore release is published yet.** | Not an error: there is no release on GitHub yet. | — |
| **Encore Bridge … is published, but not all of its files are there yet. Encore Bridge looks again later.** | The new release is still being uploaded, or lacks the file your kind of install needs. | Wait. The next daily check looks again. |
| **Encore Bridge … is published, but its checksum list isn't signed with Encore's release key, so it isn't offered. Don't install it from anywhere else; see the project page on GitHub.** | The release's `SHA256SUMS.txt.sig` doesn't match its `SHA256SUMS.txt` under the key built into your Encore Bridge. The release may have been changed, damaged or replaced by someone else, or Encore's release key was replaced. Only those two small files were downloaded, and nothing is offered. | Don't install that version, and don't get it from anywhere else. Read the project page on GitHub: if Encore's release key was ever replaced, its README says so and how to install the new version by hand once. Otherwise, report it on the issue tracker. |
| **Encore Bridge …'s signed checksum list doesn't include the file this computer needs, so it isn't offered.** | The signature is fine, but the signed list has no line for the file your install needs (for example, an older list published again under a new version). | Don't install that version. Wait for the next release, and report it if it stays. |
| **Encore Bridge … is up to date.** / **Encore Bridge … · up to date (checked …)** | Not an error: no newer final version is out. Test versions (release candidates) are never offered. | — |
| **This is a development build, so it doesn't look for updates.** | This copy has no release version number. Someone built it from source without one (for example a tray program built without the release scripts). | Update it the way it was built, or install a release ([chapter 24](#24-building-from-source)). |
| **Automatic checks are off (UPDATE_CHECK=0). Check now still works.** | `UPDATE_CHECK` is set to `0` ([Turning the update check off](#turning-the-update-check-off)). | Nothing. To turn the daily check back on, remove the setting. |

**Updating on Windows**

| You see | What it means | What to do |
|---|---|---|
| **The download stopped. Choose Update now again to continue where it stopped.** | The connection broke, or nothing arrived for a minute (three tries). | Choose **Update now…** again. It continues where it stopped. |
| **There isn't enough free space for the update: … is needed on the drive that holds %LOCALAPPDATA%.** | The drive with your Windows profile (usually C:) is nearly full. | Free some space there, then choose **Update now…** again. |
| **The downloaded installer doesn't match Encore's signed checksum list, so it was deleted and not run. Try again later.** | The installer arrived damaged or changed. Nothing was installed or run. | Try again later. If it keeps happening, report it on the issue tracker. |
| **The update was cancelled. Encore Bridge … is still installed.** | You chose **No** in Windows' permission prompt, or cancelled the installer. | Choose **Update now…** again when you are ready. The download is kept. |
| **The installer stopped before it finished (code N). Encore Bridge … is still installed.** | The installer ended early, before it quit Encore Bridge. | Try **Update now…** again later, or install the new version by hand ([Bridge on Windows](#bridge-on-windows-installer)). |
| **Windows couldn't start the installer. Try again, or download it from the release page.** | Windows refused to start the downloaded installer, often because security software blocked it. | Check your antivirus quarantine and try again, or install by hand from the release page. |
| **The update to Encore Bridge … didn't finish, so Encore Bridge … was started again.** | The installer had already quit Encore Bridge, then stopped (or the PC lost power). Your old version runs again. | Try **Update now…** again later, or install by hand. The installer's log is `%LOCALAPPDATA%\Encore\updates\<version>\setup.log`. |
| **The update to Encore Bridge … didn't finish, and Encore Bridge can't start: … is missing.** | The installer stopped after it had removed the old program files, so neither version is complete. | Run the installer the message names (`%LOCALAPPDATA%\Encore\updates\<version>\EncoreBridge-<version>-setup.exe`, already downloaded), or download it again from the release page. Your settings, sign-ins and paired phones stay. |
| Admin page: **To update, use the Encore Bridge icon on the PC: Encore Bridge … is available → Update now…** | **Update now** on the admin page works only when the page was opened on the PC as `http://127.0.0.1:8095/admin` (the tray's **Open Encore Bridge**), because Windows' permission prompt has to appear on the PC itself. This page was opened from another computer, or on the PC by its network address. | Use the tray menu, or open the page with **Open Encore Bridge** in the tray. |
| Admin page: **Updates are handled by the Encore Bridge icon in the notification area.** | The tray program hasn't reported to the bridge yet (it is starting). | Use the tray menu's **Check for updates**, or reload the page in a moment. |
| Admin page: **The Encore Bridge icon on the PC didn't answer. Check that Encore Bridge is running there, then choose Check for updates in its menu.** | The page's **Check now**, **Update now** or **Cancel** went to the tray program, and nothing picked it up within two minutes. | Check that the Encore Bridge icon is in the PC's notification area, then use its menu. |

### 17.9 Asking for help

When you report a problem, include:

1. The app version (Settings → About) and the bridge version.
2. Docker or Windows, and your device and iOS version.
3. The exact message you see.
4. The bridge log around the time it happened:
   - Docker: `docker compose logs --tail 500 gateway engine > encore-log.txt`
   - Windows: tray → **Troubleshooting → Open log** (`bridge.log`), or **Open logs folder** for the older files.

The bridge never writes passwords, tokens, search terms, or people's or devices' names into its log. On Windows it
cleans the engine's lines the same way and replaces your Windows user folder with `%USERPROFILE%`. Still, read a log
before you share it:

- It never shows a phone's address. A stream's line only says whether the phone was at home (your network or your VPN)
  or away.
- On Docker, the engine's own log (`docker compose logs engine`) names the songs it plays and the devices it hands
  playback to, and shows part of your Spotify username. To keep that private, leave `engine` out of the command above,
  or edit those lines.
- On Windows, an update's installer log (`%LOCALAPPDATA%\Encore\updates\<version>\setup.log`) is the installer's own
  file and isn't cleaned like the bridge's log: its paths show your Windows user name. Edit those before you share it.

**Never share** `.env`, `settings.env`, the `data` folder (`tokens.json`, `devices.json`, `admin.json` and the rest) or
the engine's `state.json`. They hold your sign-ins and your phones' keys. **Never post your public IP** or your Away
address: it tells strangers where your bridge is. The bridge's log never contains it.

Report problems on the project's issue tracker:
[github.com/mbucc9000/encore/issues](https://github.com/mbucc9000/encore/issues)

---

## 18. Updating

**Update the bridge first, then the app.** A new app may need the matching bridge. The app tells you when the bridge is
too old.

Encore Bridge looks for a new version once a day and tells you when one is out: on Windows in the tray menu and on the
admin page, on Docker on the admin page. It never installs anything on its own.

- **Windows:** choose **Update now…** and say yes to Windows' permission prompt.
- **Docker:** run the commands the admin page shows.
- **The app** on your phone updates through Cydia ([App](#app)).

### How Encore Bridge finds a new version

- **When:** by itself at most once a day (never in the first ten minutes after Encore Bridge starts), and whenever you
  choose **Check for updates** in the Windows tray menu or **Check now** in the admin page's **Updates** section. The
  daily check is quiet: no window pops up, and the tray menu and the admin page show what it found. A check you ask
  for always answers, for example **Encore Bridge 1.1.0 is up to date.**
- **Where:** the releases of Encore's public repository, `https://github.com/mbucc9000/encore/releases`. On Windows the
  tray program asks GitHub and the bridge shows the result. On Docker the bridge asks.
- **What it offers:** only a final release newer than yours, for example 1.1.1 or 1.2.0 when you have 1.1.0. Test
  versions (release candidates such as `1.2.0-rc1`) and older versions are never offered.
- **Signed:** Encore Bridge checks each release's signature, made with Encore's release key, before it offers the
  release, and on Windows again before it installs it ([17.8](#178-updates)).
- **What it sends:** nothing about you. The request carries no identifier, only the User-Agent
  `EncoreBridge/<version>`. GitHub sees your home's public IP address, as with any download
  ([chapter 22](#22-privacy-what-stays-home-and-what-leaves)).

On the admin page, the **Updates** section (below **Engine & stream**) shows the result, for example **Encore Bridge
1.1.0 · up to date (checked …)** or **Encore Bridge … is available (you have …) · What's new**, with a **Check now**
button. While a new version waits, a banner under the header says **Encore Bridge … is available.**, with **What's new**
(the release notes on GitHub) and **Update…**, which takes you to the **Updates** section.

### Bridge on Windows (installer)

When a new version is out, the tray menu has a new line, **Encore Bridge … is available** (for example **Encore Bridge
1.2.0 is available**), and the icon's tooltip ends in **· 1.2.0 available**. To update:

1. Tray menu → **Encore Bridge … is available** → **Update now…**. (**What's new** next to it opens the release notes.)
2. Encore Bridge asks **Update Encore Bridge to …?** and shows the size of the download. Choose **Yes**.
3. It downloads the installer from GitHub. The menu line shows the progress: **Updating to …: downloading …%**, then
   **Updating to …: checking the download…**, then **Updating to …: waiting for Windows…**.
4. Windows asks for permission to let the installer make changes. Encore isn't code-signed, so the prompt shows the
   publisher as **Unknown**. The program name is `EncoreBridge-<version>-setup.exe`. Choose **Yes**. (If your Windows
   account isn't an administrator, Windows asks for an administrator's password instead.) If no prompt appears, click
   the flashing shield (**User Account Control**) on the taskbar: Windows puts the prompt there when you were busy in
   another window. The blue SmartScreen window from the first install doesn't normally appear: it only checks files a
   browser downloaded.
5. The installer runs without questions, in a small progress window. It quits Encore Bridge, replaces the program files
   and starts Encore Bridge again. Phones stop playing for about a minute.
6. A window says **Encore Bridge is now version ….** Then update the app on your phone: Cydia → **Changes** →
   **Refresh** ([App](#app)).

Everything in `%LOCALAPPDATA%\Encore` stays: your settings, the Spotify sign-ins, the paired phones, the admin password
and the engine's settings (`engine\config.yml`; a new version never overwrites it). Your **Start with Windows** choice
and the firewall rule stay too.

- **Cancel:** while it downloads, choose **Cancel update** in the tray menu (or **Cancel** on the admin page). **Update
  now…** later continues where it stopped. If you choose **No** in Windows' prompt, nothing changes: **The update was
  cancelled. Encore Bridge … is still installed.**
- **From the admin page:** the **Updates** section has **Update now** too, with a progress bar and **Cancel**. It works
  only when the page was opened on the PC as `http://127.0.0.1:8095/admin` (the tray's **Open Encore Bridge**), because
  Windows' prompt appears on that PC's screen. From another computer, or on the PC by its network address, the page
  tells you to use the tray icon on the PC. When the download is ready, Encore Bridge asks on the PC: **Encore Bridge …
  is downloaded and checked against Encore's signed checksum list. Install it now?** Choose **Yes**, and Windows'
  prompt follows.
- **If an update doesn't finish:** if the installer stops after it has quit Encore Bridge, it starts your old version
  again, and you see **The update to Encore Bridge … didn't finish, so Encore Bridge … was started again.** The
  installer's log is `%LOCALAPPDATA%\Encore\updates\<version>\setup.log`. If the installer had already removed the old
  program files, the old version can't start either. Encore Bridge then says **The update to Encore Bridge … didn't
  finish, and Encore Bridge can't start** and names the downloaded installer to run again. These messages are in
  [17.8](#178-updates).
- **The download** goes to `%LOCALAPPDATA%\Encore\updates\<version>\` and is removed once the new version runs.

**Updating by hand** works as before: download the new `EncoreBridge-<version>-setup.exe` from the release page and run
it. It quits the running Encore Bridge, upgrades in place and keeps your settings. Its last page offers **Start Encore
Bridge now**.

### Bridge on Windows (portable zip)

The zip looks for new versions the same way and shows the same **Encore Bridge … is available** line in the tray menu,
with **Download…** instead of **Update now…**. **Download…** opens the release page. A zip copy never downloads or
installs anything itself. To update:

1. Download `EncoreBridge-<version>-win64.zip` from the release page.
2. In the tray menu, choose **Quit Encore Bridge**.
3. Unblock the zip and unzip it into a **new, empty folder** ([5.3b](#53b-or-use-the-portable-zip)). Don't mix old and
   new files. Start `Encore Bridge.exe` from there.
4. Windows asks again about the firewall, for the new folder's **Node.js JavaScript Runtime**. Tick **Private
   networks** only and press **Allow access**.
5. If you use **Start with Windows**, tick it again in the new copy's tray menu.

Your settings, sign-ins and paired phones in `%LOCALAPPDATA%\Encore` stay. Once the new version plays, delete the old
folder.

### Bridge on Docker

Encore Bridge doesn't update itself on Docker. When a new version is out, the admin page's **Updates** section shows the
update commands with the version numbers filled in, each block with a **Copy** button. Run them on the computer that
runs the bridge, from the folder that holds your current `Encore-<old>` folder. If your folder has another name, use
that name instead of `Encore-<old>`. `<new>` is the new version and `<old>` is yours:

```sh
curl -fLO https://github.com/mbucc9000/encore/releases/download/v<new>/Encore-<new>-source.tar.gz &&
tar xzf Encore-<new>-source.tar.gz &&
(cd Encore-<old>/gateway && docker compose down) &&
cd Encore-<new>/gateway &&
sudo cp -rp ../../Encore-<old>/gateway/data . &&
sudo cp -p ../../Encore-<old>/gateway/engine/state.json engine/
```

Line by line: download the new source archive; unpack it next to the old folder; stop the old bridge; go into the new
`gateway` folder; copy your `data/` folder (pairings, sign-ins, the admin password, the Client ID the setup guide saved,
Jam access, caches) and the engine's sign-in over from the old folder. Each line ends in `&&`, so a line runs only if
the one before it worked.

The copies need `sudo`: the bridge runs as root, so most of the copied files belong to root and only root can read
them. Without `sudo` the copy is incomplete, and the new bridge starts without your pairings and sign-ins.

Then, still in the new `gateway` folder:

- If you made a `.env`, copy it too: `sudo cp -p ../../Encore-<old>/gateway/.env .`
- If you changed `engine/config.yml` or `compose.yaml`, make the same changes in the new files. Don't copy the old ones
  over them: a new version may change them too.

Build and start the new version:

```sh
docker compose up -d --build
```

**A second bridge** ([chapter 20](#20-running-a-second-bridge)): in its folders use `docker compose -p encore2 down` and
`docker compose -p encore2 up -d --build`, copy that bridge's own `data/` and `engine/state.json`, and keep its
`compose.yaml` and `config.yml` changes. Update both bridges to the same version together: they share image names.

**With a git clone:**

```sh
cd <your clone>/gateway &&
git fetch --tags &&
git checkout v<new>
```

Put your clone's folder in place of `<your clone>`. Your `.env`, `data/` and `engine/state.json` stay where they are.
If `git checkout` refuses because you changed `engine/config.yml` or `compose.yaml`, run `git stash`, then the lines
above again, then `git stash pop`. Then build and start the new version:

```sh
docker compose up -d --build
```

Pairings, sign-ins, the admin password, the Client ID, Jam access and caches all survive: they live in `data/` and
`engine/`. Keep the old folder until the new bridge plays, then delete it with `sudo rm -rf Encore-<old>`. Then update
the app: Cydia → **Changes** → **Refresh** ([App](#app)).

**Another Linux install, without Docker:** the admin page shows the same notice. Stop the bridge, replace its files
with the new `gateway/src`, keep your data folder (`DATA_DIR`), and start it again.

### Turning the update check off

Set `UPDATE_CHECK=0` ([16.4](#164-bridge-settings)):

- **Windows:** tray menu → **Troubleshooting → Edit settings…**. Add the line `UPDATE_CHECK=0` (if the file has a
  `#UPDATE_CHECK=1` line, change that one to `UPDATE_CHECK=0`) and save. No restart is needed: the tray reads the file
  before each daily check.
- **Docker:** put `UPDATE_CHECK=0` into `.env` in the `gateway` folder (make one as in
  [4.3](#43-a-settings-file-optional) if you have none), then run `docker compose up -d` there.

The daily check then stops. **Check for updates** and **Check now** still work when you choose them, and the admin page
says **Automatic checks are off (UPDATE_CHECK=0). Check now still works.**

### App

From the Encore repo ([chapter 9](#9-install-the-app-from-the-encore-repo)): after the bridge is updated, open Cydia →
**Changes** → **Refresh** and install the Encore update. Otherwise, install the new `.deb` the same way as the first
time ([9.3](#93-other-ways-to-install-the-app)). Your settings, pairing and caches are kept. Upgrades don't refresh the
home screen, and you don't need to.

### Which versions work together

The app and the bridge share one version number. Keep them on the same version.

| Encore app | Encore Bridge | Engine |
|---|---|---|
| 1.1.x | 1.1.x | go-librespot 4dbc099 + Encore patches 1–6 (built with the bridge) |

1.1.0 is the first public version. The app reads the bridge's version (shown in Settings → About → Encore Bridge).
Where a feature needs a newer bridge, the app says **Update your Encore Bridge.**

The engine is always built or bundled with the bridge. On Windows they ship as one package, and the bridge refuses to
start an engine of another version. On Docker, `docker compose up -d --build` rebuilds both.

---

## 19. Backing up or moving the bridge

### What to keep

| Docker (in the `gateway` folder) | Windows (in `%LOCALAPPDATA%\Encore`) | What it is |
|---|---|---|
| `.env` (if you made one) | `settings.env` | Your settings (on Windows also the Client ID) |
| `data/settings.json` | — | The Client ID the setup guide saved |
| `data/wizard.json` | `data\wizard.json` | The setup guide's progress (only times, no addresses) |
| `data/devices.json` | `data\devices.json` | Paired phones and their keys |
| `data/tokens.json` | `data\tokens.json` | Your Spotify sign-in (refresh token) |
| `data/jam.json`, `data/last.json` | `data\jam.json`, `data\last.json` | Jam access, last playback state |
| `data/admin.json` | `data\admin.json` | Your admin password (salted hash) |
| `data/showcase.json` | `data\showcase.json` | Whether Showcase is on |
| `engine/state.json`, `engine/config.yml` | `engine\state.json`, `engine\config.yml` | The engine's sign-in and settings |
| — | `launcher.json` | The tray's own choices |

Back up the whole `data` folder plus the rest of the list. You can skip `data/cache/` and `data/diag/` (caches and
phone diagnostics), `pipe/` (Docker) and `logs\` (Windows). `data/settings.json` and `data/wizard.json` are plain
settings, not secrets. The sign-ins and keys next to them are secrets.

On Docker the bridge and the engine run as root, so `data/`, its files and `engine/state.json` belong to root, and most
can be read only by root. Back them up with `sudo`. For example, in the `gateway` folder:

```sh
sudo tar czf ~/encore-backup.tgz --exclude=data/cache --exclude=data/diag .env data engine/state.json engine/config.yml
```

(Leave `.env` out of the command if you didn't make one.)

To restore, stop the bridge and unpack the backup in the new `gateway` folder with `sudo tar xzpf ~/encore-backup.tgz`.

> **Treat a backup like a password.** It contains your Spotify sign-ins and your phones' keys. Store it encrypted or
> somewhere only you can read.

### Moving to a new machine

1. Stop the old bridge.
2. Set up the new one ([chapter 4](#4-install-the-encore-bridge-with-docker-linux) or
   [5](#5-install-the-encore-bridge-on-windows)), but **before its first start**, copy the files above into place (on
   Docker with `sudo`, as above).
3. Start it. Your phones stay paired, and the setup guide sees that the bridge is already set up. If the bridge's
   address changed, update **Home Address** in each phone's Settings, and point your router's port forward at the new
   address ([11.1](#111-forward-the-port-setup-guide-step-8)). In a new home (a new router or provider), also set up the
   forward there and update the Away Address (the setup guide's step 8).

You can move between Docker and Windows the same way, with two exceptions:

- Copy the engine's `state.json` but **not** its `config.yml`. Each platform has its own engine settings.
- Copy `.env`'s values into `settings.env` (or the other way round), not the file itself.

The files in `data` have the same format on both, and an engine sign-in saved on one platform is reused on the other.
This move hasn't been tried on every combination yet, so keep the old bridge's files until the new one plays. If the
engine asks to sign in again, [sign it in](#8-sign-the-engine-in-to-spotify) again.

---

## 20. Running a second bridge

One bridge serves one Spotify account. For a second account (a family member), run a second bridge. On Docker:

1. Copy the whole `gateway` folder to a new folder, without `data/`, `pipe/` and `engine/state.json`.
2. In the copy, change everything that would collide with the first bridge:

   | Where | Change |
   |---|---|
   | `compose.yaml` | `container_name` of both services (for example `encore2-gateway`, `encore2-engine`), and `PORT` (for example `"8096"`) |
   | `compose.yaml` | `ENGINE_URL` to the second engine's port (for example `http://127.0.0.1:3679`) |
   | `engine/config.yml` | `server.port` to the same port (`3679`) and `device_name` (for example `Encore 2`) |
   | `.env` (if the folder has one) | Empty `SPOTIFY_CLIENT_ID`, so the second bridge's setup guide asks for the second person's Client ID (their own developer app, or yours with their account added under User Management) |

3. Start it with a different project name: `docker compose -p encore2 up -d --build`. (Both stacks build images with
   the same names. That is fine while both folders hold the same Encore version.)
4. The second person opens the admin page at `http://<your-bridge-address>:8096/admin`. Its setup guide walks them
   through the admin password (the setup code is in `docker compose -p encore2 logs gateway`), their own Client ID and
   Spotify account, the second engine (they pick **Encore 2**), and pairing their phone with
   `<your-bridge-address>:8096`.

The app is the same for both bridges: a phone installs it once from the Encore repo and pairs with either bridge. To
listen away from home with the second bridge, forward its port too (TCP 8096 → the same computer, port 8096). Its setup
guide's step 8 builds the Away address with that port.

This recipe follows from how the files work, but it hasn't been run end to end yet. If a step is missing, report it.

On Windows, one Encore Bridge runs per Windows user in this release. Starting it again only opens the admin page of the
one that runs.

---

## 21. Uninstalling

### The app

1. In Encore: **Settings → Unpair This iPhone**. On the admin page, **Unpair** the phone too (that revokes its key).
2. Remove the package: Cydia → **Installed** → **Encore** → **Modify** → **Remove**, or as root:

   ```sh
   dpkg -r com.mbucc9000.encore
   ```

3. Optional: remove the Encore repo from Cydia: **Sources** → **Edit**, tap the red button next to it, then **Delete**.
   Skip this if you use other packages from it.
4. Optional: remove what the package leaves behind:
   - `/var/mobile/Library/Preferences/com.mbucc9000.encore.plist` (settings)
   - `/var/mobile/Library/Caches/com.mbucc9000.encore/` (cached lists and pictures)
   - `/var/mobile/Library/Encore/` (only on some phones: a fallback copy of the pairing)
   - a Keychain item for the pairing (harmless once the phone is unpaired on the admin page)

### The bridge on Docker

In the bridge's `gateway` folder:

```sh
docker compose down
docker image rm encore-gateway:local encore-engine:local
```

Then delete the folder (including `data/`, `engine/` and `pipe/`) with `sudo rm -rf <the folder>`. The bridge's files
in it belong to root. Remove the port forward from your router if you added one.

### The bridge on Windows

- **Installer:** **Settings → Apps → Installed apps → Encore Bridge → Uninstall.** It quits Encore Bridge, removes its
  firewall rules and its Start with Windows entry, and asks **Also delete your Encore Bridge data?** Choose **Yes** to
  delete `%LOCALAPPDATA%\Encore`, or **No** (the default) to keep it for a later reinstall.
- **Portable zip:** in the tray, untick **Start with Windows**, then choose **Quit Encore Bridge**. Delete the program
  folder and `%LOCALAPPDATA%\Encore`. Remove the firewall rules named **Node.js JavaScript Runtime** (the ones for that
  folder's `node.exe`), and **Encore Bridge (phone)** if **Fix firewall…** made one (`wf.msc` → Inbound Rules).

Remove the port forward from your router if you added one.

### On Spotify's side

1. Admin page → Spotify account → **Disconnect** (before you remove the bridge).
2. <https://www.spotify.com/account/apps/>: remove your developer app's access.
3. <https://developer.spotify.com/dashboard>: delete the developer app if you don't need it any more.
4. The engine's saved sign-in disappears with the bridge's files. To be sure, use **Sign out everywhere** on your Spotify
   account page. That signs out **all** your devices, so you'll have to log in again on them.

---

## 22. Privacy: what stays home and what leaves

Encore has **no central server**. Nothing goes to Encore's authors, and there's no analytics or telemetry. The only
check for new versions goes to GitHub (below), and you can turn it off.

### What stays on your bridge

| Data | Where |
|---|---|
| Your Spotify refresh token (Web API), and your Spotify name and id | `data/tokens.json` |
| The engine's Spotify sign-in | `engine/state.json` (Docker) / `%LOCALAPPDATA%\Encore\engine\state.json` (Windows) |
| Paired phones (name, id, key, last contact) | `data/devices.json` |
| Your admin password (salted hash) | `data/admin.json` |
| Your developer app's Client ID | `settings.env` (Windows), `data/settings.json` (Docker), or `.env` if you put it there |
| The setup guide's progress (skipped steps, when a phone first reached the bridge from outside your home network and when music first played; no names, addresses or codes) | `data/wizard.json` |
| Jam access and the last playback state | `data/jam.json`, `data/last.json` |
| Phone diagnostics logs | `data/diag/` |
| Cached lists, covers, profiles and lyrics | `data/cache/` |
| The update check's last result (times, version numbers, checksums, error codes; nothing about you) | `data/update.json` (Docker) / `%LOCALAPPDATA%\Encore\update.json` (Windows) |
| The bridge's log | Docker: the container log (`docker compose logs`); Windows: `%LOCALAPPDATA%\Encore\logs\` |

On Linux the secret files are readable only by their owner. On Windows, `%LOCALAPPDATA%` is private to your Windows user.

### What stays on your phone

Settings (including the Home and Away addresses), the pairing key (in the Keychain), cached lists and pictures, pinned
playlists and recent searches. **No audio** and **no Spotify password**.

### Where the bridge connects

| Destination | Why |
|---|---|
| Spotify (`api.spotify.com`, `accounts.spotify.com`, `spclient.wg.spotify.com`, `api-partner.spotify.com`, and the engine's own Spotify servers and audio servers) | Playback, your library, search, profiles, Jams |
| `open.spotify.com`, `open.spotifycdn.com` | Refreshing the identifiers the profile and people-search features need (public web-player files) |
| `spotify.link`, `spotify.app.link` | Expanding short Jam invite links |
| Spotify's image servers (`*.scdn.co`, `*.spotifycdn.com`) and, for some profile pictures, Facebook's image servers | Cover art, profile pictures, Spotify Codes |
| `lrclib.net` | Lyrics: it receives the song's name, first artist, album and length |
| `api.github.com`; for a new version also `github.com` and GitHub's download servers (`*.githubusercontent.com`) | **The update check:** at most once a day, and when you press **Check for updates** / **Check now**. It sends only `EncoreBridge/<version>`. GitHub sees your public IP, as with any download. When a new version appears, the bridge fetches its small signed checksum list. Only **Update now** (Windows) downloads the installer. `UPDATE_CHECK=0` turns the daily check off. On Windows the tray program makes these requests, not the bridge. |
| `api.ipify.org`, then `ipv4.icanhazip.com`, then `ifconfig.me` (one after another, only until one answers) | **Only when you press Find my public IP** in the setup guide's step 8: your home's public IP, for the Away address. Never in the background, never at startup, never while Showcase is on. The service sees your home's public IP (that is how it answers), but not that the request comes from Encore Bridge: it carries a generic User-Agent. The bridge keeps the answer only in memory, for 30 seconds, and never writes it to disk or into its log. |

The Encore app only ever talks to **your** bridge. (Cydia talks to the Encore repo when it installs or updates Encore,
as it does with any repo.)

### Logs

The bridge's log never contains passwords, tokens, search terms, song names, or people's or devices' names, in any
mode. It logs ids, counts and error codes instead. Lyrics are never logged, and neither are your phones' addresses: a
stream's line only says whether the phone was at home (your network or your VPN) or away. On Windows the log also holds
the engine's lines, after the bridge has removed names, sign-in codes and your Windows user folder from them.

The Client ID and your home's public IP never go into the log either. The public-IP check logs only which service
answered (or why none did), and step 8's tick logs one line without any address. The setup guide's network check never
reads the name of your Wi-Fi network. The update check logs only version numbers and error codes, never an address, a
link or GitHub's answer.

On Docker the engine keeps its own log (`docker compose logs engine`). It names the songs it plays and the devices it
hands playback to, and shows part of your Spotify username. It stays on your machine unless you share it.

---

## 23. FAQ

**Why do I need Premium?**
The engine (like every Spotify Connect speaker) only plays for Premium accounts, and Spotify requires the owner of a
developer app to have Premium.

**Why do I have to make my own developer app?**
Spotify's development mode allows only a handful of users per app, and a shared app would tie everyone to one person's
account. Your own app takes five minutes, keeps you independent, and the setup guide walks you through it.

**Do I have to use the setup guide?**
No. It makes the usual steps easier and checks them for you. Everything also works by hand: the Client ID in
`settings.env` or `.env` ([3.2](#32-give-the-bridge-the-client-id)), the admin page's cards for the Spotify account, the
engine and pairing ([chapter 16](#16-admin-page-reference)), the app installed with Filza or SSH
([9.3](#93-other-ways-to-install-the-app)), and the port forward from [chapter 11](#11-listening-away-from-home) (your
router's Internet address is your public IP). Close the setup guide with the ✕ whenever you like.

**Where does the app come from?**
From the Encore repo, a Cydia repo on the internet: `https://mbucc9000.github.io/slopkit/`
([chapter 9](#9-install-the-app-from-the-encore-repo)). The bridge doesn't serve the app. Every release's `.deb` is also
on the release page, for Filza or SSH.

**Does Encore Bridge update itself?**
It looks for a new version on GitHub once a day and tells you, but it never installs anything by itself. On Windows,
**Update now…** in the tray menu downloads the new installer and runs it once you say yes to Windows' prompt. On
Docker, the admin page shows the commands to run. `UPDATE_CHECK=0` turns the daily check off
([chapter 18](#18-updating)). The app updates through Cydia.

**What do I type as the Away address?**
Your home's public IP plus Encore's port, for example `http://203.0.113.7:8095`. The setup guide's step 8 finds it with
**Find my public IP**, after you forward TCP 8095 on your router ([11.1](#111-forward-the-port-setup-guide-step-8)).

**Does Encore download music or remove DRM?**
No. Audio is streamed live from Spotify to your own phone, the same way any Spotify Connect speaker plays it. Nothing
is saved to a file, on the bridge or on the phone.

**Is it safe?**
Your sign-ins stay on your bridge, every phone request is signed, the admin page only answers your home network, and
the code is open source. A port forward exposes only the signed phone API, not the admin page or pairing. But away from
home without a VPN, the stream is plain HTTP ([11.2](#112-what-a-port-forward-exposes)). And because Encore uses
private Spotify interfaces, using it may break Spotify's terms ([chapter 25](#25-legal-and-disclaimer)).

**Can I use it on mobile data?**
Yes, with a port forward on your router (the setup guide's step 8) or a VPN
([chapter 11](#11-listening-away-from-home)). See the [data table](#mobile-data-use).

**Can my family use it?**
Several phones can pair with one bridge, but they share one Spotify account and one player (one song at a time). For a
second account, run a [second bridge](#20-running-a-second-bridge).

**Does Spotify still work on my computer and other devices?**
Yes. Encore is another Spotify Connect speaker. Whichever device you press Play on gets the music.

**Can I Jam with friends who use the normal Spotify app?**
Yes. They join with their own Spotify apps ([chapter 14](#14-jam-with-friends)).

**Spotify keeps "refusing to play". Why?**
Spotify sometimes refuses to hand out audio keys to librespot-based players, for some accounts more than others. Encore
pauses and backs off when that happens. Encore can't fix this on its side.

**Podcasts? iPad? iOS 7? Dark mode?**
Not in this release.

**Does it need a Mac?**
No. You only need a Mac or Linux build machine (with Theos) to build the app from source.

**Can the bridge run on a Raspberry Pi?**
Probably, on a 64-bit OS with Docker (a Pi 4 or 5). It's untested.

**Why not Docker Desktop on Windows or a Mac?**
Docker Desktop puts containers behind its own network, so Spotify Connect discovery can't see them and the admin page
can't tell your home network from the internet. Use the Windows bridge on Windows.

**Can I use Tailscale or WireGuard on the phone?**
There are no versions for iOS 6 or iOS 5. Use a port forward, or the built-in L2TP VPN
([chapter 11](#11-listening-away-from-home)).

---

## 24. Building from source

Everything in a release can be built from this repository. [`BUILDING.md`](BUILDING.md) has the full steps:

- **App:** Theos with the iOS 6.1 SDK, on Linux or macOS. From `app/`: `make package FINALPACKAGE=1`. The target is
  `iphone:clang:6.1:6.0`, `armv7`. The icon and launch images come from `app/tools/make_art.py` (Python with NumPy).
- **Bridge on Docker:** `docker compose up -d --build` builds both images from source (the engine from `engine-src/`).
- **Windows bridge:** everything is built on a Linux machine with Docker, nothing on Windows. The engine
  (`encore-engine.exe`) is cross-compiled with MinGW-w64 and vcpkg (upstream go-librespot's own recipe) by
  `gateway/windows/build-engine/build.sh`. Then `gateway/windows/build.sh` builds the tray launcher, the portable zip
  and the installer (Inno Setup under Wine) in two build images.
- **Tests:** `node --test` in `gateway/test`, or `node --test "gateway/test/*.test.js"` from the repository root
  (Node 22; ffmpeg for some tests).
- **Release files:** `tools/release/release.py` builds all of them, writes `SHA256SUMS.txt` and signs it
  (`SHA256SUMS.txt.sig`, [BUILDING.md](BUILDING.md#release-signing)).

The engine is go-librespot at upstream commit `4dbc099` plus Encore's patches, described in
`gateway/engine-src/ENCORE_PATCH.md` and contained in `gateway/engine-src/ENCORE_PATCH.diff`.

---

## 25. Legal and disclaimer

**Encore is an unofficial Spotify client for iOS 6.** It is not affiliated with, endorsed, sponsored or supported by
Spotify AB. "Spotify" is a trademark of Spotify AB, used here only to say what Encore works with. Encore's icon is
original artwork, and Encore uses no Spotify logo.

**How Encore talks to Spotify.** Encore uses Spotify's public Web API through **your own** developer app, under **your**
acceptance of Spotify's Developer Terms. It **also** uses private, undocumented Spotify interfaces:

- the Spotify Connect protocol as implemented by librespot and go-librespot, which identifies itself with a Spotify
  desktop-client id,
- internal playlist and metadata services,
- the social-connect service behind Jams,
- internal profile, search and follow services, with a desktop-client user agent,
- Spotify's short-link service, and identifiers from Spotify's public web-player files.

These may stop working at any time, and **using them may break Spotify's Terms of Use or Developer Terms**. Spotify
could limit or close the account you use with Encore. **You use Encore at your own risk.**

**No piracy.** Encore requires Spotify Premium. It never saves audio, never removes DRM into files, and only streams
music live to your own device.

**Lyrics** come from [LRCLIB](https://lrclib.net), a community database. They are only displayed in the app, never
stored as files or logged.

**Jailbreaking** your device is your own decision and your own risk.

**No warranty.** Encore is a hobby project, provided "as is", without any warranty, as the GNU General Public License
says. There is no promise of support or updates.

If Spotify or another rights holder has a concern about this project, please contact the maintainers through the
project's issue tracker: [github.com/mbucc9000/encore/issues](https://github.com/mbucc9000/encore/issues). It will be
dealt with promptly.

---

## 26. Credits and licenses

**Encore** is free software under the **GNU General Public License, version 3 or (at your option) any later version**
(GPL-3.0-or-later). See [`LICENSE`](../LICENSE).

Encore builds on:

- **[go-librespot](https://github.com/devgianlu/go-librespot)** by devgianlu and contributors (GPL-3.0). Encore's engine
  is a modified copy; the full source and the list of changes ship with every release.
- **[librespot](https://github.com/librespot-org/librespot)** and its community, for years of Spotify protocol research.
- **[FFmpeg](https://ffmpeg.org)** for AAC encoding and cover resizing.
- **[Node.js](https://nodejs.org)**, which runs the bridge.
- **[LRCLIB](https://lrclib.net)** for synced lyrics.
- **[Theos](https://theos.dev)**, the build system for the iOS app.
- **[Project Nayuki's QR Code generator](https://www.nayuki.io/page/qr-code-generator-library)** (MIT), which the
  bridge's own QR encoder follows (Jam invites on Windows).
- **[fyne.io/systray](https://github.com/fyne-io/systray)** for the Windows tray icon.
- **[Inno Setup](https://jrsoftware.org/isinfo.php)** for the Windows installer.

The full list of third-party components and their licenses is in
[`THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md). The Windows package also has a `licenses` folder with every
license text.

Project page: [github.com/mbucc9000/encore](https://github.com/mbucc9000/encore).
