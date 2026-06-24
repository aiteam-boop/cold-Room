import 'dotenv/config';
import { google } from 'googleapis';

async function main() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const spreadsheetId = process.env.SPREADSHEET_ID;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON missing in .env');
  if (!spreadsheetId) throw new Error('SPREADSHEET_ID missing in .env');

  const creds = JSON.parse(raw);
  console.log('Service account:', creds.client_email);
  console.log('Spreadsheet ID :', spreadsheetId);

  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  console.log('\n✅ SUCCESS — connected to Sheet:', meta.data.properties?.title);
  console.log('Tabs:', meta.data.sheets?.map((s) => s.properties?.title).join(', '));
}

main().catch((e) => {
  console.error('\n❌ FAILED:', e?.errors?.[0]?.message || e?.message || e);
  if (String(e?.message || e).includes('does not have permission') || e?.code === 403) {
    console.error('\n>>> The Sheet is NOT shared with the service account yet.');
  }
  process.exit(1);
});
