#!/bin/bash
# Validation battery v1.2. Usage: test-archive.sh <tar.gz>
set -euo pipefail
export LC_ALL=C
T="$1"; V=$(mktemp -d); trap 'rm -rf "$V"' EXIT
mkdir "$V/x" "$V/s"; tar -xzf "$T" -C "$V/x"; cd "$V/x"
! grep -q 'ARCHIVE-MANIFEST' ARCHIVE-MANIFEST.sha256 || { echo "T1 FAIL self-entry"; exit 1; }
sha256sum -c ARCHIVE-MANIFEST.sha256 >/dev/null 2>&1 || { echo "T2 FAIL checksum"; exit 1; }
find . -maxdepth 1 -type f ! -name 'ARCHIVE-MANIFEST.sha256' -printf '%P\n' | LC_ALL=C sort > "$V/s/t3a"
awk '{print $2}' ARCHIVE-MANIFEST.sha256 | LC_ALL=C sort > "$V/s/t3b"
diff -q "$V/s/t3a" "$V/s/t3b" >/dev/null || { echo "T3 FAIL payload/manifest mismatch"; exit 1; }
awk '/^## פריטי תוכן/{s=1;next} /^## /{s=0} s' REGISTRY.md | grep '^| ' | grep -v -E '^\| (identity|---)' | awk -F'|' '{gsub(/^ +| +$/,"",$2); print $2}' | LC_ALL=C sort > "$V/s/t4a"
uniq -d "$V/s/t4a" | grep . && { echo "T4 FAIL dup identity"; exit 1; } || true
grep -v -E '^(REGISTRY.md|DELETION-LOG.md)$' "$V/s/t3b" > "$V/s/t5a"
diff -q "$V/s/t5a" "$V/s/t4a" >/dev/null || { echo "T5 FAIL registry/manifest reconciliation"; exit 1; }
find . -maxdepth 1 -name 'contake-archive-*' | grep . && { echo "T6 FAIL predecessor inside payload"; exit 1; } || true
for cf in REGISTRY.md DELETION-LOG.md ARCHIVE-MANIFEST.sha256; do grep -q "$cf" REGISTRY.md || { echo "T7 FAIL control $cf unregistered"; exit 1; }; done
# T8: normalized member uniqueness + exact member count
tar -tf "$T" | sed 's|^\./||' | LC_ALL=C sort > "$V/s/members"
uniq -d "$V/s/members" | grep . && { echo "T8 FAIL duplicate tar member"; exit 1; } || true
[ "$(wc -l < "$V/s/members")" -eq "$(( $(wc -l < "$V/s/t3b") + 1 ))" ] || { echo "T8 FAIL member count"; exit 1; }
echo "ALL TESTS PASS"
