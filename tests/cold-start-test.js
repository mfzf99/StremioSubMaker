/**
 * Extended validation test for 100-user cold start
 * This simulates the worst case: 100 unique users all arriving at once
 */

const { performance } = require('perf_hooks');

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
    this.maxCycles = 0;
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

    const since = start - this._lastLogin;
    if (since < this.COOLDOWN && this._lastLogin > 0) {
      await new Promise(r => setTimeout(r, this.COOLDOWN - since));
    }

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

    this.maxCycles = Math.max(this.maxCycles, cycles);
    this._lastLogin = performance.now();

    // Simulate HTTP (300-500ms)
    await new Promise(r => setTimeout(r, 300 + Math.random() * 200));

    this.logins.push(Date.now());

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

async function main() {
  console.log('100-User Cold Start Test (v1.4.58)');
  console.log('This tests the worst-case scenario: 100 unique users arriving simultaneously\n');

  const redis = new MockRedis();
  const pods = [new Pod(0, redis), new Pod(1, redis)];

  console.log('Starting 100 concurrent login requests across 2 pods...');
  const start = Date.now();

  const reqs = Array.from({length: 100}, (_, i) =>
    pods[i % 2].request().catch(e => ({ err: e.message }))
  );

  // Progress indicator
  let completed = 0;
  const checkProgress = setInterval(() => {
    const elapsed = Math.floor((Date.now() - start) / 1000);
    const logins = pods.reduce((s, p) => s + p.logins.length, 0);
    console.log(`  [${elapsed}s] Logins completed: ${logins}/100`);
  }, 10000);

  const results = await Promise.all(reqs);
  clearInterval(checkProgress);

  const elapsed = Date.now() - start;
  const ok = results.filter(r => r && r.ok).length;
  const fail = results.filter(r => r && r.err).length;

  const times = pods.flatMap(p => p.logins).sort();
  const intervals = [];
  for (let i = 1; i < times.length; i++) intervals.push(times[i] - times[i-1]);
  const violations = intervals.filter(i => i < 1000).length;
  const minInt = intervals.length ? Math.min(...intervals) : 'N/A';
  const avgInt = intervals.length ? Math.round(intervals.reduce((a,b) => a+b, 0) / intervals.length) : 'N/A';

  console.log('\n' + '='.repeat(50));
  console.log('RESULTS');
  console.log('='.repeat(50));
  console.log(`Total time: ${Math.round(elapsed/1000)}s (${elapsed}ms)`);
  console.log(`Successes: ${ok}/100 (${ok}%)`);
  console.log(`Failures: ${fail}/100 (${fail}%)`);
  console.log(`Max cycles waited: Pod 0 = ${pods[0].maxCycles}, Pod 1 = ${pods[1].maxCycles}`);
  console.log('');
  console.log('RATE LIMIT COMPLIANCE:');
  console.log(`  Violations (<1000ms between logins): ${violations}`);
  console.log(`  Min interval: ${minInt}ms`);
  console.log(`  Avg interval: ${avgInt}ms`);
  console.log('');

  const passed = fail === 0 && violations === 0;
  if (passed) {
    console.log('✓ TEST PASSED - All 100 users logged in successfully with no rate violations');
    console.log('');
    console.log('The v1.4.58 fix (MAX_CYCLES=20, TIMEOUT=45s) handles cold-start scenarios correctly.');
  } else {
    console.log('✗ TEST FAILED');
    if (fail > 0) console.log(`  ${fail} requests timed out or failed`);
    if (violations > 0) console.log(`  ${violations} rate limit violations detected`);
  }

  process.exit(passed ? 0 : 1);
}

main().catch(console.error);
