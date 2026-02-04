/**
 * Subtitle Deduplication Utilities
 * 
 * Provides functions to detect and remove duplicate subtitles
 * from multiple providers based on release name matching.
 * 
 * Strategy: Release Name Matching
 * - Normalize release names for comparison
 * - Only deduplicate EXACT matches after normalization
 * - Preserve: season packs, HI variants, different formats, partial matches
 */

const log = require('./logger');

/**
 * Normalize a release name for deduplication comparison
 * 
 * Normalization steps:
 * 1. Lowercase
 * 2. Remove file extensions (.srt, .ass, .sub, .vtt, .ssa)
 * 3. Replace common separators (., _, -) with spaces
 * 4. Remove provider-specific prefixes ([SCS], [Wyzie], etc.)
 * 5. Remove extra whitespace
 * 6. Trim
 * 
 * @param {string} name - Original release name
 * @returns {string} - Normalized name for comparison
 */
function normalizeReleaseName(name) {
  if (!name || typeof name !== 'string') {
    return '';
  }

  let normalized = name;

  // 1. Lowercase
  normalized = normalized.toLowerCase();

  // 2. Remove common subtitle file extensions
  normalized = normalized.replace(/\.(srt|ass|ssa|sub|vtt|idx|sup)$/i, '');

  // 3. Remove provider-specific prefixes/tags
  // Patterns: [SCS], [Wyzie], [SubDL], [OpenSubtitles], etc.
  normalized = normalized.replace(/^\s*\[[^\]]*\]\s*/g, '');
  normalized = normalized.replace(/\s*\[[^\]]*\]\s*$/g, '');

  // 4. Replace common separators with spaces for uniform comparison
  // Keep the structure but normalize separators
  normalized = normalized.replace(/[._]/g, ' ');

  // 5. Normalize multiple spaces to single space
  normalized = normalized.replace(/\s+/g, ' ');

  // 6. Trim whitespace
  normalized = normalized.trim();

  return normalized;
}

/**
 * Create a deduplication key from subtitle metadata
 * 
 * Key components:
 * - Language code (required - never dedupe across languages)
 * - Normalized release name
 * - HI flag (if respectHIVariants is true)
 * - Format (if respectFormats is true)
 * 
 * @param {Object} subtitle - Subtitle object
 * @param {Object} options - Key generation options
 * @param {boolean} options.respectHIVariants - Keep HI and non-HI separate (default: true)
 * @param {boolean} options.respectFormats - Keep different formats separate (default: true)
 * @returns {string} - Deduplication key
 */
function createDeduplicationKey(subtitle, options = {}) {
  const {
    respectHIVariants = true,
    respectFormats = true
  } = options;

  const parts = [];

  // Language is always part of the key (never dedupe across languages)
  parts.push(subtitle.languageCode || 'unknown');

  // Normalized release name
  const normalizedName = normalizeReleaseName(subtitle.name);
  parts.push(normalizedName);

  // HI variant flag
  if (respectHIVariants) {
    parts.push(subtitle.hearing_impaired ? 'hi' : 'regular');
  }

  // Format (srt, ass, vtt, etc.)
  if (respectFormats) {
    parts.push((subtitle.format || 'srt').toLowerCase());
  }

  return parts.join('|');
}

/**
 * Deduplicate subtitles array based on release name matching
 * 
 * Rules:
 * 1. Only EXACT matches (after normalization) are considered duplicates
 * 2. Season packs are never deduplicated against episode-specific subtitles
 * 3. HI and non-HI versions are kept separate
 * 4. Different formats (SRT vs ASS) are kept separate
 * 5. First occurrence wins (so call this AFTER ranking for best results)
 * 
 * @param {Array} subtitles - Array of subtitle objects
 * @param {Object} options - Deduplication options
 * @param {boolean} options.enabled - Enable deduplication (default: true)
 * @param {boolean} options.respectHIVariants - Keep HI and non-HI separate (default: true)
 * @param {boolean} options.respectFormats - Keep different formats separate (default: true)
 * @returns {Object} - { deduplicated: Array, stats: { total, duplicatesRemoved, byProvider } }
 */
function deduplicateSubtitles(subtitles, options = {}) {
  const {
    enabled = true,
    respectHIVariants = true,
    respectFormats = true
  } = options;

  // If disabled or empty input, return as-is
  if (!enabled || !Array.isArray(subtitles) || subtitles.length === 0) {
    return {
      deduplicated: subtitles || [],
      stats: { total: subtitles?.length || 0, duplicatesRemoved: 0, byProvider: {} }
    };
  }

  const seen = new Map(); // deduplicationKey -> first subtitle with that key
  const result = [];
  const duplicatesByProvider = {}; // provider -> count of duplicates removed

  for (const sub of subtitles) {
    // Season packs get a unique key suffix to prevent deduplication against episode subs
    // This ensures season packs are only deduplicated against other identical season packs
    const isSeasonPack = sub.is_season_pack === true;

    // Create deduplication key
    let key = createDeduplicationKey(sub, { respectHIVariants, respectFormats });

    // Append season pack marker to key if applicable
    if (isSeasonPack) {
      key += '|seasonpack';
    }

    // Check if we've seen this exact key before
    if (seen.has(key)) {
      // Duplicate found - skip this subtitle
      const provider = sub.provider || 'unknown';
      duplicatesByProvider[provider] = (duplicatesByProvider[provider] || 0) + 1;

      // Debug log for duplicate detection
      const existing = seen.get(key);
      log.debug(() => [
        `[Dedup] Removing duplicate:`,
        `"${sub.name?.substring(0, 60)}" (${sub.provider})`,
        `matches "${existing.name?.substring(0, 60)}" (${existing.provider})`
      ]);

      continue;
    }

    // New unique subtitle - add to results
    seen.set(key, sub);
    result.push(sub);
  }

  const duplicatesRemoved = subtitles.length - result.length;

  return {
    deduplicated: result,
    stats: {
      total: subtitles.length,
      duplicatesRemoved,
      byProvider: duplicatesByProvider
    }
  };
}

/**
 * Log deduplication statistics
 * @param {Object} stats - Stats object from deduplicateSubtitles
 */
function logDeduplicationStats(stats) {
  if (stats.duplicatesRemoved === 0) {
    return;
  }

  log.info(() => `[Subtitles] Deduplication removed ${stats.duplicatesRemoved} duplicate(s) from ${stats.total} total`);

  // Log per-provider breakdown if there are duplicates
  const providers = Object.entries(stats.byProvider);
  if (providers.length > 0) {
    const breakdown = providers.map(([p, count]) => `${p}: ${count}`).join(', ');
    log.debug(() => `[Subtitles] Duplicates by provider: ${breakdown}`);
  }
}

module.exports = {
  normalizeReleaseName,
  createDeduplicationKey,
  deduplicateSubtitles,
  logDeduplicationStats
};
