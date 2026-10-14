# The Encore guide

Encore is an unofficial Spotify client for jailbroken iOS 6 (iOS 5 works too). It plays through the Encore Bridge, a
program on a computer at home. [Install](#1-install) takes you to your first song; the rest is reference.

**New here?** Follow the tutorial for your computer: [Windows](TUTORIAL-WINDOWS.md) or [Docker](TUTORIAL-DOCKER.md).
You install the bridge, and its setup guide takes you to your first song.

> **Unofficial.** Encore is not made, endorsed or supported by Spotify. It uses your own Spotify Premium account, your
> own Spotify developer app, and private Spotify interfaces that can change or break at any time. Read
> [Legal and disclaimer](#18-legal-and-disclaimer) before you start. Use it at your own risk.

This guide describes Encore **1.3.0** (the app and the bridge share one version number).

## Contents

**Install**

1. [Install](#1-install)
2. [Listen away from home](#2-listen-away-from-home)

**Use Encore**

3. [Feature tour](#3-feature-tour)
4. [Jam with friends](#4-jam-with-friends)
5. [Anonymous Mode and Showcase](#5-anonymous-mode-and-showcase)

**The bridge in detail**

6. [Spotify: your developer app and sign-ins](#6-spotify-your-developer-app-and-sign-ins)
7. [The setup guide and the admin page](#7-the-setup-guide-and-the-admin-page)
8. [The Windows bridge](#8-the-windows-bridge)
9. [The Docker bridge](#9-the-docker-bridge)
10. [Bridge settings and data](#10-bridge-settings-and-data)

**Keep it running**

11. [Troubleshooting](#11-troubleshooting)
12. [Updating](#12-updating)
13. [Back up, move, or add a second bridge](#13-back-up-move-or-add-a-second-bridge)
14. [Uninstalling](#14-uninstalling)

**About**

15. [Privacy: what stays home and what leaves](#15-privacy-what-stays-home-and-what-leaves)
16. [FAQ](#16-faq)
17. [Building from source](#17-building-from-source)
18. [Legal and disclaimer](#18-legal-and-disclaimer)
19. [Credits and licenses](#19-credits-and-licenses)

Text in `<angle brackets>` is a placeholder: replace it with your own value, without the brackets.
`<your-bridge-address>` is the bridge computer's address on your home network (for example `192.168.1.20`),
`<your-public-ip>` your home's public IP (for example `203.0.113.7`), `<your-client-id>` your developer app's Client
ID, and `<version>` the Encore version (for example `1.1.0`). **Bridge** means **Encore Bridge**; its source is
`gateway/`.

---

## 1. Install

Install the bridge on Windows or with Docker, follow its setup guide in your browser, then put Encore on your phone and
pair it. It takes about 20 minutes. The tutorials show the same path screen by screen: [Windows](TUTORIAL-WINDOWS.md),
[Docker](TUTORIAL-DOCKER.md).

### What you need

Encore has three parts:

- **Encore app:** the Spotify-style app on your jailbroken iPhone or iPod touch.
- **Encore Bridge:** a program on a computer at home. It talks to Spotify, turns the music into AAC your phone plays,
  and has a web **admin page** with a **setup guide**.
- **Engine:** inside the bridge, a patched [go-librespot](https://github.com/devgianlu/go-librespot) that acts as a
  Spotify Connect speaker called **Encore**.

You need:

- **Spotify Premium.** The engine only plays for Premium accounts, and Spotify requires the owner of a developer app to
  have Premium.
- **A free Spotify developer app of your own** ([Create your developer app](#create-your-developer-app)). Encore never
  ships one; the setup guide walks you through it.
- **A jailbroken iPhone or iPod touch with Cydia.** iOS 6: iPhone 5, 4S or 4; iPod touch 5th or 4th generation. iOS 5
  (5.0 to 5.1.1): iPhone 4S, 4 or 3GS; iPod touch 4th or 3rd generation. Only the iPhone 5 on iOS 6 is tested on a
  real device. The 3GS on iOS 6 is not targeted; no iPad, no iOS 7 or later. Encore installs as a regular app in
  `/Applications` (iOS 6 dual-boot setups work too). MobileSubstrate and AppSync are **not** needed.
- **A computer for the bridge that stays on and awake** while you listen. If it sleeps, the music stops.
- **Your home Wi-Fi**, with the phone and the bridge on it for setup.
- **To listen away from home:** access to your router's settings to forward one port, or a VPN server at home
  ([Listen away from home](#2-listen-away-from-home)).

Pick one route for the bridge:

| | **Windows** | **Docker (Linux)** |
|---|---|---|
| Runs on | Windows 10 or 11, 64-bit (x64) | A 64-bit Linux computer or NAS (x86-64 or ARM64) with Docker Engine and Docker Compose v2 or newer |
| You install | An installer, or a portable zip | One compose file; Docker downloads the ready-made images |
| Runs when | While you are signed in to Windows | Always (it starts with the machine) |
| Needs | A **Private** network profile | Host networking (the containers share the machine's network) |

**Not supported in this release:** Docker Desktop on Windows or macOS (or Docker inside WSL), a macOS bridge, and a
reverse proxy in front of the bridge. Docker Desktop hides the containers behind its own network, which breaks Spotify
Connect discovery and the admin page's home-network check. On a Windows PC, use the Windows bridge.

### Install the bridge on Windows

1. Download `EncoreBridge-<version>-setup.exe` from the release page,
   [github.com/mbucc9000/encore/releases](https://github.com/mbucc9000/encore/releases/latest).
2. Run it. The files aren't code-signed in this release, so SmartScreen may say **Windows protected your PC**. Click
   **More info**, check that the app name is the file you downloaded, and click **Run anyway**. Do this only for a file
   from Encore's release page. Accept the administrator prompt.
3. The installer suggests `C:\Program Files\Encore Bridge`. On **Select Additional Tasks**, leave **Start Encore Bridge
   when I sign in to Windows** ticked: phones can only play while the bridge runs. **Create a desktop shortcut** is
   optional.
4. Press **Install**. It adds the Windows Firewall rule **Encore Bridge (phone)**: TCP port 8095, on **Private** and
   **Domain** networks only. It asks nothing about Spotify; the setup guide does that.
5. On the last page, leave **Start Encore Bridge and open the setup guide** ticked (on an upgrade: **Start Encore Bridge
   now**) and press **Finish**. The icon, a black record on a green square, appears in the notification area near the
   clock (behind the `^` arrow if it's hidden). The setup guide opens in your browser.

If Microsoft Defender quarantines a file from the release page by mistake, restore it in **Windows Security → Virus &
threat protection → Protection history**.

#### Portable zip

`EncoreBridge-<version>-win64.zip` needs no admin rights. It keeps its data in `%LOCALAPPDATA%\Encore`, like the
installer. Run only one copy at a time.

1. Right-click the zip → **Properties**. If there is an **Unblock** box, tick it and press **OK**.
2. Extract it to a folder you own, for example `C:\Users\<you>\Encore Bridge` (not `Program Files`: it is read-only for
   normal programs). Run `Encore Bridge.exe` there. The first time, the setup guide opens.
3. **Windows Defender Firewall** asks about **Node.js JavaScript Runtime** (the bridge): tick **Private networks** only
   and press **Allow access**. **Don't press Cancel**: it creates a rule that blocks the bridge
   ([Network and firewall](#network-and-firewall)).
4. In the tray menu, tick **Start with Windows**, so phones can still play after the PC restarts.

### Install the bridge with Docker

Encore Bridge comes as two ready-made images for 64-bit Linux (x86-64 and ARM64). You download one compose file and
start it; nothing is built on your machine.

1. Install Docker Engine and the Compose plugin (<https://docs.docker.com/engine/install/>; many NAS systems have it
   built in or as an app). `docker compose version` must say version 2 or newer, and
   `docker version --format '{{.Server.Arch}}'` must say `amd64` or `arm64` (`arm` is a 32-bit Docker or system, also
   on a Raspberry Pi whose 32-bit OS runs a 64-bit kernel).
2. Make a folder for Encore and download the compose file into it. Run every `docker compose` command in this folder.

   ```sh
   mkdir ~/encore && cd ~/encore
   curl -fL -o compose.yaml https://github.com/mbucc9000/encore/releases/latest/download/encore-docker-compose.yaml
   ```

   **Dockge or Portainer:** create a stack named `encore` and paste the file's contents into it instead. Portainer:
   change `./data`, `./engine` and `./pipe` to full paths, such as `/opt/encore/data`.
3. Run `systemctl is-active avahi-daemon`. If it says `active`, switch the engine to avahi before the first start
   ([Engine settings](#engine-settings)).
4. Start it, then get the one-time **setup code** for the setup guide's step 1. No settings file is needed. The first
   start downloads the images (about 270 MB); later starts take seconds.

   ```sh
   docker compose up -d
   docker compose ps
   docker compose logs gateway | grep "setup code"
   ```

   Both `encore-gateway` and `encore-engine` should be running. The code looks like `ABCD-EFGH-JKMN`. It changes at
   every start until you choose an admin password. In Dockge or Portainer, deploy the stack, then look for "setup
   code" in the log of the `encore-gateway` container.
5. From another device at home, open `http://<your-bridge-address>:8095/` (`hostname -I` shows the address). Two short
   lines, `Encore gateway` and `Encore Bridge: the admin page is at /admin`, mean the phone can reach the bridge too.
   Then open `http://<your-bridge-address>:8095/admin`. The setup guide starts.

In your router, give the machine a **fixed address** (a "DHCP reservation"). If it runs a firewall, allow TCP 8095 from
your home network ([Ports and firewall](#ports-and-firewall)).

#### Build it yourself

You can also build both images on your machine from the source instead. This needs Docker Compose 2.24 or newer
(older versions stop with an error that mentions `env_file`), and the first build takes a few minutes.

1. Download `Encore-<version>-source.tar.gz` from the release page
   ([github.com/mbucc9000/encore/releases](https://github.com/mbucc9000/encore/releases/latest)). Unpack it (or clone
   the repository) and go into its `gateway` folder. Run every `docker compose` command there.

   ```sh
   tar -xzf Encore-<version>-source.tar.gz
   cd Encore-<version>/gateway
   ```

2. avahi-daemon: as in step 3 above, but with `zeroconf_backend: avahi` in `engine/config.yml`
   ([Engine settings](#engine-settings)).
3. Build and start with `docker compose up -d --build`. Then continue with steps 4 and 5 above (`docker compose ps`,
   the setup code, the admin page).

### Follow the setup guide

The setup guide is a step-by-step page in the bridge's admin page. On Windows it opens after the installer (later: tray
menu → **Setup guide…**). On Docker it opens at the first visit to `http://<your-bridge-address>:8095/admin`. Each
step ticks itself (✓) when the bridge sees it done; step 6 ticks when the phone pairs. Most steps have **Skip for
now**, and you can go back to any step ([Using the setup guide](#using-the-setup-guide)).

| Step | Title | What you do | Details |
|---|---|---|---|
| 1 | **Protect this page** | Choose the admin password (Docker: with the setup code from the log) | [The admin password](#the-admin-password) |
| 2 | **Your Spotify developer app** | Create your developer app, paste its Client ID, press **Save Client ID** | [Create your developer app](#create-your-developer-app) |
| 3 | **Connect your Spotify account** | Press **Connect**, then **Agree** on Spotify (Docker: paste the address, **Use this address**) | [Connect your Spotify account](#connect-your-spotify-account) |
| 4 | **Sign in the Encore engine** | Windows: approve the code at spotify.com/pair. Docker: pick **Encore** once in a Spotify app | [Sign the engine in](#sign-the-engine-in) |
| 5 | **Check your network** | Fix what has a ✗, press **Check again** | [The network check](#the-network-check) |
| 6 | **Put Encore on your phone** | Add the Encore repo in Cydia, install **Encore**, press **I've installed it** | [Put Encore on your phone](#put-encore-on-your-phone) |
| 7 | **Pair your phone** | Type the Home address and the code into the app | [Pair your phone](#pair-your-phone) |
| 8 | **Listen away from home** | Forward TCP 8095, press **Find my public IP**, type the Away address into Encore, test on mobile data | [Listen away from home](#2-listen-away-from-home) |
| 9 | **Play a song** | Play a song in the app | [Feature tour](#3-feature-tour) |

Step 1 can't be skipped. Step 3 needs step 2. **Finish** on step 9 ends the guide.

### Put Encore on your phone

The app comes from the **Encore repo**, a Cydia repo. Add it once; Cydia then installs Encore and its updates from it
([Update the app](#update-the-app)). Step 6 and the admin page's **Phone setup** card show the address with a **Copy**
button:

```
https://mbucc9000.github.io/slopkit/
```

On the phone (any Wi-Fi or mobile data works):

1. Open **Cydia** → **Sources** → **Edit** → **Add**. Type the address exactly, with `https://` and the `/` at the end.
   Tap **Add Source** and wait while Cydia loads it.
2. Tap the new source, then **All Packages**, then **Encore**, then **Install** and **Confirm**.
3. When Cydia is done, tap **Return to Cydia**. The first install refreshes the home screen so the Encore icon appears.
4. In the setup guide, press **I've installed it**. Step 6 gets its ✓ when the phone pairs in step 7.

> **Never run `uicache` yourself, and never as root.** It can make other sideloaded apps disappear from the home
> screen. If the Encore icon doesn't appear, **respring** instead (from your jailbreak tool's menu, or with
> `killall SpringBoard`).

If Cydia can't add the repo, check the address letter by letter and check that the phone is online.

#### Other ways to install the app

Without Cydia, or if Cydia can't load the repo, download `Encore_<version>_iphoneos-arm.deb` from the release page.
Install it with **Filza** or **iFile** (copy the `.deb` to the phone, tap it, tap **Install**), or as root over SSH or
a terminal on the phone:

```sh
dpkg -i Encore_<version>_iphoneos-arm.deb
```

Then press **I've installed it** in step 6. The `uicache` warning above applies here too. To update, install the new
`.deb` over the old one.

### Pair your phone

Pairing gives the phone its own secret key for the bridge. **Pair at home, on your home Wi-Fi** (not a guest network):
the bridge refuses pairing requests from the internet. Open **Encore**. Its setup screen has three fields:

1. **Home:** the bridge's address and port, for example `192.168.1.20:8095`. Step 7, the admin page's **Phone setup**
   card and, on Windows, the tray's **Phone address** show it. You can leave out `http://`. **Don't leave out
   `:8095`**: Encore doesn't add the port.
2. **Away:** leave it empty. Step 8 finds it ([Listen away from home](#2-listen-away-from-home)).
3. **Code:** the six digits from step 7, or from **New pairing code** on the admin page's **Pair a device** card. A
   code works once, for 5 minutes.

Tap **Connect**. "Pairing…" turns into **Connected**, Encore opens on Home, and the setup guide says **✓ Your phone is
paired.** The admin page lists the phone by its name (**Settings → General → About → Name**), or only by its model if
[Anonymous Mode](#anonymous-mode) was on while you paired.

Encore tries **Home** first (1.5-second timeout), then **Away** (6 seconds), when it starts, comes back to the
foreground, or loses the connection. Settings shows the route in use: **Status: Home · 14 ms** or **Away · 88 ms**.

#### Security, briefly

- Every request after pairing is **signed** with the phone's key. Without that key, a stranger who reaches your bridge
  can't control it, read your library or play anything.
- The key crosses the network only once, in the pairing answer. That is why pairing only works at home.
- A lost or sold phone: **Unpair** it on the admin page to revoke its key. Unpairing *in the app* only makes the phone
  forget the bridge.

---

## 2. Listen away from home

Away from home (mobile data, someone else's Wi-Fi), the phone needs a way back to the bridge. Both ways need a public IP
at home ([Carrier-grade NAT and double NAT](#carrier-grade-nat-and-double-nat)):

- **A port forward** on your router: the main way. The setup guide's step 8, **Listen away from home**, walks you
  through it ([Forward the port](#forward-the-port)).
- **Your iPhone's built-in VPN**, for an encrypted stream ([Your iPhone's built-in VPN](#your-iphones-built-in-vpn)).

Tailscale, WireGuard, ZeroTier and similar overlay-VPN apps have no iOS 6 version. They still help you reach the
**admin page** from a laptop, because it accepts their addresses. **Not supported in this release:** HTTPS reverse
proxies and tunnels (Caddy, nginx, Traefik, Cloudflare Tunnel, ngrok and so on). iOS 6's old TLS is untested against
them, and the bridge refuses admin requests that arrive through a proxy.

### Forward the port

Your router passes TCP port 8095 from the internet to the bridge's computer. Keep the setup guide's step 8 open: it
shows the values for your network. To come back later (a new public IP, a new router), press **Listen away from home**
on the admin page's **Phone setup** card.

1. **Reserve the bridge's address** (for example `192.168.1.20`) in your router: **DHCP reservation** (or **Address
   reservation**, **Static lease**). Otherwise the forward may one day point at nothing.
2. **Add the forward.** Open your router's admin page. Its address is the computer's **default gateway** (Windows:
   `ipconfig`, **Default Gateway**; Linux: `ip route`, the address after `default via`). Find **Port forwarding** (also
   **Virtual server**, **NAT**, **Port mapping** or **Applications & gaming**) and add one rule:

   | In the router | Value |
   |---|---|
   | Protocol | `TCP` ("TCP/UDP" or "Both" works too) |
   | External port ("public port", "WAN port") | `8095` |
   | Forward to ("internal address", "LAN IP", "server IP") | the bridge computer's address, for example `192.168.1.20` |
   | Internal port ("private port", "LAN port") | `8095` |

   Forward this one port only. Don't use the router's **DMZ** ("exposed host") option. Encore doesn't use UPnP.
3. **Let it in on the bridge's computer.** Windows: nothing to do while the network is **Private** (the **Encore Bridge
   (phone)** rule, or the zip's **Node.js JavaScript Runtime** rule, covers it). Docker with a firewall: allow TCP 8095
   from anywhere, for example `sudo ufw allow 8095/tcp`, or `sudo firewall-cmd --permanent --add-port=8095/tcp`
   followed by `sudo firewall-cmd --reload`.
4. **Find your Away address.** In step 8, press **Find my public IP**. It shows **Your Away address:**
   `http://<your-public-ip>:8095` with a **Copy** button. If no IP-check service answers, take the **Internet** (WAN)
   address from your router's status page.
5. **Type it into Encore:** **Settings** → **Away Address**, then **Save** (on an unpaired phone's setup screen: the
   **Away** field). Keep the port. If the addresses read **Hidden**, turn Anonymous Mode off while you type.
6. **Test it on mobile data**, with the phone's Wi-Fi off (an iPod touch: join another Wi-Fi, such as your phone's
   hotspot). **Settings** → **Status** should say **Away**, for example **Away · 88 ms**. Step 8 then says **✓ Your
   phone reached Encore Bridge from outside your home network.**

Don't test on your home Wi-Fi. Many routers can't reach their own public IP from inside (no "NAT loopback"), and one
that can lets the phone in from a home address, which doesn't tick step 8. Back home, Encore uses Home again by itself.

- **Another external port** works too, for example external `18095` → internal `8095`. Step 8 shows the bridge's own
  port, so type the external one into Encore: `http://<your-public-ip>:18095`.
- **Step 8 ticks** on the first request from a paired phone that comes from a public address, never over a VPN. The
  bridge keeps the time, not the address. It looks up your public IP only when you press the button, keeps it in memory
  for 30 seconds, and never writes it to disk or the log ([Where the bridge connects](#where-the-bridge-connects)).
  Showcase hides the button.
- **Away from home**, the app asks for a bigger buffer (20 seconds instead of 10) and waits longer before it gives up,
  so short dead spots on mobile data don't stop the music.

#### When your public IP changes

Most home connections get a new public IP now and then, for example when the router restarts. Encore then shows
**Status: Offline** away from home. Open step 8, press **Find my public IP** again, and update the Away Address on each
phone. To avoid this, use a **dynamic DNS** name that always points at your current IP. Many routers have it built in
(**DDNS** or **Dynamic DNS**). Type `http://<that name>:8095` as the Away address once.

#### Carrier-grade NAT and double NAT

A port forward, or a VPN server at home, only works when your router has a public IP of its own. Two set-ups stop it:
**carrier-grade NAT** (CGNAT: your provider shares one public IP between many homes; common with 4G or 5G home internet
and satellite, sometimes cable and fibre) and **double NAT** (another router in front of yours, often the provider's
modem-router).

**How to tell:** compare your router's **Internet** (WAN) address, on its status page, with the IP **Find my public IP**
found. The setup guide warns only when the IP it finds is shared or not public, so make this check yourself.

- The same IP: fine.
- A different one, and the bridge's computer runs a VPN app: turn the VPN app off and press **Check again**.
- Still different, or it starts with 10., 100.64 to 100.127, 172.16 to 172.31 or 192.168.: CGNAT (`100.64.0.0/10`) or
  double NAT.

**What to do:**

- **CGNAT:** first **remove the port forward**. It can't reach you, but your provider's other customers may reach your
  router, and their addresses (100.64 to 100.127) count as home to the admin page and pairing. Then ask your provider
  for a public IPv4 address (sometimes sold as a "public IP" or "static IP" option). A VPN server at home needs one too.
- **Double NAT:** put the box in front into bridge (modem-only) mode. Or add the same forward on it, pointing at your
  router's Internet (WAN) address, port 8095 (for a VPN server: the VPN's ports).

### What a port forward exposes

**Reachable from the internet:** the bridge's signed phone API (useless without a paired phone's key) and two
plain-text lines at `/` that start with "Encore gateway". **Not reachable:** the admin page (it answers **Not from this
address.**), pairing, the setup guide's public-IP check, and the engine (port 3678 listens on the machine itself only).

- **Check once** from outside your home network (on mobile data): open your Away address with `/admin` at the end in
  Safari. It must say **Not from this address.** If it asks for a password, your router hides where connections come
  from: remove the port forward and use the VPN.
- **Everything is plain HTTP.** Someone on the path (public Wi-Fi, the mobile network) can see which songs you play and
  could record the audio. They can't control your bridge, but could replay a recorded request for up to five minutes.
- Forward **only** TCP 8095 (or your chosen external port). **Never** forward 3678 or the engine's discovery ports.
- Use a strong admin password ([The admin password](#the-admin-password)), and pair only at home.
- Unpair lost phones on the admin page right away, and keep the bridge updated.
- On Windows, the forward exposes your everyday PC's port 8095. Keep Windows updated, and set only your home network to
  **Private**: the firewall rule lets phones in only on Private networks.
- **Never post your public IP or your Away address**, for example in a bug report.

### Your iPhone's built-in VPN

With a VPN server at home, iOS 6's built-in VPN client joins your home network from anywhere, encrypted, and the
bridge's port stays closed to the internet. The VPN server must be reachable from the internet: its router forwards the
VPN's ports (many routers' built-in VPN servers do that themselves).

1. **At home:** set up an **L2TP over IPsec** VPN server (with a pre-shared key) on your router or NAS. Avoid **PPTP**:
   its encryption is broken.
2. **On the phone:** **Settings → General → VPN → Add VPN Configuration… → L2TP**. Fill in your server's public address
   (or dynamic-DNS name), your VPN account, password and the shared secret. (Cisco IPsec works too.)
3. In Encore, set the Away Address to the **same address as Home** (Settings → Encore Bridge → Away Address). The Away
   try gives slow connections the longer 6-second timeout.
4. Away from home, turn the VPN on in Settings (iOS 6 doesn't do it by itself), then open Encore.

Over the VPN, **Status** usually reads **Home**, not **Away**. That is expected. Step 8 never ticks over a VPN: press
**Skip for now** there.

---

## 3. Feature tour

Encore has five tabs: **Home**, **Search**, **Playlists**, **Library** and **Settings**. A mini player sits above the
tabs while something plays; tap it for **Now Playing**.

### The app's screens

- **Home:** a greeting and shelves built from your listening: **Jump back in**, **Made For You**, your top artists,
  **New releases for you**, your top songs, and recently played artists. The round picture opens your profile.
- **Search:** results in **Top Result**, **Songs**, **Artists**, **Profiles**, **Albums** and **Playlists**. When a
  person's name is exactly what you typed, **Profiles** comes right under the Top Result. **See all songs** and **See
  all profiles** load more as you scroll (Spotify gives developer apps 10 results per page). **Recent searches**
  remembers what you tapped, on this phone only; **Clear** empties it.
- **Playlists:** all your playlists, including the ones you follow, with their real covers. **Pin** favourites to the
  top (touch and hold → **Pin Playlist**), **New Playlist**, **Sort** (Title, Artist, Album, Custom order, Date added
  newest or oldest first) and **Filter**. In a playlist you own: edit, reorder, and **Remove from This Playlist**.
  Offline, or when Spotify is busy, lists show a **Showing a saved copy** banner and still work.
- **Library:** **Liked Songs**, saved **Albums**, followed **Artists**, **Recently Played** and your **Profile**.
- **Albums, artists and playlists:** **Play** and **Shuffle**; artists show **Popular** songs and their albums. The
  heart saves an album to your Library. The "by …" line under a playlist opens its owner's profile.
- **Song actions (•••):** **Add to Queue** (or **Add to Jam** while you are in one; you can also swipe a song row to
  queue it), **Add to Playlist…** (a "Saved in" sheet: tick or untick several playlists and Liked Songs at once), save
  to or remove from **Liked Songs**, **Go to Album**, **Go to Artist**, **Remove from This Playlist**.
- **Now Playing:** swipe the cover left or right to skip. Tap the cover or **Lyrics** for lyrics from
  [LRCLIB](https://lrclib.net), a free community database, so some songs have none. Synced lyrics follow the song; tap
  a line to jump there. The bottom bar holds volume (with AirPlay), **Lyrics**, **Album**, **Artist**, **Jam** (while
  Jam is available) and **More**. Flip to **Up Next** to see, remove or move what plays next. **Playing from …** opens
  the playlist, album or artist. When another of your devices plays Spotify, a **Listening on …** bar appears: tap
  **Play** in Encore to bring the music back.
- **In the background:** music keeps playing when you leave the app or lock the phone. The lock screen, the
  multitasking bar's music controls, and headphone and AirPods buttons work.
- **Profiles:** search for people, open anyone's profile, see their public playlists, followers and following,
  **Follow** or **Unfollow** them, and follow their playlists. Your own profile shows only your public playlists, the
  way others see it. The Playlists tab and Library show all of yours.
- **Spotify Connect:** in any Spotify app (desktop, web, a modern phone), pick **Encore** in the devices menu and the
  music plays on your phone. Tapping Play in Encore takes playback back from your other devices.
- **Play a Link:** **Settings → Play a Link…**: paste an `open.spotify.com/…` or `spotify:…` link to a song, album,
  playlist or artist and it plays. A Jam link offers to join the Jam.
- **Not included:** podcasts and audiobooks, offline downloads, dark mode, iPad layouts.

### App settings

Settings is the fifth tab. Its sections, from top to bottom:

| Section | Setting | What it does | Default |
|---|---|---|---|
| **Encore Bridge** | Home Address | The bridge's local address, tried first. Tap to change it. | What you typed on the setup screen |
| | Away Address | Tried when Home doesn't answer, for example `http://203.0.113.7:8095` ([Listen away from home](#2-listen-away-from-home)) | None |
| | Status | The route in use and its delay ("Home · 14 ms", "Away · 88 ms"), **Checking…**, or **Offline** | — |
| | Engine | **Connected**, **Not connected** or **Unknown**. Tap it for an explanation and the bridge's version. | — |
| **Playback** | Jam | Start, join or open a Jam. Shows **Update your Encore Bridge** if the bridge is too old for Jams. | — |
| | Streaming Quality | Very High (320 kbps, about 145 MB per hour), High (256, about 115 MB), Normal (160, about 72 MB), Low (96, about 43 MB). The same at home and away. | Very High |
| | Auto-Reduce Quality | Steps down when the network is slow | On |
| | Pause on Unplug | Pauses when headphones or AirPods disconnect | On |
| | Explicit Badges | Shows the **E** badge on explicit songs | On |
| | Play a Link… | Plays a pasted song, album, playlist or artist link; offers to join a Jam link | — |
| **Appearance** | Text Size | Small, Default or Large | Default |
| **Privacy** | Anonymous Mode | [Anonymous Mode](#anonymous-mode) | Off |
| | Hide My Playlist Names | Only shown while Anonymous Mode is on | Off |
| **Account** | Spotify | Your Spotify name ("Signed in" in Anonymous Mode). Your sign-in lives on the bridge; switch accounts on its admin page. | — |
| | This Device | This phone's name (the model in Anonymous Mode) | — |
| (no title) | **Unpair This iPhone** | Forgets the bridge on this phone, after asking. You need a new pairing code to connect again. | — |
| **About** | Version | The app's version | — |
| | Encore Bridge | The bridge's version | — |
| | Diagnostics | A troubleshooting screen: the stream, the quality in use, the connection, and a test player | — |

The phone also keeps choices that are not in Settings: pinned playlists, recent searches and the Playlists sort order.

---

## 4. Jam with friends

A Spotify Jam is a shared queue: friends join from their own Spotify apps and add songs, and everyone hears the same
music. Encore can host a Jam or join one. You need **Premium** to host; friends need Premium to join from anywhere
(free accounts can only join in person). Encore's Jam buttons stay greyed out until the one-time Jam check below.

### The one-time Jam check

1. On a computer or modern phone, start a Jam **in the normal Spotify app**, with **Encore** selected as the speaker.
2. On the admin page, in the **Jam** card, press **Check Jam access**. It sends one request to Spotify's Jam service.
3. The answer should be **accepted**. Encore remembers it, and the Jam buttons in the app turn on.
4. You can end that Jam now.

If Spotify refuses, Encore waits 30 minutes before it considers the check again.

### Host or join a Jam

**Host:** play something on Encore first. Then **Settings → Jam** (or the Jam bar) → **Start a Jam**. Invite friends
with the **QR code**, **Message** or **Copy Link**; they open the link in their own Spotify app. (In Anonymous Mode,
tap **Show Invite** first.) As the host you can remove people, edit **Up Next**, and **End** the Jam (everyone leaves;
your queue stays).

**Join:** **Settings → Jam → Join a Jam…** and paste the link a friend sent you. Or copy the link, then open Encore: a
**Jam Link Copied** alert offers to join it. As a guest you can add songs. Play, pause and skip only work if the host
allows it.

### Jam safety rules

These keep a forgotten Jam from playing to nobody for hours:

- As a guest, Encore leaves a Jam after **10 minutes** with nobody listening on your phone ("Encore left the Jam: nobody
  was listening").
- As the host, if nobody listens on your phone, the Jam is **paused** ("Nobody was listening to your Jam on Encore, so
  it's paused.").
- Any Jam ends on Encore after **3 hours** without anyone listening.
- If Spotify refuses to play, Encore leaves (as a guest) or pauses (as the host).

Jams use a private Spotify interface ([Legal and disclaimer](#18-legal-and-disclaimer)), so they may stop working if
Spotify changes it.

---

## 5. Anonymous Mode and Showcase

To show Encore to someone, film it or post screenshots without showing who you are, use **Anonymous Mode** on the
phone and **Showcase** on the bridge. Both hide your identity and keep the music.

### Anonymous Mode

Turn it on in **Settings → Privacy → Anonymous Mode** ("Hides names, pictures, addresses and devices. Music stays.").
It works at once on every screen and stays on after a restart or an unpair. Nothing is deleted: turn it off to see
everything again.

| Where | What you see instead |
|---|---|
| Your name and profile picture | "You" and a plain picture. Home's greeting drops your name. Settings → Spotify says "Signed in". |
| Other people's names (profiles, followers, playlist owners, Jam members) | Made-up first names. The same person always gets the same one. |
| Other people's pictures | Initials in a coloured circle. Real pictures aren't downloaded. |
| Follower and following counts, other people's playlist descriptions | Hidden (Spotify's own descriptions stay) |
| Other devices' names | Their kind: "your computer", "your phone", "a speaker", "your TV", or "another device" |
| This iPhone's name (Settings → This Device) | The model, for example "iPhone". Pairing sends the model too, so the bridge never learns the name. |
| Bridge addresses (Settings, Diagnostics) and the device id | "Hidden". You can't edit the addresses until you turn the mode off. |
| The Home, Away and Code fields on the setup screen | Hidden dots, like a password. Pairing still works. To fix a mistake, retype the whole address. |
| Jam | "Your Jam" instead of your name. The invite sits behind **Show Invite**, because an invite on video lets anyone join. |
| Bridge messages that name people, devices or playlists; people in Recent searches | Encore's own wording without names; people aren't listed |

It keeps songs, albums, artists, covers, other people's playlist names, lyrics and the lock screen's Now Playing.

### Hide My Playlist Names

While Anonymous Mode is on, a second switch appears: **Hide My Playlist Names** (off by default). It renames your own
playlists **My Playlist #1, #2, …** (the newest has the highest number) and hides their descriptions and folder names.
Covers you uploaded still show in this release. Blends show as **Blend**, without cover or description, even with
this switch off.

### Showcase on the bridge

The admin page's **Showcase** switch (top right) is for when the computer screen is on camera. The tray's **Showcase
mode** is the same switch. It stays on after a restart. With Showcase on, the line under the header turns amber, and:

- the **Spotify account** card says only **Connected**, and the connect steps are hidden (in the setup guide too),
- phones show as **Phone 1**, **Phone 2** … without ids or **Unpair** buttons; other devices show by their kind,
- codes show as dots: press and hold them (or Space / Enter) to see them. The tray's **Sign in to Spotify…** shows
  the steps without the code,
- home-network addresses (the **Phone setup** card, the tray, setup steps 5, 7 and 8) say **Hidden (Showcase)**. The
  Encore repo's address stays: it is public,
- the setup guide shows no part of the Client ID, step 8 doesn't look up your public IP, and phone diagnostics can't
  be read.

Showcase doesn't turn on Anonymous Mode on your phones. The bridge's log never contains people's or devices' names.

For a clean demo: turn Anonymous Mode on before you record, then close and reopen Encore once so the first screen is
masked too. Demo a Jam with **Fake host** ([Advanced](#admin-page-cards)). Crop the browser's address bar: it shows
the bridge's address. Spotify's own apps and your Spotify profile still show who you are.

---

## 6. Spotify: your developer app and sign-ins

Encore reads your playlists, library and search through Spotify's Web API, which needs a developer app. You make your
own for free, give the bridge its **Client ID**, and connect your account. The engine signs in separately to play
music. Use **the same Premium account** for all of it. Encore never uses a client secret. The setup guide does this in
steps 2, 3 and 4, with a **Copy** button for every value.

### Create your developer app

1. Open <https://developer.spotify.com/dashboard> (the setup guide's **Open the Spotify developer dashboard** button)
   and log in with your Premium account. Accept the Developer Terms if Spotify asks.
2. Press **Create app** and fill in:
   - **App name** and **App description:** anything, for example `Encore` and `My iOS 6 player`. **Website:** empty.
   - **Redirect URIs:** type exactly `http://127.0.0.1:8888/callback` and press **Add**: `127.0.0.1`, not
     `localhost`; port `8888`; no slash at the end.
   - **Which API/SDKs are you planning to use?** tick **Web API**.
3. Accept the terms and press **Save**.
4. Open the app's **Settings**, then **User Management**, and add the name and e-mail of your Spotify account. Apps in
   development mode only answer for their owner and this short list. If the dashboard says the owner is already there,
   or won't add it, that's fine.
5. Under **Settings → Basic Information**, copy the **Client ID** (32 letters and digits). Ignore the client secret.

If Spotify renamed a button, look for the same step under its new name.

### The Client ID

In step 2, **Your Spotify developer app**, paste the Client ID and press **Save Client ID**. The bridge uses it at
once, without a restart, and the step shows **✓ Client ID saved** with the last four characters. By hand: set
`SPOTIFY_CLIENT_ID=<your-client-id>` in `settings.env` ([Edit settings.env](#edit-settingsenv)) or `.env`
([The .env file](#the-env-file)), then restart the bridge.

The bridge uses the first of these that has a value:

1. **The bridge's environment** (Docker: `.env`). It always wins, and step 2 can't change it. Edit `.env`, then run
   `docker compose up -d` in your Encore folder.
2. **`settings.env`** (Windows: `%LOCALAPPDATA%\Encore\settings.env`, or any bridge started with `ENCORE_HOME`). The
   setup guide saves the Client ID here on Windows.
3. **`data/settings.json`** in the data folder. The setup guide saves it here on Docker. An invalid value is ignored,
   with a warning in the log.

To change it, press **Change** in step 2. If your account is connected, the bridge disconnects it (its sign-in belongs
to the old app); connect again in step 3. On Windows, close Notepad first if it has `settings.env` open, or it puts
the old Client ID back when it saves. Don't publish your Client ID or use someone else's. The bridge never logs it.

### Connect your Spotify account

Use step 3, **Connect your Spotify account**, or the admin page's **Spotify account** card.

1. Press **Connect**. A tab opens on Spotify. Log in with the same Premium account and press **Agree**.
2. Spotify sends the tab to `http://127.0.0.1:8888/callback?code=…`:
   - **Windows, with the browser on the PC that runs Encore Bridge:** the bridge catches it, and the tab says
     **Spotify account connected**. Close it.
   - **Docker, or a browser on another computer:** the tab shows an error such as **"This site can't be reached"**.
     That is expected. Copy the tab's **whole address**, paste it into the box and press **Use this address**
     (**Finish** on the card).
3. The step says **✓ Connected**, and the card says **Connected as** your Spotify name.

Finish within 15 minutes (Spotify's code can expire sooner); otherwise press **Connect** again. If another Windows
program uses port 8888, paste the address as on Docker. Only a **refresh token** is stored. Your Spotify password
never reaches the bridge or the phone.

### Sign the engine in

The engine is a Spotify Connect speaker named **Encore**. It signs in once and remembers it. Until then, song lists
fail with **Encore's player is reconnecting to Spotify.** Step 4, **Sign in the Encore engine**, and the admin page's
**Engine sign-in** card show its state:

| The page says | What to do |
|---|---|
| **Signed in.** | Nothing. If it warns about **another Spotify account**, sign the engine in with the bridge's account. |
| **Not signed in yet.** | Follow the steps for your platform below. |
| **Waiting for you to approve the sign-in.** | Open the link and enter the code. |
| **The engine isn't answering.**, or another engine problem | Docker: `docker compose ps` and `docker compose logs engine`. Windows: [The bridge machine](#the-bridge-machine). |

#### Docker: pick Encore once

On a device on your home network, open the Spotify app (same account), play any song, open the devices menu (the
speaker icon, "Connect to a device") and pick **Encore**. After a few seconds it plays there and step 4 says **Signed
in.** If **Encore** isn't listed, see [The bridge machine](#the-bridge-machine).

If discovery can't work on your network (separate VLANs, guest Wi-Fi, a NAS that blocks it), use a code: set this in
`engine/config.yml` (with `sudo` on the ready-made images, for example `sudo nano engine/config.yml`: the file belongs
to root), run `docker compose restart engine`, and follow the Windows steps below from step 2. The link and code are
also in `docker compose logs engine`.

```yaml
credentials:
  type: device_auth
```

#### Windows: sign in with a code

The Windows engine doesn't use discovery, so it opens no port that other devices could reach.

1. Step 4, the tray's **Sign in to Spotify…** and the Engine sign-in card show a sign-in page's address and a code.
2. Open that page on the PC or your phone and log in with the same Spotify account.
3. If it asks for the code, type it and approve. Step 4 then says **✓ Signed in.** An expired code is replaced by
   itself.

If Spotify won't accept the code (an error, or stuck at **Waiting for you to approve the sign-in**), switch to
discovery. Tray menu → **Troubleshooting → Open data folder**, open `engine\config.yml` in Notepad, change
`zeroconf_enabled: false` to `zeroconf_enabled: true`, and replace the `credentials:` block with:

```yaml
credentials:
  type: zeroconf
  zeroconf:
    persist_credentials: true
```

Save and press **Troubleshooting → Restart bridge**. If Windows Firewall asks about `encore-engine.exe`, allow
**Private networks** only. Then pick **Encore** once in a Spotify app, as on Docker. Discovery shows the speaker to
everyone on your home network; that is why it is off on Windows.

**Where the sign-in is kept:** `engine/state.json` (Docker) or `%LOCALAPPDATA%\Encore\engine\state.json` (Windows).
Treat it like a password. To sign the engine out, stop the bridge and delete it, or use "Sign out everywhere" on your
Spotify account page (it signs out all your devices).

### What Encore asks Spotify for

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

## 7. The setup guide and the admin page

The admin page is the bridge's control panel: the setup guide, your Spotify account, the engine's sign-in, pairing and
checks. Docker: open `http://<your-bridge-address>:8095/admin` from your home network. Windows: tray menu → **Open
Encore Bridge** (`http://127.0.0.1:8095/admin`).

### Using the setup guide

The setup guide's nine steps are listed in [Follow the setup guide](#follow-the-setup-guide).

- **Open it:** Windows opens it after the installer, and again when you start Encore Bridge yourself until setup is
  finished. Docker shows it on the first visit. At any time: the **Setup guide** button in the admin page's header,
  **Setup guide…** in the tray, or `/admin?setup=1`.
- **The step list** (beside the steps, or behind **All steps**) shows ✓ or **Skipped**. Click a step to go there.
  **Back** and **Next** move one step; **Next** always works.
- **Skip for now** (step 6: **I've installed it**) skips a step. Step 1 can't be skipped: until there is an admin
  password, the other steps say "Choose your admin password first". Step 3 needs step 2. A skipped step done later
  shows ✓.
- **Step 7's code** lasts 5 minutes. While the page is on screen, it gets a new one up to three times.
- **Finish** on step 9 always ends the guide. **Setup complete** lists each step as ✓, **Skipped** or **Not done
  yet**, with **Go to step** links and **Open the admin page**.
- **Close the guide** (the ✕) shows the admin page's cards. Until setup is finished, a **Setup isn't finished.** banner
  offers **Continue setup**.

A bridge with an admin password, a Client ID, a connected account and a paired phone counts as set up, also after an
update. The guide then never opens by itself; opened with **Setup guide**, it shows each step's state. Its progress is
in `data/wizard.json` (no names, addresses or codes); delete that file to start the guide over.

### The network check

Step 5, **Check your network**, runs when you open it and when you press **Check again**. It only looks. It checks
**This computer's address** on your home network, that **Encore Bridge is listening on port 8095** there, and, on
Windows only, the connection's **network profile** (Private, Public or Domain) and **Windows Firewall**: a rule that
blocks the bridge's `node.exe`, or an Allow rule for its port on Private networks (the installer's **Encore Bridge
(phone)** or any other).

Windows reads these without administrator rights and never reads your Wi-Fi network's name. Only **Fix firewall…**
changes rules ([Network and firewall](#network-and-firewall)). On Docker the check can't see the machine's firewall
([Ports and firewall](#ports-and-firewall)). Your phone must be on the same Wi-Fi, not a guest network. Fixes:
[Setup and pairing](#setup-and-pairing).

### The admin password

The admin page answers only requests from an address in `ADMIN_ALLOW` **and** with the **admin password**. The
default, `private`, allows your home network, the bridge machine, VPN overlay addresses such as Tailscale's
(`100.64.0.0/10`) and the IPv6 local ranges ([Bridge settings](#bridge-settings)). Anything else gets **Not from this
address.**, even through a port forward. Requests through a proxy are refused too.

**Protect this page.** Unless `ADMIN_PASSWORD` is set, the setup guide opens at step 1. Type the new password twice (at
least 8 characters). On the PC that runs the Windows bridge, that is all. On Docker, or from another device, also type
the one-time **setup code** (like `ABCD-EFGH-JKMN`) from the bridge's log. It is new at every start until a password
is chosen. Windows: tray menu → **Troubleshooting → Open log**, and look for "setup code". Docker (the step shows this
with a **Copy** button):

```sh
docker compose logs gateway | grep "setup code"
```

Press **Save password**. The browser then asks for the password. **Any user name works**; only the password counts.

- Use a long, unique password: anyone on your home network, guests included, can reach the login.
- `data/admin.json` keeps it only in a form that can't be turned back into the password.
- 10 wrong passwords (or setup codes) from one address within 15 minutes lock it out for 15 minutes.
- `ADMIN_PASSWORD` in `.env` / `settings.env` always wins over the stored one.

**Forgot the password?** Stop the bridge (Windows: **Quit Encore Bridge**), delete `admin.json` from its `data`
folder, and start it again. On Docker, in your Encore folder: `docker compose down`, then `sudo rm data/admin.json`
(the files belong to root), then `docker compose up -d`. Step 1 returns with a new setup code; everything else stays.
Or set `ADMIN_PASSWORD` in your settings and restart.

### Admin page cards

The header has a green dot while the bridge talks to the engine, the version and uptime, the **Setup guide** button
and the **Showcase** switch. When a newer version is out, a banner says **Encore Bridge … is available.**, with
**What's new** and **Update…**.

| Card | What it's for |
|---|---|
| **Now playing** | The current song, with ⏮ Prev, ⏸ Pause, ▶ Resume, Next ⏭ and +30 s. Resume brings music playing on another of your devices to Encore. |
| **Play something** | Paste a Spotify link (Share → Copy Link) or URI and press **▶ Play on Encore** |
| **Listen here (test)** | Plays the phone's AAC stream in your browser, to test the bridge without a phone. Nothing is saved. |
| **Spotify account** | **Not set up yet** (save the Client ID in step 2), **Not connected** with **Connect** (and a paste box with **Finish**), or **Connected as** your name with **Disconnect** |
| **Engine sign-in** | The engine's sign-in state and steps ([Sign the engine in](#sign-the-engine-in)) |
| **Phone setup** | The app's Home address (for example `192.168.1.20:8095`), the Encore repo `https://mbucc9000.github.io/slopkit/`, and **Listen away from home**, which opens step 8 |
| **Pair a device** | **New pairing code**, and the paired phones with id, last contact and **Unpair** |
| **Engine & stream** | Engine connection, audio clock and buffer, what the phone reports hearing, the encoders |
| **Updates** | **Check now**, and how to update this install: **Update now** (Windows installer, on the PC itself), the file to download (zip) or the commands (Docker) ([Updating](#12-updating)) |
| **Jam** | The Jam's state and **Check Jam access** ([The one-time Jam check](#the-one-time-jam-check)) |
| **Catalog** | Cache counts, Spotify request counters, and **Flush lists / Flush covers / Flush all** (a flush only costs a re-download) |

**Advanced.** Add `?dev=1` to the address (`http://<your-bridge-address>:8095/admin?dev=1`) to show **Advanced
(developer)**: **Fake host / Fake guest / Fake off** (a pretend Jam with made-up members that never talks to Spotify
and ends after 30 minutes), **Jam flags** with **Apply flags** (experimental; reset at restart), and **Jam trace**
(**Reset trace**, **Save trace**: a log without ids, tokens or names, for bug reports).

**Phone diagnostics.** Each paired phone sends a small log of playback events, stalls and errors every 30 seconds. The
bridge keeps it in `data/diag/` (up to 4 MB per phone) and logs problems by the phone's id, never its name. It never
leaves the bridge unless you send it. Showcase blocks reading it.

---

## 8. The Windows bridge

The Windows bridge is one package: the tray program (`Encore Bridge.exe`), the bridge with its own Node.js
(`runtime\`), the engine (`engine\encore-engine.exe`) and ffmpeg. Nothing else needs installing
([Install the bridge on Windows](#install-the-bridge-on-windows)).

### The tray menu

Click (or right-click) the Encore Bridge icon near the clock:

| Item | What it does |
|---|---|
| Status line | **Starting…**, **Ready**, **Ready: pair your phone**, **Streaming to 1 phone**, or a problem such as **Set your admin password**, **Sign in to Spotify**, **Connect your Spotify account** or **Port 8095 is in use**. Click a problem to see what to do. |
| **Open Encore Bridge** | Opens the admin page (`http://127.0.0.1:8095/admin`) |
| **Setup guide…** | Opens the setup guide (`http://127.0.0.1:8095/admin?setup=1`) |
| **Sign in to Spotify…** | Only while the engine needs it: the engine's sign-in code |
| **Phone address: http://…:8095** | The Home address for the app; click it for the steps. With Showcase on: **Phone address: hidden (Showcase)**. |
| **Encore Bridge … is available** ▸ | Only when a newer, checked version is out: **Update now…** (installer) or **Download…** (zip), **What's new**, and during an update its progress and **Cancel update** ([Updating](#12-updating)) |
| **Showcase mode** | The admin page's Showcase switch ([Showcase on the bridge](#showcase-on-the-bridge)) |
| **Keep this PC awake while streaming** | On by default: Windows doesn't sleep while a phone is listening |
| **Start with Windows** | Starts Encore Bridge when you sign in. The installer ticks it; with the zip, tick it yourself. |
| **Open admin page on start** | On by default: the admin page opens in your browser each time Encore Bridge starts, in one tab. Untick it to stop that. When you start Encore Bridge yourself, the setup guide still opens until setup is done. |
| **Troubleshooting** ▸ | **Open log**, **Open logs folder**, **Edit settings…**, **Open data folder**, **Fix firewall…**, **Restart bridge** |
| **Check for updates** | Asks GitHub now (Encore Bridge also checks quietly once a day) |
| **About Encore Bridge** | Versions, where your data is, the license, the update status |
| **Quit Encore Bridge** | Stops the bridge, the engine and ffmpeg, and removes the icon |

### Network and firewall

Windows blocks incoming connections on **Public** networks, so your home network must be **Private**: **Settings →
Network & internet → Wi-Fi** (or **Ethernet**) → your network → **Network profile type** → **Private network**. In
PowerShell, `Get-NetConnectionProfile` should show `NetworkCategory : Private`. Never allow the bridge on Public
networks (cafés, hotels, airports).

If the phone still can't reach the bridge, use tray menu → **Troubleshooting → Fix firewall…**. It first only looks for
**Block** rules for the bridge's `node.exe` (Windows makes them when its firewall prompt is cancelled), an **Allow**
rule for the bridge's port, and a **Public** network. If something needs fixing, it asks, then Windows asks for
administrator permission. It removes the Block rules and adds the **Encore Bridge (phone)** rule for the current port,
Private and Domain networks only. By hand:

1. Press Win+R, type `wf.msc`, press Enter, and open **Inbound Rules**.
2. Delete the Block rules (red "no entry" icon) named **Node.js JavaScript Runtime** or **Encore Bridge (phone)**.
3. Quit and restart Encore Bridge, and allow it on Private networks.

**The PC's address** is in the setup guide (steps 5, 7 and 8), the tray (**Phone address: http://…:8095**) and the
**Phone setup** card. Or run `ipconfig` and use the **IPv4 Address** of your Wi-Fi or Ethernet adapter (not a
"vEthernet", VPN or Tailscale adapter). Give the PC a fixed address in your router (a "DHCP reservation").

### Sleep, sign-out and laptops

- The bridge runs only while you are **signed in** to Windows. Locking is fine; signing out or restarting stops it.
- **Keep this PC awake while streaming** stops sleep only while a phone listens, and Encore Bridge can't wake a
  sleeping PC. To start music from your phone at any time, set **Settings → System → Power & battery → Screen and
  sleep → When plugged in, put my device to sleep after → Never**.
- Laptops: keep it plugged in. To close the lid, set the lid action to **Do nothing** when plugged in (Control Panel →
  Power Options → Choose what closing the lid does).

### Edit settings.env

For settings the setup guide doesn't set, such as the port, `ADMIN_ALLOW` or `ADMIN_PASSWORD`
([Bridge settings](#bridge-settings)):

1. Tray menu → **Troubleshooting → Edit settings…**. Notepad opens `settings.env`.
2. Change the line, for example `PORT=8096`, and save. One setting per line; no quotes, no notes on the same line.
3. **Troubleshooting → Restart bridge**.

`SPOTIFY_CLIENT_ID=<your-client-id>` works here too. Close Notepad before you use the setup guide's step 2.

### Port already in use

**Port 8095 is in use** or **Port 8095 is blocked by Windows** in the tray means another program has the port, or
Windows reserved it (Hyper-V, WSL and Docker reserve ranges). To see the reserved ranges:
`netsh int ipv4 show excludedportrange protocol=tcp`. To use another port:

1. **Troubleshooting → Edit settings…**: change `PORT=8095` to another port, for example `PORT=8096`, and save.
2. **Troubleshooting → Restart bridge**.
3. **Troubleshooting → Fix firewall…**. The installer's rule only covers 8095.
4. Use the new port in the app's Home address. If you forward a port, change both its external and internal port;
   step 8 then shows the new Away address for Encore ([Forward the port](#forward-the-port)).

---

## 9. The Docker bridge

The Docker bridge runs as two containers, `encore-gateway` (the bridge) and `encore-engine`, from the folder with your
`compose.yaml` ([Install the bridge with Docker](#install-the-bridge-with-docker)). Run every `docker compose` command
in that folder. With Dockge it is the stack's folder (usually `/opt/stacks/encore`); with Portainer, your data is in
the full paths you gave.

### Your Encore folder

| Path | What it is |
|---|---|
| `compose.yaml` | Starts the two containers from the images `ghcr.io/mbucc9000/encore-bridge` and `ghcr.io/mbucc9000/encore-engine` |
| `.env` | Optional settings ([The .env file](#the-env-file)) |
| `data/` | The bridge's data: pairings, sign-ins, the admin password, settings, caches |
| `engine/` | The engine's `config.yml` (written at the first start) and its sign-in |
| `pipe/` | The audio between the two containers |

`data/`, `engine/` and `pipe/` appear at the first start, and their files belong to root
([Where the bridge keeps its data](#where-the-bridge-keeps-its-data)).

GitHub builds the images for every release from that release's source, for `linux/amd64` and `linux/arm64`
([BUILDING.md](BUILDING.md#prebuilt-images)). Their tags: `v<version>` (for example `v1.3.0`), `<major>.<minor>` (the
newest release of that version, for example `1.3`) and `latest` (the newest release).

#### When you build it yourself

[Build it yourself](#build-it-yourself) runs from the source's `gateway` folder instead:

| Path | What it is |
|---|---|
| `compose.yaml` | Builds and starts two containers: `encore-gateway` (the bridge) and `encore-engine` |
| `Dockerfile` | Builds the bridge image: Node 22, ffmpeg and qrencode |
| `src/` | The bridge's code |
| `engine-src/` | The engine's full source (go-librespot with Encore's patches), built on your machine |
| `engine/config.yml` | The engine's settings |
| `.env.example` | A template for an optional settings file |
| `test/`, `windows/` | The bridge's tests and the Windows bridge's sources (not needed on Docker) |

The running bridge adds `data/`, `pipe/` and files in `engine/`.

### The .env file

You don't need one: the setup guide keeps the admin password and the Client ID in `data/`. Create `.env` next to
`compose.yaml` only for a setting the setup guide doesn't set, such as `ADMIN_ALLOW`, to stay on one version, or to
set the Client ID or password from outside. Make it readable only by you: `chmod 600 .env`.

The ready-made images' `compose.yaml` passes these names on (Dockge: the stack's `.env` box; Portainer: the stack's
environment variables). Leave out what you don't need; a line that starts with `#` is ignored:

```ini
#ENCORE_TAG=v1.3.0
#ZEROCONF_BACKEND=avahi
SPOTIFY_CLIENT_ID=
ADMIN_PASSWORD=
#ADMIN_ALLOW=private
#UPDATE_CHECK=1
```

- `ENCORE_TAG`: the version to stay on, such as `v1.3.0`, or `1.3` for the newest `1.3.x`. Without it you get
  `latest`, the newest release.
- `ZEROCONF_BACKEND`: `avahi` on a machine that runs avahi-daemon ([Engine settings](#engine-settings)).
- The others: [Bridge settings](#bridge-settings). A value in `SPOTIFY_CLIENT_ID` or `ADMIN_PASSWORD` wins over the
  setup guide's.

Any other bridge setting goes under the `gateway` service's `environment:` in `compose.yaml`, as one more line such as
`ENCORE_APP_REPO: <address>`.

**When you build it yourself,** `.env` sits in the `gateway` folder and every setting in it reaches the bridge. Start
from the template: `cp .env.example .env`. It has four settings (`SPOTIFY_CLIENT_ID`, `ADMIN_PASSWORD`, `ADMIN_ALLOW`,
`UPDATE_CHECK`), each explained in the file.

Apply changes with `docker compose up -d`. A plain `docker compose restart` doesn't read `.env` again. Every setting:
[Bridge settings](#bridge-settings).

### Engine settings

`engine/config.yml` holds the engine's settings. The ready-made engine writes Encore's default one at its first start
and never replaces it after that, so with the ready-made images the file belongs to root: edit it with `sudo` (for
example `sudo nano engine/config.yml`). The defaults suit most people:

| Setting | Default | Change it when |
|---|---|---|
| `device_name` | `Encore` | You run two bridges, or want another speaker name in Spotify |
| `zeroconf_backend` | `builtin` | **Your machine already runs avahi-daemon** (below) |
| `credentials.type` | `zeroconf` | You prefer the code sign-in ([Docker: pick Encore once](#docker-pick-encore-once)) |
| `bitrate` | `320` | Never: the bridge always asks for the best quality and encodes per phone |
| `metadata.enabled` | `true` | Never: song lists need it |
| `metadata.max_tracks` | `5000` | Your longest playlist (or Liked Songs) has more songs than this |

**avahi-daemon.** Many NAS systems and desktop Linux distributions run it, and it would fight the engine over the
discovery port. If `systemctl is-active avahi-daemon` says `active`:

1. Switch the engine to avahi. With the ready-made images, put `ZEROCONF_BACKEND=avahi` into `.env` (Dockge: the
   stack's `.env` box; Portainer: its environment variables); `engine/config.yml` stays as it is. Or, also when you
   build it yourself, set `zeroconf_backend: avahi` in `engine/config.yml` (with `sudo` on the ready-made images: the
   file belongs to root).
2. In `compose.yaml`, under the `engine` service's `volumes:`, remove the `# ` in front of this line, so it reads:

   ```yaml
         - /run/dbus/system_bus_socket:/run/dbus/system_bus_socket
   ```

**Firewall.** Discovery uses UDP 5353 and one TCP port the engine picks at random. To fix that port, add a line such
as `zeroconf_port: 45678` (any free port) to `engine/config.yml` (with `sudo` on the ready-made images).

After a change, run `docker compose up -d` (`compose.yaml`, `.env`) or `docker compose restart engine`
(`engine/config.yml`).

### Ports and firewall

| Port | Who uses it | Open it to |
|---|---|---|
| TCP 8095 | The phones and the admin page | Your home network, and the internet through the port forward for listening away from home. The admin page and pairing still answer only your home network. |
| TCP 3678 on 127.0.0.1 | The bridge talking to the engine | Nobody: it listens only on the machine itself. **Never forward it.** |
| UDP 5353 + the engine's `zeroconf_port` | Spotify Connect discovery of the **Encore** speaker | Your home network only |

With a firewall (ufw, firewalld, a NAS firewall), allow TCP 8095, UDP 5353 and your `zeroconf_port` from your home
network, and TCP 8095 from anywhere once you forward the port ([Forward the port](#forward-the-port) has the
commands). The setup guide's network check can't see a firewall on Linux.

**The bridge's address** is in the setup guide (steps 5, 7 and 8) and on the **Phone setup** card, or run
`hostname -I`. Give the machine a fixed address in your router (a "DHCP reservation").

---

## 10. Bridge settings and data

### Bridge settings

Put these in `.env` (Docker) or `settings.env` (Windows), one `NAME=value` per line, then restart the bridge (Docker:
`docker compose up -d`; Windows: **Troubleshooting → Restart bridge**). An empty value means "use the default". With
the ready-made Docker images, `.env` reaches the bridge only for the names their `compose.yaml` lists
([The .env file](#the-env-file)).

| Setting | What it does | Default |
|---|---|---|
| `SPOTIFY_CLIENT_ID` | Your developer app's Client ID. The setup guide usually saves it, without a restart; a value in the environment wins ([The Client ID](#the-client-id)). Without one, library, search, Home and profiles are off. | empty |
| `ADMIN_PASSWORD` | Admin password. Overrides the one chosen on the admin page. | empty |
| `ADMIN_ALLOW` | Who may open the admin page and pair phones: addresses and CIDR ranges, separated by commas, for example `192.168.1.0/24` or `private,203.0.113.7`. `private` stands for the default set. The bridge machine is always allowed. Entries that aren't addresses are ignored (the log says how many); if none is usable, only the bridge machine is. | `private`: loopback, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10`, `fc00::/7`, `fe80::/10` |
| `PORT` | The bridge's port | `8095` |
| `FFMPEG` | Path to a different ffmpeg | Docker: the image's; Windows: the bundled `ffmpeg\ffmpeg.exe` |
| `ENCORE_APP_REPO` | For forks: the Cydia repo address that step 6 and the **Phone setup** card show. Must be `http://` or `https://` (a missing `/` at the end is added); anything else is ignored, with a line in the log. | `https://mbucc9000.github.io/slopkit/` |
| `SPOTIFY_CALLBACK_CATCHER` | `1`: catch the Spotify sign-in's return address on `127.0.0.1:8888`, so a browser on the bridge machine needs no paste. `0`: always paste. | `1` on Windows, `0` on Docker |
| `ADMIN_SETUP_LOOPBACK` | `1`: choose the first admin password on the bridge machine itself (a page at `127.0.0.1` or `localhost`) without the setup code. A website's page that reaches the bridge never counts. | `1` on Windows, `0` on Docker (where "the machine itself" can be any container) |
| `ENCORE_TAG` | Docker, ready-made images: the version to stay on, for both images, such as `v1.3.0` or `1.3` | `latest` |
| `ZEROCONF_BACKEND` | Docker, ready-made images: `avahi` or `builtin`, the engine's discovery for this start, over `zeroconf_backend` in `engine/config.yml` ([Engine settings](#engine-settings)) | empty: `config.yml` decides |
| `ENCORE_PREBUILT` | Set by the ready-made bridge image (`1`), not by you: the admin page then shows the `docker compose pull` update | — |
| `UPDATE_CHECK` | `1`: look for a new Encore Bridge on GitHub once a day. `0` (or `false`, `no`, `off`): no automatic look; **Check for updates** and **Check now** still work. Windows needs no restart ([Turn the update check off](#turn-the-update-check-off)). | `1` |

`ADMIN_TRUST_PROXY=1` makes the bridge believe proxy headers. Reverse proxies are not supported, so leave it unset.

**Docker:** `compose.yaml` sets `PORT`, `DATA_DIR`, `PCM_FIFO` and `ENGINE_URL`, and they win over `.env`. To change
the port, edit `PORT` in `compose.yaml`. **Windows:** the data folder is `%LOCALAPPDATA%\Encore`, unless the
environment variable `ENCORE_HOME` names another folder.

### Where the bridge keeps its data

Docker keeps it in the folder with `compose.yaml` (the `gateway` folder when you build it yourself). Windows keeps it
in `%LOCALAPPDATA%\Encore` (tray menu → **Troubleshooting → Open data folder**).

| Docker (the folder with `compose.yaml`) | Windows (`%LOCALAPPDATA%\Encore`) | What it holds |
|---|---|---|
| `.env` (if you made one) | `settings.env` | Your settings (on Windows also the Client ID). Encore Bridge never overwrites `settings.env`; the setup guide only changes its `SPOTIFY_CLIENT_ID` line. |
| `data/settings.json` | — | The Client ID the setup guide saved |
| `data/tokens.json` | `data\tokens.json` | Your Spotify sign-in (refresh token), Spotify name and id |
| `data/devices.json` | `data\devices.json` | Paired phones: name, id, key, last contact |
| `data/admin.json` | `data\admin.json` | Your admin password (it can't be read back) |
| `data/showcase.json` | `data\showcase.json` | Whether Showcase is on |
| `data/wizard.json` | `data\wizard.json` | The setup guide's progress (times only; no names, addresses or codes) |
| `data/jam.json`, `data/last.json` | `data\jam.json`, `data\last.json` | Jam access, the last playback state |
| `data/diag/` | `data\diag\` | Phone diagnostics |
| `data/cache/` | `data\cache\` | Cached lists, covers, profiles and lyrics |
| `data/update.json` | `update.json` | The update check's last result: times, version numbers, error codes; nothing about you |
| — | `updates\` | Downloaded updates and the installer's log (`setup.log`), one folder per version, removed once that version runs or after 30 days |
| `engine/state.json` | `engine\state.json` | The engine's Spotify sign-in |
| `engine/config.yml` | `engine\config.yml` | The engine's settings |
| `pipe/` | — | The audio pipe between the containers |
| The container log (`docker compose logs`) | `logs\bridge.log` | The bridge's log (Windows: 5 MB, then `bridge.log.1` … `.3`) |
| — | `launcher.json` | The tray's own choices: Keep this PC awake, Open admin page on start |

The sign-ins, `devices.json` and `admin.json` are secrets. On Linux they are readable only by their owner; on Windows
only your user account (and administrators) can read `%LOCALAPPDATA%`. The Windows program folder holds no personal
data.

---

## 11. Troubleshooting

Search this page for the message you see, or a few words of it. Messages are quoted as Encore shows them. In Anonymous
Mode, messages that would name a person or a device read slightly differently
([chapter 5](#5-anonymous-mode-and-showcase)).

### Setup and pairing

**Pairing**

| You see | What to do |
|---|---|
| **Enter the 6-digit code from the admin page.** / **wrong or expired pairing code** / **too many attempts, wait a minute** | A code works once, for 5 minutes. Press **New pairing code** and type all six digits right away. After ten wrong codes within a minute, pairing pauses for everyone: wait a minute first. |
| **The home address should look like http://192.168.1.20:8095** | Type the bridge's local IP and port in the Home field, like `192.168.1.20:8095`. |
| **Can't reach your Encore Bridge at either address.** | Check, in order: the phone is on your **home Wi-Fi** (not mobile data or a guest network); the address and the `:8095` port are right; the bridge is running; in the phone's Safari, `http://<your-bridge-address>:8095/` shows two lines starting with "Encore gateway". If Safari can't open it either, the network or the firewall is the problem: on Windows see [Network and firewall](#network-and-firewall); Linux firewalls must allow TCP 8095. |
| **Pairing only works on your home network. Connect this iPhone to the same Wi-Fi as your Encore Bridge and try again.** | The phone came from outside `ADMIN_ALLOW`, for example from the internet through your port forward. Join your home Wi-Fi and pair again. If you changed `ADMIN_ALLOW`, make sure it includes your home network ([Bridge settings](#bridge-settings)). |
| **Couldn't save the pairing.** / **Pairing failed.** | Make sure you're pairing **at home**. Restart the phone and pair again. If it keeps happening, look in the bridge log for a line about pairing, or reinstall Encore. |

**In the setup guide**

| You see | What to do |
|---|---|
| **Choose your admin password first** (steps 2 to 9 locked) | Do step 1, **Protect this page** ([The admin password](#the-admin-password)). |
| **That isn't a Client ID. It is 32 letters (a-f) and digits, under Settings → Basic Information in your developer app. (Not the client secret.)** | Copy the whole **Client ID** from your developer app's **Settings → Basic Information** ([Create your developer app](#create-your-developer-app)). The client secret looks like an ID and is accepted, but step 3 then fails with **INVALID_CLIENT: Invalid client**. |
| **This bridge's Client ID is set in its environment (.env on Docker), so it can't be changed here. Change it there and restart the bridge.** | `SPOTIFY_CLIENT_ID` in the bridge's environment (on Docker, `.env`) always wins ([The Client ID](#the-client-id)). Change it there, then run `docker compose up -d` in your Encore folder. Or empty it there; then the setup guide can save one. |
| **The Client ID couldn't be saved (…).** | The bridge couldn't write `settings.env` (Windows) or `data/settings.json` (Docker); the code in brackets says why (`EACCES`: no permission). Windows: free some disk space and make sure nothing locks `%LOCALAPPDATA%\Encore\settings.env`. Docker: make sure the container can write to `data/`. Then press **Save Client ID** again. |
| **Showcase is on, so connecting is hidden: …** (step 3) / **Showcase is on, so your public IP stays hidden. Turn Showcase off to find it.** (step 8) | Turn **Showcase** off, then press **Connect** or **Find my public IP**. |
| **Spotify refused your account. Add your account under User Management in your developer app (step 2), then press Connect again.** / **Spotify's page was cancelled, so nothing was connected. Press Connect again.** / **Your Spotify account wasn't connected: the tab Spotify opened says why. Press Connect again.** (step 3, Windows) | Refused: add the account under **User Management** ([Create your developer app](#create-your-developer-app)). Cancelled: press **Agree** on Spotify's page next time. Another reason: read the tab Spotify opened ([Spotify account and sign-in](#spotify-account-and-sign-in)). Then press **Connect** again. |
| **Couldn't find your public IP: no IP-check service answered. …** (step 8) | Check that the bridge's computer is online and press **Find my public IP** again. Or read your router's Internet (WAN) address on its admin page: the Away address is `http://<that address>:8095`. |
| **This IP (100.64 to 100.127) is a shared address of your internet provider (carrier-grade NAT), …** / **This isn't a public IP, so a port forward can't reach your home through it. …** (step 8) | A port forward can't reach your home through this address. Shared address: remove the port forward and ask your provider for a public IPv4 address. Not public: check your router's Internet (WAN) address. See [Carrier-grade NAT and double NAT](#carrier-grade-nat-and-double-nat). |
| **Waiting for your phone to connect from outside your home network…** stays (step 8) | Test on mobile data, not your home Wi-Fi (an iPod touch: another Wi-Fi, such as your phone's hotspot), with the Away Address set in Encore. If Settings says **Status: Offline**, see [Connection](#connection). Over the iPhone's VPN this step never ticks: press **Skip for now**. |
| Another step stays on its waiting line, such as **Waiting for your phone…** | Do that step on the phone (or in Spotify). If you did it another way, press **Skip for now**. |

**From the network check** (setup guide step 5)

| You see | What to do |
|---|---|
| **Couldn't tell this computer's address on your home network.** … | The computer may have only a VPN or virtual adapter. Find its address in your router's list of connected devices and use it on the phone. |
| **Encore Bridge doesn't answer on its home-network address.** … | Restart the bridge. Windows: tray menu → **Troubleshooting → Restart bridge**. Docker: `docker compose restart gateway`. |
| **This computer's network is set to Public, and Windows keeps your phone out on Public networks.** … / **Windows Firewall has a rule that blocks Encore Bridge** … / **No Windows Firewall rule lets your phone reach Encore Bridge on port 8095.** … | Public: if it is your home network, set it to Private. Firewall: tray menu → **Troubleshooting → Fix firewall…**. See [Network and firewall](#network-and-firewall). Then press **Check again**. |
| **Couldn't read the Windows network settings.** … | Security software may have stopped the read-only check. Nothing to fix now. If the phone can't connect later, use **Troubleshooting → Fix firewall…**. |

**In Cydia**

| You see | What to do |
|---|---|
| Cydia can't add the Encore repo, or shows an error for it while it refreshes | Type the address exactly, with `https://` and the `/` at the end: `https://mbucc9000.github.io/slopkit/`. Check that the phone is online (Safari opens a page). Try again later, or install the app another way ([Other ways to install the app](#other-ways-to-install-the-app)). |
| No Encore update in **Changes** after you updated the bridge | **Changes** → **Refresh**. If it still isn't there, the new version isn't in the Encore repo yet: try later, or install the new `.deb` from the release page ([Other ways to install the app](#other-ways-to-install-the-app)). |

### Connection

| You see | What to do |
|---|---|
| **Can't reach your Encore Bridge.** / Settings **Status: Offline**, at home | As in [Setup and pairing](#setup-and-pairing). Check that the bridge machine is awake. |
| The same, away from home | Check, in order: (1) the Away Address is set in Encore (Settings) and ends in the port; (2) the router forwards TCP 8095 to the bridge computer's **current** address (the setup guide's step 8 shows it; a DHCP reservation keeps it); (3) your public IP hasn't changed ([When your public IP changes](#when-your-public-ip-changes)); (4) Windows: the network is still **Private**; Docker: the machine's firewall allows TCP 8095 from anywhere; (5) your router has its own public IP ([Carrier-grade NAT and double NAT](#carrier-grade-nat-and-double-nat)). Test on mobile data: many routers can't reach their own public IP from your home Wi-Fi. With the VPN, check that it is switched on. |
| **No audio from your Encore Bridge.** | Check the engine (**Settings → Engine**). Try **Listen here** on the admin page: if that is silent too, the engine or ffmpeg has a problem (see the bridge log). |
| **Your Encore Bridge doesn't know this phone any more. Unpair and pair again.** | The phone was unpaired on the admin page, or the bridge lost its `data` folder. **Settings → Unpair This iPhone**, then pair again with a new code. |
| **Your Encore Bridge sent an answer Encore can't read.** | Something else answered, often a hotel or café Wi-Fi login page, or a wrong address. Open Safari first and finish any Wi-Fi login page. Check the addresses. |
| **Encore Bridge error N.** | The bridge answered with an error the app has no text for (N is the HTTP status). Look in the bridge log at that time. |

### Playback

| You see | What to do |
|---|---|
| **Encore isn't playing anything. Paste a link, pick Encore in Spotify, or connect your Spotify account on the Encore Bridge admin page.** / **Nothing is playing on Encore.** | Nothing is loaded yet. Play a song, album or playlist from the app. |
| **Encore's player is reconnecting to Spotify. Try again in a moment.** | Right after another device took playback, this clears in seconds. If it stays, the engine was never signed in: [sign the engine in](#sign-the-engine-in) (the setup guide's step 4). |
| **Encore's player isn't reachable.** / **Encore's player didn't answer in time.** / **Encore's player didn't answer. Try again in a moment.** / Settings **Engine: Not connected** | The bridge can't talk to the engine. Docker: `docker compose ps` and `docker compose logs engine`. Windows: check the tray's status line and the admin page's Engine sign-in card, then **Troubleshooting → Restart bridge**. |
| **Spotify is refusing to play right now (it may be limiting requests). Try again in a minute or two.** / **Spotify is refusing to play right now. Try again in N s.** | Spotify refused the keys for the audio, so Encore waits 60 seconds. Try again then. If it happens constantly, see the [FAQ](#16-faq). |
| Music pauses by itself about 45 seconds after you close the app | By design: with nobody listening, the bridge pauses instead of playing to an empty room. |
| Stutters or gaps | Keep **Auto-Reduce Quality** on, or choose a lower **Streaming Quality**. At home, check the Wi-Fi signal. The admin page's **Engine & stream** card shows stalls. |

### Spotify account and sign-in

| You see | What to do |
|---|---|
| **Connect your Spotify account on the Encore Bridge admin page first** / **Spotify sign-in expired: reconnect on the Encore Bridge admin page** | Connect the account again: the setup guide's step 3, or admin page → Spotify account → **Connect** ([Connect your Spotify account](#connect-your-spotify-account)). A Client ID change, a new Spotify password, removed access or signing out everywhere ends the sign-in. |
| **Add your Spotify Client ID in the setup guide (step 2) first.** / Spotify account card: **Not set up yet:** add your Client ID in the setup guide (step 2). | Do the setup guide's step 2, **Your Spotify developer app** ([The Client ID](#the-client-id)). |
| Spotify's page says **INVALID_CLIENT: Invalid redirect URI** | In the dashboard, set the Redirect URI to exactly `http://127.0.0.1:8888/callback`, press **Add**, and save ([Create your developer app](#create-your-developer-app)). Then press **Connect** again. |
| Spotify's page says **INVALID_CLIENT: Invalid client** | The bridge's Client ID isn't your developer app's: usually the client secret was pasted, or the app was deleted. Copy the **Client ID** from **Settings → Basic Information**, then the setup guide's step 2 → **Change** → paste it ([The Client ID](#the-client-id)). Then press **Connect** again. |
| **paste the whole address from the browser (it starts with http://127.0.0.1:8888/callback)** | Copy the whole address from the tab that shows "can't be reached", including `?code=`. |
| **that login link is old or from another tab; press Connect again** / Windows tab: **This sign-in link is old or from another tab. Go back to the Encore Bridge admin page and press Connect again.** | The link belongs to an older attempt, or the bridge restarted in between. Press **Connect** again and use the new tab. |
| **Spotify refused this (GET /me: …)** | Add the account under **User Management** in the dashboard ([Create your developer app](#create-your-developer-app)), and check that the app owner has Premium. Then press **Connect** again. |
| **Spotify said: access_denied** / **Spotify login: invalid_grant** (or another reason) / **Spotify sign-in didn't answer. Try again in a moment.** / **Spotify sign-in failed (N). Try again in a moment.** | Press **Connect** again (and **Agree** on Spotify's page), or try again later. Check the bridge machine's internet connection. |
| Bridge log: **COULD NOT SAVE the rotated Spotify refresh token** | The bridge can't write to its `data` folder, so the sign-in is lost at the next restart. Docker: check that the container can write to `data/`. Windows: check free disk space and that nothing locks `%LOCALAPPDATA%\Encore\data`. Then connect again. |

### Lists, search and profiles

| You see | What to do |
|---|---|
| **Spotify is limiting requests. Try again in N s.** / **Spotify is limiting requests right now. Try again in a minute.** / **Spotify is busy. Try again in a moment.** / **Encore is loading other lists. Try again in a moment.** / **Encore is busy loading profiles. Try again in a moment.** | Wait a little. Encore spaces out its requests to Spotify, and it clears by itself. Meanwhile saved copies are shown. |
| **Your playlists will show here once your Encore Bridge answers.** / **Home fills up once your Encore Bridge answers.** | Pull down to refresh. Check the connection. |
| **Song lists are turned off on the Encore player (metadata.enabled).** | Set `metadata: enabled: true` in the engine's config and restart. |
| **Lyrics aren't available right now.** | LRCLIB didn't answer. Try later. Some songs have no lyrics on LRCLIB. |
| **Profiles aren't available right now.** / **Following people isn't available right now.** / **Saving other people's playlists isn't available right now.** | Spotify refused the private interface Encore uses for this, so Encore switches the feature off for a while. Try again later. Update Encore if a new release fixes it. |
| **Not a Spotify link** … **Podcasts aren't supported.** | Paste a song, album, playlist or artist link: Share → Copy Link in Spotify. |

### The bridge machine

| Problem | What to do |
|---|---|
| **"Encore" is missing from Spotify's device list** | Discovery needs the Spotify app and the bridge on the **same network**: not a guest Wi-Fi, not a separate VLAN, no "AP isolation". On Docker, if the host runs avahi-daemon, switch the engine to avahi, and let UDP 5353 and the engine's zeroconf port through firewalls ([Engine settings](#engine-settings)). Once the engine is signed in, Encore also appears for your account on other networks. Or use the code sign-in ([Sign the engine in](#sign-the-engine-in)). |
| Admin page: **Not from this address.** / **The admin page and pairing don't work through a proxy. …** | You came in from outside your network (through a port forward, a proxy or a tunnel), or `ADMIN_ALLOW` leaves your network out. Open the bridge's own address from your home network, or on the bridge machine itself. |
| **The password prompt keeps coming back** / Admin page: **Too many wrong passwords. Try again later.** | The password is wrong (any user name works). After 10 wrong passwords or setup codes from your address within 15 minutes, wait 15 minutes. To reset the password, see [The admin password](#the-admin-password). |
| Admin page: **That isn't the setup code from the bridge's log.** / **Use at least 8 characters.** / **Use the admin page itself.** | Use the newest "setup code" line: a restart prints a new one ([The admin password](#the-admin-password)). Choose a password of at least 8 characters. Use the admin page in your browser, not another website or tool. |
| Bridge log: **ADMIN_ALLOW has no usable entry: the admin page and pairing only answer this computer** | None of the entries in `ADMIN_ALLOW` is an address or range. Fix it ([Bridge settings](#bridge-settings)). |
| Bridge log: **no Spotify Client ID yet: the setup guide on the admin page asks for it** / **data/settings.json: the saved Spotify Client ID isn't valid and is ignored** | Save your Client ID in the setup guide's step 2 ([The Client ID](#the-client-id)). |
| Bridge log: **public IP check: failed (…)** | No IP-check service answered **Find my public IP**. The brackets name each service and why (`timeout`, `http_<status>`, `bad_answer` or `network`). Check the bridge machine's internet connection, or read your router's Internet (WAN) address instead ([Forward the port](#forward-the-port)). |
| Bridge log: **ENCORE_APP_REPO isn't an http(s) address, so the default Encore repo is used** | Fix or remove `ENCORE_APP_REPO` in your settings ([Bridge settings](#bridge-settings)). |
| Bridge log: **port 8095 is in use by another program (choose another PORT, or stop that program)** / Windows tray: **Port 8095 is in use** / **Port 8095 is blocked by Windows** | Docker: change `PORT` in `compose.yaml`. Windows: see [Port already in use](#port-already-in-use). |
| `docker compose up` or `pull`: **pull access denied**, **denied** or **unauthorized** | Docker couldn't download an image. Download `compose.yaml` again and check that its `image:` lines are unchanged. Right after a new release the images can take a while to appear: try again in an hour. |
| **no matching manifest for linux/arm/v7** (or another platform), or **exec format error** | The images are for 64-bit systems (`linux/amd64`, `linux/arm64`). Install a 64-bit OS and its Docker; `docker version --format '{{.Server.Arch}}'` must say `amd64` or `arm64` (`arm` is a 32-bit Docker, even on a 64-bit kernel). |
| **`docker compose up --build` fails** (built yourself) | Read the first error. Common causes: no internet on the host (the build downloads base images and Go modules), too little disk space, or a 32-bit system (use a 64-bit OS). |
| **Couldn't make the QR code.** (Jam) | Rare. The bridge log has a `jam qr:` line saying why. Copy Link and Message still work. |
| Windows tray: **Settings problem** / **Keeps stopping** / **Stopped** / **Engine stopped** | **Troubleshooting → Open log** says why. For **Settings problem**, fix the value it names (for example `PORT`) with **Edit settings…**. Then **Restart bridge**. |
| Windows tray: **Couldn't start** / **Engine missing** / **Engine version mismatch** / **Version mismatch** | `runtime\node.exe` or `engine\encore-engine.exe` is missing (usually quarantined by antivirus software: restore it), or parts of two versions are mixed. Reinstall Encore Bridge, or unzip the whole package again into an empty folder. |
| Windows: **the phone can't connect** | The setup guide's step 5 checks the network and the firewall. Then check [Network and firewall](#network-and-firewall) and [Sleep, sign-out and laptops](#sleep-sign-out-and-laptops). |

Harmless: `could not shrink the … pipe buffer` in the bridge log, and `player events disconnected` once (the engine
restarted and reconnects by itself; if it repeats, check `docker compose logs engine`, on Windows the log). On Windows,
"Encore" stays in Spotify's device list for a minute or so after you quit.

### Jam

| You see | What to do |
|---|---|
| Jam buttons greyed, with a note about **a one-time check** / **Encore can't start or join Jams yet. Start a Jam in Spotify on your computer with Encore selected.** | Do the [one-time Jam check](#the-one-time-jam-check). |
| **Spotify didn't let Encore start a Jam. …** / **Spotify didn't start the Jam.** | Try again, or start the Jam in the Spotify app on your computer with Encore selected. It shows up in Encore. |
| **Spotify didn't let Encore join this Jam. It may be full, or the host may have turned joining off.** / **Jam Not Found** — **This Jam has ended, or the link is wrong.** / **Not a Jam Link** — **That isn't a Jam link. Paste the link a friend sent you.** | Paste the invite link exactly as sent. If it still fails, ask the host for a new link. |
| **Encore left the Jam: Spotify is refusing to play right now** / **Spotify is limiting Jam requests. Try again in N s.** | Wait a minute or two. |
| **Encore left the Jam: nobody was listening** / **Nobody was listening to your Jam on Encore, so it's paused.** | Not an error: the [Jam safety rules](#jam-safety-rules). |
| **Adding songs to this Jam from Encore isn't possible yet.** | Add from the Spotify app. |
| **Encore's player can't do this. Update the Encore player.** / **Up Next needs the updated Encore player.** | The engine is older than the bridge. Update the bridge so both match ([Updating](#12-updating)). On Docker, `docker compose pull` and `docker compose up -d` update both images together. |
| **Turn shuffle off to change these songs.** / **Autoplay songs can't be moved or removed.** / **Songs can only move within their own section.** / **Up Next changed, so it was refreshed.** | Limits of editing Up Next. Nothing to fix. |

### Updates

These messages appear in the admin page's **Updates** section, and on Windows also in a window after **Check for
updates** or **Update now…** in the tray menu. A failed check changes nothing: the bridge keeps running the version it
has.

**Looking for a new version**

| You see | What to do |
|---|---|
| **Couldn't reach GitHub. Check that this computer is online; Encore Bridge tries again later.** / **GitHub didn't answer in time. Try again in a minute.** / **GitHub answered with an error (HTTP N). Encore Bridge tries again tomorrow.** / **GitHub's answer couldn't be read. Encore Bridge tries again tomorrow.** | Nothing: Encore Bridge tries again by itself. Check the computer's internet connection, or press **Check now** (or **Check for updates**) later. A firewall, a proxy or a Wi-Fi login page can be in the way (the check uses no proxy, except on Windows one set in `HTTPS_PROXY`). If it stays, look at the release page yourself. |
| **GitHub asked Encore Bridge to wait (too many requests from your network). It tries again after ….** | GitHub answers 60 requests an hour from one public IP address, and programs on your network used them up. Nothing to do: it asks again after that time. |
| **Encore Bridge … is published, but not all of its files are there yet. Encore Bridge looks again later.** | The release is still being uploaded. Wait for the next daily check. |
| **Encore Bridge … is published, but it isn't signed with Encore's release key, so it isn't offered. Don't install it from anywhere else; see the project page on GitHub.** | The release may have been changed, damaged or replaced, or Encore's release key was replaced. Nothing was downloaded. Don't install that version from anywhere. If the key was ever replaced, the project's README says so and how to install the new version by hand once. Otherwise, report it on the issue tracker. |
| **Encore Bridge … doesn't include a signed file for this computer, so it isn't offered.** / Windows tray: **Encore's signature for Encore Bridge … doesn't cover the file this computer needs, so it isn't offered.** | Don't install that version. Wait for the next release, and report it if it stays. |
| **This is a development build, so it doesn't look for updates.** | This copy was built from source without a release version number. Update it the way it was built, or install a release. |

**Updating on Docker**

| You see | What to do |
|---|---|
| The admin page still says **Encore Bridge … is available** after `docker compose pull` | Run `docker compose up -d` too: `pull` only downloads the new images, `up -d` restarts the containers on them. If `.env` sets `ENCORE_TAG`, set it to the new version first. If `pull` downloaded nothing new, the new images aren't out yet: try again later. |
| `docker compose pull`: **pull access denied**, **denied** or **unauthorized**, or **manifest unknown** | Docker couldn't find the images. Check the `image:` lines in `compose.yaml` and the version in `ENCORE_TAG` (`v1.3.0` with a `v`, or `1.3` without). Right after a release, try again in an hour. |

**Updating on Windows**

| You see | What to do |
|---|---|
| **There isn't enough free space for the update: … is needed on the drive that holds %LOCALAPPDATA%.** | Free some space on that drive (usually C:), then choose **Update now…** again. |
| **The downloaded installer doesn't match Encore's signature, so it was deleted and not run. Try again later.** | It arrived damaged or changed. Nothing was installed or run. If it keeps happening, report it on the issue tracker. |
| **The installer stopped before it finished (code N). Encore Bridge … is still installed.** / **The update to Encore Bridge … didn't finish, so Encore Bridge … was started again.** | Try **Update now…** again later, or install by hand ([Bridge on Windows](#bridge-on-windows)). The installer's log is `%LOCALAPPDATA%\Encore\updates\<version>\setup.log`. |
| **The update to Encore Bridge … didn't finish, and Encore Bridge can't start: … is missing.** | Run the installer the message names (`%LOCALAPPDATA%\Encore\updates\<version>\EncoreBridge-<version>-setup.exe`), or download it again from the release page. Your settings, sign-ins and paired phones stay. |
| **Windows couldn't start the installer. Try again, or download it from the release page.** | Security software often blocks it. Check your antivirus quarantine. |

### Asking for help

Report problems on [github.com/mbucc9000/encore/issues](https://github.com/mbucc9000/encore/issues). Include:

1. The app version (Settings → About) and the bridge version.
2. Docker or Windows, and your device and iOS version.
3. The exact message you see.
4. The bridge log around the time it happened:
   - Docker: `docker compose logs --tail 500 gateway engine > encore-log.txt`
   - Windows: tray → **Troubleshooting → Open log** (`bridge.log`), or **Open logs folder** for the older files.

Read a log before you share it. The bridge's own log leaves out passwords, tokens, search terms, names and addresses
([Logs](#logs)). But on Docker the engine's log names songs, devices and part of your Spotify username (leave `engine`
out of the command above, or edit those lines), and on Windows an update's `setup.log` shows your Windows user name.

**Never share** `.env`, `settings.env`, the `data` folder (`tokens.json`, `devices.json`, `admin.json` and the rest) or
the engine's `state.json`: they hold your sign-ins and your phones' keys. **Never post your public IP** or your Away
address: it tells strangers where your bridge is.

---

## 12. Updating

**Update the bridge first, then the app.** A new app may need the matching bridge; the app tells you when the bridge is
too old. Encore Bridge looks for a new version once a day and tells you when one is out. It never installs anything on
its own.

### How the update check works

- **When:** at most once a day (never in the first ten minutes after Encore Bridge starts), and whenever you choose
  **Check for updates** in the Windows tray menu or **Check now** in the admin page's **Updates** section.
- **Where:** [github.com/mbucc9000/encore/releases](https://github.com/mbucc9000/encore/releases/latest). On Windows the
  tray program asks GitHub; on Docker the bridge asks.
- **What:** only a final release newer than yours, never a test version (such as `1.2.0-rc1`). Encore Bridge only
  installs updates signed by Encore, and doesn't offer any others.
- **What it sends:** nothing about you, only the User-Agent `EncoreBridge/<version>`. GitHub sees your home's public IP,
  as with any download.

While a new version waits, the admin page shows a banner, **Encore Bridge … is available.**, with **What's new** (the
release notes) and **Update…** (the **Updates** section).

### Bridge on Windows

1. Tray menu → **Encore Bridge … is available** → **Update now…**. (**What's new** opens the release notes.)
2. Encore Bridge asks **Update Encore Bridge to …?** and shows the download size. Choose **Yes**.
3. Windows asks for permission for `EncoreBridge-<version>-setup.exe`, publisher **Unknown** (Encore isn't code-signed).
   Choose **Yes**. If no prompt appears, click the flashing shield (**User Account Control**) on the taskbar.
4. The installer replaces the program files and restarts Encore Bridge. Phones stop playing for about a minute. A window
   says **Encore Bridge is now version ….**

Everything in `%LOCALAPPDATA%\Encore` stays, `engine\config.yml` included, and so do **Start with Windows** and the
firewall rule.

- **Cancel:** while it downloads, choose **Cancel update** in the tray menu. **Update now…** later continues where it
  stopped.
- **From the admin page:** **Update now** works only when the page was opened on the PC as `http://127.0.0.1:8095/admin`
  (the tray's **Open Encore Bridge**), because Windows' prompt appears on the PC's screen.
- **If it fails:** see [Updates](#updates). Or update by hand: run the new `EncoreBridge-<version>-setup.exe` from the
  release page. It upgrades in place and keeps your settings.

**Portable zip.** The tray menu offers **Download…** (the release page) instead of **Update now…**. To update:

1. Download `EncoreBridge-<version>-win64.zip` and choose **Quit Encore Bridge** in the tray menu.
2. Unblock the zip, unzip it into a **new, empty folder** ([Portable zip](#portable-zip)) and start `Encore Bridge.exe`.
3. At the firewall prompt for **Node.js JavaScript Runtime**, tick **Private networks** only and press **Allow access**.
4. Tick **Start with Windows** again if you use it. Once the new version plays, delete the old folder.

### Bridge on Docker

Encore Bridge doesn't update itself on Docker. When a new version is out, the admin page's **Updates** section shows
these commands with a **Copy** button. Run them on the bridge computer, in the folder with your `compose.yaml`:

```sh
docker compose pull &&
docker compose up -d
```

`pull` downloads the new images, and `up -d` restarts both containers on them. Your data, pairings and sign-ins stay;
phones stop playing for a few seconds.

- **Dockge:** press **Update** on the Encore stack. **Portainer:** open the stack, choose **Update the stack** and turn
  on **Re-pull image and redeploy**.
- **`ENCORE_TAG`:** if your `.env` sets it to stay on one version, set it to `v<new>` first (`<new>` is the new
  version).
- The admin page shows the update about an hour after the release is published, once the images are out.
- `compose.yaml` itself seldom changes. When a release changes it, its release notes say what to change in yours.

**A second bridge:** run the same two commands in its folder, with `-p encore2` after `docker compose`
([A second bridge](#a-second-bridge)). Update both bridges together.

#### Update a bridge you built yourself

If you built the bridge from the source ([Build it yourself](#build-it-yourself)), the **Updates** section shows these
commands instead, with the versions filled in. Run them in the folder that holds your current `Encore-<old>` folder
(`<new>` is the new version, `<old>` is yours):

```sh
curl -fLO https://github.com/mbucc9000/encore/releases/download/v<new>/Encore-<new>-source.tar.gz &&
tar xzf Encore-<new>-source.tar.gz &&
(cd Encore-<old>/gateway && docker compose down) &&
cd Encore-<new>/gateway &&
sudo cp -rp ../../Encore-<old>/gateway/data . &&
sudo cp -p ../../Encore-<old>/gateway/engine/state.json engine/
```

This unpacks the new version, stops the old bridge, and copies your `data/` folder (pairings, sign-ins, admin password,
Client ID, Jam access, caches) and the engine's sign-in into the new `gateway` folder. The copies need `sudo` because
those files belong to root. Then, in the new `gateway` folder:

1. If you made a `.env`, copy it too: `sudo cp -p ../../Encore-<old>/gateway/.env .`
2. If you changed `engine/config.yml` or `compose.yaml`, make the same changes in the new files. Don't copy the old ones
   over them.
3. Build and start the new version:

   ```sh
   docker compose up -d --build
   ```

4. Once the new bridge plays, delete the old folder with `sudo rm -rf Encore-<old>`.

**With a git clone,** run these lines instead (`<your clone>` is your clone's folder), then
`docker compose up -d --build`. If `git checkout` refuses because you changed `engine/config.yml` or `compose.yaml`, run
`git stash` first and `git stash pop` after.

```sh
cd <your clone>/gateway &&
git fetch --tags &&
git checkout v<new>
```

**A second bridge you built yourself:** use `docker compose -p encore2 down` and
`docker compose -p encore2 up -d --build`, copy its own `data/` and `engine/state.json`, and keep its `compose.yaml` and
`config.yml` changes ([A second bridge](#a-second-bridge)). Update both bridges together: they share image names.

#### Switch to the ready-made images

A bridge you built yourself can move to the ready-made images. Phones stay paired. `<old>` is your current
`Encore-<version>` folder:

1. Stop the old bridge: in `<old>/gateway`, run `docker compose down`.
2. Make the new folder, copy your data into it, and download the compose file:

   ```sh
   mkdir ~/encore && cd ~/encore
   sudo cp -rp <old>/gateway/data <old>/gateway/engine .
   curl -fL -o compose.yaml https://github.com/mbucc9000/encore/releases/latest/download/encore-docker-compose.yaml
   ```

3. If `<old>/gateway` has a `.env`, put the values you use into a `.env` in the new folder: the same names
   ([The .env file](#the-env-file)). If you switched the engine to avahi, remove the `# ` in front of the dbus line in
   the new `compose.yaml` too ([Engine settings](#engine-settings)).
4. Start it with `docker compose up -d`. Once it plays, delete the old folder with `sudo rm -rf <old>`.

**Linux without Docker:** stop the bridge, replace its files with the new `gateway/src`, keep your data folder
(`DATA_DIR`), and start it again.

### Update the app

After the bridge is updated, open Cydia → **Changes** → **Refresh** and install the Encore update. If you installed the
app another way, install the new `.deb` the same way ([Other ways to install the app](#other-ways-to-install-the-app)).
Your settings, pairing and caches stay.

### Turn the update check off

Set `UPDATE_CHECK=0` ([Bridge settings](#bridge-settings)). Windows: tray menu → **Troubleshooting → Edit settings…**,
add the line `UPDATE_CHECK=0` (or change a `#UPDATE_CHECK=1` line to it) and save; no restart is needed. Docker: put it
into `.env` in your Encore folder ([The .env file](#the-env-file)), then run `docker compose up -d` there. **Check for
updates** and **Check now** still work when you choose them.

### Which versions work together

The app and the bridge share one version number. Keep them on the same version.

| Encore app | Encore Bridge | Engine |
|---|---|---|
| 1.1.x | 1.1.x | go-librespot 4dbc099 + Encore patches 1–6 (built with the bridge) |

The engine always comes with the bridge: bundled on Windows, as the `encore-engine` image of the same version on Docker
(`ENCORE_TAG` picks it for both images), or built with it from the same source. Where a feature needs a newer bridge,
the app says **Update your Encore Bridge.**

---

## 13. Back up, move, or add a second bridge

One bridge plays one Spotify account. Several phones can pair with it, and they all use that account.

### Back up the bridge

Back up the files in [Where the bridge keeps its data](#where-the-bridge-keeps-its-data). You can skip `data/cache/`,
`data/diag/`, `pipe/` (Docker) and `logs\` (Windows). On Docker most of them can be read only by root, so back them up
with `sudo`, in your Encore folder (the `gateway` folder when you build it yourself; leave `.env` out if you didn't
make one):

```sh
sudo tar czf ~/encore-backup.tgz --exclude=data/cache --exclude=data/diag .env data engine/state.json engine/config.yml
```

To restore, stop the bridge and run `sudo tar xzpf ~/encore-backup.tgz` in the new folder. If you changed
`compose.yaml`, keep a copy of it too.

> **Treat a backup like a password.** It contains your Spotify sign-ins and your phones' keys. Store it encrypted or
> somewhere only you can read.

### Move to a new machine

1. Stop the old bridge.
2. Install the new one ([Install](#1-install)), but **before its first start**, copy the backed-up files into place (on
   Docker with `sudo`).
3. Start it. Your phones stay paired. If the bridge's address changed, update **Home Address** in each phone's Settings
   and point your router's port forward at the new address ([Forward the port](#forward-the-port)). In a new home, set
   up the forward there and update the Away Address (the setup guide's step 8).

Between Docker and Windows, copy the engine's `state.json` but **not** its `config.yml`, and copy `.env`'s values into
`settings.env` (or the other way round), not the file itself. This move hasn't been tried on every combination yet, so
keep the old files until the new bridge plays. If the engine asks to sign in again, [sign it in](#sign-the-engine-in).

### A second bridge

For a second Spotify account (a family member), run a second bridge. On Docker:

1. Make a new folder with a copy of your `compose.yaml` (and `.env`, if you have one) and of the first bridge's
   `engine/config.yml`, without `engine/state.json`: `mkdir engine && sudo cp -p <first>/engine/config.yml engine/`
   (`<first>` is the first bridge's folder; the copy belongs to root, so edit it with `sudo`). If you built it
   yourself, copy the whole `gateway` folder instead, without `data/`, `pipe/` and `engine/state.json`.
2. In the copy, change everything that would collide with the first bridge:

   | Where | Change |
   |---|---|
   | `compose.yaml` | `container_name` of both services (for example `encore2-gateway`, `encore2-engine`), and `PORT` (for example `"8096"`) |
   | `compose.yaml` | `ENGINE_URL` to the second engine's port (for example `http://127.0.0.1:3679`) |
   | `engine/config.yml` | `server.port` to the same port (`3679`) and `device_name` (for example `Encore 2`) |
   | `.env` (if the folder has one) | Empty `SPOTIFY_CLIENT_ID`, so the second bridge's setup guide asks for the second person's Client ID (their own developer app, or yours with their account added under User Management) |

3. Start it with a different project name: `docker compose -p encore2 up -d` (built yourself:
   `docker compose -p encore2 up -d --build`; both stacks then build images with the same names, which is fine while
   both folders hold the same Encore version).
4. The second person opens `http://<your-bridge-address>:8096/admin`. Its setup guide walks them through the admin
   password (the setup code is in `docker compose -p encore2 logs gateway`), their own Client ID and Spotify account,
   the second engine (they pick **Encore 2**), and pairing their phone with `<your-bridge-address>:8096`.

Phones use the same app for both bridges. To listen away from home with the second bridge, also forward TCP 8096 to the
same computer, port 8096. This recipe hasn't been run end to end yet; if a step is missing, report it. On Windows, one
Encore Bridge runs per Windows user in this release.

---

## 14. Uninstalling

### Remove the app

1. In Encore: **Settings → Unpair This iPhone**. On the admin page, **Unpair** the phone too (that revokes its key).
2. Cydia → **Installed** → **Encore** → **Modify** → **Remove**, or as root: `dpkg -r com.mbucc9000.encore`
3. Optional: remove the Encore repo (Cydia → **Sources** → **Edit**, the red button next to it, **Delete**), unless you
   use other packages from it.
4. Optional: delete what the package leaves behind: `/var/mobile/Library/Preferences/com.mbucc9000.encore.plist`
   (settings), `/var/mobile/Library/Caches/com.mbucc9000.encore/` (cached lists and pictures) and, on some phones,
   `/var/mobile/Library/Encore/` (a fallback copy of the pairing). The pairing's Keychain item is harmless once the
   phone is unpaired.

### Remove the bridge

First disconnect your Spotify account on the admin page ([On Spotify's side](#on-spotifys-side)). Afterwards, remove the
port forward from your router if you added one.

**Docker:** in the folder with the bridge's `compose.yaml` (built yourself: its `gateway` folder), run
`docker compose down --rmi all`. That stops the containers and removes their images. Then delete the folder (including
`data/`, `engine/` and `pipe/`) with `sudo rm -rf <the folder>`. Its files belong to root.

**Windows installer:** **Settings → Apps → Installed apps → Encore Bridge → Uninstall.** It quits Encore Bridge, removes
its firewall rules and its Start with Windows entry, and asks **Also delete your Encore Bridge data?** Choose **Yes** to
delete `%LOCALAPPDATA%\Encore`, or **No** (the default) to keep it for a later reinstall.

**Portable zip:** in the tray, untick **Start with Windows**, then choose **Quit Encore Bridge**. Delete the program
folder and `%LOCALAPPDATA%\Encore`. In `wf.msc` → Inbound Rules, remove the **Node.js JavaScript Runtime** rules for
that folder's `node.exe`, and **Encore Bridge (phone)** if **Fix firewall…** made one.

### On Spotify's side

1. Admin page → Spotify account → **Disconnect** (before you remove the bridge).
2. <https://www.spotify.com/account/apps/>: remove your developer app's access.
3. <https://developer.spotify.com/dashboard>: delete the developer app if you don't need it any more.
4. The engine's saved sign-in disappears with the bridge's files. To be sure, use **Sign out everywhere** on your
   Spotify account page. That signs out **all** your devices.

---

## 15. Privacy: what stays home and what leaves

Encore has **no central server**. Nothing goes to Encore's authors, and there's no analytics or telemetry. The only
check for new versions goes to GitHub, and you can turn it off. **No music is ever saved:** the bridge keeps about 75
seconds of encoded audio **in memory**, so a phone that drops for a moment can pick up where it left off.

### What stays home

- **On the bridge:** your Spotify sign-ins, the paired phones and their keys, the admin password (only in a form that
  can't be turned back into the password), the Client ID, the setup guide's progress (no names, addresses or codes), Jam
  access, phone diagnostics, caches, the update check's last result and the log
  ([every file](#where-the-bridge-keeps-its-data)). On Linux the secret files are readable only by their owner; on
  Windows, `%LOCALAPPDATA%` is private to your Windows user.
- **On the phone:** settings (including the Home and Away addresses), the pairing key (in the Keychain), cached lists
  and pictures, pinned playlists and recent searches. **No audio** and **no Spotify password**.

### Where the bridge connects

| Destination | Why |
|---|---|
| Spotify (`api.spotify.com`, `accounts.spotify.com`, `spclient.wg.spotify.com`, `api-partner.spotify.com`, and the engine's own Spotify servers and audio servers) | Playback, your library, search, profiles, Jams |
| `open.spotify.com`, `open.spotifycdn.com` | Refreshing the identifiers the profile and people-search features need (public web-player files) |
| `spotify.link`, `spotify.app.link` | Expanding short Jam invite links |
| Spotify's image servers (`*.scdn.co`, `*.spotifycdn.com`) and, for some profile pictures, Facebook's image servers | Cover art, profile pictures, Spotify Codes |
| `lrclib.net` | Lyrics: it receives the song's name, first artist, album and length |
| `api.github.com`; for a new version also `github.com` and GitHub's download servers (`*.githubusercontent.com`) | **The update check:** at most once a day, and when you press **Check for updates** / **Check now**. It sends only `EncoreBridge/<version>`. For a new version it fetches the small signature files; only **Update now** (Windows) downloads the installer. On Windows the tray program makes these requests. `UPDATE_CHECK=0` turns the daily check off. |
| `api.ipify.org`, then `ipv4.icanhazip.com`, then `ifconfig.me` (one after another, only until one answers) | **Only when you press Find my public IP** in the setup guide's step 8: never in the background, at startup or while Showcase is on. The service sees your public IP, but not that the request comes from Encore Bridge (it carries a generic User-Agent). The bridge keeps the answer only in memory, for 30 seconds, and never writes it to disk or into its log. |

Docker itself downloads the ready-made images from GitHub's container registry (`ghcr.io`) at the first start and at
every `docker compose pull`, as it does for any image.

The Encore app only ever talks to **your** bridge. (Cydia talks to the Encore repo when it installs or updates Encore,
as it does with any repo.)

### Logs

- The bridge's log never contains passwords, tokens, search terms, song names, lyrics, people's or devices' names,
  phones' addresses, the Client ID or your public IP, in any mode. It logs ids, counts and error codes instead. A
  stream's line only says whether the phone was at home (your network or your VPN) or away.
- The network check never reads the name of your Wi-Fi network.
- On Windows the log also holds the engine's lines, after the bridge has removed names, sign-in codes and your Windows
  user folder from them.
- On Docker the engine keeps its own log (`docker compose logs engine`). It names the songs it plays and the devices it
  hands playback to, and shows part of your Spotify username. It stays on your machine unless you share it.

---

## 16. FAQ

- **Why do I need Premium?** The engine (like every Spotify Connect speaker) only plays for Premium accounts, and
  Spotify requires the owner of a developer app to have Premium.
- **Why do I have to make my own developer app?** Spotify's development mode allows only a handful of users per app, and
  a shared app would tie everyone to one person's account. Your own app takes five minutes.
- **Do I have to use the setup guide?** No. Everything also works by hand ([The Client ID](#the-client-id),
  [Admin page cards](#admin-page-cards), [Other ways to install the app](#other-ways-to-install-the-app),
  [Forward the port](#forward-the-port)). Close it with the ✕ whenever you like.
- **Does Encore download music or remove DRM?** No. Audio streams live from Spotify to your own phone, as with any
  Spotify Connect speaker. Nothing is saved to a file.
- **Is it safe?** Your sign-ins stay on your bridge, every phone request is signed, the admin page only answers your
  home network, and the code is open source. A port forward exposes only the signed phone API, but without a VPN the
  stream is plain HTTP ([What a port forward exposes](#what-a-port-forward-exposes)). Using private Spotify interfaces
  may break Spotify's terms ([Legal and disclaimer](#18-legal-and-disclaimer)).
- **Can my family use it?** Several phones can pair with one bridge, but they share one Spotify account and one player
  (one song at a time). For a second account, run a [second bridge](#a-second-bridge).
- **Does Spotify still work on my computer and other devices?** Yes. Encore is another Spotify Connect speaker.
  Whichever device you press Play on gets the music.
- **Spotify keeps "refusing to play". Why?** Spotify sometimes refuses audio keys to librespot-based players, for some
  accounts more than others. Encore pauses and backs off, but it can't fix this on its side.
- **Podcasts? iPad? iOS 7? Dark mode?** Not in this release.
- **Does it need a Mac?** No. You need a Mac or Linux build machine (with Theos) only to build the app from source.
- **Can the bridge run on a Raspberry Pi?** A Pi 4 or 5 with a 64-bit OS and Docker should work: the images are built
  for ARM64 too. It hasn't been tested on a real Pi yet.
- **Why not Docker Desktop on Windows or a Mac?** Its containers sit behind their own network: Spotify Connect discovery
  can't see them, and the admin page can't tell your home network from the internet. On Windows, use the Windows bridge.
- **Can I use Tailscale or WireGuard on the phone?** There are no versions for iOS 6 or iOS 5. Use a port forward, or
  the [built-in L2TP VPN](#your-iphones-built-in-vpn).

---

## 17. Building from source

Everything in a release can be built from this repository. [`BUILDING.md`](BUILDING.md) has the steps:

- **App:** Theos with the iOS 6.1 SDK, on Linux or macOS. From `app/`: `make package FINALPACKAGE=1`.
- **Bridge on Docker:** `docker compose up -d --build` in `gateway/` builds both images from source
  ([Build it yourself](#build-it-yourself)). GitHub builds the ready-made images from the same files for every release
  ([BUILDING.md](BUILDING.md#prebuilt-images)).
- **Windows bridge:** built on a Linux machine with Docker by `gateway/windows/build.sh`.
- **Tests:** `node --test` in `gateway/test` (Node 22; ffmpeg for some tests).
- **Release files:** `tools/release/release.py` builds and signs them ([BUILDING.md](BUILDING.md#release-signing)).

The engine is go-librespot at upstream commit `4dbc099` plus Encore's patches (`gateway/engine-src/ENCORE_PATCH.md`).

---

## 18. Legal and disclaimer

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

## 19. Credits and licenses

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

The full list of third-party components and their licenses is in [`THIRD-PARTY-NOTICES.md`](../THIRD-PARTY-NOTICES.md).
The Windows package also has a `licenses` folder with every license text.

Project page: [github.com/mbucc9000/encore](https://github.com/mbucc9000/encore).
