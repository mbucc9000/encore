# Encore Bridge for Windows: the FFmpeg build image (encore-ffmpeg-winbuild).
#
# A Linux toolchain that cross-compiles Encore's minimal LGPL FFmpeg (configure.txt) for windows/amd64 with MinGW-w64,
# from FFmpeg's official release tarball, checked against its SHA-256 and FFmpeg's release signing key. The tarball is
# kept in the image (/deps/sources): it is the source that goes out with every Windows release (LGPL-2.1 section 6).
#
#   docker build -t encore-ffmpeg-winbuild:1 gateway/windows/build-ffmpeg
#
# Building the image needs the network (Debian packages, the FFmpeg tarball, its signature and FFmpeg's public key).
# Building FFmpeg with it (build.sh, inside.sh) does not: that runs with --network none.

FROM debian:trixie-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f

# FFmpeg: the newest release of the 8.1 branch when this recipe was written
ARG FFMPEG_VERSION=8.1.3
ARG FFMPEG_SHA256=7138d28c96d9d3e3af4ee3d8cad72741f8ffb40da90c1112235dea3ecd3178a3
# FFmpeg's release signing key ("FFmpeg release signing key"), published at https://ffmpeg.org/ffmpeg-devel.asc and
# on https://ffmpeg.org/download.html
ARG FFMPEG_KEY_FPR=FCF986EA15E6E293A5644F10B4322F04D67658D8

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg xz-utils file make pkg-config nasm \
      gcc libc6-dev zlib1g-dev \
      gcc-mingw-w64-x86-64 binutils-mingw-w64-x86-64 libz-mingw-w64-dev \
 && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /deps/sources && cd /deps/sources \
 && curl -fsSLO "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz" \
 && curl -fsSLO "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz.asc" \
 && echo "${FFMPEG_SHA256}  ffmpeg-${FFMPEG_VERSION}.tar.xz" | sha256sum -c - \
 && curl -fsSLo /tmp/ffmpeg-devel.asc https://ffmpeg.org/ffmpeg-devel.asc \
 && export GNUPGHOME=/tmp/gnupg && mkdir -m 700 "$GNUPGHOME" \
 && gpg --batch --quiet --import /tmp/ffmpeg-devel.asc \
 && gpg --batch --status-fd 1 --verify "ffmpeg-${FFMPEG_VERSION}.tar.xz.asc" "ffmpeg-${FFMPEG_VERSION}.tar.xz" > /tmp/verify.txt 2>/dev/null \
 && grep '^\[GNUPG:\] VALIDSIG ' /tmp/verify.txt | grep -q "${FFMPEG_KEY_FPR}" \
 && grep '^\[GNUPG:\] VALIDSIG ' /tmp/verify.txt | sed 's/^\[GNUPG:\] //' > /deps/signature.txt \
 && rm -rf /tmp/gnupg /tmp/ffmpeg-devel.asc /tmp/verify.txt \
 && echo "${FFMPEG_VERSION}" > /deps/FFMPEG_VERSION

WORKDIR /build
