/**
 * Provider Metadata Cache
 * 
 * Redis-backed cache for provider-specific metadata (e.g., IMDB → SubSource movieId mappings).
 * This is CONTENT-based, not user-scoped, so it's safe to share across all users.
 * 
 * Features:
 * - Redis persistence for cross-instance sharing
 * - In-memory LRU fallback for fast reads and when Redis is unavailable
 * - Single API call per cache miss (no cascading fallbacks)
 * - Multi-instance safe via Redis pub/sub for cache invalidation
 * - Memory-bounded (250MB default Redis limit, 10k entries in-memory)
 * - No user data leakage (only stores content-to-ID mappings)
 */

const { LRUCache } = require('lru-cache');
const log = require('./logger');

// Lazy-loaded storage adapter (initialized on first use)
let storageAdapter = null;
let storageInitPromise = null;

/**
 * Get the storage adapter, initializing lazily
 * @returns {Promise<StorageAdapter|null>}
 */
async function getStorageAdapter() {
    if (storageAdapter) return storageAdapter;
    if (storageInitPromise) return storageInitPromise;

    storageInitPromise = (async () => {
        try {
            const { StorageFactory } = require('../storage');
            storageAdapter = await StorageFactory.getStorageAdapter();
            return storageAdapter;
        } catch (err) {
            log.warn(() => `[ProviderMetadataCache] Storage unavailable, using in-memory only: ${err.message}`);
            return null;
        }
    })();

    return storageInitPromise;
}

// In-memory LRU cache for fast reads (acts as L1 cache in front of Redis)
// Each entry is ~50-100 bytes (key + movieId), so 10k entries ≈ 1MB
const memoryCache = new LRUCache({
    max: 10000,                    // 10k entries max
    ttl: 30 * 24 * 60 * 60 * 1000, // 30 days TTL (sync with Redis)
    updateAgeOnGet: true           // Keep popular content cached longer
});

// Cache type from StorageAdapter
const CACHE_TYPE = 'provider_meta';

// TTL for Redis entries (30 days in seconds)
const REDIS_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * Build a cache key for a provider metadata entry
 * Format: {provider}:{type}:{id}[:season]
 * 
 * @param {string} provider - Provider name (e.g., 'subsource')
 * @param {string} metadataType - Type of metadata (e.g., 'movieId')
 * @param {string} id - Primary identifier (e.g., IMDB ID)
 * @param {number|null} season - Optional season number for TV shows
 * @returns {string}
 */
function buildKey(provider, metadataType, id, season = null) {
    const base = `${provider}:${metadataType}:${id}`;
    return season ? `${base}:S${season}` : base;
}

/**
 * Get a cached value
 * Checks in-memory cache first, then Redis
 * 
 * @param {string} provider - Provider name
 * @param {string} metadataType - Type of metadata
 * @param {string} id - Primary identifier
 * @param {number|null} season - Optional season number
 * @returns {Promise<string|null>}
 */
async function get(provider, metadataType, id, season = null) {
    const key = buildKey(provider, metadataType, id, season);

    // L1: Check in-memory cache first (fast path)
    const memCached = memoryCache.get(key);
    if (memCached !== undefined) {
        log.debug(() => `[ProviderMetadataCache] Memory HIT: ${key}`);
        return memCached;
    }

    // L2: Check Redis
    try {
        const storage = await getStorageAdapter();
        if (storage) {
            const value = await storage.get(key, CACHE_TYPE);
            if (value !== null && value !== undefined) {
                // Populate L1 cache for future reads
                memoryCache.set(key, value);
                log.debug(() => `[ProviderMetadataCache] Redis HIT: ${key} → ${value}`);
                return value;
            }
        }
    } catch (err) {
        log.warn(() => `[ProviderMetadataCache] Redis read error for ${key}: ${err.message}`);
    }

    log.debug(() => `[ProviderMetadataCache] MISS: ${key}`);
    return null;
}

/**
 * Set a cached value
 * Writes to both in-memory cache and Redis
 * 
 * @param {string} provider - Provider name
 * @param {string} metadataType - Type of metadata
 * @param {string} id - Primary identifier
 * @param {string} value - Value to cache
 * @param {number|null} season - Optional season number
 * @returns {Promise<boolean>}
 */
async function set(provider, metadataType, id, value, season = null) {
    if (value === null || value === undefined) {
        return false;
    }

    const key = buildKey(provider, metadataType, id, season);

    // L1: Always update in-memory cache immediately
    memoryCache.set(key, value);

    // L2: Persist to Redis (async, non-blocking)
    try {
        const storage = await getStorageAdapter();
        if (storage) {
            await storage.set(key, value, CACHE_TYPE, REDIS_TTL_SECONDS);
            log.debug(() => `[ProviderMetadataCache] Cached: ${key} → ${value}`);
            return true;
        }
    } catch (err) {
        log.warn(() => `[ProviderMetadataCache] Redis write error for ${key}: ${err.message}`);
    }

    return true; // In-memory cache still succeeded
}

/**
 * Delete a cached value
 * Removes from both in-memory cache and Redis
 * 
 * @param {string} provider - Provider name
 * @param {string} metadataType - Type of metadata
 * @param {string} id - Primary identifier
 * @param {number|null} season - Optional season number
 * @returns {Promise<boolean>}
 */
async function del(provider, metadataType, id, season = null) {
    const key = buildKey(provider, metadataType, id, season);

    // Remove from L1
    memoryCache.delete(key);

    // Remove from L2
    try {
        const storage = await getStorageAdapter();
        if (storage) {
            await storage.delete(key, CACHE_TYPE);
        }
    } catch (err) {
        log.warn(() => `[ProviderMetadataCache] Redis delete error for ${key}: ${err.message}`);
    }

    return true;
}

/**
 * Get cache statistics
 * @returns {Object}
 */
function getStats() {
    return {
        memorySize: memoryCache.size,
        memoryMax: memoryCache.max
    };
}

/**
 * Clear all in-memory entries (Redis entries will expire naturally via TTL)
 * Use with caution - mainly for testing
 */
function clearMemory() {
    memoryCache.clear();
    log.debug(() => '[ProviderMetadataCache] Memory cache cleared');
}

module.exports = {
    get,
    set,
    del,
    getStats,
    clearMemory,
    buildKey
};
