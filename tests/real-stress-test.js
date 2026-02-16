/**
 * Real API Stress Test - Forces Fresh Logins
 *
 * This test forces actual login API calls by clearing the token cache
 * between requests. This tests the real rate limiting behavior.
 *
 * WARNING: This will make multiple actual login calls to OpenSubtitles.
 * Run sparingly to avoid getting rate-limited.
 *
 * Usage: node tests/real-stress-test.js <username> <password>
 */

require('dotenv').config();

const CREDENTIALS = {
  username: process.argv[2] || process.env.OS_TEST_USER || '',
  password: process.argv[3] || process.env.OS_TEST_PASS || ''
};

const API_KEY = process.env.OPENSUBTITLES_API_KEY;

if (!API_KEY || !CREDENTIALS.username || !CREDENTIALS.password) {
  console.error('ERROR: API_KEY, username and password required');
  console.log('Usage: node tests/real-stress-test.js <username> <password>');
  process.exit(1);
}

console.log('='.repeat(60));
console.log('Real API Stress Test - Fresh Logins');
console.log('='.repeat(60));
console.log(`Username: ${CREDENTIALS.username}`);
console.log('');
console.log('This test will make 5 actual login calls to OpenSubtitles.');
console.log('Expected time: ~8 seconds (due to rate limiting)\n');

async function clearTokenCache() {
  const { deleteShared, CACHE_PREFIXES } = require('../src/utils/sharedCache');
  const { StorageAdapter } = require('../src/storage');
  const crypto = require('crypto');

  // Calculate the cache key
  const normalized = CREDENTIALS.username.trim().toLowerCase();
  const secret = `${normalized}:${CREDENTIALS.password}`;
  const cacheKey = crypto.createHash('sha256').update(secret).digest('hex');

  // Delete from shared cache
  await deleteShared(`ostoken:${cacheKey}`, StorageAdapter.CACHE_TYPES.SESSION);
  console.log('  [Cleared token cache]');
}

async function main() {
  // Clear module cache to reset static state
  delete require.cache[require.resolve('../src/services/opensubtitles')];

  const OpenSubtitlesService = require('../src/services/opensubtitles');

  // Clear token cache first
  await clearTokenCache();

  const NUM_LOGINS = 5;
  const timestamps = [];
  const results = [];

  console.log(`Starting ${NUM_LOGINS} sequential login calls...\n`);

  for (let i = 0; i < NUM_LOGINS; i++) {
    // Clear token cache before each login to force fresh API call
    await clearTokenCache();

    // Clear local cache too
    delete require.cache[require.resolve('../src/services/opensubtitles')];
    const Fresh = require('../src/services/opensubtitles');
    const service = new Fresh(CREDENTIALS);

    const start = Date.now();
    try {
      const token = await service.login(20000);
      const elapsed = Date.now() - start;
      timestamps.push(Date.now());

      if (token) {
        console.log(`  Login ${i + 1}: ✓ Success in ${elapsed}ms`);
        results.push({ ok: true, elapsed });
      } else {
        console.log(`  Login ${i + 1}: ✗ Returned null in ${elapsed}ms`);
        results.push({ ok: false, elapsed, error: 'null token' });
      }
    } catch (err) {
      const elapsed = Date.now() - start;
      console.log(`  Login ${i + 1}: ✗ Failed in ${elapsed}ms - ${err.message}`);
      results.push({ ok: false, elapsed, error: err.message, statusCode: err.statusCode });
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('RESULTS');
  console.log('='.repeat(60));

  const successful = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  const rateLimited = results.filter(r => r.statusCode === 429).length;

  console.log(`Successful logins: ${successful}/${NUM_LOGINS}`);
  console.log(`Failed logins: ${failed}/${NUM_LOGINS}`);

  if (rateLimited > 0) {
    console.log(`⚠ Rate limited (429 errors): ${rateLimited}`);
  }

  // Check intervals
  if (timestamps.length >= 2) {
    const intervals = [];
    for (let i = 1; i < timestamps.length; i++) {
      intervals.push(timestamps[i] - timestamps[i - 1]);
    }
    const minInterval = Math.min(...intervals);
    const avgInterval = Math.round(intervals.reduce((a, b) => a + b) / intervals.length);

    console.log(`\nLogin intervals:`);
    console.log(`  Min: ${minInterval}ms`);
    console.log(`  Avg: ${avgInterval}ms`);

    if (minInterval < 1000) {
      console.log(`\n⚠ WARNING: Min interval < 1000ms - rate limiting may not be working!`);
    } else {
      console.log(`\n✓ Rate limiting working - all intervals >= 1000ms`);
    }
  }

  const allOk = results.every(r => r.ok) && rateLimited === 0;

  console.log('\n' + (allOk
    ? '✓ TEST PASSED - All logins succeeded with proper rate limiting'
    : '✗ TEST FAILED'));

  process.exit(allOk ? 0 : 1);
}

main().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
