#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if ! xcrun --find swiftc >/dev/null 2>&1; then
  echo "swiftc not found. Install Xcode or run: xcode-select --install" >&2
  exit 1
fi

# -sectcreate embeds Helper-Info.plist in the binary so it has an identity:
# without it macOS attributes the microphone request to the wrong process.
# No .app bundle is required (spec §6).
swiftc -O aecio.swift -o aecio \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker Helper-Info.plist

# A broken signature makes TCC forget the grant on every rebuild, which looks
# exactly like a permission bug in the Node code.
codesign -v aecio && echo "built native/aecio"
