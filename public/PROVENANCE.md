# Deployed-capture assets (NOT original source)
brand/ copied byte-identical from the deployed RC capture (/home/sandbox/release/rc-full-snapshot/),
TL-verified baseline. Provenance: deployed-capture, not recovered source. Requires later
visual/license review before any production release. Fonts (/fonts/*.woff2) remain external
runtime references pending the same review; fonts.css resolves them at runtime.

## fonts/ (added 2026-09-17, QA stop-ship correction 3)
8 woff2 files satisfying the 16 font refs in the RC deployed-capture styles.css. All OFL-1.1
licensed (Heebo v28 variable; IBM Plex Mono v20), fetched from fonts.gstatic.com; full source
URLs + sha256 per file in fonts/LICENSES.md. styles.css itself remains unmodified RC capture.
