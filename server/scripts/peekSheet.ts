import 'dotenv/config';
import { getSheetsClient, getSpreadsheetId } from '../src/services/sheetsSync';

async function main() {
  const sheets = getSheetsClient();
  const spreadsheetId = getSpreadsheetId();
  for (const range of ['Users!A1:D6', 'Projects!A1:E2', 'BOQItems!A1:D4']) {
    const r = await sheets.spreadsheets.values.get({ spreadsheetId, range });
    console.log(`\n=== ${range} ===`);
    for (const row of r.data.values || []) console.log(row.join(' | '));
  }
  process.exit(0);
}
main().catch((e) => { console.error(e?.message || e); process.exit(1); });
