# Encore on Windows

This sets up Encore on a Windows PC, up to the first song on your iPhone or iPod touch. It takes about 20 minutes.
You install **Encore Bridge**; its **setup guide** in your browser walks you through the rest.

> **Unofficial.** Encore is not made, endorsed or supported by Spotify. It needs Spotify Premium and your own free
> Spotify developer app. It uses private Spotify interfaces that can change or break at any time. Use it at your own
> risk (legal details in the [guide](GUIDE.md)).

## What you need

- A jailbroken iPhone or iPod touch with **Cydia**, on iOS 6 (iPhone 4, 4S or 5; iPod touch 4th or 5th generation) or
  iOS 5.0 to 5.1.1 (iPhone 3GS, 4 or 4S; iPod touch 3rd or 4th generation). Only the iPhone 5 on iOS 6 is tested.
- **Spotify Premium**.
- A 64-bit **Windows 10 or 11 PC** that stays on while you listen, on the same home network as the phone.
- To listen away from home: access to your router's settings.

## 1. Install Encore Bridge

1. Download `EncoreBridge-<version>-setup.exe` from the
   [release page](https://github.com/mbucc9000/encore/releases/latest).
2. Run it. If Windows says **Windows protected your PC**, click **More info**, then **Run anyway** (Encore isn't
   code-signed; do this only for a file from the release page). Click **Yes** at the administrator prompt.
3. Leave **Start Encore Bridge when I sign in to Windows** ticked: your phone can only play while the bridge runs.
4. Press **Install**. Leave **Start Encore Bridge and open the setup guide** ticked and press **Finish**.

The Encore icon (a black record on a green square) appears near the clock; click **^** if it's hidden. Click the icon
for the bridge's menu (the "tray menu"). No administrator rights? Use the portable zip: see the [guide](GUIDE.md).

## 2. Follow the setup guide on the PC

The setup guide opens in your browser. If it doesn't, choose **Setup guide…** in the tray menu. Do what each step says
on screen; it ticks itself off when it's done. Steps 1 to 5 happen on the PC:

1. **Protect this page:** choose an admin password. When the browser asks, type any user name and that password.
2. **Your Spotify developer app:** create it at the [Spotify developer dashboard](https://developer.spotify.com/dashboard) as shown and paste
   its **Client ID** (not the client secret).
3. **Connect your Spotify account:** press **Connect**, then **Agree**, with the same Premium account.
4. **Sign in the Encore engine:** open the link, sign in with the same account and enter the code.
5. **Check your network:** fix any ✗ as its line says, then press **Check again**. Usually: set your home network to
   **Private** in Windows Settings, or choose **Troubleshooting → Fix firewall…** in the tray menu.

Tip: in your router, give this PC a fixed address (a "DHCP reservation"), so the phone always finds it.

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

- **Update:** when a new version is out, the tray menu shows **Encore Bridge … is available**. Choose **Update now…**.
  Windows says the publisher is **Unknown**: choose **Yes**. Your settings and paired phones stay. Then update the app
  in Cydia: **Changes** → **Refresh**.
- **Uninstall:** **Settings → Apps → Installed apps → Encore Bridge → Uninstall**. On the phone, remove Encore in Cydia.
- **Everything else** (the app's features, Jam, Anonymous Mode, all messages): the [guide](GUIDE.md).

**If the PC side doesn't work:**

| What you see | What to do |
|---|---|
| No Encore icon near the clock | Click **^** by the clock. Not there? Start **Encore Bridge** from the Start menu. |
| The setup guide didn't open | Tray menu → **Setup guide…** |
| The browser keeps asking for the password | Any user name works; only the password counts. |
| Spotify shows **INVALID_CLIENT** | Fix what step 3 of the setup guide says, then press **Connect** again. |
