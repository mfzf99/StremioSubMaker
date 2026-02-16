/**
 * Quick validation test for v1.4.58 rate limiting changes
 * Tests the key scenarios with reduced load to verify the fix quickly
 */

const { performance } = require('perf_hooks');

// Simplified mock Redis
class MockRedis {
  constructor() {
    this.data = new Map();
    this.ttls = new Map();
  }

  async set(key, value, ...args) {
    let px = null, nx = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === 'PX') { px = parseInt(args[i + 1]); i++; }
      else if (args[i] === 'NX') { nx = true; }
    }
    const ttl = this.ttls.get(key);
    if (nx && this.data.has(key) && ttl && Date.now() < ttl) return null;
    this.data.set(key, value);
    if (px) this.ttls.set(key, Date.now() + px);
    return 'OK';
  }

  async pttl(key) {
    const t = this.ttls.get(key);
    if (!t) return -2;
    const r = t - Date.now();
    if (r <= 0) { this.data.delete(key); this.ttls.delete(key); return -2; }
    return r;
  }

  async eval(script, n, ...args) {
    if (script.includes('currentOwner == ARGV[1]')) {
      const [key] = args.slice(0, n);
      const [ownerId, ttlMs] = args.slice(n);
      if (this.data.get(key) === ownerId) {
        this.data.set(key, ownerId);
        this.ttls.set(key, Date.now() + parseInt(ttlMs));
        return 1;
      }
      return 0;
    }
    return null;
  }
}

class Pod {
  constructor(id, redis) {
    this.id = id;
    this.redis = redis;
    this.ownerId = `pod${id}-${Math.random().toString(36).slice(2)}`;
    this.logins = [];
    this.failures = 0;
    this._lastLogin = 0;
    this._queue = Promise.resolve();

    // v1.4.58 values
    this.COOLDOWN = 1100;
    this.MAX_CYCLES = 20;
    this.TIMEOUT = 45000;
    this.LOCK = 'lock:os_login';
  }

  async login() {
    const start = performance.now();

    // Local throttle
    const since = start - this._lastLogin;
    if (since < this.COOLDOWN && this._lastLogin > 0) {
      await new Promise(r => setTimeout(r, this.COOLDOWN - since));
    }

    // Distributed lock
    let acquired = false, ownerId = null, cycles = 0;
    while (!acquired && cycles < this.MAX_CYCLES) {
      if (performance.now() - start > this.TIMEOUT) throw new Error('Timeout');

      const res = await this.redis.set(this.LOCK, this.ownerId, 'PX', this.COOLDOWN, 'NX');
      if (res === 'OK') { acquired = true; ownerId = this.ownerId; break; }

      const ttl = await this.redis.pttl(this.LOCK);
      const wait = (ttl > 0 ? ttl : 50) + 50 + Math.random() * 100;
      await new Promise(r => setTimeout(r, wait));
      cycles++;
    }

    if (!acquired) throw new Error('Congestion');

    this._lastLogin = performance.now();

    // Simulate HTTP (200-400ms)
    await new Promise(r => setTimeout(r, 200 + Math.random() * 200));

    this.logins.push(Date.now());

    // Refresh lock
    if (ownerId) await this.redis.eval(
      'if currentOwner == ARGV[1] then return 1 else return 0 end',
      1, this.LOCK, ownerId, this.COOLDOWN
    );

    return { ok: true, cycles, duration: performance.now() - start };
  }

  async request() {
    return new Promise((res, rej) => {
      this._queue = this._queue.then(async () => {
        try { res(await this.login()); }
        catch (e) { this.failures++; rej(e); }
      }).catch(() => {});
    });
  }
}

async function test(name, users, pods) {
  console.log(`\n--- ${name} ---`);
  const redis = new MockRedis();
  const podList = Array.from({length: pods}, (_, i) => new Pod(i, redis));

  const start = Date.now();
  const reqs = Array.from({length: users}, (_, i) =>
    podList[i % pods].request().catch(e => ({ err: e.message }))
  );
  const results = await Promise.all(reqs);
  const elapsed = Date.now() - start;

  const ok = results.filter(r => r && r.ok).length;
  const fail = results.filter(r => r && r.err).length;

  // Check rate compliance
  const times = podList.flatMap(p => p.logins).sort();
  const intervals = [];
  for (let i = 1; i < times.length; i++) intervals.push(times[i] - times[i-1]);
  const violations = intervals.filter(i => i < 1000).length;
  const minInt = intervals.length ? Math.min(...intervals) : 'N/A';

  console.log(`  Users: ${users}, Pods: ${pods}`);
  console.log(`  Time: ${elapsed}ms, Success: ${ok}/${users}, Fail: ${fail}`);
  console.log(`  Rate violations: ${violations}, Min interval: ${minInt}ms`);

  const passed = fail === 0 && violations === 0;
  console.log(passed ? '  ✓ PASS' : '  ✗ FAIL');
  return passed;
}

async function main() {
  console.log('v1.4.58 Quick Validation Test');
  console.log('MAX_CYCLES=20, TIMEOUT=45s');

  const results = [];

  // Test 1: Small load (should definitely pass)
  results.push(await test('Small load', 10, 2));

  // Test 2: Medium load
  results.push(await test('Medium load', 30, 2));

  // Test 3: Heavy load (the problematic scenario)
  results.push(await test('Heavy load', 50, 2));

  console.log('\n' + '='.repeat(40));
  console.log(`SUMMARY: ${results.filter(r => r).length}/${results.length} passed`);

  if (results.every(r => r)) {
    console.log('✓ All tests passed - v1.4.58 fix is working');
  } else {
    console.log('✗ Some tests failed');
  }

  process.exit(results.every(r => r) ? 0 : 1);
}

main().catch(console.error);
