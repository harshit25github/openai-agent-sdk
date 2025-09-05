import 'dotenv/config';
import { createClient } from 'redis';

async function checkVectorSupport() {
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379/0'; // pin DB if you want
  const client = createClient({ url });

  client.on('error', (err) => console.error('Redis error:', err));
  await client.connect();
  console.log('Connected to', url);

  // 1) Is RediSearch present?
  let hasRediSearch = false;
  try {
    await client.sendCommand(['FT._LIST']); // will throw if module not loaded
    hasRediSearch = true;
    console.log('RediSearch module detected ✅');
  } catch {
    console.log('RediSearch NOT detected ❌ (FT._LIST failed)');
  }

  // 2) Try creating a tiny vector index to confirm VECTOR support
  const indexName = `__vector_test__${Date.now()}`;
  let vectorWorks = false;

  if (hasRediSearch) {
    try {
      await client.sendCommand([
        'FT.CREATE', indexName,
        'ON', 'HASH',
        'SCHEMA',
        'v', 'VECTOR', 'HNSW', '6',
        'TYPE', 'FLOAT32',
        'DIM', '4',
        'DISTANCE_METRIC', 'COSINE'
      ]);
      vectorWorks = true;
      console.log('VECTOR index creation works ✅');
    } catch (e: any) {
      console.log('VECTOR index creation failed ❌');
      console.log('Reason:', e?.message ?? e);
    } finally {
      // clean up (drop index if it was created)
      try {
        await client.sendCommand(['FT.DROPINDEX', indexName, 'DD']);
      } catch {/* ignore */}
    }
  }

  console.log('\n=== Summary ===');
  console.log(`RediSearch present: ${hasRediSearch}`);
  console.log(`VECTOR support:     ${vectorWorks}`);

  if (!hasRediSearch) {
    console.log('→ Install Redis Stack (or Redis Enterprise/Cloud with RediSearch).');
  } else if (!vectorWorks) {
    console.log('→ RediSearch installed but VECTOR unsupported. Upgrade to RediSearch 2.4+ / Redis Stack.');
  }

  await client.quit();
}

checkVectorSupport().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
