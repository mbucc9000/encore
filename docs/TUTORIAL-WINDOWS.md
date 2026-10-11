# Encore on Windows: from nothing to your first song

This tutorial sets Encore up on a Windows PC, until a song plays on your iPhone or iPod touch. You install the
**Encore Bridge**, and its **setup guide** walks you through the rest in your browser, ticking each step off by itself.
It takes about 20 minutes.

> **Unofficial.** Encore is not made, endorsed or supported by Spotify. It needs Spotify Premium, and it uses some
> private Spotify interfaces that can change or break at any time. Use it at your own risk
> ([Legal and disclaimer](GUIDE.md#25-legal-and-disclaimer)).

**You need:**

- a jailbroken iPhone or iPod touch on iOS 6, **with Cydia** (iPhone 5, 4S or 4, iPod touch 5th or 4th generation);
- **Spotify Premium**;
- a **Windows 10 or 11 PC** (64-bit) that stays on while you listen;
- your **home Wi-Fi**, with the phone and the PC on it;
- for listening away from home: access to your **router's settings** (port forwarding).

Every step below says what to **do**, what **you should see**, and the **common mistake** at that step. `192.168.1.20`
is an example address; yours will be different.

## Contents

1. [Install Encore Bridge](#1-install-encore-bridge)
2. [Follow the setup guide on the PC](#2-follow-the-setup-guide-on-the-pc)
3. [On the phone](#3-on-the-phone)
4. [What next](#4-what-next)

---

## 1. Install Encore Bridge

### 1.1 Download the installer

**Do:**

1. From the Encore release page, download `EncoreBridge-<version>-setup.exe` and `SHA256SUMS.txt`, the list of
   checksums.
2. Check your download. In PowerShell, in your Downloads folder:

   ```powershell
   Get-FileHash .\EncoreBridge-<version>-setup.exe -Algorithm SHA256
   ```

The release page: [github.com/mbucc9000/encore/releases](https://github.com/mbucc9000/encore/releases/latest)

**You should see:** a long number that matches the line for the same file in `SHA256SUMS.txt` (open it with Notepad;
upper or lower case doesn't matter).

> **Common mistake:** running a file that doesn't match, or one you got from somewhere other than the release page. If
> the numbers differ, delete the file and download it again.

To check that `SHA256SUMS.txt` itself is Encore's, see the guide's [Checking a download](GUIDE.md#checking-a-download).
You only download and check by hand this once: later, Encore Bridge updates itself when you tell it to (part 4).

### 1.2 Run the installer

**Do:**

1. Start `EncoreBridge-<version>-setup.exe`. Encore's files aren't code-signed, so Windows may show a blue **Windows
   protected your PC** window: click **More info**, check that the file name is the one you downloaded, and click
   **Run anyway**. Then say **Yes** to the administrator prompt.
2. On **Select Additional Tasks**, leave **Start Encore Bridge when I sign in to Windows** ticked: your phone can only
   play while the bridge runs.
3. Press **Install**. On the last page, leave **Start Encore Bridge and open the setup guide** ticked and press
   **Finish**.

The installer asks nothing about Spotify: the setup guide does that, in its step 2.

**You should see:** the Encore icon (a black record on a green square) in the notification area near the clock (click
the **^** arrow there if it's hidden), and a few seconds later your browser opens the setup guide at **Step 1 of 9**,
**Protect this page**.

The installer also added a Windows Firewall rule, **Encore Bridge (phone)**, that lets phones reach the bridge on
**Private** and **Domain** networks only, never on Public ones.

> **Common mistake:** clicking **Don't run** on the SmartScreen window and thinking the file is broken. It isn't; it's
> just not signed. Only click **Run anyway** for a file whose checksum you checked in 1.1.

Prefer the portable zip (no administrator rights)? The guide's [portable zip](GUIDE.md#53b-or-use-the-portable-zip)
section shows how to start it. Then go on with part 2 here.

### 1.3 The tray icon

Encore Bridge has no window. It lives in the notification area next to the clock. Click its icon (or right-click it)
for its menu. The items you'll use most:

| Menu item | What it's for |
|---|---|
| The status line | What the bridge needs next, or **Streaming to 1 phone** |
| **Open Encore Bridge** | The admin page, in your browser |
| **Setup guide…** | The setup guide, whenever you want it again |
| **Showcase mode** | Hides names, addresses and codes on this PC's screens |
| **Start with Windows** | Starts the bridge when you sign in |
| **Check for updates** | Looks for a new Encore Bridge now (it also looks by itself once a day) |
| **Troubleshooting** | **Open log**, **Edit settings…**, **Fix firewall…**, **Restart bridge** and more |
| **Quit Encore Bridge** | Stops the bridge |

Keep the bridge running and **Start with Windows** ticked: your phone can only play while it runs.

---

## 2. Follow the setup guide on the PC

The setup guide is part of the bridge's admin page, in your browser at `http://127.0.0.1:8095/admin`. It has nine
steps, listed beside it (behind **All steps** in a narrow window). Each step ticks itself off (✓) once it's done.
Every step has **Back** and **Next**, and most have **Skip for now**: a skipped step stays in the list, and you can go
back to it at any time.

Steps 1 to 5 happen here, on the PC. Steps 6 to 9 happen on the phone ([part 3](#3-on-the-phone)); step 8 also on
your router.

Closed the setup guide, or it didn't open? Tray menu → **Setup guide…**.

### Step 1: Protect this page

The admin page controls your bridge, so it gets a password first.

**Do:** type a new password into both boxes (at least 8 characters) and press **Save password**. Your browser then asks
you to sign in: type **any** user name, and your new password.

On this PC no setup code is needed. (If the page asks for one, it was opened from another address: use **Open Encore
Bridge** or **Setup guide…** in the tray menu instead.)

**You should see:** step 2, **Your Spotify developer app**.

> **Common mistake:** a short password, or one you use elsewhere. Everyone on your home network, guests included, can
> reach this sign-in. Use a long password that you use nowhere else. (Only the password counts; the user name doesn't.)

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

**You should see:** **✓ Client ID saved**, with the last four characters of your Client ID.

> **Common mistake:** a Redirect URI that is *almost* right. It must match character for character: `http` (not
> `https`), `127.0.0.1` (not `localhost`), port `8888`, path `/callback`, no slash at the end. And press **Add** before
> **Save**: typing it into the box isn't enough.

Copy the **Client ID**, not the **client secret** under it: the secret looks just like an ID (32 letters and digits),
so the setup guide accepts it, and step 3 then fails with **INVALID_CLIENT: Invalid client**. If that happens, come
back to step 2, press **Change** and paste the Client ID. (**That isn't a Client ID…** means what you pasted isn't 32
letters and digits at all: often only part of the ID.)

### Step 3: Connect your Spotify account

This lets the bridge read your playlists, library and search results through your developer app.

**Do:** press **Connect**. Spotify opens in a new tab: log in with the **same Premium account** as in step 2, and press
**Agree**.

**You should see:** the new tab says **Spotify account connected** (you can close it), and the setup guide says
**✓ Connected**.

> **Common mistake:** Spotify shows **INVALID_CLIENT: Invalid redirect URI**. The Redirect URI in your developer app
> isn't exact: fix it there (step 2), press **Save**, then **Connect** again. **INVALID_CLIENT: Invalid client** means
> the Client ID saved in step 2 is wrong (usually the client secret): step 2 → **Change**, paste the Client ID. If the tab says **Not connected** and
> **Spotify refused this (GET /me: …)**, your account isn't on the app's **User Management** list yet: add it, then
> press **Connect** again.

### Step 4: Sign in the Encore engine

The engine is Encore's player. It signs in to Spotify on its own, once, and remembers it.

**Do:** the step shows a link and a short code.

1. On any device, open the link (<https://www.spotify.com/pair>).
2. Log in with the **same Spotify account** as in step 3.
3. If it asks for a code, type the code from the setup guide, and approve.

Codes work for a few minutes; a new one appears by itself when one runs out.

<!-- TODO(final): the Windows engine sign-in by code depends on test T2 (Spotify accepting the device-code sign-in).
     If R6 changes the default, rewrite this step. -->

**You should see:** **✓ Signed in. "Encore" shows up as a speaker in your Spotify apps.**

> **Common mistake:** signing the engine in with another Spotify account than in step 3, for example because the
> Spotify app on your phone uses a different one. The step then warns that the engine uses another Spotify account.
> Use one account for both.

### Step 5: Check your network

Your phone has to reach this PC over your home network. This step looks at four things for you, without changing
anything: this PC's address on your home network, whether **Encore Bridge is listening on port 8095**, the network
profile, and Windows Firewall.

**Do:** read the four lines. A line with ✗ says how to fix it. The two you're most likely to meet:

- **The network profile is Public:** open **Settings → Network & internet → Wi-Fi** (or **Ethernet**), click your
  network, and under **Network profile type** choose **Private network**.
- **Windows Firewall:** in the tray menu, choose **Troubleshooting → Fix firewall…**. It shows what it found and asks
  before it changes anything; then Windows asks for administrator permission.

Then press **Check again**.

**You should see:** four ✓, for example **This computer's address: 192.168.1.20** and **Network profile: Private**.

> **Common mistake:** setting the wrong network to Private, for example a VPN adapter instead of the Wi-Fi or Ethernet
> connection the PC uses at home. And never set a café or hotel network to Private.

Tip: in your router, give this PC a **fixed address** (often called a "DHCP reservation"). Your phone uses that address,
and so does the port forward of step 8, so it shouldn't change next month.

---

## 3. On the phone

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

**Step 8 on Windows.** Windows Firewall already lets the forwarded connections in: the installer's rule **Encore Bridge
(phone)** admits them while this PC's network is set to **Private** (step 5 checks it). Keep it that way only for your
home network. A port forward opens port 8095 of your everyday PC to the internet, so keep Windows updated, and keep
Encore Bridge updated too.

---

## 4. What next

- **A short tour:** the guide's [Feature tour](GUIDE.md#13-feature-tour) shows the five tabs, Now Playing's gestures,
  lyrics and Up Next, and [Jam with friends](GUIDE.md#14-jam-with-friends) how to share a queue with friends.
- **Showing Encore off** (screenshots, demo videos): turn on **Anonymous Mode** in the app (**Settings → Privacy**),
  and **Showcase** on the admin page (top right) or **Showcase mode** in the tray menu. See
  [Anonymous Mode and Showcase](GUIDE.md#12-anonymous-mode-and-showcase).
- **Updating:** Encore Bridge looks for a new version once a day. When one is out, the tray menu shows **Encore Bridge
  … is available**: choose **Update now…** and then **Yes**. It downloads the new installer, checks it against Encore's
  signed checksum list, and Windows asks for permission to install it: the prompt says the publisher is **Unknown**,
  because Encore isn't code-signed. Choose **Yes**. Your settings, sign-ins and paired phones stay. Then on the phone
  open Cydia, tap **Changes**, then **Refresh**, and install the Encore update from the Encore repo. See
  [Updating](GUIDE.md#18-updating), also for turning the daily check off.
- **Sleep:** with **Keep this PC awake while streaming** on (the default), the PC doesn't sleep while a phone listens.
  More in [Sleep, sign-out and laptops](GUIDE.md#57-sleep-sign-out-and-laptops).
- **Reopening the setup guide** (to check a step, change your Client ID, or find your public IP again): tray menu →
  **Setup guide…**, or the **Setup guide** button on the admin page. The **Phone setup** card's **Listen away from
  home** button opens step 8 directly.
- **More about listening away from home:** a changing public IP, dynamic DNS, what a port forward exposes, and your
  iPhone's built-in VPN as the alternative are in [Listening away from home](GUIDE.md#11-listening-away-from-home).

### It doesn't work

Find what you see in the left column. The guide's [Troubleshooting](GUIDE.md#17-troubleshooting) chapter covers every
message.

| What you see | What to do |
|---|---|
| No Encore icon near the clock | Click the **^** arrow near the clock. If it's not there, start **Encore Bridge** from the Start menu. |
| The setup guide didn't open | Tray menu → **Setup guide…** |
| The tray says **Port 8095 is in use** | Another program uses the port: see [Port already in use](GUIDE.md#511-port-already-in-use). |
| Step 2: **That isn't a Client ID…** | Copy the **Client ID** from **Settings → Basic Information** in your developer app, not the client secret. |
| Spotify's page: **INVALID_CLIENT: Invalid redirect URI** | Set the Redirect URI in your developer app to exactly `http://127.0.0.1:8888/callback`, press **Add**, then **Save**. |
| Spotify's page: **INVALID_CLIENT: Invalid client** | The Client ID saved in step 2 is wrong, usually the client secret: step 2 → **Change**, paste the **Client ID**. |
| Step 5 shows a ✗ | Follow the text under it, then press **Check again**. |
| Phone: **Can't reach your Encore Bridge at either address.** | The phone must be on your home Wi-Fi, and the Home address must end in `:8095`. Step 5 must show four ✓. |
| Phone: **wrong or expired pairing code** | Type the code the setup guide shows now, straight away. |
| Cydia can't add the Encore repo | Type `https://mbucc9000.github.io/slopkit/` exactly, with `https://` and the `/` at the end, and check that the phone is online. |
| Step 8: **Couldn't find your public IP…** | The PC couldn't reach an IP-check service. Check that it's online and press **Find my public IP** again, or read the Internet (WAN) address in your router's admin page. |
| Step 8: **This IP (100.64 to 100.127) is a shared address…** or **This isn't a public IP…** | Your provider shares its public IP (CGNAT), or another router sits in front of yours: see [Carrier-grade NAT and double NAT](GUIDE.md#carrier-grade-nat-and-double-nat). |
| Away from home, Settings says **Status: Offline** | Check the router's forward (TCP 8095 to the address step 8 shows), that this PC's network is still **Private**, and that your public IP hasn't changed (**Find my public IP**). Test on mobile data, not your home Wi-Fi. More in [Troubleshooting](GUIDE.md#172-connection). |
| Lists stay empty, or **Encore's player is reconnecting to Spotify. Try again in a moment.** | The engine isn't signed in: setup guide step 4. |
| The browser keeps asking for the admin password | Any user name works; only the password counts. To reset it, see [the admin page and your admin password](GUIDE.md#7-the-admin-page-and-your-admin-password). |
| An update says **…isn't signed with Encore's release key…** or **…doesn't match Encore's signed checksum list…** | Nothing was installed. Don't get that version from anywhere else; see [Updates](GUIDE.md#178-updates) in the guide's troubleshooting. |

Enjoy the music.
