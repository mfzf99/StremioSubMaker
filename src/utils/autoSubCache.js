/**
 * AutoSub Cache Management
 * Handles storage and retrieval of automatic subtitle outputs.
 */

const crypto = require('crypto');
const { StorageFactory, StorageAdapter } = require('../storage');
const log = require('./logger');
const { handleCaughtError } = require('./errorClassifier');

const INDEX_VERSION = 1;
const MAX_INDEX_ENTRIES = 200;
const CACHE_TYPE = StorageAdapter.CACHE_TYPES.AUTOSUB;
const MAX_CACHE_SIZE_BYTES = StorageAdapter.SIZE_LIMITS[CACHE_TYPE] || null;
const MAX_CACHE_SIZE_GB = MAX_CACHE_SIZE_BYTES ? (MAX_CACHE_SIZE_BYTES / (1024 * 1024 * 1024)) : null;

let storageAdapter = null;
async function getStorageAdapter() {
  if (!storageAdapter) {
    storageAdapter = await StorageFactory.getStorageAdapter();
  }
  return storageAdapter;
}

async function initAutoSubCache() {
  try {
    await getStorageAdapter();
    log.debug(() => '[AutoSub Cache] Initialized');
  } catch (error) {
    log.error(() => ['[AutoSub Cache] Failed to initialize:', error.message]);
    throw error;
  }
}

function generateAutoSubCacheKey(videoHash, languageCode, sourceSubId) {
  return `${videoHash}_${languageCode}_${sourceSubId}`;
}

function normalizeIndexSegment(value, fallback = 'unknown') {
  const str = String(value || fallback);
  let normalized = str.replace(/[\s\*\?\[\]\\]/g, '_');
  if (normalized.length > 64) {
    const hash = crypto.createHash('md5').update(str).digest('hex').slice(0, 8);
    normalized = normalized.slice(0, 40) + '_' + hash;
  }
  return normalized || fallback;
}

function getIndexKey(videoHash, languageCode) {
  const safeVideo = normalizeIndexSegment(videoHash);
  const safeLang = normalizeIndexSegment(languageCode);
  return `__index_auto__${safeVideo}__${safeLang}`;
}

async function indexExists(videoHash, languageCode) {
  try {
    const adapter = await getStorageAdapter();
    const indexKey = getIndexKey(videoHash, languageCode);
    return await adapter.exists(indexKey, CACHE_TYPE);
  } catch (error) {
    handleCaughtError(error, '[AutoSub Cache] indexExists check failed', log);
    return false;
  }
}

async function loadIndex(adapter, videoHash, languageCode) {
  const indexKey = getIndexKey(videoHash, languageCode);
  const index = await adapter.get(indexKey, CACHE_TYPE);
  if (!index || index.version !== INDEX_VERSION || !Array.isArray(index.keys)) {
    return { indexKey, keys: [] };
  }
  return { indexKey, keys: index.keys };
}

async function persistIndex(adapter, indexKey, keys) {
  const unique = Array.from(new Set(keys)).slice(-MAX_INDEX_ENTRIES);
  await adapter.set(indexKey, { version: INDEX_VERSION, keys: unique }, CACHE_TYPE);
  return unique;
}

async function addToIndex(adapter, videoHash, languageCode, cacheKey) {
  const { indexKey, keys } = await loadIndex(adapter, videoHash, languageCode);
  if (keys.includes(cacheKey)) return keys;
  const updated = [...keys, cacheKey];
  return persistIndex(adapter, indexKey, updated);
}

async function removeFromIndex(adapter, videoHash, languageCode, cacheKey) {
  const { indexKey, keys } = await loadIndex(adapter, videoHash, languageCode);
  if (!keys.length) return;
  const filtered = keys.filter(k => k !== cacheKey);
  if (filtered.length === keys.length) return;
  await persistIndex(adapter, indexKey, filtered);
}

async function rebuildIndexFromStorage(adapter, videoHash, languageCode) {
  const pattern = `${videoHash}_${languageCode}_*`;
  const keys = await adapter.list(CACHE_TYPE, pattern);
  const { indexKey } = await loadIndex(adapter, videoHash, languageCode);
  return persistIndex(adapter, indexKey, keys || []);
}

async function saveAutoSubtitle(videoHash, languageCode, sourceSubId, syncData) {
  try {
    const cacheKey = generateAutoSubCacheKey(videoHash, languageCode, sourceSubId);
    const adapter = await getStorageAdapter();

    const cacheEntry = {
      videoHash,
      languageCode,
      sourceSubId,
      content: syncData.content,
      originalSubId: syncData.originalSubId,
      metadata: syncData.metadata || {},
      timestamp: Date.now(),
      version: '1.0'
    };

    await adapter.set(cacheKey, cacheEntry, CACHE_TYPE);
    try {
      await addToIndex(adapter, videoHash, languageCode, cacheKey);
    } catch (error) {
      handleCaughtError(error, `[AutoSub Cache] Failed to update index for ${cacheKey}`, log);
    }

    log.debug(() => `[AutoSub Cache] Saved: ${cacheKey}`);
  } catch (error) {
    log.error(() => ['[AutoSub Cache] Failed to save:', error.message]);
    throw error;
  }
}

async function getAutoSubtitles(videoHash, languageCode) {
  try {
    const adapter = await getStorageAdapter();
    let { keys } = await loadIndex(adapter, videoHash, languageCode);

    if (!keys.length) {
      const indexKey = getIndexKey(videoHash, languageCode);
      const indexKeyExists = await adapter.exists(indexKey, CACHE_TYPE);
      if (!indexKeyExists) return [];
      keys = await rebuildIndexFromStorage(adapter, videoHash, languageCode);
    }

    if (!keys.length) return [];

    const results = [];
    for (const cacheKey of keys) {
      try {
        const entry = await adapter.get(cacheKey, CACHE_TYPE);
        if (!entry) {
          try { await removeFromIndex(adapter, videoHash, languageCode, cacheKey); } catch (_) { }
          continue;
        }
        results.push({
          cacheKey,
          sourceSubId: entry.sourceSubId,
          originalSubId: entry.originalSubId,
          content: entry.content,
          metadata: entry.metadata,
          timestamp: entry.timestamp || Date.now()
        });
      } catch (error) {
        handleCaughtError(error, `[AutoSub Cache] Failed to fetch entry for ${cacheKey}`, log);
        try { await removeFromIndex(adapter, videoHash, languageCode, cacheKey); } catch (_) { }
      }
    }

    results.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    return results;
  } catch (error) {
    log.error(() => ['[AutoSub Cache] Failed to retrieve:', error.message]);
    return [];
  }
}

async function listAutoSubLanguages(videoHash) {
  try {
    const adapter = await getStorageAdapter();
    const pattern = `${videoHash}_*_`;
    const keys = await adapter.list(CACHE_TYPE, pattern);
    const langs = new Set();

    (keys || []).forEach((key) => {
      const parts = (key || '').toString().split('_');
      if (parts.length >= 3 && parts[0] === videoHash && parts[1]) {
        langs.add(parts[1]);
      }
    });

    return Array.from(langs);
  } catch (error) {
    handleCaughtError(error, `[AutoSub Cache] Failed to list languages for hash ${videoHash}`, log);
    return [];
  }
}

async function getAutoSubtitle(videoHash, languageCode, sourceSubId) {
  try {
    const cacheKey = generateAutoSubCacheKey(videoHash, languageCode, sourceSubId);
    const adapter = await getStorageAdapter();
    const entry = await adapter.get(cacheKey, CACHE_TYPE);
    if (!entry) return null;
    return {
      cacheKey,
      sourceSubId: entry.sourceSubId,
      originalSubId: entry.originalSubId,
      content: entry.content,
      metadata: entry.metadata,
      timestamp: entry.timestamp
    };
  } catch (error) {
    return handleCaughtError(error, `[AutoSub Cache] Failed to retrieve ${videoHash}_${languageCode}_${sourceSubId}`, log, { fallbackValue: null });
  }
}

async function deleteAutoSubtitle(videoHash, languageCode, sourceSubId) {
  try {
    const cacheKey = generateAutoSubCacheKey(videoHash, languageCode, sourceSubId);
    const adapter = await getStorageAdapter();

    const deleted = await adapter.delete(cacheKey, CACHE_TYPE);
    if (deleted) {
      try {
        await removeFromIndex(adapter, videoHash, languageCode, cacheKey);
      } catch (error) {
        handleCaughtError(error, `[AutoSub Cache] Failed to update index on delete for ${cacheKey}`, log);
      }
      log.debug(() => `[AutoSub Cache] Deleted: ${cacheKey}`);
    }
    return deleted;
  } catch (error) {
    log.error(() => ['[AutoSub Cache] Failed to delete:', error.message]);
    return false;
  }
}

async function getCacheStats() {
  try {
    const adapter = await getStorageAdapter();
    const totalSize = await adapter.size(CACHE_TYPE);
    const keys = await adapter.list(CACHE_TYPE, '*');
    const fileCount = Array.isArray(keys) ? keys.length : 0;

    return {
      totalSize,
      totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2),
      fileCount,
      maxSizeGB: MAX_CACHE_SIZE_GB
    };
  } catch (error) {
    log.error(() => ['[AutoSub Cache] Failed to get stats:', error.message]);
    return { totalSize: 0, totalSizeMB: '0.00', fileCount: 0, maxSizeGB: MAX_CACHE_SIZE_GB };
  }
}

async function clearAutoSubCache() {
  try {
    const adapter = await getStorageAdapter();
    const keys = await adapter.list(CACHE_TYPE, '*');
    for (const key of keys) {
      try { await adapter.delete(key, CACHE_TYPE); } catch (_) { }
    }
    log.debug(() => '[AutoSub Cache] Cleared all cached auto subtitles');
  } catch (error) {
    log.error(() => ['[AutoSub Cache] Failed to clear cache:', error.message]);
    throw error;
  }
}

module.exports = {
  initAutoSubCache,
  generateAutoSubCacheKey,
  saveAutoSubtitle,
  indexExists,
  listAutoSubLanguages,
  getAutoSubtitles,
  getAutoSubtitle,
  deleteAutoSubtitle,
  getCacheStats,
  clearAutoSubCache
};
