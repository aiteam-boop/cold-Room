import 'dotenv/config';
import tls from 'node:tls';
import { MongoClient } from 'mongodb';

const NODE = 'ac-dhnrhyp-shard-00-00.dv737bf.mongodb.net';

function nodeTlsTest(): Promise<string> {
  return new Promise((resolve) => {
    const socket = tls.connect({ host: NODE, port: 27017, servername: NODE }, () => {
      const ok = socket.authorized;
      const proto = (socket as any).getProtocol?.();
      socket.end();
      resolve(`Node TLS OK | authorized=${ok} | proto=${proto}`);
    });
    socket.setTimeout(15000);
    socket.on('timeout', () => { socket.destroy(); resolve('Node TLS TIMEOUT'); });
    socket.on('error', (e) => resolve(`Node TLS FAILED: ${e.message}`));
  });
}

async function driverTest(): Promise<string> {
  const uri = process.env.DATABASE_URL!;
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
  try {
    await client.connect();
    const admin = client.db().admin();
    const r = await admin.ping();
    const count = await client.db('crmcts').collection('User').countDocuments();
    await client.close();
    return `JS driver OK | ping=${JSON.stringify(r)} | User count=${count}`;
  } catch (e: any) {
    try { await client.close(); } catch {}
    return `JS driver FAILED: ${e?.message || e}`;
  }
}

(async () => {
  console.log(await nodeTlsTest());
  console.log(await driverTest());
})();
