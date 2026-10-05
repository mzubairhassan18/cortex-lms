/* export-format.js — pure writers for the summary export.
 *
 * No imports on purpose: everything here takes a plain document object (or a
 * plain block list) and returns bytes, so it can be exercised outside a
 * browser —  node --experimental-default-type=module — and can never pull the
 * app's DOM layer into a cycle.
 *
 *   TXT  — UTF-8 plain text.
 *   PDF  — a hand-written PDF 1.4: two base-14 Helvetica fonts, one content
 *          stream per page, hand-computed xref table. No library, no build
 *          step, no network. Text runs through toLatin1() because a base-14
 *          font only draws WinAnsi — and the symbol map below keeps physics
 *          notation (Greek letters, sqrt, arrows, superscripts) instead of
 *          dropping it.
 *   DOCX — a real Office Open XML package: three parts zipped with STORED
 *          entries (no deflate needed) and a locally computed CRC32.
 *
 * All three render the SAME block list, so the three files always say exactly
 * the same thing.
 */

const pad = (n) => String(n).padStart(2, '0');
export const stamp = (d) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
  `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/* Strip markdown so a summary bullet or a pasted note reads as plain prose
 * in every target. */
export function plain(s) {
  return String(s || '')
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, ' '))
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/__([^_]*)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isEmptyDoc(doc) {
  return !(
    doc.headline ||
    doc.findings.length ||
    doc.topics.length ||
    doc.questions.length ||
    doc.notes.length ||
    doc.tests.length
  );
}

/* ================= block list =================
 * { k: 'title'|'sub'|'lead'|'h2'|'bullet'|'src'|'text'|'gap'|'rule' }
 */

export function renderBlocks(doc) {
  const b = [];
  const sec = (label, items, kind) => {
    if (!items || !items.length) return;
    b.push({ k: 'h2', t: label });
    for (const t of items) b.push({ k: kind, t });
    b.push({ k: 'gap' });
  };

  b.push({ k: 'title', t: doc.title });
  b.push({ k: 'sub', t: `Cortex · learning summary · exported ${doc.when}` });
  b.push({ k: 'rule' });
  if (doc.headline) b.push({ k: 'lead', t: doc.headline });

  sec('Key findings', doc.findings, 'bullet');
  if (doc.topics.length) {
    b.push({ k: 'h2', t: 'Topics' });
    b.push({ k: 'text', t: doc.topics.join(', ') });
    b.push({ k: 'gap' });
  }
  sec('Questions you asked', doc.questions, 'bullet');

  if (doc.notes.length) {
    b.push({ k: 'h2', t: 'Your notes' });
    for (const n of doc.notes) {
      b.push({ k: 'bullet', t: n.text });
      if (n.context) b.push({ k: 'src', t: `from: "${n.context}"` });
    }
    b.push({ k: 'gap' });
  }
  if (doc.tests.length) {
    b.push({ k: 'h2', t: 'Tests taken' });
    for (const t of doc.tests) {
      b.push({
        k: 'bullet',
        t: `${stamp(t.when)} - ${t.score}/${t.total} (${t.percent}%)`,
      });
    }
    b.push({ k: 'gap' });
  }
  return b;
}

/* ================= TXT ================= */

export function toTxt(blocks) {
  const out = [];
  for (const b of blocks) {
    switch (b.k) {
      case 'gap':
        out.push('');
        break;
      case 'rule':
        out.push('', '='.repeat(64));
        break;
      case 'lead':
        out.push('', String(b.t));
        break;
      case 'h2':
        out.push('', String(b.t).toUpperCase(), '-'.repeat(64));
        break;
      case 'bullet':
        out.push(`- ${b.t}`);
        break;
      case 'src':
        out.push(`    ${b.t}`);
        break;
      default:
        out.push(String(b.t));
    }
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

/* ================= PDF =================
 * Layout first (pages of positioned lines), then objects:
 *   1 Catalog  2 Pages  3 F1/Helvetica  4 F2/Helvetica-Bold
 *   5..4+N     Page objects
 *   5+N..4+2N  content streams
 * Everything is folded to <= 0xFF first, so one JS char == one file byte and
 * the xref offsets are just the running string lengths.
 */

const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN_L = 56;
const MARGIN_R = 56;
const MARGIN_T = 62;
const MARGIN_B = 56;
const CONTENT_W = PAGE_W - MARGIN_L - MARGIN_R;

const GREEK = {
  'α': 'alpha', 'β': 'beta', 'γ': 'gamma', 'δ': 'delta',
  'ε': 'epsilon', 'ζ': 'zeta', 'η': 'eta', 'θ': 'theta',
  'ι': 'iota', 'κ': 'kappa', 'λ': 'lambda', 'μ': 'mu',
  'ν': 'nu', 'ξ': 'xi', 'ο': 'omicron', 'π': 'pi',
  'ρ': 'rho', 'σ': 'sigma', 'ς': 'sigma', 'τ': 'tau',
  'υ': 'upsilon', 'φ': 'phi', 'χ': 'chi', 'ψ': 'psi', 'ω': 'omega',
  'Α': 'Alpha', 'Β': 'Beta', 'Γ': 'Gamma', 'Δ': 'Delta',
  'Ε': 'Epsilon', 'Ζ': 'Zeta', 'Η': 'Eta', 'Θ': 'Theta',
  'Ι': 'Iota', 'Κ': 'Kappa', 'Λ': 'Lambda', 'Μ': 'Mu',
  'Ν': 'Nu', 'Ξ': 'Xi', 'Ο': 'Omicron', 'Π': 'Pi',
  'Ρ': 'Rho', 'Σ': 'Sigma', 'Τ': 'Tau', 'Υ': 'Upsilon',
  'Φ': 'Phi', 'Χ': 'Chi', 'Ψ': 'Psi', 'Ω': 'Omega',
};

const SYM_MAP = [
  [/[‘’‚‛ʼ]/g, "'"],
  [/[“”„‟]/g, '"'],
  [/[–—―−]/g, '-'],
  [/…/g, '...'],
  [/[•▪‣◦]/g, '-'],
  [/→/g, '->'],
  [/←/g, '<-'],
  [/↑/g, '^'],
  [/↓/g, 'v'],
  [/⇒/g, '=>'],
  [/⇔/g, '<=>'],
  [/≈/g, '~='],
  [/≠/g, '!='],
  [/≤/g, '<='],
  [/≥/g, '>='],
  [/√/g, 'sqrt'],
  [/∞/g, 'inf'],
  [/∑/g, 'sum'],
  [/∫/g, 'int'],
  [/∆/g, 'Delta'],
  [/×/g, ' x '],
  [/÷/g, '/'],
  [/℃/g, ' C'],
  [/℉/g, ' F'],
  [/\u2126/g, 'ohm'],
  [/⁰/g, '0'], [/¹/g, '1'], [/²/g, '2'], [/³/g, '3'], [/⁴/g, '4'],
  [/⁵/g, '5'], [/⁶/g, '6'], [/⁷/g, '7'], [/⁸/g, '8'], [/⁹/g, '9'],
  [/₀/g, '_0'], [/₁/g, '_1'], [/₂/g, '_2'], [/₃/g, '_3'], [/₄/g, '_4'],
  [/₅/g, '_5'], [/₆/g, '_6'], [/₇/g, '_7'], [/₈/g, '_8'], [/₉/g, '_9'],
  [/[Ͱ-Ͽ]/g, (m) => GREEK[m] || '?'],
];

/* Latin-1 in, Latin-1 out: anything still above 0xFF (CJK, emoji, …) is a
 * glyph a base-14 font simply does not have — drop it rather than emit a
 * byte the PDF reader will map to something else. */
export function toLatin1(s) {
  let t = String(s == null ? '' : s);
  for (const [re, to] of SYM_MAP) t = t.replace(re, to);
  let out = '';
  for (const ch of t) {
    const cp = ch.codePointAt(0);
    if (cp <= 0xff && !(cp >= 0x80 && cp <= 0x9f)) out += ch;
  }
  return out;
}

let mctx = null;
function measure(text, size, bold) {
  const t = String(text);
  try {
    if (!mctx && typeof document !== 'undefined') {
      mctx = document.createElement('canvas').getContext('2d');
    }
    if (mctx) {
      mctx.font = `${bold ? 'bold ' : ''}${size}px Helvetica, Arial, sans-serif`;
      return mctx.measureText(t).width;
    }
  } catch {
    /* fall through — the estimate below is only used outside a browser */
  }
  return t.length * size * 0.52;
}

function wrapPdf(text, size, bold, maxW) {
  const words = String(text).split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines = [];
  let cur = '';
  const flush = () => {
    if (cur) {
      lines.push(cur);
      cur = '';
    }
  };
  for (const w of words) {
    const test = cur ? `${cur} ${w}` : w;
    if (cur && measure(test, size, bold) > maxW) {
      flush();
      cur = w;
    } else {
      cur = test;
    }
    /* One unbreakable token wider than the column: hard-split it. */
    if (!lines.length && !cur.includes(' ') && measure(cur, size, bold) > maxW) {
      let piece = '';
      for (const ch of cur) {
        if (piece && measure(piece + ch, size, bold) > maxW) {
          lines.push(piece);
          piece = ch;
        } else {
          piece += ch;
        }
      }
      cur = piece;
    }
  }
  flush();
  return lines;
}

const PDF_STYLE = {
  title: { size: 17, bold: true, gray: 0.08, x: 0, lh: 1.34 },
  sub: { size: 9, bold: false, gray: 0.42, x: 0, lh: 1.45 },
  lead: { size: 11, bold: false, gray: 0.1, x: 0, lh: 1.5 },
  h2: { size: 12, bold: true, gray: 0.1, x: 0, lh: 1.4 },
  text: { size: 10.5, bold: false, gray: 0.13, x: 0, lh: 1.45 },
  bullet: { size: 10.5, bold: false, gray: 0.13, x: 16, lh: 1.45 },
  src: { size: 9.5, bold: false, gray: 0.42, x: 30, lh: 1.45 },
};

function layoutPdf(blocks) {
  const pages = [];
  let cur = [];
  let y = PAGE_H - MARGIN_T;

  const newPage = () => {
    if (cur.length) pages.push(cur);
    cur = [];
    y = PAGE_H - MARGIN_T;
  };
  const add = (text, style) => {
    const size = style.size;
    const h = Math.round(size * style.lh * 10) / 10;
    const x = MARGIN_L + style.x;
    const width = CONTENT_W - style.x;
    const lines = wrapPdf(toLatin1(text), size, style.bold, width);
    for (const l of lines) {
      if (y - h < MARGIN_B) newPage();
      cur.push({ text: l, size, bold: style.bold, gray: style.gray, x, y });
      y -= h;
    }
  };

  for (const b of blocks) {
    if (b.k === 'gap') {
      y -= 8;
      continue;
    }
    if (b.k === 'rule') {
      if (y - 20 < MARGIN_B) newPage();
      cur.push({ rule: true, x: MARGIN_L, w: CONTENT_W, y: y - 8 });
      y -= 16;
      continue;
    }
    const st = PDF_STYLE[b.k];
    if (st) add(b.t, st);
  }
  if (cur.length) pages.push(cur);
  return pages.length ? pages : [[]];
}

const n2 = (v) => String(Math.round(v * 100) / 100);

function pdfStr(s) {
  const t = toLatin1(s)
    .replace(/[\x00-\x1f]/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .trim();
  return `(${t})`;
}

function pageOps(page) {
  const ops = [];
  for (const l of page) {
    if (l.rule) {
      ops.push(
        `0.6 w 0.6 G ${n2(l.x)} ${n2(l.y)} m ${n2(l.x + l.w)} ${n2(l.y)} l S`
      );
      continue;
    }
    ops.push(
      `BT ${n2(l.gray)} g /${l.bold ? 'F2' : 'F1'} ${n2(l.size)} Tf ` +
        `1 0 0 1 ${n2(l.x)} ${n2(l.y)} Tm ${pdfStr(l.text)} Tj ET`
    );
  }
  return ops.length ? `${ops.join('\n')}\n` : '';
}

export function toPdf(blocks) {
  const pages = layoutPdf(blocks);
  const N = pages.length;

  const bodies = [];
  bodies[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  const kids = [];
  for (let i = 0; i < N; i++) kids.push(`${5 + i} 0 R`);
  bodies[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${N} >>`;
  bodies[2] =
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  bodies[3] =
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  /* Object numbering: 1 Catalog, 2 Pages, 3 F1, 4 F2, then N pages at
   * 5..4+N and their content streams at 5+N..4+2N — so the content stream for
   * page i lives at index 4+N+i, which is exactly the number /Contents points
   * at (5+N+i). */
  for (let i = 0; i < N; i++) {
    bodies[4 + i] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      '/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> ' +
      `/Contents ${5 + N + i} 0 R >>`;
  }
  for (let i = 0; i < N; i++) {
    const data = `${pageOps(pages[i])}\n`;
    bodies[4 + N + i] = `<< /Length ${data.length} >>\nstream\n${data}endstream`;
  }

  const parts = [];
  let pos = 0;
  const push = (s) => {
    parts.push(s);
    pos += s.length;
  };
  const offsets = [];

  push('%PDF-1.4\n');
  bodies.forEach((body, i) => {
    offsets[i] = pos;
    push(`${i + 1} 0 obj\n${body}\nendobj\n`);
  });
  const xref = pos;
  push(`xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`);
  for (const off of offsets) push(`${String(off).padStart(10, '0')} 00000 n \n`);
  push(
    `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\n` +
      `startxref\n${xref}\n%%EOF\n`
  );

  const str = parts.join('');
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

/* ================= DOCX ================= */

function xmlEsc(s) {
  return String(s == null ? '' : s)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function wPara(text, o) {
  const opt = o || {};
  const sz = Math.round((opt.size || 10.5) * 2);
  const spacing =
    `<w:spacing w:before="${opt.before || 0}" w:after="${
      opt.after == null ? 100 : opt.after
    }"/>`;
  const ind = opt.indent ? `<w:ind w:left="${opt.indent}"/>` : '';
  const jc = opt.align ? `<w:jc w:val="${opt.align}"/>` : '';
  const pPr = `<w:pPr>${spacing}${ind}${jc}</w:pPr>`;
  const rPr =
    `<w:rPr>${opt.bold ? '<w:b/>' : ''}<w:color w:val="${
      opt.color || '1A1A1A'
    }"/><w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/></w:rPr>`;
  return `<w:p>${pPr}<w:r>${rPr}<w:t xml:space="preserve">${xmlEsc(
    text == null ? '' : text
  )}</w:t></w:r></w:p>`;
}

const DOCX_STYLE = {
  title: { size: 17, bold: true, color: '1F2430', after: 40 },
  sub: { size: 9, color: '6B7280', after: 140 },
  lead: { size: 11, color: '1F2430', after: 160 },
  h2: { size: 12, bold: true, color: '1F2430', before: 200, after: 80 },
  text: { size: 10.5, color: '21242D', after: 80 },
  bullet: { size: 10.5, color: '21242D', indent: 340, after: 60 },
  src: { size: 9.5, color: '6B7280', indent: 680, after: 90 },
};

function docxBody(blocks) {
  const out = [];
  for (const b of blocks) {
    if (b.k === 'gap') {
      out.push(wPara('', { after: 160 }));
      continue;
    }
    if (b.k === 'rule') {
      out.push(
        '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" ' +
          'w:space="1" w:color="C9CDD8"/></w:pBdr><w:spacing w:after="160"/>' +
          '</w:pPr></w:p>'
      );
      continue;
    }
    const st = DOCX_STYLE[b.k];
    if (!st) continue;
    out.push(wPara(b.k === 'bullet' ? `•  ${b.t}` : b.t, st));
  }
  return out.join('');
}

const DOCX_CT =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ' +
  'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '</Types>';

const DOCX_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" ' +
  'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" ' +
  'Target="word/document.xml"/></Relationships>';

function docxDocument(blocks) {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${docxBody(blocks)}` +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
    '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" ' +
    'w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>' +
    '</w:body></w:document>'
  );
}

/* ---- minimal STORED zip (no deflate) ---- */

const CRC_T = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(u8) {
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zip(files) {
  const enc = new TextEncoder();
  const u16 = (v) => [v & 255, (v >>> 8) & 255];
  const u32 = (v) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
  const now = new Date();
  const dosTime =
    ((now.getHours() & 31) << 11) |
    ((now.getMinutes() & 63) << 5) |
    ((now.getSeconds() >> 1) & 31);
  const dosDate =
    (((now.getFullYear() - 1980) & 127) << 9) |
    (((now.getMonth() + 1) & 15) << 5) |
    (now.getDate() & 31);

  const locals = [];
  const centrals = [];
  let offset = 0;
  let cdSize = 0;

  for (const f of files) {
    const name = enc.encode(f.name);
    const data = f.data;
    const crc = crc32(data);

    const lh = new Uint8Array([
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0),
      ...u16(dosTime), ...u16(dosDate),
      ...u32(crc), ...u32(data.length), ...u32(data.length),
      ...u16(name.length), ...u16(0),
    ]);
    locals.push(lh, name, data);

    const ch = new Uint8Array([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0),
      ...u16(dosTime), ...u16(dosDate),
      ...u32(crc), ...u32(data.length), ...u32(data.length),
      ...u16(name.length), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0), ...u32(0), ...u32(offset),
    ]);
    centrals.push(ch, name);
    offset += lh.length + name.length + data.length;
    cdSize += ch.length + name.length;
  }

  const eocd = new Uint8Array([
    ...u32(0x06054b50), ...u16(0), ...u16(0),
    ...u16(files.length), ...u16(files.length),
    ...u32(cdSize), ...u32(offset), ...u16(0),
  ]);

  const out = new Uint8Array(offset + cdSize + eocd.length);
  let p = 0;
  const put = (chunk) => {
    out.set(chunk, p);
    p += chunk.length;
  };
  for (const c of locals) put(c);
  for (const c of centrals) put(c);
  put(eocd);
  return out;
}

export function toDocx(blocks) {
  const enc = new TextEncoder();
  return zip([
    { name: '[Content_Types].xml', data: enc.encode(DOCX_CT) },
    { name: '_rels/.rels', data: enc.encode(DOCX_RELS) },
    { name: 'word/document.xml', data: enc.encode(docxDocument(blocks)) },
  ]);
}
