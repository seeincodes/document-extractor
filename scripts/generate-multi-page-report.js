#!/usr/bin/env node
/**
 * generate-multi-page-report.js
 *
 * Emits a synthetic 3-page US Letter PDF at samples/multi-page-report.pdf
 * with letterhead on page 1, body text across all pages, a signature on
 * the last page, and footer on every page.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const fromTop = (yFromTop) => PAGE_HEIGHT - yFromTop;

function pdfStr(s) {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function buildPage(pageNumber, totalPages) {
  const lines = [];

  if (pageNumber === 1) {
    lines.push('BT');
    lines.push('/F2 20 Tf');
    lines.push(`${PAGE_WIDTH / 2 - 80} ${fromTop(50)} Td`);
    lines.push(`(${pdfStr('ACME Corporation')}) Tj`);
    lines.push('ET');

    lines.push('BT');
    lines.push('/F1 10 Tf');
    lines.push(`${PAGE_WIDTH / 2 - 100} ${fromTop(70)} Td`);
    lines.push(`(${pdfStr('123 Business Ave, Suite 100, New York, NY 10001')}) Tj`);
    lines.push('ET');

    lines.push(`${72} ${fromTop(85)} m ${PAGE_WIDTH - 72} ${fromTop(85)} l S`);
  }

  const bodyStartY = pageNumber === 1 ? 120 : 72;
  const bodyLines = [
    `This is page ${pageNumber} of the annual performance report.`,
    'The company achieved significant milestones this quarter.',
    'Revenue grew by 15% compared to the previous quarter.',
    'Customer satisfaction scores improved across all segments.',
    'New product launches exceeded initial forecasts.',
    '',
    'Additional analysis shows strong market positioning.',
    'The team delivered on all key objectives outlined in Q1.',
    'Strategic partnerships contributed to market expansion.',
    'Operating efficiency improved through process optimization.',
    '',
    'Looking forward, we expect continued momentum in all areas.',
    'Investment in technology infrastructure will support growth.',
    'Talent acquisition remains a priority for the coming year.',
    'Risk management frameworks have been strengthened.',
  ];

  let y = bodyStartY;
  for (const line of bodyLines) {
    if (line === '') { y += 14; continue; }
    lines.push('BT');
    lines.push('/F1 11 Tf');
    lines.push(`72 ${fromTop(y)} Td`);
    lines.push(`(${pdfStr(line)}) Tj`);
    lines.push('ET');
    y += 16;
  }

  if (pageNumber === totalPages) {
    // Signature on last page
    const sigY = fromTop(620);
    // Draw a wavy line for signature
    lines.push(`72 ${sigY} m 100 ${sigY + 8} 130 ${sigY - 5} 160 ${sigY + 3} c`);
    lines.push(`160 ${sigY + 3} m 190 ${sigY + 10} 220 ${sigY - 8} 260 ${sigY} c S`);

    lines.push('BT');
    lines.push('/F1 11 Tf');
    lines.push(`72 ${fromTop(650)} Td`);
    lines.push(`(${pdfStr('Jane A. Smith, CEO')}) Tj`);
    lines.push('ET');
  }

  // Footer
  lines.push('BT');
  lines.push('/F1 9 Tf');
  lines.push(`${PAGE_WIDTH / 2 - 30} ${fromTop(760)} Td`);
  lines.push(`(${pdfStr(`Page ${pageNumber} of ${totalPages}`)}) Tj`);
  lines.push('ET');

  return lines.join('\n');
}

function buildPdf() {
  const totalPages = 3;
  const objs = [];
  let objCount = 0;

  const addObj = (content) => {
    objCount++;
    objs.push({ id: objCount, content });
    return objCount;
  };

  // 1: Catalog
  const catalogId = addObj('<< /Type /Catalog /Pages 2 0 R >>');

  // 2: Pages (placeholder, will be updated)
  const pagesId = addObj('PLACEHOLDER');

  // 3: Font Helvetica
  const fontRegId = addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  // 4: Font Helvetica-Bold
  const fontBoldId = addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');

  const pageIds = [];
  for (let p = 1; p <= totalPages; p++) {
    const stream = buildPage(p, totalPages);
    const streamId = addObj(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    const pageId = addObj(
      `<< /Type /Page /Parent ${pagesId} 0 R ` +
      `/MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      `/Contents ${streamId} 0 R ` +
      `/Resources << /Font << /F1 ${fontRegId} 0 R /F2 ${fontBoldId} 0 R >> >> >>`
    );
    pageIds.push(pageId);
  }

  // Update pages object
  objs[pagesId - 1].content =
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${totalPages} >>`;

  // Build PDF
  let pdf = '%PDF-1.4\n';
  const offsets = [];

  for (const obj of objs) {
    offsets.push(pdf.length);
    pdf += `${obj.id} 0 obj\n${obj.content}\nendobj\n`;
  }

  const xrefStart = pdf.length;
  pdf += 'xref\n';
  pdf += `0 ${objs.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (const off of offsets) {
    pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  }

  pdf += 'trailer\n';
  pdf += `<< /Size ${objs.length + 1} /Root ${catalogId} 0 R >>\n`;
  pdf += 'startxref\n';
  pdf += `${xrefStart}\n`;
  pdf += '%%EOF\n';

  return pdf;
}

const outPath = path.join(__dirname, '..', 'samples', 'multi-page-report.pdf');
fs.writeFileSync(outPath, buildPdf());
console.log(`Wrote ${outPath}`);
