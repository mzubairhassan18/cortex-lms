/*
 * extract.js — read a file's text in the browser, before it is uploaded.
 *
 * Why here and not in the Worker: pdf.js and mammoth are multi-MB, DOM-bearing
 * libraries, and a Cloudflare Worker request is billed a CPU budget measured
 * in milliseconds — parsing even a small PDF would spend it. The browser pays
 * that cost once, on a machine that already has the bytes in hand, and the
 * Worker receives text it only has to validate and store (PLAN §3.3).
 *
 * It also means the library cannot be attached without being readable: an
 * unsupported file fails here, before the upload, with the message v1 showed.
 *
 * Both libraries are vendored under public/vendor/ by scripts/vendor-libs.mjs
 * and loaded lazily, so a session that only ever attaches .txt files never
 * downloads them. Paths are resolved against this module's own URL rather than
 * against the document, because the same code has to work at the site root
 * (Cloudflare) and under /cortex-lms/ (the GitHub Pages mirror) — a document
 * relative URL would land on /app/vendor/... at the root deploy.
 */

const TEXT_EXTS = [
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json',
  '.html', '.htm', '.log', '.xml', '.yml', '.yaml',
];

/** Lower-case extension including the dot, '' when there is none. */
export function extOf(name) {
  const base = String(name || '').split(/[\\/]/).pop() || '';
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i).toLowerCase() : '';
}

/**
 * @param {ArrayBuffer} buf  the file, already read
 * @param {string} name      its original filename (the extension is what it is judged on)
 * @returns {Promise<string>} extracted text
 */
export async function extractFileText(buf, name) {
  const ext = extOf(name);
  if (TEXT_EXTS.includes(ext)) {
    // Plain text needs no library at all — and it is the common case.
    return new TextDecoder().decode(buf).replace(/^\uFEFF/, '');
  }
  if (ext === '.pdf') return pdfText(buf);
  if (ext === '.docx') return docxText(buf);
  if (ext === '.doc') {
    throw new Error('Old .doc files are not supported — open it and “Save as” .docx or PDF.');
  }
  throw new Error('Unsupported type — use Word (.docx), PDF, or a text file.');
}

async function pdfText(buf) {
  const { PDFParse } = await import('../vendor/pdf-parse/pdf-parse.es.js');
  /* pdf.js defaults workerSrc to "./pdf.worker.mjs", which it resolves against
   * window.location — and this app is served at /app/, so the default looks in
   * the wrong directory. Hand it an absolute URL derived from this module's own
   * location instead; import.meta.url carries whatever base the host chose. */
  PDFParse.setWorker(new URL('../vendor/pdf-parse/pdf.worker.mjs', import.meta.url).href);
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try {
    const result = await parser.getText();
    return String((result && result.text) || '');
  } finally {
    // Frees the worker; without it every PDF uploaded in a session leaks one.
    await parser.destroy().catch(() => {});
  }
}

async function docxText(buf) {
  const mammoth = await loadMammoth();
  // mammoth ships a UMD browser bundle, so it arrives as a classic script
  // rather than an import. Its arrayBuffer input is the browser-only branch of
  // the same extractRawText() the Node build exposes.
  const result = await mammoth.extractRawText({ arrayBuffer: buf });
  return String((result && result.value) || '');
}

let mammothPromise = null;

function loadMammoth() {
  if (mammothPromise) return mammothPromise;
  mammothPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = new URL('../vendor/mammoth.browser.min.js', import.meta.url).href;
    script.onload = () =>
      window.mammoth ? resolve(window.mammoth) : reject(new Error('Could not start the Word reader.'));
    script.onerror = () => reject(new Error('Could not load the Word reader.'));
    document.head.appendChild(script);
  });
  return mammothPromise;
}
