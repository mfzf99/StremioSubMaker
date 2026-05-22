const test = require('node:test');
const assert = require('node:assert/strict');

const { StorageAdapter, StorageFactory } = require('../storage');

function loadEmbeddedCacheWithAdapter(adapter) {
  StorageFactory.instance = adapter;
  StorageFactory.initializationPromise = null;

  const modulePath = require.resolve('./embeddedCache');
  delete require.cache[modulePath];
  return require('./embeddedCache');
}

function createFakeAdapter(initialEntries = {}) {
  const entries = new Map(Object.entries(initialEntries));
  const calls = {
    get: [],
    set: [],
    delete: [],
    exists: [],
    list: []
  };

  return {
    calls,
    async get(key, cacheType) {
      calls.get.push({ key, cacheType });
      return entries.has(key) ? entries.get(key) : null;
    },
    async set(key, value, cacheType) {
      calls.set.push({ key, value, cacheType });
      entries.set(key, value);
      return true;
    },
    async delete(key, cacheType) {
      calls.delete.push({ key, cacheType });
      entries.delete(key);
      return true;
    },
    async exists(key, cacheType) {
      calls.exists.push({ key, cacheType });
      return entries.has(key);
    },
    async list(cacheType, pattern) {
      calls.list.push({ cacheType, pattern });
      throw new Error('SCAN/list must not run while listing xEmbed entries');
    },
    async close() { }
  };
}

test.afterEach(() => {
  StorageFactory.instance = null;
  StorageFactory.initializationPromise = null;
  delete require.cache[require.resolve('./embeddedCache')];
});

test('valid empty embedded indexes are treated as empty without Redis SCAN', async () => {
  const adapter = createFakeAdapter({
    '__index_embedded__video123__original': { version: 1, keys: [] },
    '__index_embedded__video123__translation': { version: 1, keys: [] }
  });
  const embeddedCache = loadEmbeddedCacheWithAdapter(adapter);

  assert.deepEqual(await embeddedCache.listEmbeddedOriginals('video123'), []);
  assert.deepEqual(await embeddedCache.listEmbeddedTranslations('video123'), []);
  assert.equal(adapter.calls.exists.length, 0);
  assert.equal(adapter.calls.list.length, 0);
});

test('invalid embedded indexes fail closed without Redis SCAN', async () => {
  const adapter = createFakeAdapter({
    '__index_embedded__video123__original': { version: 0, keys: [] },
    '__index_embedded__video123__translation': { broken: true }
  });
  const embeddedCache = loadEmbeddedCacheWithAdapter(adapter);

  assert.deepEqual(await embeddedCache.listEmbeddedOriginals('video123'), []);
  assert.deepEqual(await embeddedCache.listEmbeddedTranslations('video123'), []);
  assert.equal(adapter.calls.exists.length, 0);
  assert.equal(adapter.calls.list.length, 0);
});

test('saving embedded originals updates indexes without Redis SCAN', async () => {
  const adapter = createFakeAdapter({
    '__index_embedded__video123__original': { version: 1, keys: [] }
  });
  const embeddedCache = loadEmbeddedCacheWithAdapter(adapter);

  await embeddedCache.saveOriginalEmbedded('video123', 'track1', 'eng', '1\n00:00:00,000 --> 00:00:01,000\nHi\n');

  assert.equal(adapter.calls.list.length, 0);

  const indexWrite = adapter.calls.set.find(call => call.key === '__index_embedded__video123__original');
  assert.ok(indexWrite);
  assert.equal(indexWrite.cacheType, StorageAdapter.CACHE_TYPES.EMBEDDED);
  assert.deepEqual(indexWrite.value, {
    version: 1,
    keys: ['video123_original_eng_track1']
  });
});
