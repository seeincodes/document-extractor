# samples/

This directory holds reproducible, non-sensitive fixture documents used by
the document-extractor pipeline for development and smoke-testing.

## `clean-letter.pdf`

A synthetic single-page US Letter PDF that contains all four regions the
extractor is designed to locate: a centred company **letterhead** in the
top ~15%, a multi-paragraph **body** in the middle ~60%, a hand-drawn-looking
cursive **signature** plus printed name and title in the bottom ~25%, and a
centred **"Page 1 of 1" footer** in the bottom ~5%. It is rendered as native
PDF text and vector strokes (not a rasterised scan), which makes it useful
as a clean baseline against which we can compare extractor behaviour on
real-world inputs that include noise, rotation, or compression artifacts.
It is regenerated deterministically by `scripts/generate-clean-letter.js`,
so you can safely delete and rebuild it at any time.

## `.local/` (gitignored)

Drop real-world fixtures — scans, faxes, signed contracts, anything with
PII or live signatures — into `samples/.local/`. That subdirectory is
ignored by git (see `.gitignore`); tests that depend on real-world inputs
should detect its absence and skip rather than fail.
