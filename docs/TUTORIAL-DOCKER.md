# Encore with Docker: from nothing to your first song

This tutorial sets Encore up on a Linux machine with Docker, until a song plays on your iPhone or iPod touch. You
build and start the **Encore Bridge** with one command, and its **setup guide** walks you through the rest in your
browser, ticking each step off by itself. It takes about 20 minutes, plus a few minutes for the first build.

> **Unofficial.** Encore is not made, endorsed or supported by Spotify. It needs Spotify Premium, and it uses some
> private Spotify interfaces that can change or break at any time. Use it at your own risk
> ([Legal and disclaimer](GUIDE.md#25-legal-and-disclaimer)).

**You need:**

- a jailbroken iPhone or iPod touch on iOS 6, **with Cydia** (iPhone 5, 4S or 4, iPod touch 5th or 4th generation);
- **Spotify Premium**;
- a **64-bit Linux machine with Docker Engine** that stays on: a home server, a NAS that runs Docker containers, or a
  spare PC (not Docker Desktop on Windows or macOS: on a Windows PC, follow [Encore on Windows](TUTORIAL-WINDOWS.md));
- your **home Wi-Fi**, with the phone and that machine on the same home network;
- a computer with a web browser, for the setup guide;
- for listening away from home: access to your **router's settings** (port forwarding).

Every step below says what to **do**, what **you should see**, and the **common mistake** at that step. `192.168.1.20`
is an example address; yours will be different. Commands that start with `docker` may need `sudo` in front, depending
on how Docker is set up on your machine.

## Contents

1. [Start Encore Bridge](#1-start-encore-bridge)
2. [Open the setup guide](#2-open-the-setup-guide)
3. [Follow the setup guide](#3-follow-the-setup-guide)
4. [On the phone](#4-on-the-phone)
5. [What next](#5-what-next)

---

## 1. Start Encore Bridge

### 1.1 Check Docker

**Do:** install Docker Engine and its Compose plugin for your system (see <https://docs.docker.com/engine/install/>;
many NAS systems have Docker built in or as an app), then run:

```sh
docker compose version
```

**You should see:** `Docker Compose version v2.24` or newer.

> **Common mistake:** an older Docker Compose. Encore's `compose.yaml` needs 2.24 or newer; an older one stops with an
> error that mentions `env_file`. Update Docker (or its Compose plugin) first.

### 1.2 Get the Encore source

**Do:** download the source archive `Encore-<version>-source.tar.gz` and `SHA256SUMS.txt` from the Encore release page
into one folder, check the archive, unpack it, and go into its bridge folder:

```sh
sha256sum -c --ignore-missing SHA256SUMS.txt
tar xzf Encore-<version>-source.tar.gz
cd Encore-<version>/gateway
```

The release page: [github.com/mbucc9000/encore/releases](https://github.com/mbucc9000/encore/releases/latest)

**You should see:** `Encore-<version>-source.tar.gz: OK`, and then `ls` lists, among others, `compose.yaml`,
`Dockerfile`, `engine`, `engine-src` and `src`.

> **Common mistake:** running the next commands from the wrong folder. Every `docker compose` command in this tutorial
> runs inside the `gateway` folder, next to `compose.yaml`.

To check that `SHA256SUMS.txt` itself is Encore's, see the guide's [Checking a download](GUIDE.md#checking-a-download).

### 1.3 Check for avahi-daemon

Spotify finds the **Encore** speaker on your network through "zeroconf" discovery. If your machine already runs
**avahi-daemon** (many NAS systems and desktop Linux systems do), the engine has to share it.

**Do:**

```sh
systemctl is-active avahi-daemon
```

- If it says **`inactive`** (or the command doesn't exist): nothing to change.
- If it says **`active`**:
  1. In `engine/config.yml`, change `zeroconf_backend: builtin` to `zeroconf_backend: avahi`.
  2. In `compose.yaml`, under the `engine` service's `volumes:`, remove the `# ` in front of the line
     `- /run/dbus/system_bus_socket:/run/dbus/system_bus_socket`, keeping its indentation.

**You should see:** nothing yet. This pays off in the setup guide's step 4, when "Encore" appears in Spotify's device
list.

> **Common mistake:** skipping this on a machine that runs avahi-daemon. Everything else works, but "Encore" never shows
> up in Spotify's device list, so the engine can't sign in.

### 1.4 Build and start it

You don't need a settings file: the setup guide asks for everything.

**Do:**

```sh
docker compose up -d --build
docker compose ps
```

The first time, this downloads the base images and compiles the engine. It takes a few minutes. Later starts take
seconds, and both containers start again by themselves when the machine reboots.

**You should see:** `encore-gateway` and `encore-engine`, both **running** (`Up`).

> **Common mistake:** a build that stops with an error on a 32-bit system or a machine without internet access. The
> build needs a 64-bit system and downloads from the internet. Read the first error line, fix that, and run the same
> command again.

---

## 2. Open the setup guide

### 2.1 Find the machine's address and open the port

**Do:**

1. Find the machine's address on your home network:

   ```sh
   hostname -I
   ```

   The first address that looks like `192.168.x.x` or `10.x.x.x` is usually the one. Your router's list of connected
   devices shows it too.
2. In your router, give this machine a **fixed address** (often called a "DHCP reservation"). Your phone uses that
   address, so it shouldn't change next month.
3. If the machine runs a firewall, let your home network reach TCP port 8095. With ufw, for example (use your own
   network's range):

   ```sh
   sudo ufw allow from 192.168.1.0/24 to any port 8095 proto tcp
   ```

**You should see:** on another computer at home, `http://<your-bridge-address>:8095/` opens a short text page that
starts with **Encore gateway**.

> **Common mistake:** forwarding port 8095 on your router now, "just to be sure". Not yet: a port forward is for
> listening away from home, and the setup guide's step 8, **Listen away from home**, walks you through it once your
> phone is paired.

### 2.2 Get the setup code

Until you choose an admin password, the bridge prints a one-time **setup code** in its log, a new one at every start.

**Do:** in the `gateway` folder:

```sh
docker compose logs gateway | grep "setup code" | tail -n 1
```

**You should see:** a line that ends with `… with the setup code ABCD-EFGH-JKMN (a new code at every start; or set
ADMIN_PASSWORD)`. Your code is different. Keep it for step 1 of the setup guide.

### 2.3 Open the admin page

**Do:** on a computer on your home network, open `http://<your-bridge-address>:8095/admin` in a browser.

**You should see:** the setup guide, at **Step 1 of 9**, **Protect this page**, with a box for the setup code.

> **Common mistake:** opening it from outside your home network. From mobile data or a guest Wi-Fi the page usually
> doesn't load at all, and from the internet (through a port forward on your router) it answers **Not from this
> address.** Open it from a computer on your home network.

---

## 3. Follow the setup guide

The setup guide has nine steps, listed beside it (behind **All steps** in a narrow window). Each step ticks itself off
(✓) once it's done. Every step has **Back** and **Next**, and most have **Skip for now**: a skipped step stays in the
list, and you can go back to it at any time.

Steps 1 to 5 happen at the computer. Steps 6 to 9 happen on the phone ([part 4](#4-on-the-phone)); step 8 also on
your router.

Closed the setup guide? Open the admin page again: until setup is finished, a banner offers **Continue setup**, and the
**Setup guide** button at the top opens it at any time.

### Step 1: Protect this page

The admin page controls your bridge, so it gets a password first.

**Do:** type the setup code from 2.2 into the **Setup code** box, then a new password into both password boxes (at least
8 characters), and press **Save password**. Your browser then asks you to sign in: type **any** user name, and your new
password.

**You should see:** step 2, **Your Spotify developer app**.

> **Common mistake:** an old setup code. The bridge prints a **new** code every time it starts, so take the last one in
> the log. Otherwise the page says **That isn't the setup code from the bridge's log.**

Use a long password that you use nowhere else: everyone on your home network, guests included, can reach this sign-in.

### Step 2: Your Spotify developer app

Encore reads your playlists, library and search results through Spotify's Web API, and Spotify only allows that
through a free "developer app" of your own. The bridge needs one thing from it: its **Client ID**.

**Do:** follow the four steps on the page. A **Copy** button sits next to every value you need to type.

1. Press **Open the Spotify developer dashboard** and log in with the Spotify **Premium** account you'll use with
   Encore. If Spotify asks you to accept its Developer Terms or confirm your e-mail address, do that.
2. Press **Create app** and fill in: App name `Encore`, App description `My iOS 6 player`, Website empty, Redirect URI
   `http://127.0.0.1:8888/callback` (then press **Add**). Tick **Web API**, accept the terms and press **Save**.
3. In your app's **Settings → User Management**, add your Spotify account's name and e-mail address.
4. In **Settings → Basic Information**, copy the **Client ID**, paste it into the box in the setup guide, and press
   **Save Client ID**.

<!-- screenshot: w1-setup-developer-app.png — the setup guide at step 2, Your Spotify developer app: the checklist with its Copy buttons and the empty Client ID box -->

**You should see:** **✓ Client ID saved**, with the last four characters of your Client ID. The bridge keeps it in its
`data` folder and uses it at once; no restart needed.

> **Common mistake:** a Redirect URI that is *almost* right. It must match character for character: `http` (not
> `https`), `127.0.0.1` (not `localhost`), port `8888`, path `/callback`, no slash at the end. And press **Add** before
> **Save**: typing it into the box isn't enough.

Copy the **Client ID**, not the **client secret** under it: the secret looks just like an ID (32 letters and digits),
so the setup guide accepts it, and step 3 then fails with **INVALID_CLIENT: Invalid client**. If that happens, come
back to step 2, press **Change** and paste the Client ID. (**That isn't a Client ID…** means what you pasted isn't 32
letters and digits at all: often only part of the ID. If you put a Client ID into a `.env` file yourself, this step says it
comes from the bridge's environment, and you change it there.)

### Step 3: Connect your Spotify account

This lets the bridge read your playlists, library and search results through your developer app.

**Do:**

1. Press **Connect**. Spotify opens in a new tab: log in with the **same Premium account** as in step 2, and press
   **Agree**.
2. The tab then shows an error page, such as "This site can't be reached", at `127.0.0.1:8888`. **That's expected.**
   Copy that tab's **whole address** from the address bar (it starts with `http://127.0.0.1:8888/callback?code=`).
3. Back in the setup guide, paste it into the box and press **Use this address**.

**You should see:** **✓ Connected**.

> **Common mistake:** pasting only part of the address, or an address from an older attempt. The setup guide then says
> **paste the whole address from the browser (it starts with http://127.0.0.1:8888/callback)** or **that login link is
> old or from another tab; press Connect again**. Press **Connect** again and copy the whole address from the new tab.

If Spotify shows **INVALID_CLIENT: Invalid redirect URI**, the Redirect URI in your developer app isn't exact: fix it
there (step 2), press **Save**, then **Connect** again. **INVALID_CLIENT: Invalid client** means the Client ID saved in
step 2 is wrong (usually the client secret): step 2 → **Change**, paste the Client ID.

### Step 4: Sign in the Encore engine

The engine is Encore's player, a Spotify Connect speaker called **Encore**. It signs in to Spotify on its own, once,
and remembers it.

**Do:**

1. On a phone, tablet or computer **on the same home network**, open the normal Spotify app, signed in to the same
   account as in step 3.
2. Play any song, open the devices menu (the speaker icon), and pick **Encore**.
3. Wait a few seconds. You can switch Spotify back to your own device afterwards.

**You should see:** **✓ Signed in. "Encore" shows up as a speaker in your Spotify apps.**

> **Common mistake:** "Encore" isn't in Spotify's device list. The device running Spotify must be on the same network as
> the bridge (not a guest Wi-Fi), and a machine that runs avahi-daemon needs 1.3. If discovery can't work on your
> network, the engine can sign in with a code instead: see
> [Sign the engine in to Spotify](GUIDE.md#8-sign-the-engine-in-to-spotify).

Use the same Spotify account for the engine as in step 3; the step warns you if they differ.

### Step 5: Check your network

**Do:** look at what the step shows: this machine's address on your home network (if it has several, the one Encore
chose comes first), and **Encore Bridge is listening on port 8095**.

**You should see:** the address (for example `192.168.1.20`) and the listening line, both with ✓, and a reminder that
your phone must be on the same network as this computer: the same Wi-Fi, not a guest network.

> **Common mistake:** a firewall on the machine that keeps the phone out. The step can't see it: if you skipped 2.1's
> firewall rule, add it now.

---

## 4. On the phone

<!-- BEGIN SHARED: phone -->
Take the phone, and keep the setup guide open on the computer. The last four steps happen on the phone (step 8 also on
your router), and the setup guide ticks them off as soon as your bridge sees them.

If the setup guide says **Hidden (Showcase)** where an address belongs, or hides your public IP, untick **Showcase** at
the top right of the page while you set the phone up.

### Setup guide step 6: Put Encore on your phone

Encore comes from the **Encore repo**, a Cydia repo on the internet. You add it to Cydia once; Cydia then installs
Encore from it, and later its updates. The setup guide's step 6 shows the repo's address with a **Copy** button:
`https://mbucc9000.github.io/slopkit/`

**Do:**

1. On the phone, open **Cydia**, tap **Sources**, then **Edit**, then **Add**.
2. Type the address exactly, with `https://` and the `/` at the end: `https://mbucc9000.github.io/slopkit/`. Tap
   **Add Source**.
3. When Cydia has loaded it, tap the new source in your list of sources, then **All Packages**, then **Encore**. Tap
   **Install**, then **Confirm**.
4. When Cydia is done, tap **Return to Cydia** and press the Home button.
5. In the setup guide, press **I've installed it**.

<!-- screenshot: p1-cydia-add-source.png — Cydia's Add Source box with the Encore repo's address https://mbucc9000.github.io/slopkit/ typed in -->

<!-- screenshot: p2-cydia-encore.png — the Encore package page in Cydia, under the Encore repo, before Install -->

**You should see:** the **Encore** icon on your home screen. (The bridge can't see Cydia, so step 6 gets its ✓ when
your phone pairs in step 7.)

> **Common mistake:** running `uicache` yourself when the icon doesn't show up straight away. **Never run `uicache`**:
> it can make your other sideloaded apps disappear from the home screen. Respring instead (from your jailbreak tool's
> menu, or with `killall SpringBoard`).

If Cydia can't add the repo, check the address letter by letter (`https://`, and the `/` at the end) and that the phone
is online: this step works on any Wi-Fi and on mobile data. If it still fails, install the Encore `.deb` from the
release page another way ([other ways to install the app](GUIDE.md#93-other-ways-to-install-the-app)), then press
**I've installed it**.

Updates come from the same repo: open Cydia, tap **Changes**, then **Refresh**, and install the Encore update. Keep
Encore and Encore Bridge on the same version: update the bridge first.

### Setup guide step 7: Pair your phone

Pairing gives your phone its own key for your bridge. It only works at home, on your home Wi-Fi.

**Do:**

1. On the phone, open **Settings → Wi-Fi** and join the **same Wi-Fi** as the bridge's computer: your home network, not
   a guest network, and not mobile data.
2. Open **Encore**. Its setup screen has three fields: **Home**, **Away** and **Code**.
3. **Home:** type the address the setup guide shows in step 7, for example `192.168.1.20:8095`. You can leave out
   `http://`, but not the `:8095`.
4. **Away:** leave it empty for now: the next step finds that address.
5. **Code:** type the six digits the setup guide shows, then tap **Connect**.

<!-- screenshot: w2-setup-pair.png — the setup guide at step 7, Pair your phone, with Showcase on: the address reads Hidden (Showcase) and the code shows as dots -->

<!-- screenshot: p3-phone-setup.png — Encore's setup screen with the Home, Away and Code fields, Anonymous Mode on -->

**You should see:** **Pairing…**, then a check mark and **Connected**, and Encore opens on its **Home** tab. The setup
guide says **✓ Your phone is paired.**

> **Common mistake:** typing a code that has run out. A code works once, for 5 minutes. The setup guide shows a new one
> by itself when the old one runs out while the page is on screen (up to three times in a row), and **New code** makes
> one at once. If the phone says **wrong or expired pairing
> code**, type the code that's on the screen now. If it says **Can't reach your Encore Bridge at either address.**,
> check the Home address and its `:8095`, and that the phone is on your home Wi-Fi.

### Setup guide step 8: Listen away from home

This step lets Encore play away from home: on mobile data, or on someone else's Wi-Fi. For that, your router has to
pass Encore's port, **TCP 8095**, on to the bridge's computer. This is called **port forwarding**, and you set it up
once, in your router's settings. The setup guide shows every value you need, and finds the address you type into
Encore. Only listening at home? Press **Skip for now**; you can come back at any time.

**Do:**

1. **Forward the port.** Open your router's admin page in a browser and sign in (its address and password are often
   printed on the router itself; its address is also the bridge computer's **default gateway**: on Windows, run
   `ipconfig` and use the **Default Gateway**; on Linux, run `ip route` and use the address after `default via`). Find
   **Port forwarding** (some routers call it **Virtual server**, **NAT** or **Applications & gaming**) and add one
   rule:

   | Router setting | Value |
   |---|---|
   | Protocol | `TCP` |
   | External port | `8095` |
   | Forward to (internal address) | the address the setup guide shows in step 8, for example `192.168.1.20` |
   | Internal port | `8095` |

   Save it. Forward this one port only, never anything else. If the bridge's computer has a firewall of its own, it
   must let TCP 8095 in from anywhere, not only from your home network (Windows: the installer's rule already does;
   Docker: see the note after step 9).
2. **Keep that address.** In the router, look for **DHCP reservation** (or **Address reservation**, **Static lease**)
   and reserve the address the setup guide shows for the bridge's computer, so the rule keeps pointing at it.
3. **Find your Away address.** In the setup guide, press **Find my public IP**. After a few seconds it says **Your Away
   address:** with an address such as `http://203.0.113.7:8095` (yours is different), and a **Copy** button.
4. **Type it into Encore.** On the phone, open Encore → **Settings** → **Away Address**, type that address and tap
   **Save**.
5. **Test it.** Turn the phone's Wi-Fi off, so it uses mobile data, then open Encore → **Settings**. (An iPod touch
   has no mobile data: join another Wi-Fi instead, for example your phone's hotspot.) Testing on your home Wi-Fi
   proves nothing: many routers can't reach their own public IP from inside.

<!-- screenshot: w3-setup-away.png — the setup guide at step 8, Listen away from home, with Showcase on: the internal address reads Hidden (Showcase) and the public IP section shows its Showcase line -->

<!-- screenshot: p4-phone-away.png — Encore's Settings with Status Away, Anonymous Mode on: the addresses read Hidden -->

**You should see:** **Status: Away** with a delay, for example **Away · 88 ms**, and the setup guide says **✓ Your phone
reached Encore Bridge from outside your home network.** Turn Wi-Fi back on afterwards: at home, Encore uses the Home
address again by itself.

> **Common mistake:** a port forward that can't work, because your internet provider shares one public IP between many
> homes (carrier-grade NAT, "CGNAT"), or another router sits in front of yours. The setup guide warns you when the IP
> it finds is such a shared or non-public address. To check by hand, find your router's **Internet** (WAN) address in
> its admin page. If it isn't the IP the setup guide found and the bridge's computer runs a VPN app, turn the VPN app
> off and press **Check again** (the IP-check service saw the VPN's address). If it still isn't the IP the setup guide
> found, or it starts with 10., 100.64 to 100.127, 172.16 to 172.31 or 192.168., a forward can't reach your home:
> remove it, and ask your provider for a public IPv4 address. The guide's
> [Carrier-grade NAT and double NAT](GUIDE.md#carrier-grade-nat-and-double-nat) has the details and the other ways.

If Encore shows the addresses as **Hidden** and won't let you edit them, Anonymous Mode is on: turn it off in
**Settings → Privacy** while you type the Away Address.

Your home's public IP can change, for example when the router restarts. If Encore stops connecting away from home,
open the setup guide's step 8 again (the admin page's **Listen away from home** button), press **Find my public IP**
and update the Away Address. A dynamic DNS name (many routers offer one) avoids this
([more in the guide](GUIDE.md#when-your-public-ip-changes)).

**Is this safe?** Only Encore's phone connection is reachable from the internet, and every request from a phone must be
signed with the key it got when you paired it. The admin page and pairing still answer only on your home network, even
with the port open. Use a strong admin password (step 1), unpair a lost phone on the admin page right away, and forward
only port 8095. The music itself travels unencrypted (plain HTTP). Check it once, from outside your home network: in
Safari, open your Away address with `/admin` at the end. It must say **Not from this address.** If it asks for a
password instead, your router hides where connections come from: remove the port forward and use a VPN instead
([the guide's 11.3](GUIDE.md#113-alternative-your-iphones-built-in-vpn)).

### Setup guide step 9: Play a song

**Do:** on the phone, tap **Search**, type the name of a song you like, and tap the song under **Songs**.

**You should see:** after a moment, the music plays from the phone. A mini player appears above the tabs; tap it to
open **Now Playing**. The setup guide says **✓ Music is playing on your phone.** Press **Finish** there: the **Setup
complete** page lists every step, and **Open the admin page** takes you to the bridge's admin page. If you skipped
step 8, the page reminds you that without a port forward (or a VPN), Encore plays only on your home Wi-Fi.

<!-- screenshot: p5-phone-now-playing.png — Now Playing with a well-known song playing, Anonymous Mode on -->

<!-- screenshot: w4-setup-complete.png — the setup guide's Setup complete page, every step ticked, Showcase on -->

> **Common mistake:** lists stay empty, or Encore says **Encore's player is reconnecting to Spotify. Try again in a
> moment.** for more than a minute. The engine isn't signed in yet: go back to the setup guide's step 4, **Sign in the
> Encore engine**.

**That's it: Encore works.** The rest is optional.
<!-- END SHARED: phone -->

**Step 8 with Docker.** The bridge uses the machine's own network (host networking), so the router's forward points at
the machine's address, the one step 8 shows. If the machine runs a firewall, the rule from 2.1 only lets your home
network in: for the port forward, allow TCP 8095 from anywhere, for example `sudo ufw allow 8095/tcp` (firewalld:
`sudo firewall-cmd --permanent --add-port=8095/tcp`, then `sudo firewall-cmd --reload`). Keep the bridge updated.

---

## 5. What next

- **A short tour:** the guide's [Feature tour](GUIDE.md#13-feature-tour) shows the five tabs, Now Playing's gestures,
  lyrics and Up Next, and [Jam with friends](GUIDE.md#14-jam-with-friends) how to share a queue with friends.
- **Showing Encore off** (screenshots, demo videos): turn on **Anonymous Mode** in the app (**Settings → Privacy**),
  and **Showcase** at the top right of the admin page. See
  [Anonymous Mode and Showcase](GUIDE.md#12-anonymous-mode-and-showcase).
- **Updating:** the bridge looks for a new version once a day (it never updates itself on Docker). When one is out, the
  admin page shows **Encore Bridge … is available**, and its **Updates** section shows the commands to run, with the
  new version and the archive's checked checksum filled in and a **Copy** button for each block. They download and
  check the new source archive, move your `data` folder (it holds your Client ID, pairings and sign-ins) and the
  engine's sign-in over, and run `docker compose up -d --build`; [Updating](GUIDE.md#bridge-on-docker) explains every
  line, and how to turn the daily check off. Then on the phone open Cydia, tap **Changes**, then **Refresh**, and
  install the Encore update from the Encore repo.
- **Reopening the setup guide** (to check a step, change your Client ID, or find your public IP again): the **Setup
  guide** button at the top of the admin page. The **Phone setup** card's **Listen away from home** button opens
  step 8 directly.
- **More about listening away from home:** a changing public IP, dynamic DNS, what a port forward exposes, and your
  iPhone's built-in VPN as the alternative are in [Listening away from home](GUIDE.md#11-listening-away-from-home).

### It doesn't work

Find what you see in the left column. The guide's [Troubleshooting](GUIDE.md#17-troubleshooting) chapter covers every
message.

| What you see | What to do |
|---|---|
| `docker compose` stops with an error that mentions `env_file` | Docker Compose is older than 2.24: update it (1.1). |
| The admin page doesn't load | Check the address and the `:8095`, that `docker compose ps` shows both containers **Up**, and the firewall (2.1). |
| **That isn't the setup code from the bridge's log.** | Take the newest code: `docker compose logs gateway \| grep "setup code" \| tail -n 1`. |
| Step 2: **That isn't a Client ID…** | Copy the **Client ID** from **Settings → Basic Information** in your developer app, not the client secret. |
| Spotify's page: **INVALID_CLIENT: Invalid redirect URI** | Set the Redirect URI in your developer app to exactly `http://127.0.0.1:8888/callback`, press **Add**, then **Save**. |
| Spotify's page: **INVALID_CLIENT: Invalid client** | The Client ID saved in step 2 is wrong, usually the client secret: step 2 → **Change**, paste the **Client ID**. |
| "Encore" missing from Spotify's device list | Same network as the bridge (no guest Wi-Fi), avahi-daemon (1.3), or [the sign-in with a code](GUIDE.md#8-sign-the-engine-in-to-spotify). |
| Phone: **Can't reach your Encore Bridge at either address.** | The phone must be on your home Wi-Fi, the Home address must end in `:8095`, and the machine's firewall must allow TCP 8095 (2.1). |
| Phone: **wrong or expired pairing code** | Type the code the setup guide shows now, straight away. |
| Cydia can't add the Encore repo | Type `https://mbucc9000.github.io/slopkit/` exactly, with `https://` and the `/` at the end, and check that the phone is online. |
| Step 8: **Couldn't find your public IP…** | The machine couldn't reach an IP-check service. Check that it's online and press **Find my public IP** again, or read the Internet (WAN) address in your router's admin page. |
| Step 8: **This IP (100.64 to 100.127) is a shared address…** or **This isn't a public IP…** | Your provider shares its public IP (CGNAT), or another router sits in front of yours: see [Carrier-grade NAT and double NAT](GUIDE.md#carrier-grade-nat-and-double-nat). |
| Away from home, Settings says **Status: Offline** | Check the router's forward (TCP 8095 to the address step 8 shows), the machine's firewall (TCP 8095 allowed from anywhere), and that your public IP hasn't changed (**Find my public IP**). Test on mobile data, not your home Wi-Fi. More in [Troubleshooting](GUIDE.md#172-connection). |
| Lists stay empty, or **Encore's player is reconnecting to Spotify. Try again in a moment.** | The engine isn't signed in: setup guide step 4. |
| The browser keeps asking for the admin password | Any user name works; only the password counts. To reset it, see [the admin page and your admin password](GUIDE.md#7-the-admin-page-and-your-admin-password). |

Enjoy the music.
