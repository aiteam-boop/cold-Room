import fs from 'fs';

// Extract plain text from a PDF (text-based drawings). Returns '' on failure
// (e.g. scanned/image-only PDFs) so callers can fall back to the filename.
export async function extractPdfText(filePath: string, maxChars = 6000): Promise<string> {
  try {
    const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const buf = new Uint8Array(fs.readFileSync(filePath));
    const doc = await pdfjs.getDocument({ data: buf, useSystemFonts: true, isEvalSupported: false }).promise;
    let text = '';
    for (let i = 1; i <= Math.min(doc.numPages, 6) && text.length < maxChars; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      text += tc.items.map((it: any) => it.str).join(' ') + ' ';
    }
    return text.replace(/\s+/g, ' ').trim().slice(0, maxChars);
  } catch (err) {
    console.error('[extractPdfText] failed:', (err as Error).message);
    return '';
  }
}
