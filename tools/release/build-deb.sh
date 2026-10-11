#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Build the public Encore deb from an EXPORTED source tree (tools/release/export.py), never from a working copy.
#
#   sh build-deb.sh <exported tree> <output folder>
#
# Runs on the Theos machine: Linux or macOS with Theos ($THEOS, default ~/theos) and the iOS 6.1 SDK in
# $THEOS/sdks. It copies app/ into a fresh temporary folder outside your home folder (so no personal path can end up
# in the binary), builds the final package (make package FINALPACKAGE=1), and copies the result to
# <output folder>/Encore_<version>_iphoneos-arm.deb. The temporary folder is removed afterwards.
set -eu

if [ $# -ne 2 ]; then
	echo "usage: sh build-deb.sh <exported tree> <output folder>" >&2
	exit 2
fi
TREE=$1
OUT=$2
if [ ! -f "$TREE/app/control" ] || [ ! -f "$TREE/app/Makefile" ]; then
	echo "build-deb: $TREE is not an exported Encore tree (no app/control or app/Makefile)" >&2
	exit 2
fi
: "${THEOS:=$HOME/theos}"
export THEOS
if [ ! -d "$THEOS/makefiles" ]; then
	echo "build-deb: Theos not found at \$THEOS ($THEOS)" >&2
	exit 2
fi

VER=$(sed -n 's/^Version:[[:space:]]*//p' "$TREE/app/control" | head -n 1 | tr -d '\r')
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/encore-deb.XXXXXX")
trap 'rm -rf "$WORK"' EXIT INT TERM

cp -r "$TREE/app" "$WORK/Encore"
# maintainer scripts must be executable for dpkg-deb
for f in "$WORK/Encore/layout/DEBIAN/"*; do
	[ -f "$f" ] && chmod 0755 "$f"
done
cd "$WORK/Encore"
rm -rf .theos packages obj
make package FINALPACKAGE=1 messages=no
DEB=$(ls -t packages/*.deb | head -n 1)
cp "$DEB" "$OUT/Encore_${VER}_iphoneos-arm.deb"
echo "build-deb: built Encore_${VER}_iphoneos-arm.deb"
