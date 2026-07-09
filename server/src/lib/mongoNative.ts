// Shared native MongoDB client + GridFS bucket.
//
// The app's structured data goes through Prisma, but two things use the native
// driver instead: the Google-Sheets export (Prisma's engine TLS is flaky on the
// office network — see the project memory) and file storage (Prisma has no
// GridFS support, and a single Prisma `Bytes` field is capped at Mongo's 16MB
// document limit, which the 26–30MB DXF drawings blow straight past).
//
// One cached client for the whole process; the DB name comes from the connection
// string (…/crmcts), same as everywhere else.

import { MongoClient, Db, GridFSBucket } from 'mongodb';

let cachedClient: MongoClient | null = null;
let cachedBucket: GridFSBucket | null = null;

export async function getMongo(): Promise<Db> {
  if (!cachedClient) {
    const uri = process.env.DATABASE_URL;
    if (!uri) throw new Error('DATABASE_URL is not set');
    cachedClient = new MongoClient(uri, { serverSelectionTimeoutMS: 20000 });
    await cachedClient.connect();
  }
  return cachedClient.db();
}

/** GridFS bucket "uploads" — chunks files into 255KB pieces, so any size fits. */
export async function getUploadsBucket(): Promise<GridFSBucket> {
  if (!cachedBucket) {
    const db = await getMongo();
    cachedBucket = new GridFSBucket(db, { bucketName: 'uploads' });
  }
  return cachedBucket;
}

export async function closeMongoNative(): Promise<void> {
  if (cachedClient) {
    await cachedClient.close();
    cachedClient = null;
    cachedBucket = null;
  }
}
