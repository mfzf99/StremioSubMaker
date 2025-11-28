const log = require('./logger');
const { getEncryptionKey } = require('./encryption');
const Redis = require('ioredis');

/**
 * Comprehensive startup validation for production readiness
 * Tests encryption, storage, and multi-instance configuration
 */
class StartupValidator {
  constructor() {
    this.warnings = [];
    this.errors = [];
  }

  /**
   * Validate encryption key availability
   */
  async validateEncryptionKey() {
    try {
      const key = getEncryptionKey();
      if (!key) {
        this.errors.push('Encryption key is null or undefined');
        return false;
      }
      log.debug(() => '[Startup Validation] ✓ Encryption key available');
      return true;
    } catch (err) {
      this.errors.push(`Failed to load encryption key: ${err.message}`);
      return false;
    }
  }

  /**
   * Validate Redis connection and configuration (if using Redis)
   */
  async validateRedisConnection() {
    const storageType = process.env.STORAGE_TYPE || 'filesystem';
    if (storageType !== 'redis') {
      log.debug(() => '[Startup Validation] Skipping Redis validation (filesystem mode)');
      return true;
    }

    try {
      const redisOptions = {
        host: process.env.REDIS_HOST || 'localhost',
        port: process.env.REDIS_PORT || 6379,
        password: process.env.REDIS_PASSWORD || undefined,
        db: process.env.REDIS_DB ? parseInt(process.env.REDIS_DB, 10) : 0,
        // Use a raw client (no keyPrefix) for validation so SCAN/EXISTS operate on exact keys
        keyPrefix: '',
        maxRetriesPerRequest: 1,
        retryStrategy: () => null, // Don't retry for validation
        lazyConnect: true
      };

      const testClient = new Redis(redisOptions);

      await new Promise((resolve, reject) => {
        testClient.on('ready', resolve);
        testClient.on('error', reject);
        const timeout = setTimeout(() => {
          reject(new Error('Redis connection timeout after 5 seconds'));
        }, 5000);
        testClient.connect().catch(reject);
      });

      log.debug(() => `[Startup Validation] ✓ Redis connection successful (${redisOptions.host}:${redisOptions.port})`);

      // Check for double-prefixed keys
      const doublePrefixedCount = await this.checkForDoublePrefix(testClient);
      if (doublePrefixedCount > 0) {
        this.warnings.push(`Found ${doublePrefixedCount} double-prefixed keys in Redis. See CHANGELOG for migration instructions.`);
      }

      // Check encryption key consistency for multi-instance
      if (!process.env.ENCRYPTION_KEY) {
        this.warnings.push(
          'ENCRYPTION_KEY env var not set. All instances must share the same .encryption-key file or risk being unable to read each other\'s sessions.'
        );
      } else {
        log.debug(() => '[Startup Validation] ✓ ENCRYPTION_KEY environment variable is set');
      }

      testClient.disconnect();
      return true;
    } catch (err) {
      this.errors.push(`Redis validation failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Check for double-prefixed keys (legacy bug from earlier versions)
   * @private
   */
  async checkForDoublePrefix(client) {
    try {
      // Scan for stremio:stremio:* pattern (double prefix)
      const keyPrefix = process.env.REDIS_KEY_PREFIX || 'stremio:';
      const doublePrefix = `${keyPrefix}${keyPrefix}`;

      let cursor = '0';
      let count = 0;
      const scanPattern = `${doublePrefix}*`;

      do {
        const [newCursor, keys] = await client.scan(cursor, 'MATCH', scanPattern, 'COUNT', 100);
        cursor = newCursor;
        count += keys.length;
      } while (cursor !== '0' && count < 1000); // Limit scan to avoid timeout

      return count;
    } catch (err) {
      log.debug(() => `[Startup Validation] Could not scan for double-prefix keys: ${err.message}`);
      return 0;
    }
  }

  /**
   * Validate storage adapter is working
   */
  async validateStorageAdapter() {
    try {
      const { StorageFactory, StorageAdapter } = require('../storage');
      const adapter = await StorageFactory.getStorageAdapter();

      // Test write and read
      const testKey = `_startup_test_${Date.now()}`;
      const testData = { test: true, timestamp: Date.now() };

      await adapter.set(testKey, testData, StorageAdapter.CACHE_TYPES.SESSION, 60);
      const retrieved = await adapter.get(testKey, StorageAdapter.CACHE_TYPES.SESSION);

      if (!retrieved || !retrieved.test) {
        this.errors.push('Storage adapter test failed: unable to retrieve written data');
        return false;
      }

      // Clean up
      await adapter.delete(testKey, StorageAdapter.CACHE_TYPES.SESSION);
      log.debug(() => '[Startup Validation] ✓ Storage adapter is working correctly');
      return true;
    } catch (err) {
      this.errors.push(`Storage adapter validation failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Run all validations
   */
  async validateAll() {
    log.debug(() => '[Startup Validation] Starting comprehensive validation...');

    const results = {
      encryptionKey: await this.validateEncryptionKey(),
      redis: await this.validateRedisConnection(),
      storageAdapter: await this.validateStorageAdapter()
    };

    // Log results
    if (this.errors.length > 0) {
      log.error(() => ['[Startup Validation] CRITICAL ERRORS FOUND:']);
      this.errors.forEach(err => {
        log.error(() => `  ✗ ${err}`);
      });
    }

    if (this.warnings.length > 0) {
      log.warn(() => ['[Startup Validation] Warnings:']);
      this.warnings.forEach(warn => {
        log.warn(() => `  ⚠ ${warn}`);
      });
    }

    const hasCriticalErrors = this.errors.length > 0;
    if (!hasCriticalErrors) {
      log.info(() => '[Startup Validation] ✓ All validations passed');
    }

    return {
      success: !hasCriticalErrors,
      errors: this.errors,
      warnings: this.warnings,
      results
    };
  }
}

/**
 * Run startup validation and return results
 */
async function runStartupValidation() {
  const validator = new StartupValidator();
  return validator.validateAll();
}

module.exports = {
  StartupValidator,
  runStartupValidation
};
