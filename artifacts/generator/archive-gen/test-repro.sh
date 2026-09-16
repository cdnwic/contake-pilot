#!/bin/bash
# T8: byte-equality repeat build. Usage: test-repro.sh <payload_dir>
set -euo pipefail
D=$(mktemp -d); trap 'rm -rf "$D"' EXIT
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
H1=$("$SCRIPT_DIR/build-archive.sh" "$1" "$D/a.tar.gz" | cut -d' ' -f1)
sleep 1.1
H2=$("$SCRIPT_DIR/build-archive.sh" "$1" "$D/b.tar.gz" | cut -d' ' -f1)
[ "$H1" = "$H2" ] && echo "REPRODUCIBLE: $H1" || { echo "T8 FAIL: $H1 != $H2"; exit 1; }
