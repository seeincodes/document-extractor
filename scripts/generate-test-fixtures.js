#!/usr/bin/env node
/**
 * Generates deterministic PDF fixtures for unit tests.
 *
 * Outputs:
 *   tests/fixtures/encrypted.pdf — 1-page PDF protected with the standard
 *     security handler (RC4 40-bit, V=1, R=2). Opening it with pdfjs-dist
 *     without supplying a password rejects with a PasswordException.
 *   tests/fixtures/malformed.pdf — starts with valid %PDF-1.4 magic bytes
 *     but the rest of the file is truncated/garbage, so pdfjs-dist rejects
 *     with a parser error (not a PasswordException).
 *
 * Uses only Node standard library + nothing else. Safe to re-run.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE_DIR = path.join(ROOT, 'tests', 'fixtures');

// ---------- helpers ---------------------------------------------------------

// RC4 implementation (Node's crypto removed rc4 in newer versions for some
// providers; implement directly to avoid surprises).
function rc4(key, data) {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = Buffer.alloc(data.length);
  let i = 0;
  j = 0;
  for (let k = 0; k < data.length; k++) {
    i = (i + 1) & 0xff;
    j = (j + s[i]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
    out[k] = data[k] ^ s[(s[i] + s[j]) & 0xff];
  }
  return out;
}

function md5(buf) {
  return crypto.createHash('md5').update(buf).digest();
}

// PDF standard security handler — Algorithm 3.2 (compute encryption key) and
// Algorithm 3.3/3.4 (compute O and U entries), revision 2 / V=1 / 40-bit RC4.
const PASSWORD_PADDING = Buffer.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56,
  0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80,
  0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

function padPassword(pwd) {
  const buf = Buffer.alloc(32);
  const bytes = Buffer.from(pwd, 'latin1');
  bytes.copy(buf, 0, 0, Math.min(32, bytes.length));
  if (bytes.length < 32) {
    PASSWORD_PADDING.copy(buf, bytes.length, 0, 32 - bytes.length);
  }
  return buf;
}

// Algorithm 3.3: compute O (owner password entry) — revision 2.
function computeO(ownerPwd, userPwd) {
  const padOwner = padPassword(ownerPwd);
  const key = md5(padOwner).slice(0, 5);
  const padUser = padPassword(userPwd);
  return rc4(key, padUser);
}

// Algorithm 3.2: compute encryption key — revision 2.
function computeEncryptionKey(userPwd, O, P, fileID) {
  const buf = Buffer.concat([
    padPassword(userPwd),
    O,
    Buffer.from([P & 0xff, (P >> 8) & 0xff, (P >> 16) & 0xff, (P >> 24) & 0xff]),
    fileID,
  ]);
  return md5(buf).slice(0, 5);
}

// Algorithm 3.4: compute U — revision 2.
function computeU(encryptionKey) {
  return rc4(encryptionKey, PASSWORD_PADDING);
}

// Per-object key for RC4: append low 3 bytes of object number and low 2 bytes
// of generation to the file encryption key, then MD5, then truncate to
// min(n+5, 16) bytes. For 40-bit (n=5) this yields 10 bytes.
function objectKey(fileKey, objNum, gen) {
  const ext = Buffer.from([
    objNum & 0xff,
    (objNum >> 8) & 0xff,
    (objNum >> 16) & 0xff,
    gen & 0xff,
    (gen >> 8) & 0xff,
  ]);
  return md5(Buffer.concat([fileKey, ext])).slice(0, Math.min(fileKey.length + 5, 16));
}

// ---------- build encrypted.pdf --------------------------------------------

function buildEncryptedPdf() {
  // We want a real 1-page PDF, then encrypt strings/streams with RC4.
  // User password: "password". Owner password: same (any string works).
  const userPwd = 'password';
  const ownerPwd = 'password';
  const P = -4; // permissions: standard "deny everything" mask, signed int32.
  const fileID = md5(Buffer.from('document-extractor-test-fixture-encrypted-v1'));

  const O = computeO(ownerPwd, userPwd);
  const fileKey = computeEncryptionKey(userPwd, O, P, fileID);
  const U = computeU(fileKey);

  // Object definitions. We hand-assemble byte offsets for the xref table.
  // 1: Catalog, 2: Pages, 3: Page, 4: Content stream (encrypted), 5: Font.
  const contentRaw = Buffer.from('BT /F1 12 Tf 72 720 Td (Hello) Tj ET\n');
  const contentKey = objectKey(fileKey, 4, 0);
  const contentEnc = rc4(contentKey, contentRaw);

  const objects = [];
  objects[1] = Buffer.from('<< /Type /Catalog /Pages 2 0 R >>');
  objects[2] = Buffer.from('<< /Type /Pages /Count 1 /Kids [3 0 R] >>');
  objects[3] = Buffer.from(
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
  );
  objects[4] = Buffer.concat([
    Buffer.from(`<< /Length ${contentEnc.length} >>\nstream\n`),
    contentEnc,
    Buffer.from('\nendstream'),
  ]);
  objects[5] = Buffer.from(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  );

  // Encrypt object 1 (catalog) — it has no strings/streams in our case, but
  // some PDFs do; safe to skip. We only had a stream in object 4 (done) and
  // no literal strings to encrypt.

  const hex = (b) => b.toString('hex').toUpperCase();
  const encryptDict =
    `<< /Filter /Standard /V 1 /R 2 /Length 40 ` +
    `/O <${hex(O)}> /U <${hex(U)}> /P ${P} >>`;

  // Trailer ID — both entries equal to fileID (typical for unencrypted gen).
  const idHex = hex(fileID);

  // Assemble body, tracking offsets.
  const chunks = [];
  const offsets = [];
  let pos = 0;

  const header = Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'binary');
  chunks.push(header);
  pos += header.length;

  for (let i = 1; i <= 5; i++) {
    offsets[i] = pos;
    const prefix = Buffer.from(`${i} 0 obj\n`);
    const suffix = Buffer.from('\nendobj\n');
    const body = objects[i];
    chunks.push(prefix, body, suffix);
    pos += prefix.length + body.length + suffix.length;
  }

  // xref
  const xrefOffset = pos;
  let xref = `xref\n0 6\n0000000000 65535 f \n`;
  for (let i = 1; i <= 5; i++) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  chunks.push(Buffer.from(xref));

  // trailer
  const trailer =
    `trailer\n<< /Size 6 /Root 1 0 R /Encrypt ${encryptDict.replace(
      /^<< /,
      '',
    )}` +
    ` /ID [<${idHex}> <${idHex}>] >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  // Note: pdfjs accepts /Encrypt as an inline dictionary in the trailer.
  // We rebuild the trailer cleanly to avoid double-wrapping.
  const cleanTrailer =
    `trailer\n<< /Size 6 /Root 1 0 R /Encrypt ${encryptDict}` +
    ` /ID [<${idHex}> <${idHex}>] >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  void trailer;
  chunks.push(Buffer.from(cleanTrailer));

  return Buffer.concat(chunks);
}

// ---------- build malformed.pdf --------------------------------------------

function buildMalformedPdf() {
  // Valid magic header so a file-type check passes, then garbage that has no
  // xref, no objects, no %%EOF — pdfjs will reject with a parse error.
  return Buffer.from('%PDF-1.4\nthis is not a real pdf body, just garbage\n', 'binary');
}

// ---------- build minimal.docx ---------------------------------------------

// A DOCX is a ZIP with three required parts: [Content_Types].xml, _rels/.rels,
// and word/document.xml. file-type detects DOCX by peeking [Content_Types].xml
// inside the ZIP central directory, so we cannot just write the ZIP magic —
// we need a real (small) ZIP archive with that entry. We build it by hand:
// each file is stored uncompressed (method 0) so we can skip zlib entirely
// and keep the fixture deterministic and verifiable.
function buildMinimalDocx() {
  const files = [
    {
      name: '[Content_Types].xml',
      body:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '</Types>',
    },
    {
      name: '_rels/.rels',
      body:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        '</Relationships>',
    },
    {
      name: 'word/document.xml',
      body:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        '<w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p></w:body>' +
        '</w:document>',
    },
  ];

  // CRC-32 used by ZIP. Implemented inline to avoid pulling in zlib.crc32.
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };

  const u16 = (n) => Buffer.from([n & 0xff, (n >> 8) & 0xff]);
  const u32 = (n) => Buffer.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]);

  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const { name, body } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const bodyBuf = Buffer.from(body, 'utf8');
    const crc = crc32(bodyBuf);

    const localHeader = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]), // local file header signature
      u16(20),                                // version needed
      u16(0),                                 // flags
      u16(0),                                 // method = store
      u16(0), u16(0x21),                      // last mod time/date (stable epoch)
      u32(crc),
      u32(bodyBuf.length),                    // compressed size
      u32(bodyBuf.length),                    // uncompressed size
      u16(nameBuf.length),
      u16(0),                                 // extra length
      nameBuf,
      bodyBuf,
    ]);
    localParts.push(localHeader);

    centralParts.push(Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x01, 0x02]), // central dir signature
      u16(20), u16(20),                       // version made by / needed
      u16(0), u16(0),                         // flags / method
      u16(0), u16(0x21),                      // time/date
      u32(crc),
      u32(bodyBuf.length),
      u32(bodyBuf.length),
      u16(nameBuf.length),
      u16(0), u16(0),                         // extra / comment
      u16(0), u16(0),                         // disk / internal attrs
      u32(0),                                 // external attrs
      u32(offset),                            // local header offset
      nameBuf,
    ]));

    offset += localHeader.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x05, 0x06]),    // end of central dir signature
    u16(0), u16(0),                            // disk numbers
    u16(files.length), u16(files.length),
    u32(centralDir.length),
    u32(offset),                               // central dir offset
    u16(0),                                    // comment length
  ]);

  return Buffer.concat([...localParts, centralDir, eocd]);
}

// ---------- write -----------------------------------------------------------

fs.mkdirSync(FIXTURE_DIR, { recursive: true });

const encrypted = buildEncryptedPdf();
const malformed = buildMalformedPdf();
const docx = buildMinimalDocx();

fs.writeFileSync(path.join(FIXTURE_DIR, 'encrypted.pdf'), encrypted);
fs.writeFileSync(path.join(FIXTURE_DIR, 'malformed.pdf'), malformed);
fs.writeFileSync(path.join(FIXTURE_DIR, 'minimal.docx'), docx);

console.log(`encrypted.pdf: ${encrypted.length} bytes`);
console.log(`malformed.pdf: ${malformed.length} bytes`);
console.log(`minimal.docx:  ${docx.length} bytes`);
