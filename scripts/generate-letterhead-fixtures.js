#!/usr/bin/env node
/**
 * generate-letterhead-fixtures.js
 *
 * Emits two synthetic single-page US Letter PDFs used by
 * `src/lib/detect/letterhead.test.ts` to exercise the smart-boundary-scan
 * algorithm:
 *
 *   1. samples/tall-letterhead.pdf — a letter with a letterhead that extends
 *      below the default top-18% crop. The detector's smart-boundary scan
 *      should find a clear ink→whitespace transition around 28% from the top
 *      and prefer that over the 18% default.
 *
 *   2. samples/no-letterhead.pdf — a letter whose body text starts almost
 *      immediately at the top of the page, with no distinct letterhead block.
 *      The smart-boundary scan should NOT find a clean ink→whitespace
 *      boundary in the top 35%, and the detector should either fall back to
 *      the 18% default with low confidence or return null.
 *
 * Like `generate-clean-letter.js`, this script writes the PDFs by hand using
 * the 14 standard Type 1 fonts and no external PDF library, then verifies
 * each result with pdfjs-dist (numPages === 1, width === 612, height === 792).
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// ─────────────────────────────────────────────────────────────────────────────
// Page geometry — US Letter at 72 dpi. PDF origin is at the BOTTOM-LEFT.
// ─────────────────────────────────────────────────────────────────────────────
const PAGE_WIDTH = 612; //  8.5" * 72
const PAGE_HEIGHT = 792; // 11.0" * 72

// Convert a y measured from the TOP of the page into PDF (bottom-origin) y.
const fromTop = (yFromTop) => PAGE_HEIGHT - yFromTop;

// PDF string literal escaping (parenthesised form).
function pdfString(s) {
  return (
    '(' +
    s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)') +
    ')'
  );
}

// Coarse average em widths for the standard fonts we use. Good enough for
// visual centring of single-line strings.
const avgEm = (font) => (font === 'F2' ? 0.55 : 0.5);
const centerX = (text, font, size) => {
  const w = text.length * avgEm(font) * size;
  return (PAGE_WIDTH - w) / 2;
};

// ─────────────────────────────────────────────────────────────────────────────
// Content stream builders. Each returns the body of a /Contents stream as a
// string; the outer assembler wraps it in `<< /Length ... >> stream ... endstream`.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fixture 1: tall letterhead (~28% from the top), clear whitespace gap, then
 * body text.
 *
 * Layout (y measured from the top of the page):
 *   - Company name           y ≈ 60  (Helvetica-Bold 22pt)
 *   - Tagline                y ≈ 95  (Helvetica-Italic 11pt)
 *   - Address line 1         y ≈ 125 (Helvetica 10pt)
 *   - Address line 2         y ≈ 142 (Helvetica 10pt)
 *   - Phone / web            y ≈ 159 (Helvetica 10pt)
 *   - Horizontal rule        y ≈ 215 (so the bottom-most letterhead ink sits
 *                                     at ~27% of 792pt = ~213pt)
 *   - Whitespace band        y ≈ 215..262 (≈ 5.9% of page height, no ink)
 *   - Body opening           y ≈ 262 (~33% from top), then 8-10 lines
 *   - "Sincerely,"           y ≈ 540
 *   - Printed name "Jane Doe" y ≈ 594 (75% of 792pt = 594)
 *   - Footer "Page 1 of 1"   y ≈ 770
 */
function buildTallLetterheadContent() {
  const lines = [];

  // ── Letterhead block ──
  const letterhead = [
    { text: 'NORTHRIDGE & ASSOCIATES', font: 'F2', size: 22, yTop: 60 },
    { text: 'Counsellors at Law', font: 'F3', size: 11, yTop: 95 },
    { text: '4500 Park Avenue, Suite 1200', font: 'F1', size: 10, yTop: 125 },
    { text: 'New York, NY 10022', font: 'F1', size: 10, yTop: 142 },
    {
      text: 'Tel: (212) 555-0188   |   www.northridge-law.example',
      font: 'F1',
      size: 10,
      yTop: 159,
    },
  ];

  for (const { text, font, size, yTop } of letterhead) {
    const x = centerX(text, font, size);
    lines.push(
      'BT',
      `/${font} ${size} Tf`,
      `1 0 0 1 ${x.toFixed(2)} ${fromTop(yTop).toFixed(2)} Tm`,
      `${pdfString(text)} Tj`,
      'ET'
    );
  }

  // Horizontal rule at y≈215 from top — the *bottom* of the letterhead.
  // 215 / 792 ≈ 27.1%, i.e. squarely below the default 18% cap (143pt) and
  // therefore the case the smart-boundary scan is designed to handle.
  lines.push(
    'q',
    '0.6 w',
    '0.3 0.3 0.3 RG',
    `72 ${fromTop(215).toFixed(2)} m`,
    `${(PAGE_WIDTH - 72).toFixed(2)} ${fromTop(215).toFixed(2)} l`,
    'S',
    'Q'
  );

  // ── Body (starts ~33% from top, after a clear whitespace band) ──
  const body = [
    'May 20, 2026',
    '',
    'Dear Reviewer,',
    '',
    'We write to follow up on the matter previously discussed in our',
    'meeting of last week. Enclosed please find the documents that were',
    'requested by your office, organised in the order set out in your',
    'letter of April 30. We trust they will be found complete and in',
    'good order.',
    '',
    'If any further materials are required, please do not hesitate to',
    'contact this office. We remain available to assist you in any',
    'manner that may be useful to your continued review of these items.',
    '',
    'Sincerely,',
  ];

  const bodyX = 72;
  let bodyY = 262; // ~33% from top — well below the whitespace band
  const bodyLeading = 16;

  for (const line of body) {
    if (line.length > 0) {
      lines.push(
        'BT',
        '/F1 11 Tf',
        `1 0 0 1 ${bodyX} ${fromTop(bodyY).toFixed(2)} Tm`,
        `${pdfString(line)} Tj`,
        'ET'
      );
    }
    bodyY += bodyLeading;
  }

  // Printed name near the 75% mark from top.
  lines.push(
    'BT',
    '/F2 11 Tf',
    `1 0 0 1 ${bodyX} ${fromTop(594).toFixed(2)} Tm`,
    `${pdfString('Jane Doe')} Tj`,
    'ET'
  );

  // Footer.
  const footerText = 'Page 1 of 1';
  const footerSize = 9;
  const footerX = centerX(footerText, 'F1', footerSize);
  lines.push(
    'BT',
    `/F1 ${footerSize} Tf`,
    `1 0 0 1 ${footerX.toFixed(2)} ${fromTop(770).toFixed(2)} Tm`,
    `${pdfString(footerText)} Tj`,
    'ET'
  );

  return lines.join('\n') + '\n';
}

/**
 * Fixture 2: no letterhead. Body text starts at ~3% from the top and runs
 * continuously down the page. There is no clean ink→whitespace transition
 * anywhere in the top 35%, so the smart-boundary scan should not find a
 * letterhead boundary.
 */
function buildNoLetterheadContent() {
  const lines = [];

  // Body lines, packed from the very top of the page.
  // Page is 792pt tall; first line at y=24 (~3% from top); leading 16pt.
  const body = [
    'Dear Reviewer, this letter has no formal letterhead, no centred',
    'company name, no logo, and no horizontal rule along the top of the',
    'page. It is meant to exercise the negative path of the letterhead',
    'detector: there is no ink-then-whitespace pattern in the top third',
    'of the page, so the smart-boundary scan should not lock onto any',
    'particular y-coordinate as the lower edge of a letterhead block.',
    '',
    'The intent here is to produce a document that looks the way many',
    'informal letters and memos look in practice: a salutation followed',
    'immediately by paragraphs of body text, with no decorative header',
    'separating the sender block from the message itself. Real-world',
    'inputs of this shape are common enough that the extractor must',
    'handle them without hallucinating a letterhead region.',
    '',
    'We continue with several more lines of body text to fill the page',
    'and ensure that the detector cannot rely on a short document as a',
    'shortcut. The body wraps around natural paragraph breaks and uses',
    'the same 11pt Helvetica face throughout, which means the ink',
    'profile across the top of the page is roughly uniform rather than',
    'showing the sharp transitions characteristic of a letterhead.',
    '',
    'In the absence of any reliable ink-to-whitespace transition, the',
    'detector is expected either to fall back to the default 18% crop',
    'with low confidence or to return null and let downstream consumers',
    'decide. This fixture deliberately makes either outcome defensible.',
    '',
    'Sincerely,',
  ];

  const bodyX = 72;
  let bodyY = 24; // ~3% from top
  const bodyLeading = 16;

  for (const line of body) {
    if (line.length > 0) {
      lines.push(
        'BT',
        '/F1 11 Tf',
        `1 0 0 1 ${bodyX} ${fromTop(bodyY).toFixed(2)} Tm`,
        `${pdfString(line)} Tj`,
        'ET'
      );
    }
    bodyY += bodyLeading;
  }

  // Printed name near the 80% mark from top (792 * 0.80 ≈ 634).
  lines.push(
    'BT',
    '/F2 11 Tf',
    `1 0 0 1 ${bodyX} ${fromTop(634).toFixed(2)} Tm`,
    `${pdfString('John Doe')} Tj`,
    'ET'
  );

  // Footer.
  const footerText = 'Page 1 of 1';
  const footerSize = 9;
  const footerX = centerX(footerText, 'F1', footerSize);
  lines.push(
    'BT',
    `/F1 ${footerSize} Tf`,
    `1 0 0 1 ${footerX.toFixed(2)} ${fromTop(770).toFixed(2)} Tm`,
    `${pdfString(footerText)} Tj`,
    'ET'
  );

  return lines.join('\n') + '\n';
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF assembly. Object map identical to generate-clean-letter.js so the two
// scripts stay structurally comparable:
//   1  Catalog
//   2  Pages
//   3  Page
//   4  Content stream
//   5  F1 — Helvetica
//   6  F2 — Helvetica-Bold
//   7  F3 — Helvetica-Oblique (italic, used only by the tall-letterhead tagline)
// ─────────────────────────────────────────────────────────────────────────────
function buildPdf(content) {
  const contentBytes = Buffer.from(content, 'latin1');

  const objects = [
    `<< /Type /Catalog /Pages 2 0 R >>`,
    `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`,
    `<< /Type /Page /Parent 2 0 R ` +
      `/MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      `/Resources << /Font << /F1 5 0 R /F2 6 0 R /F3 7 0 R >> ` +
      `/ProcSet [/PDF /Text] >> ` +
      `/Contents 4 0 R >>`,
    `<< /Length ${contentBytes.length} >>\nstream\n${content}endstream`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>`,
  ];

  const chunks = [];
  let offset = 0;
  const push = (s) => {
    const buf = Buffer.isBuffer(s) ? s : Buffer.from(s, 'latin1');
    chunks.push(buf);
    offset += buf.length;
  };

  push('%PDF-1.4\n');
  push(Buffer.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  const xref = [0];
  for (let i = 0; i < objects.length; i++) {
    xref.push(offset);
    push(`${i + 1} 0 obj\n${objects[i]}\nendobj\n`);
  }

  const startxref = offset;
  let xrefTable = `xref\n0 ${objects.length + 1}\n`;
  xrefTable += `0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    xrefTable += `${String(xref[i]).padStart(10, '0')} 00000 n \n`;
  }
  push(xrefTable);

  push(
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`
  );

  return Buffer.concat(chunks);
}

// ─────────────────────────────────────────────────────────────────────────────
// Verification with pdfjs-dist 4.x.
// ─────────────────────────────────────────────────────────────────────────────
async function verify(pdfPath) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const loadingTask = pdfjs.getDocument({ data, isEvalSupported: false });
  const doc = await loadingTask.promise;
  const page = await doc.getPage(1);
  const viewport = page.getViewport({ scale: 1 });
  const result = {
    numPages: doc.numPages,
    width: viewport.width,
    height: viewport.height,
  };
  await doc.destroy();
  return result;
}

async function main() {
  const outDir = path.resolve(__dirname, '..', 'samples');
  fs.mkdirSync(outDir, { recursive: true });

  const fixtures = [
    {
      name: 'tall-letterhead.pdf',
      content: buildTallLetterheadContent(),
    },
    {
      name: 'no-letterhead.pdf',
      content: buildNoLetterheadContent(),
    },
  ];

  let failures = 0;
  for (const { name, content } of fixtures) {
    const outPath = path.join(outDir, name);
    fs.writeFileSync(outPath, buildPdf(content));
    const bytes = fs.statSync(outPath).size;
    const v = await verify(outPath);
    console.log(`Wrote ${outPath}`);
    console.log(`  Size: ${bytes} bytes`);
    console.log(
      `  Verification: numPages=${v.numPages}, width=${v.width}pt, height=${v.height}pt`
    );
    if (v.numPages !== 1 || v.width !== 612 || v.height !== 792) {
      console.error(
        `  FAIL: expected numPages=1, width=612, height=792 for ${name}`
      );
      failures += 1;
    }
  }

  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
