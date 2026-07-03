import 'dotenv/config';
import fs from 'fs';
import { persistToDb } from './src/lib/fileStore';
import { MongoClient, GridFSBucket } from 'mongodb';
(async () => {
  // make a small test file
  fs.writeFileSync('_probe.txt', 'hello-durable-'+Date.now());
  await persistToDb('_probe.txt', '_probe.txt', 'text/plain');
  // verify it exists in GridFS
  const client = new MongoClient(process.env.DATABASE_URL!);
  await client.connect();
  const b = new GridFSBucket(client.db(), { bucketName: 'uploads' });
  const files = await b.find({ filename: '_probe.txt' }).toArray();
  console.log('GridFS files named _probe.txt:', files.length, files[0] ? `(size ${files[0].length} bytes, type ${(files[0].metadata as any)?.mimeType})` : '');
  // read it back
  let content = '';
  await new Promise<void>((r) => b.openDownloadStreamByName('_probe.txt').on('data', (c) => content += c).on('end', r));
  console.log('read back:', content.slice(0, 30));
  // cleanup
  for (const f of files) await b.delete(f._id);
  await client.close(); fs.rmSync('_probe.txt');
  console.log('✓ GridFS persist + read + cleanup OK');
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
