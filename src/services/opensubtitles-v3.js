const axios = require('axios');
const { toISO6391, toISO6392 } = require('../utils/languages');
const { handleSearchError, handleDownloadError } = require('../utils/apiErrorHandler');
const { httpAgent, httpsAgent, dnsLookup } = require('../utils/httpAgents');
const { detectAndConvertEncoding } = require('../utils/encodingDetector');
const { version } = require('../utils/version');
const { hasExplicitSeasonEpisodeMismatch } = require('../utils/animeSearchResolver');
const log = require('../utils/logger');
const { isTrueishFlag, inferHearingImpairedFromName } = require('../utils/subtitleFlags');
const { detectArchiveType, extractSubtitleFromArchive, convertSubtitleToVtt } = require('../utils/archiveExtractor');
const { analyzeResponseContent, createInvalidResponseSubtitle } = require('../utils/responseAnalyzer');

const OPENSUBTITLES_V3_BASE_URL = 'https://opensubtitles-v3.strem.io/subtitles/';
const USER_AGENT = `SubMaker v${version}`;
const MAX_ZIP_BYTES = 25 * 1024 * 1024; // hard cap for ZIP downloads (~25MB) to avoid huge packs

// 🎯 RAM Cache Anti-Spam (30s TTL + Had Siling Memori)
const osV3MemoryCache = new Map();
const MAX_CACHE_ENTRIES = 500;
const DEBOUNCE_TTL_MS = 30000;

function setOsV3Cache(key, data) {
  if (osV3MemoryCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = osV3MemoryCache.keys().next().value;
    osV3MemoryCache.delete(oldestKey);
  }
  osV3MemoryCache.set(key, { timestamp: Date.now(), data });
}

// Performance: Skip slow HEAD requests for filename extraction by default
const V3_EXTRACT_FILENAMES = process.env.V3_EXTRACT_FILENAMES === 'true';

/**
 * OpenSubtitles V3 Service - Uses official Stremio OpenSubtitles V3 addon
 * No authentication required, fetches from public Stremio service
 */
class OpenSubtitlesV3Service {
  static initLogged = false;

  static client = axios.create({
    baseURL: OPENSUBTITLES_V3_BASE_URL,
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip, deflate, br'
    },
    timeout: 12000,
    httpAgent,
    httpsAgent,
    lookup: dnsLookup,
    maxRedirects: 5,
    decompress: true
  });

  constructor() {
    this.client = OpenSubtitlesV3Service.client;

    if (!OpenSubtitlesV3Service.initLogged) {
      log.debug(() => '[OpenSubtitles V3] Initialized with Stremio V3 addon (no authentication required)');
      OpenSubtitlesV3Service.initLogged = true;
    }
  }

  /**
   * Search for subtitles using OpenSubtitles V3 API
   * @param {Object} params - Search parameters
   * @param {string} params.imdb_id - IMDB ID (with 'tt' prefix)
   * @param {string} params.type - 'movie' or 'episode'
   * @param {number} params.season - Season number (for episodes)
   * @param {number} params.episode - Episode number (for episodes)
   * @param {Array<string>} params.languages - Array of ISO-639-2 language codes
   * @returns {Promise<Array>} - Array of subtitle objects
   */
  async searchSubtitles(params) {
    try {
      const { imdb_id, type, season, episode, languages, providerTimeout } = params;

      if (!imdb_id || imdb_id === 'undefined') {
        log.debug(() => '[OpenSubtitles V3] No IMDB ID available, skipping search');
        return [];
      }

      const fullImdbId = imdb_id.startsWith('tt') ? imdb_id : `tt${imdb_id}`;

      // 🎯 Penapis Spam Request Stremio (Local RAM Hit)
      const localCacheKey = `${fullImdbId}:${type}:${season || 1}:${episode || ''}:${(languages || []).join(',')}`;
      if (osV3MemoryCache.has(localCacheKey)) {
        const cachedEntry = osV3MemoryCache.get(localCacheKey);
        if (Date.now() - cachedEntry.timestamp < DEBOUNCE_TTL_MS) {
          log.debug(() => `[OpenSubtitles V3] Local RAM hit for ${localCacheKey} - Debouncing duplicate Stremio request`);
          return cachedEntry.data;
        }
        osV3MemoryCache.delete(localCacheKey);
      }

      let url;
      if ((type === 'episode' || type === 'anime-episode') && episode) {
        const effectiveSeason = season || 1;
        url = `series/${fullImdbId}:${effectiveSeason}:${episode}.json`;
      } else if (type === 'movie' || type === 'anime') {
        url = `movie/${fullImdbId}.json`;
      } else {
        url = `${type}/${fullImdbId}.json`;
      }

      log.debug(() => ['[OpenSubtitles V3] Searching:', url]);

      const requestConfig = providerTimeout ? { timeout: providerTimeout } : {};
      const response = await this.client.get(url, requestConfig);

      if (!response.data || !response.data.subtitles || response.data.subtitles.length === 0) {
        log.debug(() => '[OpenSubtitles V3] No subtitles found');
        return [];
      }

      const allSubtitles = response.data.subtitles;

      const normalizedRequestedLangs = new Set(
        (languages || []).map(lang => this.normalizeLanguageCode(lang)).filter(Boolean)
      );

      log.debug(() => ['[OpenSubtitles V3] Requested languages (normalized):', Array.from(normalizedRequestedLangs).join(', ')]);

      const filteredSubtitles = allSubtitles
        .map(sub => {
          const normalizedLang = this.normalizeLanguageCode(sub.lang);
          return {
            ...sub,
            normalizedLang
          };
        })
        .filter(sub => {
          return normalizedRequestedLangs.size === 0 || (sub.normalizedLang && normalizedRequestedLangs.has(sub.normalizedLang));
        });

      const subtitlesWithNames = await this.extractFilenames(filteredSubtitles);

      let episodeFilteredSubtitles = subtitlesWithNames;
      if ((type === 'episode' || type === 'anime-episode') && episode) {
        const effectiveSeason = season || 1;
        const beforeCount = episodeFilteredSubtitles.length;

        episodeFilteredSubtitles = episodeFilteredSubtitles.filter(sub => {
          const nameLower = (sub.name || '').toLowerCase();

          if (hasExplicitSeasonEpisodeMismatch(nameLower, effectiveSeason, episode)) {
            return false;
          }

          const seasonPackPatterns = [
            new RegExp(`(?:complete|full|entire)?\\s*(?:season|s)\\s*0*${effectiveSeason}(?:\\s+(?:complete|full|pack))?(?!.*e0*\\d)`, 'i'),
            new RegExp(`(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\\s+season(?!.*episode)`, 'i'),
            new RegExp(`s0*${effectiveSeason}\\s*(?:complete|full|pack)`, 'i')
          ];

          const animeSeasonPackPatterns = [
            /(?:complete|batch|full(?:\s+series)?|\d{1,2}\s*[-~]\s*\d{1,2})/i,
            /\[(?:batch|complete|full)\]/i,
            /(?:episode\s*)?(?:01|001)\s*[-~]\s*(?:\d{2}|\d{3})/i
          ];

          let isSeasonPack = false;
          if (type === 'anime-episode') {
            isSeasonPack = animeSeasonPackPatterns.some(p => p.test(nameLower)) &&
              !new RegExp(`(?:^|[^0-9])0*${episode}(?:v\\d+)?(?:[^0-9]|$)`, 'i').test(nameLower);
          } else {
            isSeasonPack = seasonPackPatterns.some(p => p.test(nameLower)) &&
              !/s0*\d+e0*\d+|\d+x\d+|episode\s*\d+|ep\s*\d+/i.test(nameLower);
          }

          if (isSeasonPack) {
            sub.is_season_pack = true;
            sub.season_pack_season = effectiveSeason;
            sub.season_pack_episode = episode;
            const originalFileId = sub.fileId || sub.id;
            sub.fileId = `${originalFileId}_seasonpack_s${effectiveSeason}e${episode}`;
            sub.id = sub.fileId;
            log.debug(() => `[OpenSubtitles V3] Detected season pack: ${sub.name}`);
            return true;
          }

          const seasonEpisodePatterns = [
            new RegExp(`s0*${effectiveSeason}e0*${episode}\\b`, 'i'),
            new RegExp(`${effectiveSeason}x0*${episode}\\b`, 'i'),
            new RegExp(`s0*${effectiveSeason}[\\s._-]*x[\\s._-]*e?0*${episode}\\b`, 'i'),
            new RegExp(`0*${effectiveSeason}[\\s._-]*x[\\s._-]*e?0*${episode}\\b`, 'i'),
            new RegExp(`s0*${effectiveSeason}\\.e0*${episode}\\b`, 'i'),
            new RegExp(`season\\s*0*${effectiveSeason}.*episode\\s*0*${episode}\\b`, 'i')
          ];

          const animeEpisodePatterns = [
            new RegExp(`(?<=\\b|\\s|\\[|\\(|-|_)e?p?\\s*0*${episode}(?:v\\d+)?(?=\\b|\\s|\\[\\]|\\(\\)|\\.|-|_|$)`, 'i'),
            new RegExp(`(?:^|[\\s\\[\\(\\-_])0*${episode}(?:v\\d+)?(?=$|[\\s\\[\\]\\(\\)\\-_.])`, 'i'),
            new RegExp(`(?:^|[\\s\\[\\(\\-_])0*${episode}(?:v\\d+)?[a-z]{2,3}(?=\\.|[\\s\\[\\]\\(\\)\\-_.]|$)`, 'i'),
            new RegExp(`(?:^|[\\s\\[\\(\\-_])episode\\s*0*${episode}(?=$|[\\s\\]\\)\\-_.])`, 'i'),
            new RegExp(`(?:^|[\\s\\[\\(\\-_])ep\\s*0*${episode}(?=$|[\\s\\]\\)\\-_.])`, 'i'),
            new RegExp(`(?:^|[\\s\\[\\(\\-_])cap(?:itulo|\\.)?\\s*0*${episode}(?=$|[\\s\\]\\)\\-_.])`, 'i'),
            new RegExp(`(?:^|[\\s\\[\\(\\-_])epis[oó]dio\\s*0*${episode}(?=$|[\\s\\]\\)\\-_.])`, 'i'),
            new RegExp(`第\\s*0*${episode}\\s*(?:話|集)`, 'i'),
            new RegExp(`(?:^|[\\s\\[\\(\\-_])0*${episode}\\s*(?:話|集|화)(?=$|[\\s\\]\\)\\-_.])`, 'i'),
            new RegExp(`(?:^|[\\s\\[\\(\\-_])0*${episode}\\s*[-~](?=\\s*\\d)`, 'i'),
            new RegExp(`(?:^|[\\s\\[\\(\\-_])\\d+\\s*[-~]\\s*0*${episode}(?=$|[\\s\\]\\)\\-_.])`, 'i'),
          ];

          if (seasonEpisodePatterns.some(pattern => pattern.test(nameLower)) ||
            (type === 'anime-episode' && animeEpisodePatterns.some(p => p.test(nameLower)))) {
            return true;
          }

          return true;
        });

        const filteredCount = beforeCount - episodeFilteredSubtitles.length;
        const seasonPackCount = episodeFilteredSubtitles.filter(s => s.is_season_pack).length;
        if (filteredCount > 0 || seasonPackCount > 0) {
          log.debug(() => `[OpenSubtitles V3] Episode filtering kept ${episodeFilteredSubtitles.length}/${beforeCount} (season packs: ${seasonPackCount})`);
        }
      }

      if (episodeFilteredSubtitles.length > 0) {
        setOsV3Cache(localCacheKey, episodeFilteredSubtitles);
      }

      return episodeFilteredSubtitles;

    } catch (error) {
      return handleSearchError(error, 'OpenSubtitles V3');
    }
  }

  /**
   * Extract filenames from subtitle URLs
   * @param {Array} subtitles - Array of subtitle objects with urls
   * @returns {Promise<Array>} - Subtitles with extracted names
   */
  async extractFilenames(subtitles) {
    const extractedNames = new Array(subtitles.length).fill(null);

    if (!V3_EXTRACT_FILENAMES) {
      log.debug(() => `[OpenSubtitles V3] Using fast URL-based filename extraction (${subtitles.length} subs)`);
    } else {
      log.debug(() => `[OpenSubtitles V3] Using HEAD requests for filename extraction (${subtitles.length} subs)`);
      const BATCH_SIZE = 15;
      const HEAD_TIMEOUT = 2000;

      for (let i = 0; i < subtitles.length; i += BATCH_SIZE) {
        const batch = subtitles.slice(i, i + BATCH_SIZE);
        const batchPromises = batch.map(async (sub) => {
          try {
            const response = await this.client.head(sub.url, {
              headers: { 'User-Agent': USER_AGENT },
              timeout: HEAD_TIMEOUT
            });

            const contentDisposition = response.headers['content-disposition'];
            if (contentDisposition) {
              const match = contentDisposition.match(/filename="(.+?)"/);
              if (match && match[1]) {
                return match[1];
              }
            }
            return null;
          } catch (error) {
            const status = error?.response?.status;
            if (status === 429) {
              log.debug(() => `[OpenSubtitles V3] 429 while extracting filename for ${sub.id} - retrying once`);
              await new Promise(r => setTimeout(r, 1500));
              try {
                const response = await this.client.head(sub.url, {
                  headers: { 'User-Agent': USER_AGENT },
                  timeout: HEAD_TIMEOUT
                });
                const contentDisposition = response.headers['content-disposition'];
                if (contentDisposition) {
                  const match = contentDisposition.match(/filename="(.+?)"/);
                  if (match && match[1]) {
                    return match[1];
                  }
                }
                return null;
              } catch (retryErr) {
                log.debug(() => `[OpenSubtitles V3] Failed to extract filename for ${sub.id} after retry: ${retryErr.message}`);
                return null;
              }
            }
            log.debug(() => `[OpenSubtitles V3] Failed to extract filename for ${sub.id}: ${error.message}`);
            return null;
          }
        });

        const batchResults = await Promise.all(batchPromises);
        batchResults.forEach((result, batchIndex) => {
          extractedNames[i + batchIndex] = result;
        });
      }
    }

    return subtitles.map((sub, index) => {
      const encodedUrl = Buffer.from(sub.url).toString('base64url');
      const fileId = `v3_${encodedUrl}`;

      const extracted = extractedNames[index];
      let detectedFormat = null;
      let finalName;
      if (extracted) {
        const lower = String(extracted).toLowerCase();
        const m = lower.match(/\.([a-z0-9]{2,4})$/);
        if (m) {
          const ext = m[1];
          if (['srt', 'vtt', 'ass', 'ssa', 'sub'].includes(ext)) detectedFormat = ext;
        }
        finalName = extracted.replace(/\.[^.]+$/, '');
      } else {
        try {
          const urlLower = String(sub.url || '').toLowerCase();
          const um = urlLower.match(/(?:^|\/)([^\/?#]+)\.(srt|vtt|ass|ssa|sub)(?:$|[?#])/);
          if (um) {
            detectedFormat = um[2];
            finalName = um[1];
          }
        } catch (_) { }

        if (!finalName) {
          const langName = this.getLanguageDisplayName(sub.lang);
          finalName = `OpenSubtitles (${langName}) - #${sub.id}`;
        }
      }

      return {
        id: fileId,
        language: sub.lang,
        languageCode: sub.normalizedLang,
        name: finalName,
        downloads: 0,
        rating: 0,
        uploadDate: null,
        format: detectedFormat || 'srt',
        fileId: fileId,
        downloadLink: sub.url,
        hearing_impaired: isTrueishFlag(sub.hearing_impaired) || isTrueishFlag(sub.hi) || inferHearingImpairedFromName(extracted || finalName),
        foreign_parts_only: false,
        machine_translated: false,
        uploader: 'OpenSubtitles V3',
        provider: 'opensubtitles-v3',
        _v3Url: sub.url
      };
    });
  }

  /**
   * Download subtitle content from V3 API with retry logic
   * @param {string} fileId - File ID from search results (contains encoded URL)
   * @returns {Promise<string>} - Subtitle content as text
   */
  async downloadSubtitle(fileId, options = {}) {
    let maxRetries = 3;
    let timeout = 12000;

    if (typeof options === 'number') {
      maxRetries = options;
    } else if (options) {
      timeout = options.timeout || 12000;
      maxRetries = options.maxRetries || 3;
    }

    if (!fileId.startsWith('v3_')) {
      throw new Error('Invalid V3 file ID format');
    }

    let isSeasonPack = false;
    let seasonPackSeason = null;
    let seasonPackEpisode = null;
    let baseFileId = fileId;

    const seasonPackMatch = fileId.match(/^(v3_.+)_seasonpack_s(\d+)e(\d+)$/i);
    if (seasonPackMatch) {
      isSeasonPack = true;
      baseFileId = seasonPackMatch[1];
      seasonPackSeason = parseInt(seasonPackMatch[2], 10);
      seasonPackEpisode = parseInt(seasonPackMatch[3], 10);
      log.debug(() => `[OpenSubtitles V3] Season pack download: S${String(seasonPackSeason).padStart(2, '0')}E${String(seasonPackEpisode).padStart(2, '0')}`);
    }

    const encodedUrl = baseFileId.substring(3);
    const downloadUrl = Buffer.from(encodedUrl, 'base64url').toString('utf-8');

    log.debug(() => '[OpenSubtitles V3] Decoded download URL');

    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        log.debug(() => `[OpenSubtitles V3] Downloading subtitle (attempt ${attempt}/${maxRetries}): ${fileId}`);

        const response = await this.client.get(downloadUrl, {
          responseType: 'arraybuffer',
          headers: { 'User-Agent': USER_AGENT },
          timeout: timeout,
          maxContentLength: MAX_ZIP_BYTES
        });

        const buf = Buffer.isBuffer(response.data) ? response.data : Buffer.from(response.data);
        const contentAnalysis = analyzeResponseContent(buf);
        const archiveType = detectArchiveType(buf);

        if (archiveType) {
          log.debug(() => `[OpenSubtitles V3] Detected ${archiveType.toUpperCase()} archive`);

          return await extractSubtitleFromArchive(buf, {
            providerName: 'OpenSubtitles V3',
            maxBytes: MAX_ZIP_BYTES,
            isSeasonPack: isSeasonPack,
            season: seasonPackSeason,
            episode: seasonPackEpisode,
            languageHint: options.languageHint || null,
            skipAssConversion: options.skipAssConversion
          });
        }

        if (contentAnalysis.type !== 'subtitle' && contentAnalysis.type !== 'unknown') {
          if (contentAnalysis.type.startsWith('html') || contentAnalysis.type === 'json_error' || contentAnalysis.type === 'text_error' || contentAnalysis.type === 'empty' || contentAnalysis.type === 'truncated') {
            log.error(() => `[OpenSubtitles V3] Download failed: ${contentAnalysis.type} - ${contentAnalysis.hint}`);
            return createInvalidResponseSubtitle('OpenSubtitles V3', contentAnalysis, buf.length);
          }
        }

        let text = detectAndConvertEncoding(buf, 'OpenSubtitles V3', options.languageHint || null);

        const trimmed = (text || '').trimStart();
        if (trimmed.startsWith('WEBVTT')) {
          log.debug(() => '[OpenSubtitles V3] Detected VTT; returning original VTT');
          return text;
        }

        if (/^\d+\s*\r?\n\d{2}:\d{2}:\d{2}[,.:]\d{2,3}/.test(trimmed)) {
          log.debug(() => '[OpenSubtitles V3] Detected SRT; returning original SRT');
          return text;
        }

        if (/\[events\]/i.test(text) || /^dialogue\s*:/im.test(text) ||
          trimmed.endsWith('.ass') || trimmed.endsWith('.ssa') ||
          trimmed.endsWith('.sub')) {
          log.debug(() => '[OpenSubtitles V3] Non-SRT format detected, using centralized converter');
          let filename = 'subtitle.ass';
          try {
            const urlMatch = downloadUrl.match(/\/([^\/]+)\.(srt|vtt|ass|ssa|sub)$/i);
            if (urlMatch) filename = `${urlMatch[1]}.${urlMatch[2]}`;
          } catch (_) { }
          return await convertSubtitleToVtt(text, filename, 'OpenSubtitles V3', { skipAssConversion: options.skipAssConversion });
        }

        log.debug(() => '[OpenSubtitles V3] Subtitle downloaded successfully');
        return text;

      } catch (error) {
        lastError = error;
        const status = error.response?.status;

        if (status === 404 || status === 401 || status === 403) {
          log.debug(() => `[OpenSubtitles V3] Non-retryable error (${status}), aborting retries`);
          break;
        }

        if ((status === 469 || status >= 500) && attempt < maxRetries) {
          const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
          log.warn(() => `[OpenSubtitles V3] Download failed (status ${status}), retrying in ${backoffMs}ms...`);
          await new Promise(resolve => setTimeout(resolve, backoffMs));
          continue;
        }

        if (attempt === maxRetries) {
          log.error(() => `[OpenSubtitles V3] All ${maxRetries} download attempts failed`);
        }
      }
    }

    handleDownloadError(lastError, 'OpenSubtitles V3');
  }

  /**
   * Get human-readable language name for display
   * @param {string} languageCode - Language code
   * @returns {string} - Display name
   */
  getLanguageDisplayName(languageCode) {
    if (!languageCode) return 'Unknown';

    const lower = languageCode.toLowerCase().trim();

    const displayNames = {
      'en': 'English', 'eng': 'English',
      'pt': 'Portuguese', 'por': 'Portuguese',
      'pob': 'Portuguese (BR)', 'pb': 'Portuguese (BR)',
      'es': 'Spanish', 'spa': 'Spanish', 'spn': 'Spanish (Latin America)',
      'fr': 'French', 'fre': 'French', 'fra': 'French',
      'de': 'German', 'ger': 'German', 'deu': 'German',
      'it': 'Italian', 'ita': 'Italian',
      'ru': 'Russian', 'rus': 'Russian',
      'ja': 'Japanese', 'jpn': 'Japanese',
      'zh': 'Chinese', 'chi': 'Chinese', 'zho': 'Chinese', 'zhs': 'Chinese (Simplified)', 'zht': 'Chinese (Traditional)',
      'ko': 'Korean', 'kor': 'Korean',
      'ar': 'Arabic', 'ara': 'Arabic',
      'nl': 'Dutch', 'dut': 'Dutch', 'nld': 'Dutch',
      'pol': 'Polish', 'pol': 'Polish',
      'tr': 'Turkish', 'tur': 'Turkish',
      'sv': 'Swedish', 'swe': 'Swedish',
      'no': 'Norwegian', 'nor': 'Norwegian',
      'da': 'Danish', 'dan': 'Danish',
      'fi': 'Finnish', 'fin': 'Finnish',
      'el': 'Greek', 'gre': 'Greek', 'ell': 'Greek',
      'he': 'Hebrew', 'heb': 'Hebrew',
      'hi': 'Hindi', 'hin': 'Hindi',
      'cs': 'Czech', 'cze': 'Czech', 'ces': 'Czech',
      'hu': 'Hungarian', 'hun': 'Hungarian',
      'ro': 'Romanian', 'rum': 'Romanian', 'ron': 'Romanian',
      'th': 'Thai', 'tha': 'Thai',
      'vi': 'Vietnamese', 'vie': 'Vietnamese',
      'id': 'Indonesian', 'ind': 'Indonesian',
      'uk': 'Ukrainian', 'ukr': 'Ukrainian',
      'bg': 'Bulgarian', 'bul': 'Bulgarian',
      'hr': 'Croatian', 'hrv': 'Croatian',
      'sr': 'Serbian', 'srp': 'Serbian',
      'sk': 'Slovak', 'slo': 'Slovak', 'slk': 'Slovak',
      'sl': 'Slovenian', 'slv': 'Slovenian',
      'ast': 'Asturian',
      'mni': 'Manipuri',
      'syr': 'Syriac',
      'tet': 'Tetum',
      'sat': 'Santali',
      'ext': 'Extremaduran',
      'tok': 'Toki Pona'
    };

    return displayNames[lower] || languageCode.toUpperCase();
  }

  /**
   * Normalize language code to ISO-639-2 for Stremio
   * @param {string} language - Language code from V3 API
   * @returns {string} - ISO-639-2 language code (3-letter)
   */
  normalizeLanguageCode(language) {
    if (!language) return null;

    const lower = language.toLowerCase().trim();

    if (lower === 'pob' || lower === 'ptbr' || lower === 'pt-br') {
      return 'pob';
    }

    if (lower === 'ea') {
      return 'spn';
    }

    if (lower === 'sx') return 'sat';
    if (lower === 'at') return 'ast';
    if (lower === 'pr') return 'per';
    if (lower === 'ex') return 'ext';
    if (lower === 'ma') return 'mni';
    if (lower === 'pm') return 'por';
    if (lower === 'sp') return 'spa';
    if (lower === 'sy') return 'syr';
    if (lower === 'tm-td') return 'tet';
    if (lower === 'tp') return 'tok';

    // 🎯 Chinese variants mapping (selaras dengan request parameter dan V3 feed)
    if (lower === 'chi' || lower === 'zho' || lower === 'zh-cn' || lower === 'zhcn' || lower === 'zhs') {
      return 'zhs';
    }
    if (lower === 'zht' || lower === 'zh-tw' || lower === 'zhtw') {
      return 'zht';
    }
    if (lower === 'ze') {
      return 'ze';
    }

    if (lower === 'me') {
      return 'mne';
    }

    const regionMatch = lower.match(/^([a-z]{2})-[a-z0-9]{2,}$/);
    if (regionMatch) {
      const base = regionMatch[1];
      if (lower === 'pt-pt') {
        return 'por';
      }
      const iso2Codes = toISO6392(base);
      if (iso2Codes && iso2Codes.length > 0) {
        return iso2Codes[0].code2;
      }
    }

    if (lower.length === 3 && /^[a-z]{3}$/.test(lower)) {
      return lower;
    }

    if (lower.length === 2 && /^[a-z]{2}$/.test(lower)) {
      const iso2Codes = toISO6392(lower);
      if (iso2Codes && iso2Codes.length > 0) {
        return iso2Codes[0].code2;
      }
    }

    log.warn(() => `[OpenSubtitles V3] Unknown language format: "${language}"`);
    return null;
  }
}

module.exports = OpenSubtitlesV3Service;
