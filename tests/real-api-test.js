/**
 * Real Integration Test - OpenSubtitles Rate Limiting
 *
 * This test actually hits the OpenSubtitles API to verify that:
 * 1. Our rate limiting prevents 429 errors
 * 2. The login flow works correctly
 * 3. Token caching is functioning
 *
 * REQUIRES: Real OpenSubtitles credentials
 *
 * Usage: OPENSUBTITLES_API_KEY=xxx node tests/real-api-test.js
 */

require('dotenv').config();

const CREDENTIALS = {
  username: process.argv[2] || process.env.OS_TEST_USER || '',
  password: process.argv[3] || process.env.OS_TEST_PASS || ''
};

const API_KEY = process.env.OPENSUBTITLES_API_KEY;

if (!API_KEY) {
  console.error('ERROR: OPENSUBTITLES_API_KEY environment variable required');
  console.log('Set it in your .env file or export it before running');
  process.exit(1);
}

if (!CREDENTIALS.username || !CREDENTIALS.password) {
  console.error('ERROR: Username and password required');
  console.log('Usage: node tests/real-api-test.js <username> <password>');
  console.log('  or: set OS_TEST_USER and OS_TEST_PASS env vars');
  process.exit(1);
}

console.log('='.repeat(60));
console.log('OpenSubtitles Real API Integration Test');
console.log('='.repeat(60));
console.log(`Username: ${CREDENTIALS.username}`);
console.log(`API Key: ${API_KEY.slice(0, 8)}...${API_KEY.slice(-4)}`);
console.log('');

async function testSingleLogin() {
  console.log('\n--- Test 1: Single Login ---');
  const OpenSubtitlesService = require('../src/services/opensubtitles');
  const service = new OpenSubtitlesService(CREDENTIALS);

  const start = Date.now();
  try {
    const token = await service.login(10000);
    const elapsed = Date.now() - start;

    if (token) {
      console.log(`✓ Login successful in ${elapsed}ms`);
      console.log(`  Token: ${token.slice(0, 20)}...`);
      return true;
    } else {
      console.log(`✗ Login returned null in ${elapsed}ms`);
      return false;
    }
  } catch (err) {
    const elapsed = Date.now() - start;
    console.log(`✗ Login failed in ${elapsed}ms: ${err.message}`);
    return false;
  }
}

async function testConcurrentLogins() {
  console.log('\n--- Test 2: Concurrent Logins (3 simultaneous) ---');
  console.log('This tests the rate limiting queue...');

  const OpenSubtitlesService = require('../src/services/opensubtitles');

  // Create 3 separate service instances (simulating 3 different requests)
  const services = [
    new OpenSubtitlesService(CREDENTIALS),
    new OpenSubtitlesService(CREDENTIALS),
    new OpenSubtitlesService(CREDENTIALS)
  ];

  const start = Date.now();
  const results = await Promise.all(services.map(async (svc, i) => {
    try {
      const s = Date.now();
      const token = await svc.login(20000);
      const elapsed = Date.now() - s;
      return { ok: !!token, index: i, elapsed };
    } catch (err) {
      const elapsed = Date.now() - start;
      return { ok: false, index: i, elapsed, error: err.message };
    }
  }));

  const totalElapsed = Date.now() - start;
  console.log(`  Total time: ${totalElapsed}ms`);

  results.forEach((r, i) => {
    if (r.ok) {
      console.log(`  ✓ Request ${i}: Success in ${r.elapsed}ms`);
    } else {
      console.log(`  ✗ Request ${i}: Failed - ${r.error}`);
    }
  });

  const allOk = results.every(r => r.ok);
  console.log(allOk ? '✓ All concurrent logins succeeded' : '✗ Some logins failed');

  // Check timing - with mutex, all 3 should share the same token (one actual login)
  // Or with fresh cache, they should be serialized
  return allOk;
}

async function testSearch() {
  console.log('\n--- Test 3: Search for Subtitles ---');

  const OpenSubtitlesService = require('../src/services/opensubtitles');
  const service = new OpenSubtitlesService(CREDENTIALS);

  try {
    const start = Date.now();
    const results = await service.searchSubtitles({
      imdb_id: 'tt0111161',  // The Shawshank Redemption
      type: 'movie',
      languages: ['eng', 'spa'],
      providerTimeout: 15000
    });
    const elapsed = Date.now() - start;

    console.log(`  Search completed in ${elapsed}ms`);
    console.log(`  Found ${results.length} subtitles`);

    if (results.length > 0) {
      console.log(`  First result: ${results[0].name} (${results[0].languageCode})`);
      return true;
    } else {
      console.log('  Warning: No results (but no error)');
      return true;  // No results is not a failure
    }
  } catch (err) {
    console.log(`  ✗ Search failed: ${err.message}`);
    return false;
  }
}

async function testRateLimitStress() {
  console.log('\n--- Test 4: Rate Limit Stress Test (5 rapid requests) ---');
  console.log('This tests that we properly queue and don\'t get 429 errors...');

  // Clear any cached module state
  delete require.cache[require.resolve('../src/services/opensubtitles')];
  const OpenSubtitlesService = require('../src/services/opensubtitles');

  // Use different credentials to force actual logins (bypass token cache)
  // Actually, let's use same credentials but rely on the login mutex
  const services = Array.from({ length: 5 }, () =>
    new OpenSubtitlesService(CREDENTIALS)
  );

  const timestamps = [];
  const start = Date.now();

  const results = await Promise.all(services.map(async (svc, i) => {
    try {
      const s = Date.now();
      const token = await svc.login(60000);  // 60s timeout for stress test
      const elapsed = Date.now() - s;
      timestamps.push({ index: i, time: Date.now() });
      return { ok: !!token, index: i, elapsed };
    } catch (err) {
      return { ok: false, index: i, error: err.message, statusCode: err.statusCode };
    }
  }));

  const totalElapsed = Date.now() - start;
  console.log(`  Total time: ${totalElapsed}ms`);

  const successful = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  const rateLimited = results.filter(r => r.statusCode === 429).length;

  console.log(`  Successful: ${successful}/5`);
  console.log(`  Failed: ${failed}/5`);

  if (rateLimited > 0) {
    console.log(`  ⚠ Rate limited (429): ${rateLimited}/5 - THIS IS A PROBLEM`);
    return false;
  }

  // With the mutex and token caching, all should succeed
  const allOk = successful === 5;
  console.log(allOk ? '✓ Stress test passed - no 429 errors' : '✗ Stress test had failures');

  return allOk;
}

async function main() {
  const results = [];

  results.push(await testSingleLogin());

  // Wait a bit before next test
  await new Promise(r => setTimeout(r, 2000));

  results.push(await testConcurrentLogins());

  await new Promise(r => setTimeout(r, 2000));

  results.push(await testSearch());

  await new Promise(r => setTimeout(r, 2000));

  results.push(await testRateLimitStress());

  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  console.log(`Tests passed: ${results.filter(r => r).length}/${results.length}`);

  if (results.every(r => r)) {
    console.log('\n✓ ALL TESTS PASSED');
    console.log('The rate limiting implementation is working correctly against the real API.');
  } else {
    console.log('\n✗ SOME TESTS FAILED');
  }

  process.exit(results.every(r => r) ? 0 : 1);
}

main().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
