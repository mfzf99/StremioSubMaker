/**
 * Stress Test: Multi-Instance Rate Limiting for OpenSubtitles Login
 *
 * This test simulates a 2-pod SubMaker deployment with 3 Redis instances,
 * processing thousands of concurrent subtitle requests.
 *
 * Test scenarios:
 * 1. Thundering herd: Many concurrent login attempts
 * 2. Lock contention: Pods competing for the rate limit lock
 * 3. Lock refresh: Verifying cooldown is properly refreshed after login
 * 4. Redis failure: Graceful degradation when Redis is unavailable
 * 5. Queue timeout: Handling when queue is overloaded
 *
 * Run with: node tests/stress-test-rate-limiting.js
 */

const { performance } = require('perf_hooks');

// Mock Redis client that simulates distributed behavior
class MockRedisClient {
  constructor(options = {}) {
    this.data = new Map();
    this.ttls = new Map();
    this.latencyMs = options.latencyMs || 5;  // Simulated network latency
    this.failureRate = options.failureRate || 0;
    this.requestCount = 0;
    this.lockContentionCount = 0;
  }

  async _delay() {
    if (this.latencyMs > 0) {
      const jitter = Math.random() * this.latencyMs * 0.5;
      await new Promise(r => setTimeout(r, this.latencyMs + jitter));
    }
  }

  _shouldFail() {
    if (this.failureRate > 0 && Math.random() < this.failureRate) {
      throw new Error('REDIS_SIMULATED_FAILURE');
    }
  }

  async set(key, value, ...args) {
    await this._delay();
    this._shouldFail();
    this.requestCount++;

    // Parse args: PX <ms> NX
    let px = null;
    let nx = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === 'PX' && args[i + 1]) {
        px = parseInt(args[i + 1]);
        i++;
      } else if (args[i] === 'NX') {
        nx = true;
      }
    }

    // NX: Only set if not exists
    if (nx && this.data.has(key)) {
      const existingTTL = this.ttls.get(key);
      if (existingTTL && Date.now() < existingTTL) {
        this.lockContentionCount++;
        return null;  // Key exists and not expired
      }
      // Key expired, allow setting
    }

    this.data.set(key, value);
    if (px) {
      this.ttls.set(key, Date.now() + px);
    }
    return 'OK';
  }

  async get(key) {
    await this._delay();
    this._shouldFail();
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
    await this._delay();
    this._shouldFail();
    this.requestCount++;

    const expireAt = this.ttls.get(key);
    if (!expireAt) return -2;  // Key doesn't exist

    const remaining = expireAt - Date.now();
    if (remaining <= 0) {
      this.data.delete(key);
      this.ttls.delete(key);
      return -2;
    }
    return remaining;
  }

  async eval(script, numKeys, ...args) {
    await this._delay();
    this._shouldFail();
    this.requestCount++;

    // Simple Lua script interpreter for our specific scripts
    const keys = args.slice(0, numKeys);
    const argv = args.slice(numKeys);

    // Detect the refresh lock script (compare-and-swap)
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

    // Detect decrement script
    if (script.includes('decr')) {
      const key = keys[0];
      const current = parseInt(this.data.get(key) || '0');
      if (current <= 0) return 0;
      const newVal = current - 1;
      this.data.set(key, String(newVal));
      return newVal;
    }

    return null;
  }

  pipeline() {
    const commands = [];
    const client = this;
    return {
      incr(key) {
        commands.push({ cmd: 'incr', key });
        return this;
      },
      expire(key, seconds) {
        commands.push({ cmd: 'expire', key, seconds });
        return this;
      },
      hset(key, field, value) {
        commands.push({ cmd: 'hset', key, field, value });
        return this;
      },
      hincrby(key, field, increment) {
        commands.push({ cmd: 'hincrby', key, field, increment });
        return this;
      },
      async exec() {
        await client._delay();
        client._shouldFail();

        const results = [];
        for (const cmd of commands) {
          if (cmd.cmd === 'incr') {
            const current = parseInt(client.data.get(cmd.key) || '0');
            const newVal = current + 1;
            client.data.set(cmd.key, String(newVal));
            results.push([null, newVal]);
          } else if (cmd.cmd === 'expire') {
            client.ttls.set(cmd.key, Date.now() + cmd.seconds * 1000);
            results.push([null, 1]);
          } else if (cmd.cmd === 'hincrby') {
            const hashKey = `${cmd.key}:${cmd.field}`;
            const current = parseInt(client.data.get(hashKey) || '0');
            const newVal = current + cmd.increment;
            client.data.set(hashKey, String(newVal));
            results.push([null, newVal]);
          } else if (cmd.cmd === 'hset') {
            const hashKey = `${cmd.key}:${cmd.field}`;
            client.data.set(hashKey, cmd.value);
            results.push([null, 1]);
          }
        }
        return results;
      }
    };
  }

  getStats() {
    return {
      requestCount: this.requestCount,
      lockContentionCount: this.lockContentionCount,
      activeKeys: this.data.size
    };
  }
}

// Mock storage adapter that uses our mock Redis
class MockStorageAdapter {
  constructor(mockRedis) {
    this.client = mockRedis;
  }

  _getKey(key, cacheType) {
    return `submaker:${cacheType}:${key}`;
  }
}

// Simulated Pod - represents one SubMaker instance
class SimulatedPod {
  constructor(podId, sharedRedis, options = {}) {
    this.podId = podId;
    this.redis = sharedRedis;
    this.options = options;

    // Each pod has its own unique owner ID (like the real implementation)
    this.ownerId = `pod${podId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    // Metrics
    this.loginAttempts = 0;
    this.loginSuccesses = 0;
    this.loginFailures = 0;
    this.lockWaits = 0;
    this.lockTimeouts = 0;
    this.loginTimestamps = [];  // Track actual login times for analysis

    // Local rate limiting state (mimics _globalLastLoginTime)
    this._localLastLoginTime = 0;
    this._loginQueue = Promise.resolve();

    // Constants from implementation - v1.4.58 values
    this.LOGIN_MIN_INTERVAL_MS = 1100;
    this.DISTRIBUTED_LOGIN_COOLDOWN_MS = 1100;
    this.MAX_LOCK_WAIT_CYCLES = options.maxWaitCycles || 20;  // Increased from 4
    this.TOTAL_LOCK_TIMEOUT_MS = options.totalTimeout || 45000;  // Increased from 6000
    this.LOCK_KEY = 'os_login_cooldown';
  }

  async tryAcquireLock(ttlMs) {
    const fullKey = `submaker:SESSION:lock:${this.LOCK_KEY}`;
    const result = await this.redis.set(fullKey, this.ownerId, 'PX', ttlMs, 'NX');
    return { acquired: result === 'OK', ownerId: result === 'OK' ? this.ownerId : null };
  }

  async getLockTTL() {
    const fullKey = `submaker:SESSION:lock:${this.LOCK_KEY}`;
    const ttl = await this.redis.pttl(fullKey);
    return ttl < 0 ? 0 : ttl;
  }

  async refreshLock(ttlMs, ownerId) {
    const fullKey = `submaker:SESSION:lock:${this.LOCK_KEY}`;
    const script = `
      local currentOwner = redis.call('get', KEYS[1])
      if currentOwner == ARGV[1] then
        redis.call('set', KEYS[1], ARGV[1], 'PX', ARGV[2])
        return 1
      else
        return 0
      end
    `;
    const result = await this.redis.eval(script, 1, fullKey, ownerId, ttlMs);
    return result === 1;
  }

  async performLogin() {
    this.loginAttempts++;
    const lockStartTime = performance.now();

    // Local throttle
    const now = performance.now();
    const timeSinceLast = now - this._localLastLoginTime;
    if (timeSinceLast < this.LOGIN_MIN_INTERVAL_MS && this._localLastLoginTime > 0) {
      const waitMs = this.LOGIN_MIN_INTERVAL_MS - timeSinceLast;
      await new Promise(r => setTimeout(r, waitMs));
    }

    // Distributed lock acquisition
    let lockResult = await this.tryAcquireLock(this.DISTRIBUTED_LOGIN_COOLDOWN_MS);
    let acquired = lockResult.acquired;
    let ownerId = lockResult.ownerId;
    let waitCycles = 0;

    while (!acquired && waitCycles < this.MAX_LOCK_WAIT_CYCLES) {
      // Check absolute timeout
      if (performance.now() - lockStartTime > this.TOTAL_LOCK_TIMEOUT_MS) {
        this.lockTimeouts++;
        throw new Error('Queue timeout');
      }

      // Get remaining TTL on the lock
      const remainingTTL = await this.getLockTTL();
      this.lockWaits++;

      if (remainingTTL > 0) {
        // Add jitter (50-150ms)
        const jitter = 50 + Math.floor(Math.random() * 100);
        const waitMs = remainingTTL + jitter;
        await new Promise(r => setTimeout(r, waitMs));
      } else {
        // Lock expired - small delay before retry
        await new Promise(r => setTimeout(r, 50 + Math.floor(Math.random() * 50)));
      }

      // Retry acquiring lock
      lockResult = await this.tryAcquireLock(this.DISTRIBUTED_LOGIN_COOLDOWN_MS);
      acquired = lockResult.acquired;
      ownerId = lockResult.ownerId;
      waitCycles++;
    }

    if (!acquired) {
      this.lockTimeouts++;
      throw new Error('Queue congestion');
    }

    // Update local timestamp BEFORE the request
    this._localLastLoginTime = performance.now();

    // Simulate actual login HTTP request (200-500ms)
    const loginLatency = 200 + Math.random() * 300;
    await new Promise(r => setTimeout(r, loginLatency));

    // Record the actual login timestamp
    const loginTime = Date.now();
    this.loginTimestamps.push(loginTime);

    // Refresh the lock after successful login
    if (ownerId) {
      await this.refreshLock(this.DISTRIBUTED_LOGIN_COOLDOWN_MS, ownerId);
    }

    this.loginSuccesses++;
    return { success: true, waitCycles, lockDuration: performance.now() - lockStartTime };
  }

  // Simulate a subtitle request that needs to login
  async simulateSubtitleRequest() {
    return new Promise((resolve, reject) => {
      // Queue this request locally (mimics _globalLoginQueue)
      this._loginQueue = this._loginQueue.then(async () => {
        try {
          const result = await this.performLogin();
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
      loginAttempts: this.loginAttempts,
      loginSuccesses: this.loginSuccesses,
      loginFailures: this.loginFailures,
      lockWaits: this.lockWaits,
      lockTimeouts: this.lockTimeouts,
      loginTimestamps: this.loginTimestamps
    };
  }
}

// Test runner
async function runStressTest(config) {
  console.log('\n' + '='.repeat(70));
  console.log(`TEST: ${config.name}`);
  console.log('='.repeat(70));
  console.log(`Pods: ${config.numPods}, Concurrent requests: ${config.concurrentRequests}`);
  console.log(`Redis latency: ${config.redisLatency}ms, Failure rate: ${config.redisFailureRate * 100}%`);
  console.log('-'.repeat(70));

  // Shared Redis (simulates Redis cluster)
  const sharedRedis = new MockRedisClient({
    latencyMs: config.redisLatency,
    failureRate: config.redisFailureRate
  });

  // Create pods
  const pods = [];
  for (let i = 0; i < config.numPods; i++) {
    pods.push(new SimulatedPod(i, sharedRedis, config.podOptions));
  }

  // Track timing
  const startTime = performance.now();

  // Fire concurrent requests distributed across pods
  const requests = [];
  for (let i = 0; i < config.concurrentRequests; i++) {
    const pod = pods[i % config.numPods];
    requests.push(pod.simulateSubtitleRequest().catch(err => ({ error: err.message })));
  }

  // Wait for all requests to complete
  const results = await Promise.all(requests);
  const totalTime = performance.now() - startTime;

  // Aggregate stats
  const successes = results.filter(r => r && r.success).length;
  const failures = results.filter(r => r && r.error).length;
  const avgWaitCycles = results
    .filter(r => r && r.waitCycles !== undefined)
    .reduce((sum, r) => sum + r.waitCycles, 0) / successes || 0;
  const avgLockDuration = results
    .filter(r => r && r.lockDuration)
    .reduce((sum, r) => sum + r.lockDuration, 0) / successes || 0;

  // Analyze login timing distribution
  const allTimestamps = pods.flatMap(p => p.loginTimestamps).sort();
  const intervals = [];
  for (let i = 1; i < allTimestamps.length; i++) {
    intervals.push(allTimestamps[i] - allTimestamps[i - 1]);
  }

  const violations = intervals.filter(i => i < 1000).length;  // Less than 1 second between logins
  const minInterval = intervals.length > 0 ? Math.min(...intervals) : 0;
  const avgInterval = intervals.length > 0 ? intervals.reduce((a, b) => a + b, 0) / intervals.length : 0;

  console.log('\nRESULTS:');
  console.log(`  Total time: ${(totalTime / 1000).toFixed(2)}s`);
  console.log(`  Successes: ${successes}/${config.concurrentRequests} (${(successes / config.concurrentRequests * 100).toFixed(1)}%)`);
  console.log(`  Failures: ${failures}`);
  console.log(`  Avg wait cycles: ${avgWaitCycles.toFixed(2)}`);
  console.log(`  Avg lock duration: ${avgLockDuration.toFixed(0)}ms`);
  console.log('\nRATE LIMIT COMPLIANCE:');
  console.log(`  Total logins executed: ${allTimestamps.length}`);
  console.log(`  Min interval between logins: ${minInterval.toFixed(0)}ms`);
  console.log(`  Avg interval between logins: ${avgInterval.toFixed(0)}ms`);
  console.log(`  Rate limit violations (<1000ms): ${violations}`);
  console.log('\nREDIS STATS:');
  console.log(`  Total Redis requests: ${sharedRedis.getStats().requestCount}`);
  console.log(`  Lock contentions: ${sharedRedis.getStats().lockContentionCount}`);

  // Per-pod breakdown
  console.log('\nPER-POD BREAKDOWN:');
  for (const pod of pods) {
    const stats = pod.getStats();
    console.log(`  Pod ${stats.podId}: ${stats.loginSuccesses} success, ${stats.loginFailures} fail, ${stats.lockWaits} waits, ${stats.lockTimeouts} timeouts`);
  }

  // Pass/fail determination
  const passed = violations === 0 && failures < config.concurrentRequests * 0.1;
  console.log('\n' + (passed ? '✓ TEST PASSED' : '✗ TEST FAILED'));
  if (violations > 0) {
    console.log(`  ⚠ ${violations} rate limit violations detected!`);
  }

  return { passed, violations, successes, failures, minInterval, avgInterval };
}

// Main test suite
async function main() {
  console.log('╔═══════════════════════════════════════════════════════════════════════╗');
  console.log('║  OPENSUBTITLES DISTRIBUTED RATE LIMITING STRESS TEST                  ║');
  console.log('║  Simulating 2x SubMaker + 3x Redis deployment                         ║');
  console.log('╚═══════════════════════════════════════════════════════════════════════╝');

  const results = [];

  // Test 1: Basic 2-pod, moderate load
  results.push(await runStressTest({
    name: 'Basic 2-Pod Moderate Load',
    numPods: 2,
    concurrentRequests: 20,
    redisLatency: 5,
    redisFailureRate: 0,
    podOptions: {}
  }));

  // Test 2: 2-pod, heavy load (simulating popular content)
  results.push(await runStressTest({
    name: 'Heavy Load (Popular Content)',
    numPods: 2,
    concurrentRequests: 50,
    redisLatency: 5,
    redisFailureRate: 0,
    podOptions: {}
  }));

  // Test 3: Thundering herd - all requests arrive at once
  results.push(await runStressTest({
    name: 'Thundering Herd (Simultaneous Requests)',
    numPods: 2,
    concurrentRequests: 100,
    redisLatency: 2,  // Low latency makes race conditions more likely
    redisFailureRate: 0,
    podOptions: {}
  }));

  // Test 4: High Redis latency (slow network)
  results.push(await runStressTest({
    name: 'High Redis Latency',
    numPods: 2,
    concurrentRequests: 30,
    redisLatency: 50,
    redisFailureRate: 0,
    podOptions: {}
  }));

  // Test 5: Intermittent Redis failures
  results.push(await runStressTest({
    name: 'Redis Partial Failures (10%)',
    numPods: 2,
    concurrentRequests: 30,
    redisLatency: 5,
    redisFailureRate: 0.1,
    podOptions: {}
  }));

  // Test 6: Extended load (more pods)
  results.push(await runStressTest({
    name: 'Multi-Pod Extended Load',
    numPods: 4,  // Simulating scaling up
    concurrentRequests: 80,
    redisLatency: 5,
    redisFailureRate: 0,
    podOptions: {}
  }));

  // Test 7: Stress test - extreme concurrent load (uses default v1.4.58 values)
  results.push(await runStressTest({
    name: 'EXTREME: 200 Concurrent Requests',
    numPods: 2,
    concurrentRequests: 200,
    redisLatency: 5,
    redisFailureRate: 0,
    podOptions: {}  // Use default v1.4.58 values (20 cycles, 45s timeout)
  }));

  // Summary
  console.log('\n' + '═'.repeat(70));
  console.log('FINAL SUMMARY');
  console.log('═'.repeat(70));

  const allPassed = results.every(r => r.passed);
  const totalViolations = results.reduce((sum, r) => sum + r.violations, 0);

  console.log(`Tests passed: ${results.filter(r => r.passed).length}/${results.length}`);
  console.log(`Total rate limit violations: ${totalViolations}`);
  console.log('\n' + (allPassed ? '🎉 ALL TESTS PASSED!' : '❌ SOME TESTS FAILED - REVIEW IMPLEMENTATION'));

  // Check if we need to recommend fixes
  if (totalViolations > 0) {
    console.log('\n⚠️  RECOMMENDATIONS:');
    console.log('1. Increase DISTRIBUTED_LOGIN_COOLDOWN_MS to ensure full 1.1s between requests');
    console.log('2. Consider adding pre-check for lock before HTTP request');
    console.log('3. Review lock refresh timing to ensure cooldown starts AFTER request');
  }

  process.exit(allPassed ? 0 : 1);
}

// Run tests
main().catch(console.error);
