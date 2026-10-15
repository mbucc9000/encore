# The Encore guide

Encore is an unofficial Spotify client for jailbroken iOS 6 (iOS 5 works too). It plays through **Encore Bridge**, a
program on a computer at home. This guide covers Encore **1.3.0** (the app and the bridge share one version number).

> **Unofficial.** Encore is not made, endorsed or supported by Spotify. It needs your own Spotify Premium account and
> your own Spotify developer app, and it uses private Spotify interfaces that can change or break at any time. Use it
> at your own risk ([Legal and credits](#10-legal-and-credits)).

## Contents

1. [Install](#1-install)
2. [Listen away from home](#2-listen-away-from-home)
3. [Using Encore](#3-using-encore)
4. [Bridge settings](#4-bridge-settings)
5. [Troubleshooting](#5-troubleshooting)
6. [Updating](#6-updating)
7. [Uninstalling](#7-uninstalling)
8. [Privacy](#8-privacy)
9. [FAQ](#9-faq)
10. [Legal and credits](#10-legal-and-credits)

## 1. Install

The tutorials go from nothing to your first song, screen by screen: [Windows](TUTORIAL-WINDOWS.md) or
[Docker](TUTORIAL-DOCKER.md). In short: install the bridge, follow its setup guide in your browser, put Encore on your
phone and pair it. It takes about 20 minutes.

### What you need

- **Spotify Premium**, and a free **Spotify developer app** of your own, made at the
  [Spotify developer dashboard](https://developer.spotify.com/dashboard) (the setup guide shows you how).
- **A jailbroken iPhone or iPod touch with Cydia.** iOS 6: iPhone 5, 4S or 4; iPod touch 5th or 4th generation. iOS 5
  (5.0 to 5.1.1): iPhone 4S, 4 or 3GS; iPod touch 4th or 3rd generation. Only the iPhone 5 on iOS 6 is tested. No
  iPad, no iOS 7 or later.
- **A computer for the bridge that stays on and awake** while you listen:
  - **Windows** 10 or 11, 64-bit. The bridge runs while you're signed in. Your home network must be **Private**.
  - **Docker** on a 64-bit Linux computer or NAS (x86-64 or ARM64) with Docker Compose v2 or newer.
- **Your home Wi-Fi**, with the phone and the bridge on it for setup.

Not supported: Docker Desktop on Windows or macOS (on a PC, use the Windows bridge), a macOS bridge, and a reverse
proxy in front of the bridge.

### Install the bridge

Downloads: [github.com/mbucc9000/encore/releases](https://github.com/mbucc9000/encore/releases/latest).

**Windows:** run `EncoreBridge-<version>-setup.exe`. If SmartScreen says **Windows protected your PC**, click **More
info**, then **Run anyway** (only for a file from the release page). Keep **Start Encore Bridge when I sign in to
Windows** ticked. When it finishes, the setup guide opens and the icon appears near the clock.

**Docker:** in a new folder, download the compose file, start it, and get the one-time setup code for step 1:

```sh
mkdir ~/encore && cd ~/encore
curl -fL -o compose.yaml https://github.com/mbucc9000/encore/releases/latest/download/encore-docker-compose.yaml
docker compose up -d
docker compose logs gateway | grep "setup code"
```

Then open `http://<your-bridge-address>:8095/admin` from another device at home (`hostname -I` shows the address).
Run every `docker compose` command in this folder. Dockge or Portainer: paste the file into a new stack named `encore`
(Portainer: change `./data`, `./engine` and `./pipe` to full paths). If `systemctl is-active avahi-daemon` says
`active`, set up [zeroconf](#zeroconf-settings) first.

#### Portable zip

`EncoreBridge-<version>-win64.zip` needs no admin rights. Right-click it → **Properties** → tick **Unblock**, extract it
to a folder you own (not `Program Files`) and run `Encore Bridge.exe`. When Windows Firewall asks about **Node.js
JavaScript Runtime**, tick **Private networks** only and press **Allow access** (not Cancel). In the tray menu, tick
**Start with Windows**.

#### Build it yourself

To build the Docker images from source instead (Docker Compose 2.24 or newer): download
`Encore-<version>-source.tar.gz` from the release page, unpack it, and in its `gateway` folder run
`docker compose up -d --build`. Then continue as above (the setup code, the admin page). Details:
[BUILDING.md](BUILDING.md).

### Follow the setup guide

The setup guide is part of the bridge's admin page. It opens after the Windows installer (later: tray menu → **Setup
guide…**) and at the first visit to `http://<your-bridge-address>:8095/admin` on Docker. Each step shows what to do
and ticks itself (✓) when done; most have **Skip for now**. The steps: 1 **Protect this page** (Docker: with the setup
code from the log), 2 **Your Spotify developer app**, 3 **Connect your Spotify account**, 4 **Sign in the Encore
engine**, 5 **Check your network**, 6 **Put Encore on your phone**, 7 **Pair your phone**, 8 **Listen away from
home**, 9 **Play a song**, 10 **Turn on Jam** (optional). To come back later, press **Setup guide** on the admin page.

### Put Encore on your phone

The app comes from the Encore repo in Cydia:

```
https://mbucc9000.github.io/slopkit/
```

In Cydia: **Sources** → **Edit** → **Add**, type the address exactly (with `https://` and the `/` at the end), then
open the new source and install **Encore**. Step 6 of the setup guide shows the same, with a **Copy** button.

**Never run `uicache` yourself**: it can hide other sideloaded apps. If the Encore icon doesn't appear, respring.

#### Other ways to install the app

Download `Encore_<version>_iphoneos-arm.deb` from the release page and install it with **Filza** or **iFile**, or as
root: `dpkg -i Encore_<version>_iphoneos-arm.deb`. Then press **I've installed it** in step 6.

### Pair your phone

On your home Wi-Fi (pairing only works at home), open Encore and fill in:

- **Home:** the bridge's address with the port, for example `192.168.1.20:8095`. Don't leave out `:8095`.
- **Away:** leave it empty for now ([Listen away from home](#2-listen-away-from-home)).
- **Code:** the six digits from step 7. A code works once, for 5 minutes.

Tap **Connect**. Every request after pairing is signed with the phone's own key. Lost or sold a phone? **Unpair** it on
the admin page's **Pair a device** card.

## 2. Listen away from home

Away from home (mobile data, other Wi-Fi), the phone reaches the bridge through a **port forward** on your router.
Step 8 of the setup guide walks you through it. It needs a public IP at home.

### Forward the port

1. In step 8, press **Open your router** (or open your router's admin page yourself) and sign in. Give the bridge
   computer a fixed address there (**DHCP reservation**).
2. Forward **TCP 8095** to that address, port 8095. Forward this one port only; don't use **DMZ**.
3. Windows: nothing else to do while the network is **Private**. Docker with a firewall: allow TCP 8095, for example
   `sudo ufw allow 8095/tcp`.
4. In step 8, press **Find my public IP** and type the Away address it shows (`http://<your-public-ip>:8095`) into
   Encore → **Settings** → **Away Address** → **Save**.
5. Test on **mobile data** with Wi-Fi off (not on your home Wi-Fi). **Settings** → **Status** should say **Away**.

**Check it once:** on mobile data, open your Away address with `/admin` at the end in Safari. It must say **Not from
this address.** If it asks for a password, remove the port forward. The connection is plain HTTP: someone on the way
can see what you play. Never forward port 3678, use a strong admin password, and never post your public IP or Away
address.

## 3. Using Encore

- **Tabs:** Home, Search, Playlists, Library and Settings. While music plays, tap the mini player for **Now Playing**:
  swipe the cover to skip, tap **Lyrics** for lyrics, and flip to **Up Next** to reorder, remove or jump to songs.
- **Spotify Connect:** in any Spotify app, pick **Encore** in the devices menu and the music plays on your phone.
  Tapping Play in Encore takes playback back.
- **Settings:** Home and Away Address, Status, Streaming Quality, **Play a Link…**, Anonymous Mode, **Unpair This
  iPhone**, and **Diagnostics**.
- **App Icon** (Settings → Appearance): Encore, Classic, Round, 2013, Flat or Disco; the home screen icon changes at
  once. It needs MobileSubstrate (Encore itself runs without it) and one respring after installing Encore.
- Not included: podcasts, audiobooks, offline downloads, dark mode, iPad layouts.

### Jam with friends

A Jam is a shared Spotify queue. Hosting needs Premium. Before the first Jam, Encore needs a one-time check: step 10 of
the setup guide, **Turn on Jam** (skipped it? The admin page's **Jam** card has the same **Check Jam access** button).
After that, use **Settings** → **Jam** → **Start a Jam** or **Join a Jam…** in Encore. Encore leaves or pauses a Jam
that nobody is listening to.

### Anonymous Mode and Showcase

- **Anonymous Mode** (Settings → Privacy) hides names, pictures, addresses and devices on the phone. Music stays.
  **Hide My Playlist Names** also renames your own playlists.
- **Showcase** (the switch on the admin page, or **Showcase mode** in the tray) hides your account, codes and addresses
  on the bridge's screen.

Turn both on before you film or demo Encore, then close and reopen the app once.

## 4. Bridge settings

The setup guide sets everything most people need. For anything else, add a `NAME=value` line:

- **Windows:** tray menu → **Troubleshooting** → **Edit settings…** (`settings.env`), save, then **Troubleshooting** →
  **Restart bridge**.
- **Docker:** put the setting into a `.env` file next to `compose.yaml` (Dockge: the stack's `.env` box; Portainer:
  its environment variables), then run `docker compose up -d`.

| Setting | What it does |
|---|---|
| `SPOTIFY_CLIENT_ID` | Your developer app's Client ID. The setup guide saves it; a value here wins. |
| `ADMIN_PASSWORD` | The admin password. Wins over the one chosen in the setup guide. |
| `ADMIN_ALLOW` | Who may open the admin page and pair phones. Default `private` (your home network). |
| `PORT` | The bridge's port, default `8095`. On Docker, change `PORT` in `compose.yaml` instead. |
| `UPDATE_CHECK` | `0` turns the daily update check off. |
| `ENCORE_TAG` | Docker: a version to stay on, such as `v1.3.0` or `1.3`. Default: the newest. |
| `ZEROCONF_BACKEND` | Docker: `avahi` on machines that run avahi-daemon ([Zeroconf settings](#zeroconf-settings)). |

**Your data** is in `%LOCALAPPDATA%\Encore` on Windows (tray → **Troubleshooting** → **Open data folder**), and in
`data/` and `engine/` next to `compose.yaml` on Docker (owned by root: use `sudo`). To back up or move the bridge, copy
these before the new bridge's first start. They hold your sign-ins and your phones' keys: never share them, or `.env`
and `settings.env`.

## 5. Troubleshooting

### The phone can't reach the bridge

- The phone is on your **home Wi-Fi** (not a guest network), and the Home address ends in `:8095`.
- The bridge computer is on, awake, and (Windows) signed in.
- In the phone's Safari, `http://<your-bridge-address>:8095/` shows two lines starting with "Encore gateway". If not,
  it's the network or the firewall: on Windows set the network to **Private** and use tray menu → **Troubleshooting**
  → **Fix firewall…**; on Docker allow TCP 8095. Step 5 of the setup guide checks this.
- **Wrong or expired pairing code:** press **New pairing code** and type it within 5 minutes.
- **Your Encore Bridge doesn't know this phone any more:** **Settings** → **Unpair This iPhone**, then pair again.

### Status: Offline away from home

Test on mobile data, then check in order: the Away Address is set in Encore and ends in the port; the router forwards
TCP 8095 to the bridge's current address; your public IP hasn't changed (press **Find my public IP** in step 8 again);
Windows' network is still **Private**, or Docker's firewall allows TCP 8095; your router has a public IP of its own
(step 8 tells you how to check).

### Sign the engine in

If **Encore's player is reconnecting to Spotify.** doesn't go away, the engine isn't signed in (step 4).

- **Docker:** on your home network, play a song in a Spotify app (same account) and pick **Encore** once in its devices
  menu. Not listed? See [Zeroconf settings](#zeroconf-settings).
- **Windows:** open the link that step 4 (or tray → **Sign in to Spotify…**) shows, and approve the code.
- **The engine isn't answering:** Docker: `docker compose ps` and `docker compose logs engine`. Windows: tray →
  **Troubleshooting** → **Restart bridge**.

#### Zeroconf settings

On Docker, "Encore" appears in Spotify's device list through zeroconf. If it's missing:

- The Spotify app and the bridge must be on the same network (no guest Wi-Fi, separate VLAN or AP isolation).
- **avahi-daemon** (many NAS systems run it): put `ZEROCONF_BACKEND=avahi` into `.env`, remove the `# ` in front of
  the `/run/dbus/system_bus_socket` line in `compose.yaml`, and run `docker compose up -d`. Built yourself: set
  `zeroconf_backend: avahi` in `engine/config.yml` instead.
- **A firewall:** allow UDP 5353 and the engine's port. To fix that port, add `zeroconf_port: 45678` to
  `engine/config.yml`.
- **Or sign in with a code:** in `engine/config.yml` (with `sudo`), replace the `credentials:` block with the one
  below, run `docker compose restart engine`, and approve the code that step 4 (or `docker compose logs engine`) shows.

```yaml
credentials:
  type: device_auth
```

On Windows the engine signs in with a code. If Spotify won't take the code, switch to zeroconf: tray →
**Troubleshooting** → **Open data folder**, and in `engine\config.yml` set `zeroconf_enabled: true` and replace the
`credentials:` block with:

```yaml
credentials:
  type: zeroconf
  zeroconf:
    persist_credentials: true
```

Then **Restart bridge**, allow `encore-engine.exe` on **Private networks**, and pick **Encore** once in a Spotify app.

### Connecting your Spotify account fails

- **INVALID_CLIENT: Invalid redirect URI:** in your developer app, set the Redirect URI to exactly
  `http://127.0.0.1:8888/callback`, save, and press **Connect** again.
- **INVALID_CLIENT: Invalid client:** usually the client secret was saved. In step 2, press **Change** and paste the
  **Client ID**.
- **Spotify refused your account:** add your account under **User Management** in your developer app.
- On Docker (or from another computer), the tab after **Agree** says it can't be reached. That's expected: paste
  its whole address into step 3 and press **Use this address**.
- **Spotify sign-in expired:** press **Connect** again in step 3.

### The admin password

- The browser asks for a user name too: any name works, only the password counts.
- After 10 wrong passwords in 15 minutes, wait 15 minutes.
- **Forgot it?** Stop the bridge, delete `admin.json` from its data folder, and start it again. Docker:
  `docker compose down`, `sudo rm data/admin.json`, `docker compose up -d`. Step 1 then asks for a new password.
- **Not from this address.** means you came from outside your home network, or `ADMIN_ALLOW` leaves it out.

### Port 8095 is in use

On Windows (**Port 8095 is in use** or **Port 8095 is blocked by Windows** in the tray): **Troubleshooting** → **Edit
settings…**, change to `PORT=8096`, save, **Restart bridge**, then **Fix firewall…**. Use the new port in the app's
Home address (and in your port forward). On Docker, change `PORT` in `compose.yaml`.

### Spotify is refusing to play

**Spotify is refusing to play right now** or **Spotify is limiting requests**: wait a minute or two. Spotify sometimes
refuses players like Encore's engine; Encore can't fix that on its side. For stutters, keep **Auto-Reduce Quality** on
or pick a lower **Streaming Quality**.

### Docker image errors

- **pull access denied**, **unauthorized** or **manifest unknown:** check the `image:` lines in `compose.yaml`
  (`ghcr.io/mbucc9000/encore-bridge` and `ghcr.io/mbucc9000/encore-engine`) and `ENCORE_TAG` (`v1.3.0` or `1.3`).
  Right after a release, try again in an hour.
- **no matching manifest** or **exec format error:** the images need a 64-bit system;
  `docker version --format '{{.Server.Arch}}'` must say `amd64` or `arm64`.

### Update messages

- **…isn't signed with Encore's release key…** or **…doesn't match Encore's signature…**: nothing was installed. Don't
  get that version from anywhere else; report it on the issue tracker.
- **Couldn't reach GitHub** and similar: the bridge tries again by itself.
- A Windows update that didn't finish: run the new `EncoreBridge-<version>-setup.exe` from the release page by hand.

### Asking for help

Report problems at [github.com/mbucc9000/encore/issues](https://github.com/mbucc9000/encore/issues) with the app and
bridge versions (Settings → About), Windows or Docker, your device, the exact message, and the bridge log (Docker:
`docker compose logs --tail 500 gateway > encore-log.txt`; Windows: tray → **Troubleshooting** → **Open log**). Read
the log before you share it. Never share `.env`, `settings.env`, the data folder or your public IP.

## 6. Updating

Update the bridge first, then the app. The bridge checks GitHub once a day and shows **Encore Bridge … is available.**
on the admin page. It never installs anything by itself. To turn the daily check off, set `UPDATE_CHECK=0`
([Bridge settings](#4-bridge-settings)); **Check for updates** (tray) and **Check now** (admin page) still work.

### Bridge on Windows

Tray menu → **Encore Bridge … is available** → **Update now…** → **Yes**, and accept the Windows prompt (publisher
**Unknown**). Phones stop for about a minute; your settings, sign-ins and pairings stay. Or run the new
`EncoreBridge-<version>-setup.exe` from the release page.

**Portable zip:** the tray offers **Download…**. Quit Encore Bridge, unzip the new version into a new, empty folder,
start it, allow **Private networks** at the firewall prompt, and tick **Start with Windows** again.

### Bridge on Docker

In the folder with your `compose.yaml` (the admin page's **Updates** section shows these with a **Copy** button):

```sh
docker compose pull &&
docker compose up -d
```

Dockge: **Update**. Portainer: **Update the stack** with **Re-pull image and redeploy**. If `.env` sets `ENCORE_TAG`,
change it to the new version first.

#### A bridge you built yourself

The **Updates** section shows the commands with the versions filled in: they unpack the new source, stop the old
bridge and copy your `data/` and `engine/state.json` into the new `gateway` folder. Then run
`docker compose up -d --build` there. With a git clone: `git fetch --tags && git checkout v<new>`, then the same.

### Update the app

In Cydia: **Changes** → **Refresh**, then install the Encore update. Or install the new `.deb` the way you installed
the old one.

## 7. Uninstalling

### Remove the app

1. In Encore: **Settings** → **Unpair This iPhone**. On the admin page, **Unpair** the phone too.
2. Cydia → **Installed** → **Encore** → **Modify** → **Remove** (or as root: `dpkg -r com.mbucc9000.encore`).
3. Optional: remove the Encore repo in Cydia → **Sources** → **Edit**.

### Remove the bridge

First press **Disconnect** on the admin page's **Spotify account** card, and remove the port forward if you made one.

- **Windows:** **Settings** → **Apps** → **Installed apps** → **Encore Bridge** → **Uninstall**. It asks **Also delete
  your Encore Bridge data?**
- **Portable zip:** untick **Start with Windows**, choose **Quit Encore Bridge**, then delete the folder and
  `%LOCALAPPDATA%\Encore`.
- **Docker:** in the bridge's folder, run `docker compose down --rmi all`, then delete the folder with `sudo rm -rf`.

On Spotify's side, remove Encore's access at <https://www.spotify.com/account/apps/> and delete the developer app at
<https://developer.spotify.com/dashboard> if you don't need it.

## 8. Privacy

- Encore has **no central server**: nothing goes to Encore's authors, and there's no analytics.
- Your Spotify sign-ins, the admin password and your phones' keys stay on the bridge. The app only talks to your bridge.
  Your Spotify password never reaches either.
- No music is saved: the bridge keeps about 75 seconds of audio in memory.
- The bridge connects to Spotify, to `lrclib.net` for lyrics (the song's name, artist, album and length), to GitHub for
  the daily update check (`UPDATE_CHECK=0` turns it off), and to a public-IP service only when you press **Find my
  public IP**.
- The bridge's log leaves out passwords, tokens, names, search terms and addresses. On Docker the engine's own log
  (`docker compose logs engine`) names songs and devices.

## 9. FAQ

- **Why Premium?** Spotify Connect speakers like Encore's engine only play for Premium accounts.
- **Why my own developer app?** Spotify lets a developer app serve only a handful of users. Yours takes five minutes.
- **Does Encore download music or remove DRM?** No. It streams live to your own phone and saves nothing.
- **Can my family use it?** Several phones can pair with one bridge, but they share one Spotify account and play one
  song at a time.
- **Does it run on a Raspberry Pi?** A Pi 4 or 5 with a 64-bit OS and Docker should work. It hasn't been tested.
- **Podcasts? iPad? iOS 7? Dark mode?** Not in this release.
- **How do I build it myself?** See [BUILDING.md](BUILDING.md).

<a id="18-legal-and-disclaimer"></a>

## 10. Legal and credits

**Encore is an unofficial Spotify client.** It is not affiliated with, endorsed, sponsored or supported by Spotify AB.
Spotify and its logos are trademarks of Spotify AB; the optional app icons are included as provided. Encore uses the
name "Spotify" only to say what it works with.

Encore uses Spotify's public Web API through **your own** developer app, under **your** acceptance of Spotify's
Developer Terms. It **also** uses private, undocumented Spotify interfaces: Spotify Connect (through go-librespot),
internal playlist, metadata, profile, search and follow services, the Jam service, and Spotify's short links. These
may stop working at any time, and **using them may break Spotify's Terms of Use or Developer Terms**. Spotify could
limit or close the account you use with Encore. **You use Encore at your own risk.**

- **No piracy.** Encore requires Premium, never saves audio and never removes DRM.
- **Lyrics** come from [LRCLIB](https://lrclib.net) and are only shown, never stored.
- **Jailbreaking** your device is your own decision and risk.
- **No warranty.** Encore is a hobby project, provided "as is", without any warranty, as the GPL says.
- **Concerns** from Spotify or another rights holder: please use the
  [issue tracker](https://github.com/mbucc9000/encore/issues).

**License:** GPL-3.0-or-later ([`LICENSE`](../LICENSE)). Encore builds on
[go-librespot](https://github.com/devgianlu/go-librespot) (GPL-3.0; Encore's engine is a modified copy, with its source
in every release), [librespot](https://github.com/librespot-org/librespot), [FFmpeg](https://ffmpeg.org),
[Node.js](https://nodejs.org), [LRCLIB](https://lrclib.net), [Theos](https://theos.dev),
[Project Nayuki's QR Code generator](https://www.nayuki.io/page/qr-code-generator-library),
[fyne.io/systray](https://github.com/fyne-io/systray) and [Inno Setup](https://jrsoftware.org/isinfo.php). All
third-party licenses: [`THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md). Project page:
[github.com/mbucc9000/encore](https://github.com/mbucc9000/encore).
