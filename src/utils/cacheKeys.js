/**
 * Cache key generation utilities
 *
 * Provides a single source of truth for cache key generation across the application.
 * This ensures consistent scoping for bypass vs permanent cache and prevents
 * cache key mismatches that could break partial cache delivery or cause
 * user isolation issues.
 */

const log = require('./logger');

/**
 * Generate cache keys for translation caching
 *
 * @param {Object} config - User configuration
 * @param {string} sourceFileId - Source file identifier (e.g., "imdb123_en")
 * @param {string} targetLang - Target language code (e.g., "es")
 * @returns {Object} Cache key information
 * @returns {string} .baseKey - Base key without user scoping (e.g., "imdb123_en_es")
 * @returns {string} .cacheKey - Scoped key for cache operations (e.g., "imdb123_en_es__u_abc123")
 * @returns {boolean} .bypass - Whether bypass mode is enabled in config
 * @returns {boolean} .bypassEnabled - Whether bypass mode is actually active (requires userHash)
 * @returns {string} .userHash - User configuration hash (empty string if not available)
 */
function generateCacheKeys(config, sourceFileId, targetLang) {
  const baseKey = `${sourceFileId}_${targetLang}`;

  // Determine bypass mode
  const bypass = config.bypassCache === true;
  const bypassCfg = config.bypassCacheConfig || config.tempCache || {}; // Support both old and new names
  let bypassEnabled = bypass && (bypassCfg.enabled !== false);

  // Get user hash for user-scoped caching
  // CRITICAL: userHash must be a valid non-empty string for bypass cache
  // If missing, bypass cache would be shared across all users!
  const userHash = (config && typeof config.__configHash === 'string' && config.__configHash.length > 0)
    ? config.__configHash
    : '';

  // Security: Fall back to permanent cache if no userHash (prevents sharing bypass cache across users)
  if (bypass && bypassEnabled && !userHash) {
    log.warn(() => `[CacheKeys] Bypass cache requested but no valid configHash available for ${baseKey} - falling back to permanent cache`);
    bypassEnabled = false;
  }

  // Generate scoped cache key
  // Bypass mode: User-scoped key (e.g., "imdb123_en_es__u_abc123")
  // Permanent mode: Unscoped key (e.g., "imdb123_en_es")
  const cacheKey = (bypass && bypassEnabled)
    ? `${baseKey}__u_${userHash}`  // User-scoped for bypass mode
    : baseKey;                       // Unscoped for permanent cache

  if (bypass && bypassEnabled) {
    log.debug(() => `[CacheKeys] Generated user-scoped bypass cache key: ${cacheKey}`);
  }

  return {
    baseKey,        // Base key without user scoping (e.g., "imdb123_en_es")
    cacheKey,       // Scoped key for cache operations (e.g., "imdb123_en_es__u_abc123")
    bypass,         // Whether bypass mode is enabled in config
    bypassEnabled,  // Whether bypass mode is actually active (requires userHash)
    userHash        // User configuration hash (empty string if not available)
  };
}

module.exports = {
  generateCacheKeys
};
