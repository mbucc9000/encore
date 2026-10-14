#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Builds Encore's two Docker images for one platform (DESIGN-DOCKER-IMAGES.md 4.3). Run it from the repository root:
#
#   bash .github/scripts/build-images.sh load   # both images for linux/$ARCH into the local Docker as <image>:$SMOKE_TAG
#   bash .github/scripts/build-images.sh push   # both images pushed by digest only (no tag); digests -> $DIGESTS_DIR
#
# Environment: ARCH (amd64 or arm64), VERSION (X.Y.Z), BRIDGE_IMAGE, ENGINE_IMAGE (required); DOC_REF, SOURCE_URL,
# GPL_URL (optional: an empty one leaves its label out); SMOKE_TAG (default ci-smoke); DOCKER (default docker, used
# unquoted on purpose, such as "sudo -n docker"); DIGESTS_DIR (push only); LOADED_DIR (default
# $RUNNER_TEMP/encore-loaded, else /tmp/encore-loaded).
# load and push use the same flags, so the push after a load is a cache hit (with the same builder). load keeps each
# image's config digest in LOADED_DIR; push hands on a digest only when its build has that same config, so what is
# pushed is exactly what the smoke test checked (a base image updated in between makes push fail instead).
set -euo pipefail

mode=${1:-}
case "$mode" in
  load | push) ;;
  *) echo "usage: bash .github/scripts/build-images.sh load|push" >&2; exit 2 ;;
esac
: "${ARCH:?ARCH is required (amd64 or arm64)}" "${VERSION:?VERSION is required}"
: "${BRIDGE_IMAGE:?BRIDGE_IMAGE is required}" "${ENGINE_IMAGE:?ENGINE_IMAGE is required}"
case "$ARCH" in
  amd64 | arm64) ;;
  *) echo "build-images: ARCH must be amd64 or arm64" >&2; exit 2 ;;
esac
if ! [[ $VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "build-images: VERSION must look like 1.3.0" >&2
  exit 2
fi
if [ ! -f gateway/Dockerfile ] || [ ! -f gateway/engine-src/Dockerfile ]; then
  echo "build-images: run this from the repository root" >&2
  exit 2
fi
DOCKER=${DOCKER:-docker}
SMOKE_TAG=${SMOKE_TAG:-ci-smoke}
if [ "$mode" = push ]; then
  : "${DIGESTS_DIR:?DIGESTS_DIR is required for push}"
  mkdir -p "$DIGESTS_DIR"
fi

# the commit and its time (a rebuild of a tag keeps both); a copy without .git gets placeholders (the current time:
# there, push never matches an earlier load)
REVISION=$(git rev-parse HEAD 2>/dev/null || true)
CREATED=$(git log -1 --format=%cI 2>/dev/null || true)
[ -n "$REVISION" ] || REVISION=unknown
[ -n "$CREATED" ] || CREATED=$(date -u +%Y-%m-%dT%H:%M:%SZ)

REPO_URL=https://github.com/mbucc9000/encore
COMMON=(--platform "linux/$ARCH" --pull --provenance=false --sbom=false --progress=plain)

# labels <title> <licenses> <description>: fills LABELS
labels() {
  LABELS=(
    --label "org.opencontainers.image.source=$REPO_URL"
    --label "org.opencontainers.image.url=$REPO_URL"
    --label "org.opencontainers.image.version=$VERSION"
    --label "org.opencontainers.image.revision=$REVISION"
    --label "org.opencontainers.image.created=$CREATED"
    --label "org.opencontainers.image.title=$1"
    --label "org.opencontainers.image.licenses=$2"
    --label "org.opencontainers.image.description=$3"
  )
  if [ -n "${DOC_REF:-}" ]; then
    LABELS+=(--label "org.opencontainers.image.documentation=$REPO_URL/blob/$DOC_REF/docs/TUTORIAL-DOCKER.md")
  fi
  if [ -n "${SOURCE_URL:-}" ]; then
    LABELS+=(--label "io.github.mbucc9000.encore.source-archive=$SOURCE_URL")
  fi
  if [ -n "${GPL_URL:-}" ]; then
    LABELS+=(--label "io.github.mbucc9000.encore.gpl-source=$GPL_URL")
  fi
}

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
LOADED_DIR=${LOADED_DIR:-${RUNNER_TEMP:-/tmp}/encore-loaded}

# meta <what> <key>: a string from the build's metadata file ('' when it isn't there)
meta() {
  python3 -c 'import json, sys; v = json.load(open(sys.argv[1])).get(sys.argv[2], ""); print(v if isinstance(v, str) else "")' \
    "$TMP/$1.json" "$2" 2>/dev/null || true
}

# build <what> <image> <context> <build arg>
build() {
  local what=$1 image=$2 context=$3 arg=$4
  echo "build-images: $what ($image) for linux/$ARCH, $mode"
  local config
  if [ "$mode" = load ]; then
    # shellcheck disable=SC2086  # DOCKER may be "sudo -n docker"
    $DOCKER buildx build "${COMMON[@]}" "${LABELS[@]}" --build-arg "$arg" \
      --load -t "$image:$SMOKE_TAG" --metadata-file "$TMP/$what.json" "$context"
    config=$(meta "$what" containerimage.config.digest)
    mkdir -p "$LOADED_DIR"
    rm -f "$LOADED_DIR/$what-$ARCH"
    if [[ $config == sha256:* ]]; then
      printf '%s' "$config" > "$LOADED_DIR/$what-$ARCH"
    else
      echo "build-images: note: this builder reports no config digest for $what (push needs one)" >&2
    fi
  else
    # shellcheck disable=SC2086
    $DOCKER buildx build "${COMMON[@]}" "${LABELS[@]}" --build-arg "$arg" \
      --output "type=image,name=$image,push-by-digest=true,name-canonical=true,push=true" \
      --metadata-file "$TMP/$what.json" "$context"
    local digest tested
    digest=$(meta "$what" containerimage.digest)
    if [[ $digest != sha256:* ]]; then
      echo "build-images: no digest for $what in the build's metadata" >&2
      exit 1
    fi
    config=$(meta "$what" containerimage.config.digest)
    tested=$(cat "$LOADED_DIR/$what-$ARCH" 2>/dev/null || true)
    if [[ $config != sha256:* ]] || [ "$config" != "$tested" ]; then
      echo "build-images: the $what image built for the push isn't the one the smoke test checked (a base image" \
        "probably changed in between, or load didn't run first): nothing handed on; run the job again" >&2
      exit 1
    fi
    printf '%s' "$digest" > "$DIGESTS_DIR/$what-$ARCH"
    echo "build-images: $what for linux/$ARCH pushed as $image@$digest"
  fi
}

labels 'Encore Bridge' GPL-3.0-or-later \
  'Encore Bridge: plays your Spotify on a jailbroken iOS 5 or 6 iPhone or iPod touch with the Encore app. Unofficial, not affiliated with Spotify.'
build bridge "$BRIDGE_IMAGE" gateway ENCORE_PREBUILT=1

labels 'Encore engine' GPL-3.0-only \
  'Encore'"'"'s engine: go-librespot with Encore'"'"'s patches, the Spotify Connect speaker "Encore" that Encore Bridge plays from.'
build engine "$ENGINE_IMAGE" gateway/engine-src "ENCORE_VERSION=$VERSION"

echo "build-images: done ($mode, linux/$ARCH, version $VERSION)"
