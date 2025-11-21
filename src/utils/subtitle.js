/**
 * Utility functions for subtitle handling
 */

/**
 * Parse SRT subtitle content into structured format
 * @param {string} srtContent - SRT formatted subtitle content
 * @returns {Array} - Array of subtitle entries
 */
function parseSRT(srtContent) {
  if (!srtContent || typeof srtContent !== 'string') {
    return [];
  }

  const entries = [];
  // CRLF-aware splitting: handles both \n\n (LF) and \r\n\r\n (CRLF) line endings
  // Pattern (?:\r?\n){2,} matches 2 or more consecutive newlines (with optional \r before each \n)
  const blocks = srtContent.trim().split(/(?:\r?\n){2,}/);

  for (const block of blocks) {
    // Also handle CRLF when splitting lines within each block
    const lines = block.trim().split(/\r?\n/);
    if (lines.length < 3) continue;

    const id = parseInt(lines[0]);
    if (isNaN(id)) continue;

    const timecode = lines[1];
    const text = lines.slice(2).join('\n');

    entries.push({
      id,
      timecode,
      text
    });
  }

  return entries;
}

/**
 * Convert parsed subtitle entries back to SRT format
 * @param {Array} entries - Array of subtitle entries
 * @returns {string} - SRT formatted content
 */
function toSRT(entries) {
  return entries
    .map(entry => {
      // Ensure text uses only LF (\n), not CRLF (\r\n)
      // This prevents extra spacing issues on Linux
      const normalizedText = entry.text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      return `${entry.id}\n${entry.timecode}\n${normalizedText}`;
    })
    .join('\n\n') + '\n';
}

/**
 * Convert SRT time (HH:MM:SS,mmm) to VTT time (HH:MM:SS.mmm)
 */
function srtTimeToVttTime(tc) {
  return String(tc || '').replace(/,/g, '.');
}

// Parse SRT timecode duration in milliseconds (00:00:00,000 --> 00:00:05,000)
function srtDurationMs(tc) {
  const m = /^(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/.exec(String(tc || '').trim());
  if (!m) return 0;
  const toMs = (h, mm, s, ms) => (((parseInt(h, 10) || 0) * 60 + (parseInt(mm, 10) || 0)) * 60 + (parseInt(s, 10) || 0)) * 1000 + (parseInt(ms, 10) || 0);
  return Math.max(0, toMs(m[5], m[6], m[7], m[8]) - toMs(m[1], m[2], m[3], m[4]));
}

/**
 * Convert two aligned SRT strings into a dual-language WebVTT output
 * - Emits two cues per entry with overlapping timecodes
 * - Positions based on order: 'source-top' (source at top) or 'target-top'
 */
function srtPairToWebVTT(sourceSrt, targetSrt, order = 'source-top', placement = 'stacked') {
  try {
    const srcEntries = parseSRT(sourceSrt);
    const trgEntries = parseSRT(targetSrt);
    const srcTop = order === 'source-top';
    const isStatusCue = (text) => /TRANSLATION IN PROGRESS|Reload this subtitle/i.test(String(text || ''));

    // When we only have a partial translation, limit cues to what the target has (including the status tail)
    const statusIndex = trgEntries.findIndex(e => isStatusCue(e.text));
    const hasStatusTail = statusIndex !== -1;
    const translatedCount = hasStatusTail ? Math.max(0, statusIndex) : trgEntries.length;
    const isPartial = hasStatusTail || (trgEntries.length > 0 && trgEntries.length < srcEntries.length);
    const count = isPartial
      ? Math.min(translatedCount, srcEntries.length)
      : Math.max(srcEntries.length, trgEntries.length);

    const lines = ['WEBVTT', ''];

    const normalizedPlacement = placement === 'top' ? 'top' : 'stacked';

    // Some Stremio players partially ignore raw cue line settings. When users request "Top",
    // also emit a REGION anchored to the top of the viewport. Players that support regions will
    // honor it; others still have the explicit line values below.
    const useTopRegion = normalizedPlacement === 'top';
    if (useTopRegion) {
      lines.push('REGION');
      lines.push('id:submaker-top');
      lines.push('width:100%');
      lines.push('lines:3');
      lines.push('regionanchor:50% 0%');
      lines.push('viewportanchor:50% 0%');
      lines.push('scroll:up');
      lines.push('');
    }

    // Stremio is more consistent with snap-to-lines integers; combine with a top region so
    // compatible players pin the first cue to the true top instead of stacking near the bottom.
    const positions = (place) => {
      if (place === 'top') {
        return { top: 'region:submaker-top line:0 align:center position:50%', bottom: 'line:-1 align:center position:50%' };
      }
      return { top: 'line:-5 align:center position:50%', bottom: 'line:-1 align:center position:50%' };
    };
    const pos = positions(normalizedPlacement);

    for (let i = 0; i < count; i++) {
      const s = srcEntries[i];
      const t = trgEntries[i];
      if (!s && !t) continue;

      // Detect status cues so we keep their long durations intact
      // Choose timecode: prefer target when it exists and is a status cue or longer than source
      let chosenTimecode = (s && s.timecode) || '';
      if (t && t.timecode) {
        if (!chosenTimecode) {
          chosenTimecode = t.timecode;
        } else if (isStatusCue(t.text) || srtDurationMs(t.timecode) > srtDurationMs(chosenTimecode)) {
          chosenTimecode = t.timecode;
        }
      }

      if (!chosenTimecode) {
        chosenTimecode = '00:00:00,000 --> 00:00:05,000';
      }

      const vttTime = srtTimeToVttTime(chosenTimecode);

      // Status cues should render alone so they don't get paired with source text
      if (isStatusCue(t && t.text)) {
        lines.push(`${vttTime} ${pos.bottom}`);
        lines.push(sanitizeSubtitleText(t.text));
        lines.push('');
        continue;
      }

      let topCue = srcTop ? (s && s.text) : (t && t.text);
      let bottomCue = srcTop ? (t && t.text) : (s && s.text);

      // Fallbacks so status cues still render even if only one side exists
      if (!topCue && bottomCue) {
        topCue = bottomCue;
        bottomCue = '';
      }

      if (!topCue && !bottomCue) continue;

      // Top cue
      lines.push(`${vttTime} ${pos.top}`);
      lines.push(sanitizeSubtitleText(topCue));
      lines.push('');

      // Bottom cue
      if (bottomCue) {
        lines.push(`${vttTime} ${pos.bottom}`);
        lines.push(sanitizeSubtitleText(bottomCue));
        lines.push('');
      }
    }
    // If we had a status tail that wasn't consumed in the main loop (e.g., no translations yet),
    // render it here so users still see progress without extra source lines mixed in.
    if (hasStatusTail && (count === 0 || statusIndex >= count)) {
      const statusEntry = trgEntries[statusIndex];
      const fallbackTime = srcEntries[count - 1]?.timecode || '00:00:00,000 --> 04:00:00,000';
      const vttTime = srtTimeToVttTime(statusEntry.timecode || fallbackTime);
      lines.push(`${vttTime} ${pos.bottom}`);
      lines.push(sanitizeSubtitleText(statusEntry.text));
      lines.push('');
    }

    if (count === 0 && !hasStatusTail) {
      // Fallback minimal cue
      lines.push('00:00:00.000 --> 04:00:00.000 line:95% align:center position:50%');
      lines.push('No content available');
      lines.push('');
    }

    return lines.join('\n');
  } catch (_) {
    // Simple fallback VTT
    return 'WEBVTT\n\n00:00:00.000 --> 04:00:00.000\nLearn Mode: Unable to build VTT';
  }
}

/**
 * Validate SRT subtitle content
 * @param {string} srtContent - SRT content to validate
 * @returns {boolean} - True if valid SRT format
 */
function validateSRT(srtContent) {
  if (!srtContent || typeof srtContent !== 'string') {
    return false;
  }

  const entries = parseSRT(srtContent);
  return entries.length > 0;
}

/**
 * Extract IMDB ID from various formats
 * @param {string} id - ID in various formats (tt1234567, 1234567, etc.)
 * @returns {string} - Normalized IMDB ID with 'tt' prefix
 */
function normalizeImdbId(id) {
  if (!id) return null;

  const idStr = String(id).trim();

  // If it already has 'tt' prefix, return as is
  if (idStr.startsWith('tt')) {
    return idStr;
  }

  // If it's just numbers, add 'tt' prefix
  if (/^\d+$/.test(idStr)) {
    return `tt${idStr}`;
  }

  return idStr;
}

/**
 * Extract video info from Stremio ID
 * @param {string} id - Stremio video ID (e.g., "tt1234567:1:2" for episode, "anidb:123:1:2" for anime)
 * @returns {Object} - Parsed video info
 */
function parseStremioId(id) {
  if (!id) return null;

  const parts = id.split(':');

  // Handle anime IDs (anidb, kitsu, mal, anilist)
  if (parts[0] && /^(anidb|kitsu|mal|anilist)/.test(parts[0])) {
    const animeIdType = parts[0]; // Platform name (anidb, kitsu, etc.)

    if (parts.length === 1) {
      // Anime movie or series (format: platform:id)
      const animeId = parts[0];
      return {
        animeId,
        animeIdType,
        type: 'anime',
        isAnime: true,
        // Keep anidbId for backward compatibility if it's an AniDB ID
        ...(animeIdType === 'anidb' && { anidbId: animeId })
      };
    }

    if (parts.length === 3) {
      // Anime episode (format: platform:id:episode)
      // Example: kitsu:8640:2 -> platform=kitsu, id=8640, episode=2
      const animeId = `${parts[0]}:${parts[1]}`; // Full ID with platform prefix
      return {
        animeId,
        animeIdType,
        type: 'anime-episode',
        episode: parseInt(parts[2]),
        isAnime: true,
        // Keep anidbId for backward compatibility if it's an AniDB ID
        ...(animeIdType === 'anidb' && { anidbId: animeId })
      };
    }

    if (parts.length === 4) {
      // Anime episode with season (format: platform:id:season:episode)
      // Example: kitsu:8640:1:2 -> platform=kitsu, id=8640, season=1, episode=2
      const animeId = `${parts[0]}:${parts[1]}`; // Full ID with platform prefix
      return {
        animeId,
        animeIdType,
        type: 'anime-episode',
        season: parseInt(parts[2]),
        episode: parseInt(parts[3]),
        isAnime: true,
        // Keep anidbId for backward compatibility if it's an AniDB ID
        ...(animeIdType === 'anidb' && { anidbId: animeId })
      };
    }
  }

  // Handle IMDB IDs (regular content)
  const imdbId = normalizeImdbId(parts[0]);

  if (parts.length === 1) {
    // Movie
    return {
      imdbId,
      type: 'movie'
    };
  }

  if (parts.length === 3) {
    // TV Episode
    return {
      imdbId,
      type: 'episode',
      season: parseInt(parts[1]),
      episode: parseInt(parts[2])
    };
  }

  return null;
}

/**
 * Create a subtitle URL for Stremio
 * @param {string} id - Subtitle ID
 * @param {string} lang - Language code
 * @param {string} baseUrl - Base URL of the addon
 * @returns {string} - Subtitle URL
 */
function createSubtitleUrl(id, lang, baseUrl) {
  return `${baseUrl}/subtitle/${encodeURIComponent(id)}/${lang}.srt`;
}

/**
 * Sanitize subtitle text (remove unwanted characters, fix encoding issues)
 * @param {string} text - Subtitle text
 * @returns {string} - Sanitized text
 */
function sanitizeSubtitleText(text) {
  if (!text) return '';

  return text
    .replace(/\r\n/g, '\n') // Normalize line endings
    .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '') // Remove control characters
    .trim();
}

module.exports = {
  parseSRT,
  toSRT,
  validateSRT,
  normalizeImdbId,
  parseStremioId,
  createSubtitleUrl,
  sanitizeSubtitleText,
  srtPairToWebVTT
};
