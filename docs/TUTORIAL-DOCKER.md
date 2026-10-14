# Encore with Docker

This sets up Encore on a Linux machine with Docker, up to the first song on your iPhone or iPod touch (about 15
minutes). Docker downloads the ready-made **Encore Bridge**; its **setup guide** in your browser does the rest.

> **Unofficial.** Encore is not made, endorsed or supported by Spotify. It needs Spotify Premium and your own free
> Spotify developer app. It uses private Spotify interfaces that can change or break at any time. Use it at your own
> risk (legal details in the [guide](GUIDE.md)).

## What you need

- A jailbroken iPhone or iPod touch with **Cydia**, on iOS 6 (iPhone 4, 4S or 5; iPod touch 4th or 5th generation) or
  iOS 5.0 to 5.1.1 (iPhone 3GS, 4 or 4S; iPod touch 3rd or 4th generation). Only the iPhone 5 on iOS 6 is tested.
- **Spotify Premium**.
- A 64-bit Linux machine that stays on (x86-64 or ARM64: a home server, a NAS, a Raspberry Pi 4 or 5 with a 64-bit
  OS) with **Docker Engine** and Compose. Not Docker Desktop; for Windows: [Encore on Windows](TUTORIAL-WINDOWS.md).
- The phone and that machine on the same home network, and a computer with a browser.
- To listen away from home: access to your router's settings.

## 1. Start Encore Bridge

1. Check Docker (put `sudo` in front of `docker` if your setup needs it): `docker compose version` must say v2 or
   newer, and `docker version --format '{{.Server.Arch}}'` must say `amd64` or `arm64` (`arm` is 32-bit and won't work).
2. Download the compose file into a new folder. Encore keeps its data there: run every `docker compose` command in it.

   ```sh
   mkdir ~/encore && cd ~/encore
   curl -fL -o compose.yaml https://github.com/mbucc9000/encore/releases/latest/download/encore-docker-compose.yaml
   ```

3. Only if `systemctl is-active avahi-daemon` says `active` (many NAS systems): run
   `echo ZEROCONF_BACKEND=avahi >> .env` and, in `compose.yaml`, remove the `# ` in front of the last line.
4. Run `docker compose up -d` (the first start downloads about 270 MB). `docker compose ps` should show
   `encore-gateway` and `encore-engine` **Up**. They start again by themselves after a reboot.
5. If the machine runs a firewall, let your home network reach TCP port 8095, for example
   `sudo ufw allow from 192.168.1.0/24 to any port 8095 proto tcp` (use your own network's range).

**Dockge or Portainer:** paste the compose file into a new stack named `encore` (and set `ZEROCONF_BACKEND=avahi` there
if step 3 applies). Portainer: change `./data`, `./engine` and `./pipe` to full paths, such as `/opt/encore/data`.

**Build it yourself** instead: get the source code, run `docker compose up -d --build` in its `gateway` folder, and
continue with part 2. See [Building Encore from source](BUILDING.md).

## 2. Follow the setup guide on a computer

Find the machine's address with `hostname -I` (usually the first `192.168.x.x` or `10.x.x.x`) and give it a fixed
address in your router (a "DHCP reservation"). On a computer at home, open `http://<that address>:8095/admin`: the
setup guide opens. Do what each step says; it ticks itself off when it's done. Steps 1 to 5 happen at the computer:

1. **Protect this page:** type the **setup code** from the bridge's log (the page shows the command; take the newest
   code), then choose an admin password. When the browser asks, type any user name and that password.
2. **Your Spotify developer app:** create it at the [Spotify developer dashboard](https://developer.spotify.com/dashboard) as shown and paste
   its **Client ID** (not the client secret).
3. **Connect your Spotify account:** press **Connect**, then **Agree**, with the same Premium account. The tab then
   can't load `127.0.0.1:8888`: that's expected. Copy its whole address, paste it and press **Use this address**.
4. **Sign in the Encore engine:** on a phone or computer on the same network, open Spotify (same account), play a
   song and pick **Encore** in the devices menu.
5. **Check your network:** both lines should show ✓.

## 3. On the phone

<!-- BEGIN SHARED: phone -->
Steps 6 to 9 happen on the phone (step 8 also on your router); step 10 is optional. Keep the setup guide open: it shows
what to type and ticks each step off. If it shows **Hidden (Showcase)**, untick **Showcase** at the top right.

**Step 6: Put Encore on your phone.** In Cydia, tap **Sources** → **Edit** → **Add**, type the Encore repo exactly,
`https://mbucc9000.github.io/slopkit/` (with `https://` and the `/` at the end), and tap **Add Source**. Tap the new
source → **All Packages** → **Encore** → **Install** → **Confirm**, then press **I've installed it** in the setup guide.
No icon? Respring. **Never run `uicache`**: it can hide your other sideloaded apps.

<!-- screenshot: p1-cydia-add-source.png — Cydia's Add Source box with the Encore repo's address typed in -->

**Step 7: Pair your phone.** Put the phone on your home Wi-Fi (not a guest network, not mobile data) and open Encore.
**Home:** the address the setup guide shows, with `:8095` (for example `192.168.1.20:8095`). **Away:** leave it empty.
**Code:** the six digits the setup guide shows. Tap **Connect**.

**Step 8: Listen away from home.** Optional: press **Skip for now** if you only listen at home. Otherwise follow the
setup guide: forward TCP port 8095 on your router, press **Find my public IP**, and type the address into Encore →
**Settings** → **Away Address**. Test on mobile data and do the **Is this safe?** check once. If your IP is shared or
not public (the setup guide warns you), use your iPhone's built-in VPN instead (see the VPN section of the
[guide](GUIDE.md)).

**Step 9: Play a song.** On the phone, tap **Search**, type a song and tap it under **Songs**.

<!-- screenshot: p5-phone-now-playing.png — Now Playing with a well-known song playing, Anonymous Mode on -->

**Step 10: Turn on Jam.** Optional: start a Jam in Spotify on another phone or computer with **Encore** as the speaker
and press **Check Jam access**, then **Finish**; or press **Skip Jam**. Encore is set up.

**If the phone side doesn't work:**

| What you see | What to do |
|---|---|
| Cydia can't add the repo | Check the address letter by letter, and that the phone is online. |
| **wrong or expired pairing code** | Type the code the setup guide shows now. |
| **Can't reach your Encore Bridge at either address.** | Join your home Wi-Fi. The Home address ends in `:8095`. |
| Lists stay empty, or **Encore's player is reconnecting…** | The engine isn't signed in: setup guide step 4. |
| Away, **Status: Offline** in Settings | Check the port forward. New public IP? Redo step 8's **Find my public IP**. |
<!-- END SHARED: phone -->

## 4. Done

- **Update:** when the admin page shows **Encore Bridge … is available**, run
  `docker compose pull && docker compose up -d` in your Encore folder (Dockge: **Update**; Portainer: **Update the
  stack** with **Re-pull image and redeploy**). Then update the app in Cydia: **Changes** → **Refresh**.
- **Uninstall:** run `docker compose down --rmi all` in your Encore folder, then delete the folder
  (`sudo rm -rf ~/encore`). On the phone, remove Encore in Cydia.
- **Everything else** (features, Jam, Anonymous Mode, the zeroconf settings, all messages): the [guide](GUIDE.md).

**If the computer side doesn't work:**

| What you see | What to do |
|---|---|
| `pull access denied` or `unauthorized` | Download `compose.yaml` again. After a new release, wait an hour. |
| `exec format error` or `no matching manifest` | This Docker is 32-bit: install a 64-bit OS and its Docker. |
| The admin page doesn't load | Check the address, `:8095`, `docker compose ps` and the firewall (part 1). |
| "Encore" isn't in Spotify's device list | Use the bridge's network (no guest Wi-Fi). Check part 1, step 3. |
