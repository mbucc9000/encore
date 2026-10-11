# Encore engine for Windows: the build image (encore-engine-winbuild).
#
# A Linux toolchain that cross-compiles the patched go-librespot in gateway/engine-src for windows/amd64: Go, MinGW-w64,
# and the decode libraries (libogg, libvorbis, libflac, mpg123) built by vcpkg as static x64-mingw-static libraries.
# It follows upstream's own cross-build (go-librespot CI job "windows-vcpkg", CROSS_COMPILE.md).
#
# The build context is gateway/engine-src (vcpkg.json, vcpkg-configuration.json, vcpkg-triplets/, go.mod, go.sum):
#
#   docker build -t encore-engine-winbuild:1 -f gateway/windows/build-engine/Dockerfile gateway/engine-src
#
# Building the image needs the network (Debian packages, Go, vcpkg and the library sources). Building the engine
# with it (build.sh, inside.sh) does not: that runs with --network none.

FROM debian:trixie-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f

# Go: the newest release with security support when this recipe was written. go.mod's "go 1.25" line keeps the
# language version and the GODEBUG defaults of Go 1.25.
ARG GO_VERSION=1.26.8
ARG GO_SHA256=d0f743b33e8d8945e6b1f432edd15785c70507121d6e2a723b21285eddf8b57b

# vcpkg: the tag upstream's CI uses. The ports themselves come from the baseline in vcpkg-configuration.json.
ARG VCPKG_TAG=2025.09.17
ARG VCPKG_COMMIT=4334d8b4c8916018600212ab4dd4bbdc343065d1

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git zip unzip tar xz-utils file python3 \
      pkg-config make cmake ninja-build gcc g++ \
      gcc-mingw-w64-x86-64 g++-mingw-w64-x86-64 binutils-mingw-w64-x86-64 \
 && rm -rf /var/lib/apt/lists/*

RUN curl -fsSLo /tmp/go.tgz "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" \
 && echo "${GO_SHA256}  /tmp/go.tgz" | sha256sum -c - \
 && tar -C /usr/local -xzf /tmp/go.tgz \
 && rm /tmp/go.tgz
ENV PATH=/usr/local/go/bin:$PATH GOTOOLCHAIN=local GOPATH=/opt/gopath GOTELEMETRY=off

RUN git clone --depth 1 --branch "${VCPKG_TAG}" https://github.com/microsoft/vcpkg.git /opt/vcpkg \
 && test "$(git -C /opt/vcpkg rev-parse HEAD)" = "${VCPKG_COMMIT}" \
 && /opt/vcpkg/bootstrap-vcpkg.sh -disableMetrics
ENV VCPKG_ROOT=/opt/vcpkg VCPKG_DISABLE_METRICS=1

# The static decode libraries. Their source archives (/deps/sources) and the vcpkg port recipes that built them, with
# the patches each applies (/deps/sources/vcpkg-ports), are kept: mpg123 is LGPL-2.1 and linked statically, so a
# release ships its source next to the engine's (gateway/windows/build-engine/README.md).
WORKDIR /deps
COPY vcpkg.json vcpkg-configuration.json ./
COPY vcpkg-triplets ./vcpkg-triplets
RUN /opt/vcpkg/vcpkg install --triplet x64-mingw-static --x-install-root=/deps/vcpkg_installed \
 && mkdir -p /deps/sources/vcpkg-ports \
 && for f in /opt/vcpkg/downloads/*; do \
      case "$(basename "$f")" in \
        *ogg*|*vorbis*|*flac*|*FLAC*|*mpg123*) cp "$f" /deps/sources/ ;; \
      esac; \
    done \
 && for d in /root/.cache/vcpkg/registries/git-trees/*/; do \
      n=$(sed -n 's/^ *"name": *"\([^"]*\)".*/\1/p' "${d}vcpkg.json" 2>/dev/null | head -1); \
      case "$n" in \
        libogg|libvorbis|libflac|mpg123) cp -r "$d" "/deps/sources/vcpkg-ports/$n" ;; \
      esac; \
    done \
 && for n in libogg libvorbis libflac mpg123; do test -f "/deps/sources/vcpkg-ports/$n/portfile.cmake"; done \
 && ls /deps/vcpkg_installed/vcpkg/info/ > /deps/vcpkg-ports.txt \
 && rm -rf /opt/vcpkg/buildtrees /opt/vcpkg/packages /opt/vcpkg/downloads /root/.cache/vcpkg

# Every Go module the engine and its tests need, so the engine build itself runs offline (GOPROXY=off).
COPY go.mod go.sum /deps/gomod/
RUN cd /deps/gomod && go mod download && go mod verify

WORKDIR /src
