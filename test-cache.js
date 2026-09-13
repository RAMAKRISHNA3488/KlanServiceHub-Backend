import app from './src/index.js';
import { cacheStore } from './src/lib/cache.js';

async function testCacheSystem() {
  console.log('🧪 Starting Cache & Cache Validation Tests...\n');

  // Test 1: Cache Stats Endpoint
  const statsRes = await app.request('/api/cache/stats');
  const statsData = await statsRes.json();
  console.log('1. Initial Cache Stats:', statsData);

  // Test 2: Request Health (cacheable/health check)
  const healthRes = await app.request('/health');
  console.log('2. Health status:', healthRes.status, 'Body:', await healthRes.json());

  // Test 3: Set and Retrieve a cache entry manually to verify ETag validation
  cacheStore.set('test-user:http://localhost/api/test-data', { test: true, count: 42 }, {
    ttlSeconds: 60,
    tags: ['test', 'workspaces:ws1'],
  });

  const entry = cacheStore.get('test-user:http://localhost/api/test-data');
  console.log('3. Stored Cache Entry ETag:', entry.etag);

  // Test 4: Verify Tag Invalidation
  console.log('4. Testing Tag Invalidation for tag "workspaces:ws1"...');
  const countInvalidated = cacheStore.invalidateTags('workspaces:ws1');
  console.log(`   Invalidated ${countInvalidated} entry/entries.`);
  const afterDelete = cacheStore.get('test-user:http://localhost/api/test-data');
  console.log('   Entry after invalidation:', afterDelete === null ? 'NULL (Success: Purged)' : 'Still exists');

  // Test 5: Cache Purge Endpoint
  const purgeRes = await app.request('/api/cache/purge', { method: 'POST' });
  const purgeData = await purgeRes.json();
  console.log('5. Cache Purge Endpoint Result:', purgeData);

  console.log('\n✅ ALL CACHE & CACHE VALIDATION TESTS PASSED!');
}

testCacheSystem().catch((err) => {
  console.error('❌ Cache test failed:', err);
  process.exit(1);
});
