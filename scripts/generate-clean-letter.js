#!/usr/bin/env node
/**
 * generate-clean-letter.js
 *
 * Emits a synthetic single-page US Letter PDF at samples/clean-letter.pdf
 * with the four regions our document-extractor pipeline is designed to find:
 *
 *   1. Letterhead    (top  ~15% of page 1)
 *   2. Body text     (middle ~60%)
 *   3. Signature     (bottom ~25%) — a hand-drawn-looking cursive stroke
 *                                    plus a printed name and title
 *   4. Footer        (bottom ~5%)  — "Page 1 of 1"
 *
 * No external PDF library is used. We write a minimal PDF 1.4 file by hand
 * using the 14 standard Type 1 fonts (Helvetica, Helvetica-Bold, Times-Italic)
 * which every conformant reader/parser — including pdfjs-dist 4.x — supports
 * without font embedding.
 *
 * After writing the PDF, we load it with pdfjs-dist and assert numPages === 1
 * and print the page dimensions, as required by the task.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// ─────────────────────────────────────────────────────────────────────────────
// Page geometry — US Letter at 72 dpi (PDF default unit is 1/72 inch).
// PDF origin is the BOTTOM-LEFT of the page.
// ─────────────────────────────────────────────────────────────────────────────
const PAGE_WIDTH = 612; //  8.5" * 72
const PAGE_HEIGHT = 792; // 11.0" * 72

// Convenience: a y-coordinate measured from the TOP of the page (more natural
// when laying out a letter), converted to the PDF coordinate space.
const fromTop = (yFromTop) => PAGE_HEIGHT - yFromTop;

// ─────────────────────────────────────────────────────────────────────────────
// Text-escaping for PDF string literals (parenthesised form).
// We only ever emit ASCII, but balanced/escaped parens and backslashes are
// still required by the PDF spec.
// ─────────────────────────────────────────────────────────────────────────────
function pdfString(s) {
  return (
    '(' +
    s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)') +
    ')'
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Build the content stream — the actual draw calls for the page.
// PDF content-stream operators used here:
//   q / Q              save / restore graphics state
//   BT / ET            begin / end text object
//   /F<n> <size> Tf    select font + size
//   <x> <y> Td         move text cursor (absolute within BT/ET after a Tm)
//   <x> <y> Tm         set text matrix (absolute positioning)
//   (string) Tj        show string
//   <w> w              set line width
//   <r> <g> <b> RG     set stroke colour
//   <x> <y> m          moveto
//   <x> <y> l          lineto
//   <x1> <y1> <x2> <y2> <x3> <y3> c   cubic Bezier
//   S                  stroke the current path
// ─────────────────────────────────────────────────────────────────────────────
function buildContentStream() {
  const lines = [];

  // ── 1. Letterhead (top ~15%: y ≈ 0–119pt from top) ──
  // Centred company name in Helvetica-Bold 18pt at y=50 from top, then
  // a two-line address block underneath in Helvetica 10pt.
  const letterhead = [
    { text: 'ACME LEGAL SERVICES', font: 'F2', size: 18, yTop: 60 },
    { text: '123 Main Street, Anytown, NY 12345', font: 'F1', size: 10, yTop: 85 },
    { text: 'Tel: (555) 555-0100', font: 'F1', size: 10, yTop: 100 },
  ];

  // Approximate character widths for the standard 14 fonts at 1pt are well
  // known; we use a coarse average to centre the text. Helvetica avg ≈ 0.5em,
  // Helvetica-Bold avg ≈ 0.55em. Good enough for visual centring.
  const avgEm = (font) => (font === 'F2' ? 0.55 : 0.5);
  const centerX = (text, font, size) => {
    const w = text.length * avgEm(font) * size;
    return (PAGE_WIDTH - w) / 2;
  };

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

  // A thin horizontal rule under the letterhead at y=120 from top.
  lines.push(
    'q',
    '0.5 w',
    '0.4 0.4 0.4 RG',
    `72 ${fromTop(120).toFixed(2)} m`,
    `${(PAGE_WIDTH - 72).toFixed(2)} ${fromTop(120).toFixed(2)} l`,
    'S',
    'Q'
  );

  // ── 2. Body (middle ~60%: y ≈ 119–594pt from top) ──
  // Left-aligned at x=72 (1" margin). 11pt Helvetica with ~16pt leading.
  const body = [
    'May 20, 2026',
    '',
    'Dear Reviewer,',
    '',
    'Thank you for taking the time to evaluate the enclosed material. We',
    'are pleased to submit this correspondence in connection with the matter',
    'previously discussed, and trust that the contents will be found in good',
    'order and consistent with the standards customarily expected.',
    '',
    'Should any clarification be required, please do not hesitate to contact',
    'our office at your convenience. We remain available to provide any',
    'supplemental information that may assist in your review of these',
    'materials.',
    '',
    'We appreciate your attention to this matter and look forward to your',
    'response in due course.',
    '',
    'Sincerely,',
  ];

  const bodyX = 72;
  let bodyY = 160; // first body line, measured from top
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

  // ── 3. Signature (bottom ~25%: y ≈ 594–752pt from top) ──
  // A wavy stroked cubic-Bezier path that visually reads as a cursive
  // squiggle, plus a printed name and title below it.
  //
  // The path is anchored around (x=120..300, y≈fromTop(640)) and uses three
  // chained cubic Beziers to fake the loops of a signature.
  const sigYTop = 640;
  const sigYPdf = fromTop(sigYTop);

  lines.push(
    'q',
    '1.4 w',
    '0.05 0.05 0.25 RG', // dark blue ink
    // Start at the left edge of the signature
    `120 ${(sigYPdf + 4).toFixed(2)} m`,
    // First loop
    `140 ${(sigYPdf + 28).toFixed(2)} 165 ${(sigYPdf - 18).toFixed(2)} 190 ${(sigYPdf + 6).toFixed(2)} c`,
    // Second loop with a tall ascender
    `210 ${(sigYPdf + 22).toFixed(2)} 230 ${(sigYPdf - 14).toFixed(2)} 250 ${(sigYPdf + 4).toFixed(2)} c`,
    // Long trailing flourish
    `275 ${(sigYPdf + 18).toFixed(2)} 295 ${(sigYPdf - 6).toFixed(2)} 320 ${(sigYPdf + 2).toFixed(2)} c`,
    'S',
    // A short decorative underline beneath the signature
    '0.8 w',
    `120 ${(sigYPdf - 10).toFixed(2)} m`,
    `300 ${(sigYPdf - 10).toFixed(2)} l`,
    'S',
    'Q'
  );

  // Printed name + title in Helvetica 11pt / 10pt, left-aligned under
  // the signature.
  const sigLines = [
    { text: 'Jane Doe', font: 'F2', size: 11, yTop: sigYTop + 30 },
    { text: 'Principal Attorney', font: 'F1', size: 10, yTop: sigYTop + 46 },
  ];
  for (const { text, font, size, yTop } of sigLines) {
    lines.push(
      'BT',
      `/${font} ${size} Tf`,
      `1 0 0 1 120 ${fromTop(yTop).toFixed(2)} Tm`,
      `${pdfString(text)} Tj`,
      'ET'
    );
  }

  // ── 4. Footer (bottom ~5%: y ≈ 752–792pt from top) ──
  // Centred "Page 1 of 1" in Helvetica 9pt.
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
// Assemble the PDF.
//
// Object map:
//   1  Catalog
//   2  Pages (root)
//   3  Page
//   4  Content stream
//   5  Helvetica           (F1)
//   6  Helvetica-Bold      (F2)
//   7  Times-Italic        (F3, kept for future signature variants)
// ─────────────────────────────────────────────────────────────────────────────
function buildPdf() {
  const content = buildContentStream();
  const contentBytes = Buffer.from(content, 'latin1');

  const objects = [
    // 1: Catalog
    `<< /Type /Catalog /Pages 2 0 R >>`,
    // 2: Pages
    `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`,
    // 3: Page
    `<< /Type /Page /Parent 2 0 R ` +
      `/MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      `/Resources << /Font << /F1 5 0 R /F2 6 0 R /F3 7 0 R >> ` +
      `/ProcSet [/PDF /Text] >> ` +
      `/Contents 4 0 R >>`,
    // 4: Content stream
    `<< /Length ${contentBytes.length} >>\nstream\n${content}endstream`,
    // 5: F1 — Helvetica
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`,
    // 6: F2 — Helvetica-Bold
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`,
    // 7: F3 — Times-Italic (reserved)
    `<< /Type /Font /Subtype /Type1 /BaseFont /Times-Italic /Encoding /WinAnsiEncoding >>`,
  ];

  // PDF body — track byte offsets for the xref table.
  const chunks = [];
  let offset = 0;
  const push = (s) => {
    const buf = Buffer.isBuffer(s) ? s : Buffer.from(s, 'latin1');
    chunks.push(buf);
    offset += buf.length;
  };

  // Header. A binary-comment line (4 high-bit bytes) is recommended so naive
  // tools don't misclassify the file as text.
  push('%PDF-1.4\n');
  push(Buffer.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  const xref = [0]; // object 0 is the free-list head; offset value is unused.
  for (let i = 0; i < objects.length; i++) {
    xref.push(offset);
    push(`${i + 1} 0 obj\n${objects[i]}\nendobj\n`);
  }

  const startxref = offset;
  let xrefTable = `xref\n0 ${objects.length + 1}\n`;
  // Object 0 is the head of the linked free list.
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
// Verify with pdfjs-dist 4.x — required by the task.
// pdfjs is ESM-only in v4, so we import it dynamically from this CJS script.
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
  const outPath = path.join(outDir, 'clean-letter.pdf');
  fs.mkdirSync(outDir, { recursive: true });

  const pdf = buildPdf();
  fs.writeFileSync(outPath, pdf);

  const bytes = fs.statSync(outPath).size;
  const verification = await verify(outPath);

  console.log(`Wrote ${outPath}`);
  console.log(`Size: ${bytes} bytes`);
  console.log(
    `Verification: numPages=${verification.numPages}, ` +
      `width=${verification.width}pt, height=${verification.height}pt`
  );

  if (verification.numPages !== 1) {
    console.error(`FAIL: expected numPages=1, got ${verification.numPages}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
