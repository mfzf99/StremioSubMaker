/**
 * Embedded Subtitle Cache
 * Stores extracted embedded subtitle tracks (original + translated) keyed by video hash and track id.
 */

const log = require('./logger');
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
  if (!index || index.version !== INDEX_VERSION || !Array.isArray(index.keys)) {
    return { indexKey, keys: [] };
  }
  return { indexKey, keys: index.keys };
}

async function persistIndex(adapter, indexKey, keys) {
  const unique = Array.from(new Set(keys)).slice(-MAX_INDEX_ENTRIES);
  await adapter.set(indexKey, { version: INDEX_VERSION, keys: unique }, StorageAdapter.CACHE_TYPES.EMBEDDED);
  return unique;
}

async function addToIndex(adapter, videoHash, type, cacheKey) {
  const { indexKey, keys } = await loadIndex(adapter, videoHash, type);
  if (keys.includes(cacheKey)) {
    return keys;
  }
  keys.push(cacheKey);
  return persistIndex(adapter, indexKey, keys);
}

async function removeFromIndex(adapter, videoHash, type, cacheKey) {
  const { indexKey, keys } = await loadIndex(adapter, videoHash, type);
  if (!keys.length) return;
  const filtered = keys.filter(k => k !== cacheKey);
  if (filtered.length === keys.length) return;
  await persistIndex(adapter, indexKey, filtered);
}

async function rebuildIndexFromStorage(adapter, videoHash, type, pattern) {
  const keys = await adapter.list(StorageAdapter.CACHE_TYPES.EMBEDDED, pattern);
  const { indexKey } = await loadIndex(adapter, videoHash, type);
  const saved = await persistIndex(adapter, indexKey, keys || []);
  return saved;
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
  } catch (error) {
    log.warn(() => [`[Embedded Cache] Failed to update original index for ${cacheKey}:`, error.message]);
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
  } catch (error) {
    log.warn(() => [`[Embedded Cache] Failed to update translation index for ${cacheKey}:`, error.message]);
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

async function listEmbeddedTranslations(videoHash) {
  const adapter = await getStorageAdapter();
  const pattern = `${normalizeString(videoHash || 'unknown')}_translation_*`;
  let { keys } = await loadIndex(adapter, videoHash, 'translation');
  if (!keys.length) {
    keys = await rebuildIndexFromStorage(adapter, videoHash, 'translation', pattern);
  }
  const results = [];
  for (const key of keys) {
    try {
      const entry = unwrapEntry(await adapter.get(key, StorageAdapter.CACHE_TYPES.EMBEDDED));
      if (!entry) continue;
      results.push({ cacheKey: key, ...entry });
    } catch (error) {
      log.warn(() => [`[Embedded Cache] Failed to fetch translation ${key}:`, error.message]);
      try { await removeFromIndex(adapter, videoHash, 'translation', key); } catch (_) {}
    }
  }
  results.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  return results;
}

async function listEmbeddedOriginals(videoHash) {
  const adapter = await getStorageAdapter();
  const pattern = `${normalizeString(videoHash || 'unknown')}_original_*`;
  let { keys } = await loadIndex(adapter, videoHash, 'original');
  if (!keys.length) {
    keys = await rebuildIndexFromStorage(adapter, videoHash, 'original', pattern);
  }
  const results = [];
  for (const key of keys) {
    try {
      const entry = unwrapEntry(await adapter.get(key, StorageAdapter.CACHE_TYPES.EMBEDDED));
      if (!entry) continue;
      results.push({ cacheKey: key, ...entry });
    } catch (error) {
      log.warn(() => [`[Embedded Cache] Failed to fetch original ${key}:`, error.message]);
      try { await removeFromIndex(adapter, videoHash, 'original', key); } catch (_) {}
    }
  }
  results.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  return results;
}

module.exports = {
  generateEmbeddedCacheKey,
  saveOriginalEmbedded,
  saveTranslatedEmbedded,
  getOriginalEmbedded,
  getTranslatedEmbedded,
  listEmbeddedOriginals,
  listEmbeddedTranslations
};
