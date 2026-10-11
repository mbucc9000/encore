# Build image for packaging Encore Bridge for Windows: the bundle script's tools (curl, unzip, zip, binutils) and
# Inno Setup's compiler running under Wine, so the installer is built on Linux (owner decision on D24: build images
# on the server; nothing installed on the developer's PC or the app build VM).
#   docker build -t encore-winbuild-package:1 -f package.Dockerfile .
# The base image is pinned by digest and Inno Setup by version and SHA-256. Debian 13 brings Wine 10: Inno Setup runs
# on older Wine too, but the launcher smoke tests (launcher/testdata/*-smoke.sh) need Wine 9 or later, because Go 1.24+
# programs use bcryptprimitives.dll.
FROM debian:trixie-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 WINEDEBUG=-all WINEPREFIX=/opt/wine WINEDLLOVERRIDES="mscoree,mshtml="
RUN dpkg --add-architecture i386 \
 && apt-get update \
 && apt-get install -y --no-install-recommends wine wine64 wine32:i386 xvfb xauth \
      ca-certificates curl unzip zip binutils file xz-utils procps \
 && rm -rf /var/lib/apt/lists/*
ARG INNO_VERSION=6.7.3
ARG INNO_TAG=is-6_7_3
ARG INNO_SHA256=9c73c3bae7ed48d44112a0f48e66742c00090bdb5bef71d9d3c056c66e97b732
RUN curl -fsSL -o /tmp/innosetup.exe "https://github.com/jrsoftware/issrc/releases/download/${INNO_TAG}/innosetup-${INNO_VERSION}.exe" \
 && echo "${INNO_SHA256}  /tmp/innosetup.exe" | sha256sum -c - \
 && xvfb-run -a sh -c 'wineboot --init && wine /tmp/innosetup.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP- /CURRENTUSER "/DIR=C:\InnoSetup" && wineserver -w' \
 && rm -f /tmp/innosetup.exe \
 && test -f /opt/wine/drive_c/InnoSetup/ISCC.exe
ENV ISCC_EXE=/opt/wine/drive_c/InnoSetup/ISCC.exe
# Python for R4's release scan, which bundle.sh runs over the staging folder (--scan)
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*
WORKDIR /work
