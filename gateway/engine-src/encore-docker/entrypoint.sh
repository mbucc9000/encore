#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Encore patch 8: how the engine container starts.
#  - First start: when /config holds neither config.yml nor config.yaml, copy Encore's default config.yml there.
#    An existing file (or a link by that name) is never changed or replaced.
#  - ZEROCONF_BACKEND=builtin|avahi: use that zeroconf backend for this start ("-c zeroconf_backend=..."), without
#    touching config.yml. Empty: config.yml decides.
# Then it runs the command (by default the engine). It prints fixed texts only.
set -eu
CONFIG_DIR=/config
DEFAULT=/usr/share/encore/config.yml

mkdir -p "$CONFIG_DIR"
present() { [ -e "$1" ] || [ -L "$1" ]; }
if ! present "$CONFIG_DIR/config.yml" && ! present "$CONFIG_DIR/config.yaml"; then
  tmp="$CONFIG_DIR/.config.yml.encore-new"
  if cp "$DEFAULT" "$tmp" && mv -n "$tmp" "$CONFIG_DIR/config.yml"; then
    rm -f "$tmp"
    echo "encore-engine: no config.yml yet: wrote Encore's default one"
  else
    rm -f "$tmp"
    echo "encore-engine: couldn't write config.yml into the engine folder (is it writable?)" >&2
    exit 1
  fi
fi

if [ "${1:-}" = /usr/bin/go-librespot ] && [ -n "${ZEROCONF_BACKEND:-}" ]; then
  case "$ZEROCONF_BACKEND" in
    builtin|avahi)
      set -- "$@" -c "zeroconf_backend=$ZEROCONF_BACKEND"
      echo "encore-engine: zeroconf_backend $ZEROCONF_BACKEND (ZEROCONF_BACKEND)" ;;
    *)
      echo "encore-engine: ZEROCONF_BACKEND must be builtin or avahi" >&2
      exit 64 ;;
  esac
fi
exec "$@"
