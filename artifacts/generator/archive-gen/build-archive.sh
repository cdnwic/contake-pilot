#!/bin/bash
# Contake deterministic archive generator v1.2 (reproducible, single-membership)
set -euo pipefail
export LC_ALL=C
PAYLOAD="$1"; OUT="$2"
SOURCE_DATE_EPOCH=1758000000
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
mkdir "$WORK/root"
( cd "$PAYLOAD" && find . -maxdepth 1 -type f ! -name 'ARCHIVE-MANIFEST.sha256' -printf '%P\0' | LC_ALL=C sort -z ) > "$WORK/list"
while IFS= read -r -d '' f; do cp -- "$PAYLOAD/$f" "$WORK/root/$f"; done < "$WORK/list"
( cd "$WORK/root" && xargs -0 sha256sum < "$WORK/list" > ARCHIVE-MANIFEST.sha256 )
{ cat "$WORK/list"; printf 'ARCHIVE-MANIFEST.sha256\0'; } | LC_ALL=C sort -z > "$WORK/flist"
( cd "$WORK/root" && tar --null --no-recursion --files-from "$WORK/flist" \
    --sort=name --format=gnu --numeric-owner --owner=0 --group=0 \
    --mode='u+rw,go+r-w' --mtime="@${SOURCE_DATE_EPOCH}" -cf - ) | gzip -n -9 > "$OUT"
sha256sum "$OUT"
