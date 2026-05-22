const test = require('node:test');
const assert = require('node:assert/strict');

const RedisStorageAdapter = require('./RedisStorageAdapter');
const { StorageUnavailableError } = require('./errors');

test('Redis adapter sets a bounded command timeout and disables offline queueing', () => {
  const previousTimeout = process.env.REDIS_COMMAND_TIMEOUT_MS;
  process.env.REDIS_COMMAND_TIMEOUT_MS = '4321';

  try {
    const adapter = new RedisStorageAdapter({ host: '127.0.0.1', port: 6379 });

    assert.equal(adapter.options.commandTimeout, 4321);
    assert.equal(adapter.options.enableOfflineQueue, false);
    assert.equal(adapter.options.maxRetriesPerRequest, 3);
  } finally {
    if (previousTimeout === undefined) {
      delete process.env.REDIS_COMMAND_TIMEOUT_MS;
    } else {
      process.env.REDIS_COMMAND_TIMEOUT_MS = previousTimeout;
    }
  }
});

test('Redis command timeouts are not retried into long route stalls', async () => {
  const adapter = new RedisStorageAdapter({ host: '127.0.0.1', port: 6379 });
  let attempts = 0;

  await assert.rejects(
    adapter._executeWithRetry('test command timeout', async () => {
      attempts += 1;
      throw new Error('Command timed out');
    }),
    StorageUnavailableError
  );

  assert.equal(attempts, 1);
});
