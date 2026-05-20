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

## `tall-letterhead.pdf`

A synthetic single-page US Letter PDF whose letterhead deliberately extends
*below* the default top-18% crop. The header block (centred 22pt company
name, italic tagline, three address/contact lines, and a thin horizontal
rule) occupies roughly the top 27% of the page, followed by a clear band of
whitespace and then body text starting around the 33% mark, a "Sincerely,"
closing, the printed name "Jane Doe" near the 75% mark, and a centred
"Page 1 of 1" footer. It is the positive case for the smart-boundary-scan
algorithm in `src/lib/detect/letterhead.ts`: the default 18% cap would miss
the bottom of the letterhead, but a scan looking for the first long
ink→whitespace transition in the top third of the page should lock onto
the rule at ~27% and prefer that boundary. Regenerated deterministically
by `scripts/generate-letterhead-fixtures.js`.

## `no-letterhead.pdf`

A synthetic single-page US Letter PDF that intentionally has **no**
distinct letterhead. Body text begins at ~3% from the top of the page with
"Dear Reviewer, ..." and runs continuously down through several paragraphs
of uniform 11pt Helvetica until a "Sincerely," and the printed name
"John Doe" near the 80% mark, ending with a centred "Page 1 of 1" footer.
Because there is no decorative header — and therefore no clean
ink→whitespace transition anywhere in the top 35% of the page — this
fixture is the negative case for the smart-boundary-scan algorithm: the
detector should either fall back to the 18% default with low confidence or
return null, and the test suite uses this fixture to assert that behaviour.
Regenerated deterministically by `scripts/generate-letterhead-fixtures.js`.

## `.local/` (gitignored)

Drop real-world fixtures — scans, faxes, signed contracts, anything with
PII or live signatures — into `samples/.local/`. That subdirectory is
ignored by git (see `.gitignore`); tests that depend on real-world inputs
should detect its absence and skip rather than fail.
