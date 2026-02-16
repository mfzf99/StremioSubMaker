/**
 * Production-Realistic Rate Limiting Test
 *
 * This test simulates actual SubMaker behavior more accurately:
 * 1. Token caching - most requests don't need to login at all
 * 2. Gradual load - requests don't all arrive at exactly the same instant
 * 3. Multiple users - different credential sets have separate tokens
 *
 * The key insight: In production, the token is cached for 23 hours.
 * Login only happens when:
 * - First request from a user
 * - Token expired (rare)
 * - Token was invalidated by OpenSubtitles
 *
 * Run with: node tests/realistic-rate-test.js
 */

const { performance } = require('perf_hooks');

// Mock Redis client
class MockRedisClient {
  constructor() {
    this.data = new Map();
    this.ttls = new Map();
    this.requestCount = 0;
    this.lockContentionCount = 0;
    this.DEBUG = false;
  }

  async set(key, value, ...args) {
    this.requestCount++;
    let px = null, nx = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === 'PX' && args[i + 1]) { px = parseInt(args[i + 1]); i++; }
      else if (args[i] === 'NX') { nx = true; }
    }

    // Check TTL for existing key
    const existingTTL = this.ttls.get(key);
    if (nx && this.data.has(key) && existingTTL && Date.now() < existingTTL) {
      this.lockContentionCount++;
      return null;
    }

    this.data.set(key, value);
    if (px) this.ttls.set(key, Date.now() + px);
    return 'OK';
  }

  async get(key) {
    this.requestCount++;
    const ttl = this.ttls.get(key);
    if (ttl && Date.now() > ttl) {
      this.data.delete(key);
      this.ttls.delete(key);
      return null;
    }
    return this.data.get(key) || null;
  }

  async pttl(key) {
    this.requestCount++;
    const expireAt = this.ttls.get(key);
    if (!expireAt) return -2;
    const remaining = expireAt - Date.now();
    if (remaining <= 0) { this.data.delete(key); this.ttls.delete(key); return -2; }
    return remaining;
  }

  async eval(script, numKeys, ...args) {
    this.requestCount++;
    const keys = args.slice(0, numKeys);
    const argv = args.slice(numKeys);

    if (script.includes('if currentOwner == ARGV[1]')) {
      const key = keys[0];
      const ownerId = argv[0];
      const ttlMs = parseInt(argv[1]);
      const currentOwner = this.data.get(key);
      if (currentOwner === ownerId) {
        this.data.set(key, ownerId);
        this.ttls.set(key, Date.now() + ttlMs);
        return 1;
      }
      return 0;
    }
    return null;
  }

  getStats() {
    return { requestCount: this.requestCount, lockContentionCount: this.lockContentionCount };
  }
}

// Simulated Pod with token caching
class SimulatedPod {
  constructor(podId, sharedRedis) {
    this.podId = podId;
    this.redis = sharedRedis;
    this.ownerId = `pod${podId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    // Token cache (per-user)
    this.tokenCache = new Map();
    this.TOKEN_TTL_MS = 23 * 60 * 60 * 1000; // 23 hours

    // Metrics
    this.totalRequests = 0;
    this.cacheHits = 0;
    this.loginAttempts = 0;
    this.loginSuccesses = 0;
    this.loginFailures = 0;
    this.lockWaits = 0;
    this.lockTimeouts = 0;
    this.loginTimestamps = [];

    // Rate limiting state
    this._localLastLoginTime = 0;
    this._loginQueue = Promise.resolve();

    // Constants - v1.4.58 values
    this.LOGIN_MIN_INTERVAL_MS = 1100;
    this.DISTRIBUTED_LOGIN_COOLDOWN_MS = 1100;
    this.MAX_LOCK_WAIT_CYCLES = 20;  // Increased from 4
    this.TOTAL_LOCK_TIMEOUT_MS = 45000;  // Increased from 6000
    this.LOCK_KEY = 'os_login_cooldown';
  }

  getCacheKey(username) {
    return `token:${username}`;
  }

  async getCachedToken(username) {
    // L1: Check local cache
    const local = this.tokenCache.get(this.getCacheKey(username));
    if (local && Date.now() < local.expiry) {
      return local.token;
    }

    // L2: Check Redis (simulating cross-pod cache)
    const redisKey = `ostoken:${username}`;
    const cached = await this.redis.get(redisKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (parsed.expiry > Date.now()) {
        // Populate local cache
        this.tokenCache.set(this.getCacheKey(username), parsed);
        return parsed.token;
      }
    }
    return null;
  }

  async setCachedToken(username, token, expiry) {
    const cacheKey = this.getCacheKey(username);
    this.tokenCache.set(cacheKey, { token, expiry });

    // Also cache in Redis
    const redisKey = `ostoken:${username}`;
    await this.redis.set(redisKey, JSON.stringify({ token, expiry }), 'PX', this.TOKEN_TTL_MS);
  }

  async tryAcquireLock(ttlMs) {
    const fullKey = `lock:${this.LOCK_KEY}`;
    const result = await this.redis.set(fullKey, this.ownerId, 'PX', ttlMs, 'NX');
    return { acquired: result === 'OK', ownerId: result === 'OK' ? this.ownerId : null };
  }

  async getLockTTL() {
    const fullKey = `lock:${this.LOCK_KEY}`;
    const ttl = await this.redis.pttl(fullKey);
    return ttl < 0 ? 0 : ttl;
  }

  async refreshLock(ttlMs, ownerId) {
    const fullKey = `lock:${this.LOCK_KEY}`;
    const script = `local currentOwner = redis.call('get', KEYS[1]) if currentOwner == ARGV[1] then redis.call('set', KEYS[1], ARGV[1], 'PX', ARGV[2]) return 1 else return 0 end`;
    const result = await this.redis.eval(script, 1, fullKey, ownerId, ttlMs);
    return result === 1;
  }

  async performLogin(username) {
    this.loginAttempts++;
    const lockStartTime = performance.now();

    // Local throttle
    const now = performance.now();
    const timeSinceLast = now - this._localLastLoginTime;
    if (timeSinceLast < this.LOGIN_MIN_INTERVAL_MS && this._localLastLoginTime > 0) {
      await new Promise(r => setTimeout(r, this.LOGIN_MIN_INTERVAL_MS - timeSinceLast));
    }

    // Distributed lock acquisition
    let lockResult = await this.tryAcquireLock(this.DISTRIBUTED_LOGIN_COOLDOWN_MS);
    let acquired = lockResult.acquired;
    let ownerId = lockResult.ownerId;
    let waitCycles = 0;

    while (!acquired && waitCycles < this.MAX_LOCK_WAIT_CYCLES) {
      if (performance.now() - lockStartTime > this.TOTAL_LOCK_TIMEOUT_MS) {
        this.lockTimeouts++;
        throw new Error('Queue timeout');
      }

      const remainingTTL = await this.getLockTTL();
      this.lockWaits++;

      if (remainingTTL > 0) {
        const jitter = 50 + Math.floor(Math.random() * 100);
        await new Promise(r => setTimeout(r, remainingTTL + jitter));
      } else {
        await new Promise(r => setTimeout(r, 50 + Math.floor(Math.random() * 50)));
      }

      lockResult = await this.tryAcquireLock(this.DISTRIBUTED_LOGIN_COOLDOWN_MS);
      acquired = lockResult.acquired;
      ownerId = lockResult.ownerId;
      waitCycles++;
    }

    if (!acquired) {
      this.lockTimeouts++;
      throw new Error('Queue congestion');
    }

    this._localLastLoginTime = performance.now();

    // Simulate login HTTP request (200-500ms)
    const loginLatency = 200 + Math.random() * 300;
    await new Promise(r => setTimeout(r, loginLatency));

    const loginTime = Date.now();
    this.loginTimestamps.push(loginTime);

    // Cache token
    const token = `token_${username}_${Date.now()}`;
    const expiry = Date.now() + this.TOKEN_TTL_MS;
    await this.setCachedToken(username, token, expiry);

    // Refresh lock
    if (ownerId) {
      await this.refreshLock(this.DISTRIBUTED_LOGIN_COOLDOWN_MS, ownerId);
    }

    this.loginSuccesses++;
    return { success: true, waitCycles, lockDuration: performance.now() - lockStartTime, token };
  }

  async simulateSubtitleRequest(username) {
    this.totalRequests++;

    // Check cache first (this is the critical path for most requests)
    const cachedToken = await this.getCachedToken(username);
    if (cachedToken) {
      this.cacheHits++;
      return { success: true, cached: true };
    }

    // Need to login - queue it
    return new Promise((resolve, reject) => {
      this._loginQueue = this._loginQueue.then(async () => {
        try {
          // Double-check cache (another pod might have logged in)
          const rechecked = await this.getCachedToken(username);
          if (rechecked) {
            this.cacheHits++;
            resolve({ success: true, cached: true, recheck: true });
            return;
          }
          const result = await this.performLogin(username);
          resolve(result);
        } catch (err) {
          this.loginFailures++;
          reject(err);
        }
      }).catch(() => {});
    });
  }

  getStats() {
    return {
      podId: this.podId,
      totalRequests: this.totalRequests,
      cacheHits: this.cacheHits,
      loginAttempts: this.loginAttempts,
      loginSuccesses: this.loginSuccesses,
      loginFailures: this.loginFailures,
      lockWaits: this.lockWaits,
      lockTimeouts: this.lockTimeouts,
      loginTimestamps: this.loginTimestamps
    };
  }
}

async function runScenario(config) {
  console.log('\n' + '='.repeat(70));
  console.log(`SCENARIO: ${config.name}`);
  console.log('='.repeat(70));
  console.log(`Users: ${config.numUsers}, Requests/user: ${config.requestsPerUser}, Pods: ${config.numPods}`);
  console.log('-'.repeat(70));

  const sharedRedis = new MockRedisClient();
  const pods = [];
  for (let i = 0; i < config.numPods; i++) {
    pods.push(new SimulatedPod(i, sharedRedis));
  }

  const startTime = performance.now();
  const requests = [];

  // Simulate gradual load arrival
  const totalRequests = config.numUsers * config.requestsPerUser;
  const arrivalSpread = config.arrivalSpreadMs || 1000; // Spread requests over this many ms

  for (let u = 0; u < config.numUsers; u++) {
    const username = `user${u}`;
    for (let r = 0; r < config.requestsPerUser; r++) {
      const pod = pods[Math.floor(Math.random() * config.numPods)];
      const delay = Math.random() * arrivalSpread;
      requests.push(
        new Promise(resolve => setTimeout(resolve, delay))
          .then(() => pod.simulateSubtitleRequest(username))
          .catch(err => ({ error: err.message }))
      );
    }
  }

  const results = await Promise.all(requests);
  const totalTime = performance.now() - startTime;

  // Aggregate stats
  const successes = results.filter(r => r && r.success).length;
  const failures = results.filter(r => r && r.error).length;
  const cacheHits = results.filter(r => r && r.cached).length;
  const actualLogins = results.filter(r => r && r.success && !r.cached).length;

  // Login timing analysis
  const allTimestamps = pods.flatMap(p => p.loginTimestamps).sort();
  const intervals = [];
  for (let i = 1; i < allTimestamps.length; i++) {
    intervals.push(allTimestamps[i] - allTimestamps[i - 1]);
  }
  const violations = intervals.filter(i => i < 1000).length;
  const minInterval = intervals.length > 0 ? Math.min(...intervals) : 'N/A';
  const avgInterval = intervals.length > 0 ? (intervals.reduce((a, b) => a + b, 0) / intervals.length).toFixed(0) : 'N/A';

  console.log('\nRESULTS:');
  console.log(`  Total time: ${(totalTime / 1000).toFixed(2)}s`);
  console.log(`  Total requests: ${totalRequests}`);
  console.log(`  Successes: ${successes} (${(successes / totalRequests * 100).toFixed(1)}%)`);
  console.log(`  Failures: ${failures} (${(failures / totalRequests * 100).toFixed(1)}%)`);
  console.log(`  Cache hits: ${cacheHits} (${(cacheHits / totalRequests * 100).toFixed(1)}%)`);
  console.log(`  Actual logins needed: ${actualLogins}`);

  console.log('\nRATE LIMIT COMPLIANCE:');
  console.log(`  Login rate limit violations: ${violations}`);
  console.log(`  Min interval: ${minInterval}ms`);
  console.log(`  Avg interval: ${avgInterval}ms`);

  console.log('\nPER-POD STATS:');
  for (const pod of pods) {
    const s = pod.getStats();
    console.log(`  Pod ${s.podId}: ${s.totalRequests} req, ${s.cacheHits} cache hits, ${s.loginSuccesses} logins, ${s.loginFailures} failed`);
  }

  const passed = failures === 0 || failures / totalRequests < 0.05; // Allow 5% failure
  console.log('\n' + (passed ? '✓ PASSED' : '✗ FAILED'));

  return { passed, violations, successes, failures, cacheHits };
}

async function main() {
  console.log('╔═══════════════════════════════════════════════════════════════════════╗');
  console.log('║  REALISTIC RATE LIMITING TEST - Production-like Behavior              ║');
  console.log('╚═══════════════════════════════════════════════════════════════════════╝');

  const results = [];

  // Scenario 1: Typical load - 50 users, 3 requests each (simulate browse, search, play)
  results.push(await runScenario({
    name: 'Typical Load (50 users, 3 requests each)',
    numUsers: 50,
    requestsPerUser: 3,
    numPods: 2,
    arrivalSpreadMs: 3000  // Spread over 3 seconds
  }));

  // Scenario 2: Popular content spike - same users hammering same content
  results.push(await runScenario({
    name: 'Popular Content Spike (10 users, 20 requests each)',
    numUsers: 10,
    requestsPerUser: 20,
    numPods: 2,
    arrivalSpreadMs: 2000
  }));

  // Scenario 3: Cold start - many new users at once (worst case for login)
  results.push(await runScenario({
    name: 'Cold Start - Many New Users (100 unique users)',
    numUsers: 100,
    requestsPerUser: 1,
    numPods: 2,
    arrivalSpreadMs: 5000  // Spread over 5 seconds
  }));

  // Scenario 4: Burst traffic - all at once
  results.push(await runScenario({
    name: 'Burst Traffic (30 users, all at once)',
    numUsers: 30,
    requestsPerUser: 2,
    numPods: 2,
    arrivalSpreadMs: 100  // Almost simultaneous
  }));

  // Scenario 5: Extreme cold start
  results.push(await runScenario({
    name: 'EXTREME: 200 New Users Simultaneously',
    numUsers: 200,
    requestsPerUser: 1,
    numPods: 2,
    arrivalSpreadMs: 2000
  }));

  console.log('\n' + '═'.repeat(70));
  console.log('FINAL SUMMARY');
  console.log('═'.repeat(70));

  const allPassed = results.every(r => r.passed);
  console.log(`Scenarios passed: ${results.filter(r => r.passed).length}/${results.length}`);

  if (!allPassed) {
    console.log('\n⚠️  FAILURE ANALYSIS:');
    console.log('The "cold start" scenarios fail because too many unique users');
    console.log('need to login simultaneously. Each login takes ~1.5s due to the rate limit.');
    console.log('');
    console.log('With current settings (MAX_LOCK_WAIT_CYCLES=4, TIMEOUT=6s):');
    console.log('  - Max queue depth per pod: ~4 requests');
    console.log('  - With 200 users across 2 pods: 100 users per pod');
    console.log('  - Only first ~8 can succeed, rest timeout');
    console.log('');
    console.log('RECOMMENDATIONS:');
    console.log('1. Increase MAX_LOCK_WAIT_CYCLES for production (e.g., 10-20)');
    console.log('2. Increase TOTAL_LOCK_TIMEOUT_MS (e.g., 30-60 seconds)');
    console.log('3. Return graceful degradation error instead of 500');
    console.log('4. Consider exponential backoff with retry on client');
  }

  process.exit(allPassed ? 0 : 1);
}

main().catch(console.error);
