/**
 * Embedded Subtitle Cache
 * Stores extracted embedded subtitle tracks (original + translated) keyed by video hash and track id.
 */

const log = require('./logger');
const { handleCaughtError } = require('./errorClassifier');
const { StorageFactory, StorageAdapter } = require('../storage');

let storageAdapter = null;

// Keep per-video indexes to avoid SCAN in hot paths. Storage adapters already
// apply per-user isolation (prefix/baseDir); indexes stay inside the same cache.
const INDEX_VERSION = 1;
const MAX_INDEX_ENTRIES = 200;

async function getStorageAdapter() {
  if (!storageAdapter) {
    storageAdapter = await StorageFactory.getStorageAdapter();
  }
  return storageAdapter;
}

function normalizeString(value, fallback = '') {
  if (!value && fallback) return fallback;
  if (!value) return '';
  const str = String(value);

  // Sanitize wildcards and special characters to prevent NoSQL injection attacks
  // Replace: * ? [ ] \ with underscores
  let normalized = str.replace(/[\*\?\[\]\\]/g, '_');
  // Also replace whitespace
  normalized = normalized.replace(/\s+/g, '_');

  if (normalized.length > 120) {
    return normalized.slice(0, 100) + '_' + require('crypto').createHash('md5').update(str).digest('hex').slice(0, 8);
  }
  return normalized;
}

function getIndexKey(videoHash, type) {
  const safeVideo = normalizeString(videoHash || 'unknown', 'unknown');
  return `__index_embedded__${safeVideo}__${type}`;
}

async function loadIndex(adapter, videoHash, type) {
  const indexKey = getIndexKey(videoHash, type);
  const index = await adapter.get(indexKey, StorageAdapter.CACHE_TYPES.EMBEDDED);
  if (index && index.version === INDEX_VERSION && Array.isArray(index.keys)) {
    return { indexKey, keys: index.keys, valid: true, present: true };
  }

  return {
    indexKey,
    keys: [],
    valid: false,
    present: index !== null && index !== undefined
  };
}

/**
 * Fast O(1) check if an index exists for a video hash + type.
 * @param {string} videoHash - Video file hash
 * @param {string} type - 'original' or 'translation'
 * @returns {Promise<boolean>} True if index exists (has cached entries)
 */
async function indexExists(videoHash, type) {
  try {
    const adapter = await getStorageAdapter();
    const indexKey = getIndexKey(videoHash, type);
    return await adapter.exists(indexKey, StorageAdapter.CACHE_TYPES.EMBEDDED);
  } catch (error) {
    handleCaughtError(error, `[Embedded Cache] indexExists check failed`, log);
    return false; // Assume no index on error (will fallback to normal lookup)
  }
}

async function persistIndex(adapter, indexKey, keys, previousKeys = []) {
  const unique = Array.from(new Set(keys)).slice(-MAX_INDEX_ENTRIES);
  const trimmed = Array.isArray(keys) ? keys.filter(k => k && !unique.includes(k)) : [];
  const removed = Array.isArray(previousKeys) ? previousKeys.filter(k => k && !unique.includes(k)) : [];
  const toDelete = Array.from(new Set([...trimmed, ...removed]));

  await adapter.set(indexKey, { version: INDEX_VERSION, keys: unique }, StorageAdapter.CACHE_TYPES.EMBEDDED);

  if (toDelete.length) {
    for (const key of toDelete) {
      try {
        await adapter.delete(key, StorageAdapter.CACHE_TYPES.EMBEDDED);
      } catch (error) {
        handleCaughtError(error, `[Embedded Cache] Failed to delete pruned key ${key}`, log);
      }
    }
  }

  return unique;
}

async function addToIndex(adapter, videoHash, type, cacheKey) {
  const { indexKey, keys: previousKeys } = await loadIndex(adapter, videoHash, type);
  if (previousKeys.includes(cacheKey)) {
    return previousKeys;
  }
  const updated = [...previousKeys, cacheKey];
  return persistIndex(adapter, indexKey, updated, previousKeys);
}

async function removeFromIndex(adapter, videoHash, type, cacheKey) {
  const { indexKey, keys: previousKeys } = await loadIndex(adapter, videoHash, type);
  if (!previousKeys.length) return;
  const filtered = previousKeys.filter(k => k !== cacheKey);
  if (filtered.length === previousKeys.length) return;
  await persistIndex(adapter, indexKey, filtered, previousKeys);
}

function generateEmbeddedCacheKey(videoHash, trackId, languageCode, type = 'original', targetLanguageCode = '') {
  const safeVideo = normalizeString(videoHash || 'unknown');
  const safeTrack = normalizeString(trackId || 'track');
  const safeLang = normalizeString(languageCode || 'und');
  const safeTarget = normalizeString(targetLanguageCode || '');
  const base = `${safeVideo}_${type}_${safeLang}_${safeTrack}`;
  return type === 'translation' && safeTarget ? `${base}_${safeTarget}` : base;
}

function unwrapEntry(entry) {
  if (!entry) return null;
  if (entry.content && typeof entry.content === 'object' && (entry.content.videoHash || entry.content.type)) {
    return entry.content;
  }
  if (typeof entry === 'object' && entry.videoHash) {
    return entry;
  }
  if (entry.content && typeof entry.content === 'string') {
    return { content: entry.content };
  }
  if (typeof entry === 'string') {
    return { content: entry };
  }
  return entry;
}

async function saveOriginalEmbedded(videoHash, trackId, languageCode, content, metadata = {}) {
  const adapter = await getStorageAdapter();
  const cacheKey = generateEmbeddedCacheKey(videoHash, trackId, languageCode, 'original');
  const entry = {
    type: 'original',
    videoHash,
    trackId,
    languageCode,
    content,
    metadata: metadata || {},
    timestamp: Date.now(),
    version: '1.0'
  };
  await adapter.set(cacheKey, { content: entry }, StorageAdapter.CACHE_TYPES.EMBEDDED);
  try {
    await addToIndex(adapter, videoHash, 'original', cacheKey);
    await pruneOriginalsForVideo(videoHash, metadata.batchId);
    await pruneTranslationsForVideo(videoHash, metadata.batchId);
  } catch (error) {
    handleCaughtError(error, `[Embedded Cache] Failed to update original index for ${cacheKey}`, log);
  }
  log.debug(() => `[Embedded Cache] Saved original: ${cacheKey}`);
  return { cacheKey, entry };
}

async function saveTranslatedEmbedded(videoHash, trackId, sourceLanguageCode, targetLanguageCode, content, metadata = {}) {
  const adapter = await getStorageAdapter();
  const cacheKey = generateEmbeddedCacheKey(videoHash, trackId, sourceLanguageCode, 'translation', targetLanguageCode);
  const entry = {
    type: 'translation',
    videoHash,
    trackId,
    languageCode: sourceLanguageCode,
    targetLanguageCode,
    content,
    metadata: metadata || {},
    timestamp: Date.now(),
    version: '1.0'
  };
  await adapter.set(cacheKey, { content: entry }, StorageAdapter.CACHE_TYPES.EMBEDDED);
  try {
    await addToIndex(adapter, videoHash, 'translation', cacheKey);
    await pruneTranslationsForVideo(videoHash, metadata.batchId);
  } catch (error) {
    handleCaughtError(error, `[Embedded Cache] Failed to update translation index for ${cacheKey}`, log);
  }
  log.debug(() => `[Embedded Cache] Saved translation: ${cacheKey}`);
  return { cacheKey, entry };
}

async function getOriginalEmbedded(videoHash, trackId, languageCode) {
  const adapter = await getStorageAdapter();
  const cacheKey = generateEmbeddedCacheKey(videoHash, trackId, languageCode, 'original');
  const entry = unwrapEntry(await adapter.get(cacheKey, StorageAdapter.CACHE_TYPES.EMBEDDED));
  if (!entry) return null;
  return { cacheKey, ...entry };
}

async function getTranslatedEmbedded(videoHash, trackId, sourceLanguageCode, targetLanguageCode) {
  const adapter = await getStorageAdapter();
  const cacheKey = generateEmbeddedCacheKey(videoHash, trackId, sourceLanguageCode, 'translation', targetLanguageCode);
  const entry = unwrapEntry(await adapter.get(cacheKey, StorageAdapter.CACHE_TYPES.EMBEDDED));
  if (!entry) return null;
  return { cacheKey, ...entry };
}

/**
 * Fetch an embedded subtitle entry directly by its cache key.
 * Works for both original and translated entries.
 */
async function getEmbeddedByCacheKey(cacheKey) {
  if (!cacheKey) return null;
  const adapter = await getStorageAdapter();
  const entry = unwrapEntry(await adapter.get(cacheKey, StorageAdapter.CACHE_TYPES.EMBEDDED));
  if (!entry) return null;
  return { cacheKey, ...entry };
}

/**
 * List all embedded translations for a video hash
 * Performance: uses the maintained per-video index and never SCANs on subtitle-list reads.
 * @param {string} videoHash - Video file hash
 * @returns {Promise<Array>} Array of translation entries
 */
async function listEmbeddedTranslations(videoHash) {
  const adapter = await getStorageAdapter();
  const { keys, valid, present } = await loadIndex(adapter, videoHash, 'translation');

  if (!valid) {
    if (present) {
      log.warn(() => `[Embedded Cache] Ignoring invalid translation index for ${normalizeString(videoHash || 'unknown', 'unknown')}`);
    }
    return [];
  }

  if (!keys.length) {
    return [];
  }

  const results = [];
  for (const key of keys) {
    try {
      const entry = unwrapEntry(await adapter.get(key, StorageAdapter.CACHE_TYPES.EMBEDDED));
      if (!entry) continue;
      results.push({ cacheKey: key, ...entry });
    } catch (error) {
      handleCaughtError(error, `[Embedded Cache] Failed to fetch translation ${key}`, log);
      try { await removeFromIndex(adapter, videoHash, 'translation', key); } catch (_) { }
    }
  }
  results.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  return results;
}

/**
 * List all embedded originals for a video hash
 * Performance: uses the maintained per-video index and never SCANs on subtitle-list reads.
 * @param {string} videoHash - Video file hash
 * @returns {Promise<Array>} Array of original embedded entries
 */
async function listEmbeddedOriginals(videoHash) {
  const adapter = await getStorageAdapter();
  const { keys, valid, present } = await loadIndex(adapter, videoHash, 'original');

  if (!valid) {
    if (present) {
      log.warn(() => `[Embedded Cache] Ignoring invalid original index for ${normalizeString(videoHash || 'unknown', 'unknown')}`);
    }
    return [];
  }

  if (!keys.length) {
    return [];
  }

  const results = [];
  for (const key of keys) {
    try {
      const entry = unwrapEntry(await adapter.get(key, StorageAdapter.CACHE_TYPES.EMBEDDED));
      if (!entry) continue;
      results.push({ cacheKey: key, ...entry });
    } catch (error) {
      handleCaughtError(error, `[Embedded Cache] Failed to fetch original ${key}`, log);
      try { await removeFromIndex(adapter, videoHash, 'original', key); } catch (_) { }
    }
  }
  results.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  return results;
}

async function pruneOriginalsForVideo(videoHash, preferredBatchId = null) {
  const adapter = await getStorageAdapter();
  const originals = await listEmbeddedOriginals(videoHash);
  if (!originals.length) return;

  // Determine the batch to keep: prefer provided batchId, else max batchId, else most recent timestamp
  let targetBatchId = preferredBatchId !== undefined && preferredBatchId !== null
    ? Number(preferredBatchId)
    : null;

  if (Number.isNaN(targetBatchId)) {
    targetBatchId = null;
  }

  if (targetBatchId === null) {
    const withBatch = originals
      .map(o => Number(o?.metadata?.batchId))
      .filter(v => Number.isFinite(v));
    if (withBatch.length) {
      targetBatchId = Math.max(...withBatch);
    }
  }

  let newestTimestamp = null;
  if (targetBatchId === null) {
    const timestamps = originals
      .map(o => Number(o?.timestamp))
      .filter(v => Number.isFinite(v));
    if (timestamps.length) {
      newestTimestamp = Math.max(...timestamps);
    }
  }

  const toDelete = [];
  for (const entry of originals) {
    const batchId = Number(entry?.metadata?.batchId);
    if (targetBatchId !== null) {
      if (!Number.isNaN(batchId) && batchId === targetBatchId) continue;
      toDelete.push(entry.cacheKey);
      continue;
    }
    if (newestTimestamp !== null) {
      const ts = Number(entry.timestamp);
      if (Number.isFinite(ts) && ts >= newestTimestamp) continue;
      toDelete.push(entry.cacheKey);
    }
  }

  if (!toDelete.length) return;

  const { indexKey, keys: previousKeys } = await loadIndex(adapter, videoHash, 'original');
  const remaining = previousKeys.filter(k => !toDelete.includes(k));
  await persistIndex(adapter, indexKey, remaining, previousKeys);

  for (const key of toDelete) {
    try {
      await adapter.delete(key, StorageAdapter.CACHE_TYPES.EMBEDDED);
      log.debug(() => `[Embedded Cache] Pruned original ${key}`);
    } catch (error) {
      handleCaughtError(error, `[Embedded Cache] Failed to prune original ${key}`, log);
    }
  }
}

async function pruneTranslationsForVideo(videoHash, preferredBatchId = null) {
  const adapter = await getStorageAdapter();
  const translations = await listEmbeddedTranslations(videoHash);
  if (!translations.length) return;

  let targetBatchId = preferredBatchId !== undefined && preferredBatchId !== null
    ? Number(preferredBatchId)
    : null;

  if (Number.isNaN(targetBatchId)) {
    targetBatchId = null;
  }

  if (targetBatchId === null) {
    const withBatch = translations
      .map(t => Number(t?.metadata?.batchId))
      .filter(v => Number.isFinite(v));
    if (withBatch.length) {
      targetBatchId = Math.max(...withBatch);
    }
  }

  let newestTimestamp = null;
  if (targetBatchId === null) {
    const timestamps = translations
      .map(t => Number(t?.timestamp))
      .filter(v => Number.isFinite(v));
    if (timestamps.length) {
      newestTimestamp = Math.max(...timestamps);
    }
  }

  const toDelete = [];
  for (const entry of translations) {
    const batchId = Number(entry?.metadata?.batchId);
    if (targetBatchId !== null) {
      if (!Number.isNaN(batchId) && batchId === targetBatchId) continue;
      toDelete.push(entry.cacheKey);
      continue;
    }
    if (newestTimestamp !== null) {
      const ts = Number(entry.timestamp);
      if (Number.isFinite(ts) && ts >= newestTimestamp) continue;
      toDelete.push(entry.cacheKey);
    }
  }

  if (!toDelete.length) return;

  const { indexKey, keys: previousKeys } = await loadIndex(adapter, videoHash, 'translation');
  const remaining = previousKeys.filter(k => !toDelete.includes(k));
  await persistIndex(adapter, indexKey, remaining, previousKeys);

  for (const key of toDelete) {
    try {
      await adapter.delete(key, StorageAdapter.CACHE_TYPES.EMBEDDED);
      log.debug(() => `[Embedded Cache] Pruned translation ${key}`);
    } catch (error) {
      handleCaughtError(error, `[Embedded Cache] Failed to prune translation ${key}`, log);
    }
  }
}

module.exports = {
  generateEmbeddedCacheKey,
  saveOriginalEmbedded,
  saveTranslatedEmbedded,
  getOriginalEmbedded,
  getTranslatedEmbedded,
  getEmbeddedByCacheKey,
  indexExists,
  listEmbeddedOriginals,
  listEmbeddedTranslations,
  pruneOriginalsForVideo,
  pruneTranslationsForVideo
};
