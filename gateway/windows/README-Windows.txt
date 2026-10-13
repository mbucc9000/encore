Encore Bridge for Windows
=========================

Encore Bridge runs on your PC and connects the Encore app on a jailbroken iPhone or iPod touch (iOS 6) to your
Spotify Premium account. Encore is an unofficial client. It isn't affiliated with or endorsed by Spotify.

Start Encore Bridge.exe; the setup guide opens in your browser. It takes you through everything, one step at a
time, and ticks each step off by itself:

 1. Protect this page (choose an admin password)
 2. Your Spotify developer app (paste its Client ID; the guide shows the exact values to use)
 3. Connect your Spotify account
 4. Sign in the Encore engine
 5. Check your network
 6. Put Encore on your phone (add the Encore repo in Cydia and install Encore from it)
 7. Pair your phone
 8. Listen away from home (forward port 8095 on your router; the guide finds your public IP for Encore's
    Away Address)
 9. Play a song

Encore Bridge's icon (a green record) is in the notification area, next to the clock; if you can't see it, click
the ^ arrow there. If the setup guide didn't open, or to go back to it later: click the icon, then
"Setup guide...". The guide that comes with Encore explains every step in more detail.

Languages: the menu and the installer follow Windows' display language (Spanish, Portuguese (Brazil), French,
German, Italian, Dutch, Polish, Russian, Turkish, Japanese, Korean or Simplified Chinese; any other language gets
English, and so does the installer in Simplified Chinese). The admin page starts in your browser's language and
has its own language picker.

Where things are
----------------
- This folder holds the program. Nothing in it changes while it runs.
- Your settings, paired phones, sign-ins, cache and logs are in %LOCALAPPDATA%\Encore (menu: Troubleshooting >
  Open data folder). Treat a copy of that folder like a password.
- Settings: the setup guide saves your Spotify Client ID for you. Everything else: Troubleshooting > Edit
  settings, then Troubleshooting > Restart bridge.

Windows Firewall
----------------
- The installer adds a rule that lets phones reach Encore Bridge on home (Private) networks, on TCP port 8095.
  It also lets in the connections your router forwards from outside (see "Listening away from home" below).
- The zip version adds no rule. The first time Encore Bridge starts, Windows asks whether "Node.js JavaScript
  Runtime" may communicate on networks: allow it on private networks. If you clicked Cancel, or the phone can't
  connect, use Troubleshooting > Fix firewall.
- The setup guide's "Check your network" step tells you whether all of this is right.
- If your network is set to Public, phones can't connect. Set your home network to Private: Settings > Network &
  internet > Wi-Fi (or Ethernet) > your network > Network profile type > Private.

Listening away from home
------------------------
To play music away from home (on mobile data or someone else's Wi-Fi), your router has to pass Encore's port on
to this PC. This is called port forwarding, and you set it up once. The setup guide's step 8, "Listen away from
home", walks you through it:
- In your router's admin page, add a port forward: protocol TCP, external port 8095, forward to this PC's address
  on your home network (the guide shows it), internal port 8095. Forward this one port only.
- In the router, also reserve that address for this PC (DHCP reservation), so the forward keeps pointing at it.
- Windows Firewall already lets these connections in (the rule "Encore Bridge (phone)"), as long as your network
  is set to Private.
- In the guide, press "Find my public IP". It shows your Away address, http://<your public IP>:8095. On the phone,
  type it into Encore > Settings > Away Address.
- Test it with the phone on mobile data (Wi-Fi off): Encore > Settings > Status should say Away, and the guide
  ticks the step. Testing on your own Wi-Fi proves nothing.
- Your home's public IP can change. If Encore stops connecting away from home, press "Find my public IP" again
  and update the Away Address (or use a dynamic DNS name, if your router offers one).
- If your internet provider shares one public IP between many homes (CGNAT), a port forward can't reach you:
  remove it again. The guide explains how to tell, and what to ask your provider.
- Only Encore's phone connection is reachable from outside, and every phone request must be signed with the key
  the phone got when you paired it. The admin page and pairing still answer only on your home network. Use a
  strong admin password, and keep Windows up to date.

SmartScreen
-----------
Encore Bridge isn't code-signed. The first time you start it (or the installer), Windows may say "Windows protected
your PC". Check the download's SHA-256 checksum against the one published with the release, then choose
More info > Run anyway.

Updates
-------
Once a day Encore Bridge asks GitHub whether a newer version is out (menu: Check for updates asks right away). It
sends only its version number. When there is one, the menu shows "Encore Bridge <version> is available":
- Installed: choose Update now. Encore Bridge downloads the installer, checks Encore's signature on it, and Windows
  asks for permission to install it (it names an "Unknown publisher", because Encore isn't code-signed). Phones stop playing for about a minute; your settings, sign-ins and paired phones stay.
- Zip: choose Download, check the new zip's SHA-256 as the admin page shows, quit Encore Bridge, unzip the new
  version into a new, empty folder and start it from there.
Afterwards, update the Encore app on your phone too: Cydia > Changes > Refresh. To turn the daily check off, set
UPDATE_CHECK=0 in settings.env (Troubleshooting > Edit settings).

Sleep
-----
While a phone is listening, Encore Bridge keeps the PC from going to sleep (menu: Keep this PC awake while
streaming). It can't wake a sleeping PC: while the PC sleeps, the phone can't connect.

Uninstall
---------
- Installed: Settings > Apps > Installed apps > Encore Bridge > Uninstall. It asks whether to delete your data too.
- Zip: in the menu, turn off Start with Windows, then Quit Encore Bridge. Delete this folder, and
  %LOCALAPPDATA%\Encore too unless you want to keep your data.

Licenses
--------
Encore Bridge is free software under the GNU General Public License, version 3 or later, and comes with ABSOLUTELY
NO WARRANTY. The "licenses" folder holds its license and those of the programs it includes: Node.js, FFmpeg (LGPL)
and the go-librespot engine (GPL-3.0), with where to get their source code.
