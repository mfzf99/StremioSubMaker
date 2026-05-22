const test = require('node:test');
const assert = require('node:assert/strict');

const { StorageAdapter, StorageFactory } = require('../storage');

function loadModuleWithAdapter(moduleName, adapter) {
  StorageFactory.instance = adapter;
  StorageFactory.initializationPromise = null;

  const modulePath = require.resolve(`./${moduleName}`);
  delete require.cache[modulePath];
  return require(`./${moduleName}`);
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
      throw new Error('SCAN/list must not run while listing local subtitle cache entries');
    },
    async close() { }
  };
}

test.afterEach(() => {
  StorageFactory.instance = null;
  StorageFactory.initializationPromise = null;
  delete require.cache[require.resolve('./syncCache')];
  delete require.cache[require.resolve('./autoSubCache')];
});

test('xSync empty indexes are treated as empty without Redis SCAN', async () => {
  const adapter = createFakeAdapter({
    '__index_sync__video123__eng': { version: 1, keys: [] }
  });
  const syncCache = loadModuleWithAdapter('syncCache', adapter);

  assert.deepEqual(await syncCache.getSyncedSubtitles('video123', 'eng'), []);
  assert.equal(adapter.calls.exists.length, 0);
  assert.equal(adapter.calls.list.length, 0);
});

test('AutoSub empty indexes are treated as empty without Redis SCAN', async () => {
  const adapter = createFakeAdapter({
    '__index_auto__video123__eng': { version: 1, keys: [] }
  });
  const autoSubCache = loadModuleWithAdapter('autoSubCache', adapter);

  assert.deepEqual(await autoSubCache.getAutoSubtitles('video123', 'eng'), []);
  assert.equal(adapter.calls.exists.length, 0);
  assert.equal(adapter.calls.list.length, 0);
});

test('xSync saves update indexes without Redis SCAN', async () => {
  const adapter = createFakeAdapter({
    '__index_sync__video123__eng': { version: 1, keys: [] }
  });
  const syncCache = loadModuleWithAdapter('syncCache', adapter);

  await syncCache.saveSyncedSubtitle('video123', 'eng', 'source1', {
    content: '1\n00:00:00,000 --> 00:00:01,000\nHi\n',
    originalSubId: 'source1'
  });

  assert.equal(adapter.calls.list.length, 0);
  assert.deepEqual(adapter.calls.set.find(call => call.key === '__index_sync__video123__eng'), {
    key: '__index_sync__video123__eng',
    value: { version: 1, keys: ['video123_eng_source1'] },
    cacheType: StorageAdapter.CACHE_TYPES.SYNC
  });
});

test('AutoSub saves update indexes without Redis SCAN', async () => {
  const adapter = createFakeAdapter({
    '__index_auto__video123__eng': { version: 1, keys: [] }
  });
  const autoSubCache = loadModuleWithAdapter('autoSubCache', adapter);

  await autoSubCache.saveAutoSubtitle('video123', 'eng', 'source1', {
    content: '1\n00:00:00,000 --> 00:00:01,000\nHi\n',
    originalSubId: 'source1'
  });

  assert.equal(adapter.calls.list.length, 0);
  assert.deepEqual(adapter.calls.set.find(call => call.key === '__index_auto__video123__eng'), {
    key: '__index_auto__video123__eng',
    value: { version: 1, keys: ['video123_eng_source1'] },
    cacheType: StorageAdapter.CACHE_TYPES.AUTOSUB
  });
});
