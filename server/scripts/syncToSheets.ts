import 'dotenv/config';
import { exportAll, sheetsEnabled, getSpreadsheetId } from '../src/services/sheetsSync';

async function main() {
  if (!sheetsEnabled()) {
    console.error('Sheets sync disabled — set GOOGLE_SERVICE_ACCOUNT_JSON and SPREADSHEET_ID in .env');
    process.exit(1);
  }
  console.log('Exporting all collections to spreadsheet:', getSpreadsheetId());
  const result = await exportAll();
  console.log('\nDone. Rows written per tab:');
  for (const r of result) console.log(`  ${r.tab.padEnd(22)} ${r.rows}`);
  const total = result.reduce((a, b) => a + b.rows, 0);
  console.log(`\nTotal rows: ${total}`);
  process.exit(0);
}

main().catch((e) => {
  console.error('Export failed:', e?.errors?.[0]?.message || e?.message || e);
  process.exit(1);
});
