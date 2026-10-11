# Encore tutorial: from nothing to your first song

Encore puts your Spotify library back on a jailbroken iPhone or iPod touch on iOS 6. Setting it up takes about
20 minutes: you install a small program, the **Encore Bridge**, on a computer at home, and its **setup guide** walks you
through the rest in your browser, ticking each step off by itself. This page helps you pick the right tutorial.

> **Unofficial.** Encore is not made, endorsed or supported by Spotify. It needs Spotify Premium, and it uses some
> private Spotify interfaces that can change or break at any time. Use it at your own risk
> ([Legal and disclaimer](GUIDE.md#25-legal-and-disclaimer)).

## How it fits together

![How Encore works: the Encore app on the phone talks to the Encore Bridge on a computer at home. Inside that computer the engine, a Spotify Connect speaker named Encore, plays the music from Spotify and hands it to the bridge, which streams it to the phone as AAC.](images/how-it-works.svg)

- **The Encore app** on your phone is what you tap: Home, Search, Playlists, Library, Now Playing.
- **The Encore Bridge** on a computer at home talks to today's Spotify for the phone, turns the music into a stream the
  old iPhone can play, and has a web page for setting things up, the **admin page**. Its **setup guide** lives there.
- **The engine**, inside the bridge, is a Spotify Connect speaker called **Encore**. It plays your music and hands it to
  the bridge.

Your phone only ever talks to your own bridge. No music is saved anywhere, and your Spotify sign-ins stay on your own
computer.

## What you need

- [ ] **A jailbroken iPhone or iPod touch on iOS 6, with Cydia:** iPhone 5, iPhone 4S, iPhone 4, iPod touch (5th
      generation) or iPod touch (4th generation). You install the app from the Encore repo in Cydia.
- [ ] **Spotify Premium.** Free accounts won't work.
- [ ] **A computer that stays on**, at home: a **Windows 10 or 11 PC** (64-bit), or a **Linux machine with Docker** (a
      home server, a NAS that runs Docker containers, or a spare PC).
- [ ] **Your home Wi-Fi**, with the phone and that computer on it.
- [ ] **For listening away from home:** access to your router's settings (port forwarding). The setup guide walks you
      through it.

**Not supported:** iPads, iOS 7 or later, and Docker Desktop on Windows or macOS (on a Windows PC, use the Windows
bridge). The full list is in the guide's [What you need](GUIDE.md#2-what-you-need).

## Pick your tutorial

You only need one bridge. Pick the one that matches the computer that will stay on:

| | **Windows** | **Docker (Linux)** |
|---|---|---|
| You install | An installer | The Encore source, built on your machine with one command |
| It runs | While you're signed in to Windows (it starts with Windows) | Always: it starts with the machine |
| The setup guide opens | By itself, at the end of the installer | When you open the bridge's admin page |
| Signing the engine in | Type a code at spotify.com/pair | Pick "Encore" once in a Spotify app on your network |
| **Your tutorial** | **[Encore on Windows](TUTORIAL-WINDOWS.md)** | **[Encore with Docker](TUTORIAL-DOCKER.md)** |

Both end the same way, on the phone: add the Encore repo in Cydia, install Encore from it, pair the phone, set up
listening away from home, and play a song.

Already set up, or looking for one detail? [The Encore guide](GUIDE.md) is the full reference.
