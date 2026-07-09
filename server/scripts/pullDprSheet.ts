// Pull the DPR_Cold_Storage_RoomWise workbook out of Drive and archive it into
// the repo. It is an .xlsx living in Drive (NOT a native Google Sheet), so the
// Sheets API 400s on it — we must go through Drive files.get + alt:'media'.
//
// Writes two artefacts under docs/dpr-sheet/:
//   DPR_Cold_Storage_RoomWise.xlsx  — byte-for-byte copy of the source workbook
//   dpr-sheet-snapshot.json         — every tab's cells + every formula, decoded
//
// Run:  npx tsx scripts/_tmp_dprDump.ts
import 'dotenv/config';
import { google } from 'googleapis';
import * as XLSX from 'xlsx';
import * as fs from 'fs';
import * as path from 'path';

const FILE_ID = '1mVSD7857cqC3-YHOZFAQcy94e_VxHTen';
const OUT_DIR = path.resolve(__dirname, '../../docs/dpr-sheet');

async function main() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON!);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
  const drive = google.drive({ version: 'v3', auth });

  const meta = await drive.files.get({ fileId: FILE_ID, fields: 'id,name,mimeType,size,modifiedTime' });
  console.log('source:', JSON.stringify(meta.data));

  const res = await drive.files.get({ fileId: FILE_ID, alt: 'media' }, { responseType: 'arraybuffer' });
  const buf = Buffer.from(res.data as any);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'DPR_Cold_Storage_RoomWise.xlsx'), buf);

  const wb = XLSX.read(buf, { type: 'buffer', cellFormula: true, cellStyles: false });
  const out: any = {
    source: meta.data,
    pulledAt: new Date().toISOString(),
    tabs: wb.SheetNames,
    sheets: {} as Record<string, unknown>,
  };
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' }) as any[][];
    const formulas: Record<string, string> = {};
    for (const addr of Object.keys(ws)) {
      if (addr.startsWith('!')) continue;
      const cell: any = (ws as any)[addr];
      if (cell?.f) formulas[addr] = cell.f;
    }
    out.sheets[name] = { rows: rows.filter((r) => r.some((c) => String(c).trim() !== '')), formulas };
  }
  fs.writeFileSync(path.join(OUT_DIR, 'dpr-sheet-snapshot.json'), JSON.stringify(out, null, 1));

  console.log('archived ->', OUT_DIR);
  console.log('tabs:', wb.SheetNames.join(' | '));
}
main().catch((e) => { console.error('ERR', e?.message || e); process.exit(1); });
