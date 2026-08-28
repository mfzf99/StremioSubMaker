/**
 * SubSource API Integration
 *
 * This implementation:
 * - Uses header-based authentication (X-API-Key and api-key headers)
 * - Attempts both /subtitles and /search endpoints
 * - Converts language codes from ISO-639-2 (3-letter) to SubSource language names
 * - Uses browser-like headers for better compatibility
 * - In-memory RAM debounce cache to absorb duplicate Stremio requests
 * - Redis-backed movieId cache to eliminate redundant metadata lookups
 */

const axios = require('axios');
const { toISO6391, toISO6392 } = require('../utils/languages');
const { handleSearchError, handleDownloadError, logApiError } = require('../utils/apiErrorHandler');
const { httpAgent, httpsAgent, dnsLookup } = require('../utils/httpAgents');
const { detectAndConvertEncoding } = require('../utils/encodingDetector');
const { hasExplicitSeasonEpisodeMismatch } = require('../utils/animeSearchResolver');
const { sanitizeApiKeyForHeader } = require('../utils/security');
const providerMetadataCache = require('../utils/providerMetadataCache');
const log = require('../utils/logger');
const { isTrueishFlag } = require('../utils/subtitleFlags');
const { detectArchiveType, extractSubtitleFromArchive } = require('../utils/archiveExtractor');
const { analyzeResponseContent, createInvalidResponseSubtitle } = require('../utils/responseAnalyzer');
const {
  getProviderAuthFailureCacheKey,
  hasCachedProviderAuthFailure,
  cacheProviderAuthFailure
} = require('../utils/providerAuthFailureCache');

const SUBSOURCE_API_URL = 'https://api.subsource.net/api/v1';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MAX_LINK_CACHE = 2000; // in-memory direct-link cache size
const MAX_ZIP_BYTES = 25 * 1024 * 1024; // hard cap for ZIP downloads (~25MB) to avoid huge packs

// 🎯 RAM Cache Anti-Spam (30s TTL + Had Siling Memori)
const subsourceMemoryCache = new Map();
const MAX_CACHE_ENTRIES = 500;
const DEBOUNCE_TTL_MS = 30000;

function setSubsourceCache(key, data) {
  if (subsourceMemoryCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = subsourceMemoryCache.keys().next().value;
    subsourceMemoryCache.delete(oldestKey);
  }
  subsourceMemoryCache.set(key, { timestamp: Date.now(), data });
}

function isSubSourceAuthFailure(error) {
  const status = error?.response?.status;
  if (status === 401) {
    return true;
  }

  if (status !== 403) {
    return false;
  }

  const data = error?.response?.data;
  const message = (typeof data === 'string' ? data : (data?.message || data?.error || error?.message || '')).toLowerCase();
  return (
    message.includes('not authorized') ||
    message.includes('unauthorized') ||
    message.includes('invalid api') ||
    message.includes('api key') ||
    message.includes('forbidden') ||
    message.includes('authentication')
  );
}

class SubSourceService {
  static client = axios.create({
    baseURL: SUBSOURCE_API_URL,
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'application/json, application/*+json, application/zip, application/octet-stream, application/x-subrip, text/plain, text/srt, */*',
      'Accept-Encoding': 'gzip, deflate, br',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://subsource.net/',
      'Origin': 'https://subsource.net',
      'DNT': '1',
      'Sec-GPC': '1',
      'Connection': 'keep-alive',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-site',
      'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-ch-ua-platform-version': '"15.0.0"',
      'sec-ch-ua-arch': '"x86"',
      'sec-ch-ua-bitness': '"64"',
      'sec-ch-ua-full-version': '"131.0.6778.86"',
      'sec-ch-ua-full-version-list': '"Chromium";v="131.0.6778.86", "Not_A Brand";v="24.0.0.0"',
      'X-Requested-With': 'XMLHttpRequest'
    },
    httpAgent,
    httpsAgent,
    lookup: dnsLookup,
    timeout: 12000,
    maxRedirects: 5,
    decompress: true
  });

  static initLogged = false;

  constructor(apiKey = null) {
    this.apiKey = (typeof apiKey === 'string') ? apiKey.trim() : '';
    this.authFailureCacheKey = getProviderAuthFailureCacheKey('subsource', this.apiKey);
    this.baseURL = SUBSOURCE_API_URL;
    this._linkCache = new Map();
    this.client = SubSourceService.client;

    this.defaultHeaders = {
      'User-Agent': USER_AGENT,
      'Accept': 'application/json, application/*+json, application/zip, application/octet-stream, application/x-subrip, text/plain, text/srt, */*',
      'Accept-Encoding': 'gzip, deflate, br',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://subsource.net/',
      'Origin': 'https://subsource.net',
      'DNT': '1',
      'Sec-GPC': '1',
      'Connection': 'keep-alive',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-site',
      'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-ch-ua-platform-version': '"15.0.0"',
      'sec-ch-ua-arch': '"x86"',
      'sec-ch-ua-bitness': '"64"',
      'sec-ch-ua-full-version': '"131.0.6778.86"',
      'sec-ch-ua-full-version-list': '"Chromium";v="131.0.6778.86", "Not_A Brand";v="24.0.0.0"',
      'X-Requested-With': 'XMLHttpRequest'
    };

    const sanitizedApiKey = sanitizeApiKeyForHeader(this.apiKey);
    if (sanitizedApiKey) {
      this.defaultHeaders['X-API-Key'] = sanitizedApiKey;
      this.defaultHeaders['api-key'] = sanitizedApiKey;
      if (!SubSourceService.initLogged) {
        log.debug(() => '[SubSource] Initializing with API key in headers');
      }
    } else if (this.apiKey && this.apiKey.trim() !== '') {
      log.warn(() => '[SubSource] API key appears corrupted (contains invalid characters) - please re-enter your SubSource API key');
    }

    if (!SubSourceService.initLogged) {
      SubSourceService.initLogged = true;
    }
  }

  rememberDownloadLink(id, url) {
    try {
      if (!id || !url || typeof url !== 'string') return;
      if (!/^https?:\/\//i.test(url)) return;
      this._linkCache.set(String(id), url);
      if (this._linkCache.size > MAX_LINK_CACHE) {
        const firstKey = this._linkCache.keys().next().value;
        if (firstKey !== undefined) this._linkCache.delete(firstKey);
      }
    } catch (_) { /* ignore */ }
  }

  async retryWithBackoff(fn, options = {}) {
    const totalTimeoutMs = options.totalTimeoutMs ?? 10000;
    const maxRetries = options.maxRetries ?? 2;
    const baseDelay = options.baseDelay ?? 800;
    const minAttemptTimeoutMs = options.minAttemptTimeoutMs ?? 2500;

    const startedAt = Date.now();
    let attempt = 0;

    const remaining = () => Math.max(0, totalTimeoutMs - (Date.now() - startedAt));

    while (true) {
      const r = remaining();
      if (r <= 0) throw new Error('Request timed out');

      const hasMoreRetries = attempt < maxRetries;
      const plannedDelay = hasMoreRetries
        ? Math.min(Math.round(baseDelay * Math.pow(2, attempt)), Math.floor(r / 3))
        : 0;

      const attemptTimeout = Math.max(minAttemptTimeoutMs, r - plannedDelay);

      try {
        return await fn(attemptTimeout);
      } catch (error) {
        const status = error.response?.status;
        const code = error.code;
        const isTimeout = code === 'ECONNABORTED' || code === 'ETIMEDOUT' || /timeout/i.test(error.message || '');
        const isNetwork = code === 'ECONNRESET' || code === 'ECONNREFUSED';
        const isRetryableStatus = status === 429 || status === 503 || (status >= 500 && status <= 599);
        const retryable = isTimeout || isNetwork || isRetryableStatus;

        if (!retryable || attempt >= maxRetries) {
          throw error;
        }

        const r2 = remaining();
        const delay = Math.min(plannedDelay, Math.max(0, r2 - minAttemptTimeoutMs));
        if (delay <= 0) {
          throw error;
        }
        log.warn(() => `[SubSource] Request failed (attempt ${attempt + 1}) — ${status || code || error.message}. Retrying in ${delay}ms...`);
        await new Promise(res => setTimeout(res, delay));
        attempt++;
      }
    }
  }

  async getMovieId(imdb_id, season = null, providerTimeout = null) {
    const timeoutMs = providerTimeout || 10000;

    try {
      const cached = await providerMetadataCache.get('subsource', 'movieId', imdb_id, season);
      if (cached) {
        log.debug(() => `[SubSource] movieId cache HIT: ${imdb_id}${season ? `:S${season}` : ''} → ${cached}`);
        return cached;
      }
    } catch (err) {
      log.warn(() => `[SubSource] Cache read error: ${err.message}`);
    }

    try {
      let searchUrl = `${this.baseURL}/movies/search?searchType=imdb&imdb=${imdb_id}`;
      if (season) {
        searchUrl += `&season=${season}`;
      }

      log.debug(() => `[SubSource] Fetching movieId: ${imdb_id}${season ? ` S${season}` : ''} (timeout: ${timeoutMs}ms)`);

      const response = await this.client.get(searchUrl, {
        headers: this.defaultHeaders,
        responseType: 'json',
        timeout: timeoutMs
      });

      const movies = Array.isArray(response.data) ? response.data : (response.data?.data || []);

      if (movies.length > 0) {
        const movieId = movies[0].id || movies[0].movieId;
        const movieTitle = movies[0].title || 'Unknown';

        if (movieId) {
          providerMetadataCache.set('subsource', 'movieId', imdb_id, movieId, season)
            .catch(err => log.warn(() => `[SubSource] Cache write error: ${err.message}`));

          log.debug(() => `[SubSource] Found movieId=${movieId} for "${movieTitle}"${season ? ` S${season}` : ''}`);
          return movieId;
        }
      }

      log.debug(() => `[SubSource] No movie found for: ${imdb_id}${season ? ` S${season}` : ''}`);
      return null;
    } catch (error) {
      const code = error?.code || '';
      const isTimeout = code === 'ECONNABORTED' || code === 'ETIMEDOUT' || /timeout/i.test(error?.message || '');

      if (isTimeout) {
        log.warn(() => `[SubSource] movieId lookup timed out after ${timeoutMs}ms for ${imdb_id}`);
      } else {
        logApiError(error, 'SubSource', 'Get movie ID', { skipResponseData: true, skipUserMessage: true });
      }

      return null;
    }
  }

  async searchSubtitles(params) {
    try {
      if (!this.apiKey || this.apiKey.trim() === '') {
        log.debug(() => '[SubSource] API key is missing; skipping search');
        return [];
      }

      if (await hasCachedProviderAuthFailure(this.authFailureCacheKey)) {
        log.warn(() => '[SubSource] Search blocked: cached invalid API key detected');
        return [];
      }

      const { imdb_id, type, season, episode, languages, excludeHearingImpairedSubtitles, providerTimeout } = params;

      if (!imdb_id || imdb_id === 'undefined') {
        log.debug(() => '[SubSource] No IMDB ID available, skipping search');
        return [];
      }

      // 🎯 Penapis Spam Request Stremio (Local RAM Hit)
      const localCacheKey = `${imdb_id}:${type}:${season || 1}:${episode || ''}:${(languages || []).join(',')}:${excludeHearingImpairedSubtitles === true ? 'nohi' : 'all'}`;
      if (subsourceMemoryCache.has(localCacheKey)) {
        const cachedEntry = subsourceMemoryCache.get(localCacheKey);
        if (Date.now() - cachedEntry.timestamp < DEBOUNCE_TTL_MS) {
          log.debug(() => `[SubSource] Local RAM hit for ${localCacheKey} - Debouncing duplicate Stremio request`);
          return cachedEntry.data;
        }
        subsourceMemoryCache.delete(localCacheKey);
      }

      const userTimeoutMs = providerTimeout || 10000;
      const totalStartTime = Date.now();

      const movieId = await this.getMovieId(imdb_id, season, userTimeoutMs);
      const movieIdDurationMs = Date.now() - totalStartTime;

      if (!movieId) {
        log.debug(() => `[SubSource] Could not find movie ID for: ${imdb_id}${season ? ` S${season}` : ''} (took ${movieIdDurationMs}ms)`);
        return [];
      }

      const elapsedMs = Date.now() - totalStartTime;
      const searchTimeoutMs = Math.max(0, userTimeoutMs - elapsedMs);

      if (movieIdDurationMs > 1000) {
        log.debug(() => `[SubSource] movieId lookup took ${movieIdDurationMs}ms - subtitle search gets ${searchTimeoutMs}ms`);
      }

      if (searchTimeoutMs < 2000) {
        log.warn(() => `[SubSource] Insufficient time remaining for search after movieId lookup (${searchTimeoutMs}ms left)`);
        return [];
      }

      const queryParams = {
        movieId: movieId,
        sort: 'popular',
        limit: 100
      };

      if (excludeHearingImpairedSubtitles === true) {
        queryParams.hearingImpaired = 'false';
      }

      const languageMap = {
        'eng': 'english', 'spa': 'spanish', 'spn': 'spanish_latin_america',
        'fre': 'french', 'fra': 'french', 'ger': 'german', 'deu': 'german',
        'por': 'portuguese', 'pob': 'brazilian_portuguese', 'ita': 'italian',
        'rus': 'russian', 'jpn': 'japanese', 'kor': 'korean', 'chi': 'chinese',
        'zho': 'chinese', 'zhs': 'chinese_simplified', 'zht': 'chinese_traditional',
        'ara': 'arabic', 'dut': 'dutch', 'nld': 'dutch', 'pol': 'polish',
        'tur': 'turkish', 'swe': 'swedish', 'dan': 'danish', 'fin': 'finnish',
        'nor': 'norwegian', 'nob': 'norwegian', 'nno': 'norwegian',
        'heb': 'hebrew', 'hin': 'hindi', 'tha': 'thai', 'vie': 'vietnamese',
        'ind': 'indonesian', 'rum': 'romanian', 'ron': 'romanian',
        'cze': 'czech', 'ces': 'czech', 'hun': 'hungarian', 'gre': 'greek',
        'ell': 'greek', 'bul': 'bulgarian', 'hrv': 'croatian', 'ukr': 'ukrainian',
        'srp': 'serbian', 'per': 'farsi_persian', 'fas': 'farsi_persian',
        'may': 'malay', 'msa': 'malay', 'est': 'estonian', 'lav': 'latvian',
        'lit': 'lithuanian', 'slo': 'slovak', 'slk': 'slovak', 'slv': 'slovenian',
        'ben': 'bengali', 'tgl': 'tagalog', 'fil': 'tagalog', 'bos': 'bosnian',
        'mac': 'macedonian', 'mkd': 'macedonian', 'alb': 'albanian', 'sqi': 'albanian',
        'geo': 'georgian', 'kat': 'georgian', 'ice': 'icelandic', 'isl': 'icelandic',
        'cat': 'catalan', 'baq': 'basque', 'eus': 'basque', 'glg': 'galician',
        'wel': 'welsh', 'cym': 'welsh', 'swa': 'swahili', 'mal': 'malayalam',
        'tam': 'tamil', 'tel': 'telugu', 'urd': 'urdu', 'pan': 'punjabi',
        'nep': 'nepali', 'sin': 'sinhala', 'khm': 'khmer', 'lao': 'lao',
        'bur': 'burmese', 'mya': 'burmese', 'mon': 'mongolian', 'afr': 'afrikaans',
        'kur': 'kurdish',
        'en': 'english', 'es': 'spanish', 'fr': 'french', 'de': 'german',
        'pt': 'portuguese', 'it': 'italian', 'ru': 'russian', 'ja': 'japanese',
        'ko': 'korean', 'zh': 'chinese', 'ar': 'arabic', 'nl': 'dutch',
        'pl': 'polish', 'tr': 'turkish', 'sv': 'swedish', 'da': 'danish',
        'fi': 'finnish', 'no': 'norwegian', 'he': 'hebrew', 'hi': 'hindi',
        'th': 'thai', 'vi': 'vietnamese', 'id': 'indonesian', 'ro': 'romanian',
        'cs': 'czech', 'hu': 'hungarian', 'el': 'greek', 'bg': 'bulgarian',
        'hr': 'croatian', 'uk': 'ukrainian', 'sr': 'serbian', 'fa': 'farsi_persian',
        'ms': 'malay', 'et': 'estonian', 'lv': 'latvian', 'lt': 'lithuanian',
        'sk': 'slovak', 'sl': 'slovenian', 'bn': 'bengali', 'tl': 'tagalog',
        'bs': 'bosnian', 'mk': 'macedonian', 'sq': 'albanian', 'ka': 'georgian',
        'is': 'icelandic', 'ca': 'catalan', 'eu': 'basque', 'gl': 'galician',
        'cy': 'welsh', 'sw': 'swahili', 'ml': 'malayalam', 'ta': 'tamil',
        'te': 'telugu', 'ur': 'urdu', 'pa': 'punjabi', 'ne': 'nepali',
        'si': 'sinhala', 'km': 'khmer', 'lo': 'lao', 'my': 'burmese',
        'mn': 'mongolian', 'af': 'afrikaans', 'ku': 'kurdish'
      };

      const convertedLanguages = (languages || []).map(lang => {
        if (!lang) return null;
        const lower = lang.toLowerCase().trim();
        return languageMap[lower] || null;
      }).filter(lang => lang !== null);

      const uniqueLanguages = [...new Set(convertedLanguages)];
      if (uniqueLanguages.length > 0) {
        queryParams.language = uniqueLanguages.join(',');
      } else if (languages && languages.length > 0) {
        log.warn(() => `[SubSource] None of the requested languages [${languages.join(', ')}] are supported by SubSource, skipping search`);
        return [];
      }

      log.debug(() => `[SubSource] Searching: movieId=${queryParams.movieId}, languages=[${queryParams.language || 'all'}], sort=${queryParams.sort}, limit=${queryParams.limit}${type === 'episode' ? `, episode=${episode}` : ''}`);

      let response;
      let endpoint = '/subtitles';
      const queryString = new URLSearchParams(queryParams).toString();
      const url = `${this.baseURL}${endpoint}?${queryString}`;

      try {
        const requestConfig = { headers: this.defaultHeaders, responseType: 'json', timeout: searchTimeoutMs };
        const rawResponse = await this.client.get(url, requestConfig);
        response = rawResponse.data;
      } catch (error) {
        if (error.response?.status === 404) {
          log.debug(() => '[SubSource] /subtitles endpoint not found, trying /search');
          endpoint = '/search';
          const searchUrl = `${this.baseURL}${endpoint}?${queryString}`;
          const searchConfig = { headers: this.defaultHeaders, responseType: 'json', timeout: searchTimeoutMs };
          const rawResponse = await this.client.get(searchUrl, searchConfig);
          response = rawResponse.data;
        } else {
          throw error;
        }
      }

      let subtitlesData = null;
      if (response) {
        if (Array.isArray(response)) {
          subtitlesData = response;
        } else if (response.subtitles) {
          subtitlesData = response.subtitles;
        } else if (response.data) {
          if (Array.isArray(response.data)) {
            subtitlesData = response.data;
          } else if (response.data.subtitles) {
            subtitlesData = response.data.subtitles;
          } else if (response.data.results) {
            subtitlesData = response.data.results;
          }
        } else if (response.results) {
          subtitlesData = response.results;
        }
      }

      if (!subtitlesData || subtitlesData.length === 0) {
        log.debug(() => '[SubSource] No subtitles found in response');
        return [];
      }

      log.debug(() => `[SubSource] API returned ${subtitlesData.length} subtitles (before episode filtering)`);

      const subtitles = subtitlesData.map(sub => {
        const originalLang = sub.language || 'en';
        const normalizedLang = this.normalizeLanguageCode(originalLang);
        const subtitleId = sub.subtitleId || sub.id || sub.subtitle_id || sub._id;
        const fileId = `subsource_${subtitleId}`;

        if (!subtitleId) {
          log.error(() => '[SubSource] WARNING: Subtitle missing ID field');
        }

        let extractedName = null;
        if (sub.releaseInfo && Array.isArray(sub.releaseInfo) && sub.releaseInfo.length > 0) {
          extractedName = sub.releaseInfo.join(' / ');
        } else if (sub.releaseInfo && typeof sub.releaseInfo === 'string') {
          extractedName = sub.releaseInfo;
        }

        if (!extractedName) {
          extractedName = sub.name ||
            sub.release_name ||
            sub.releaseName ||
            sub.fullname ||
            sub.fullName ||
            sub.full_name ||
            sub.file_name ||
            sub.fileName ||
            sub.filename ||
            sub.title ||
            sub.subtitle_name ||
            sub.subtitleName ||
            sub.releasename ||
            sub.label ||
            sub.description ||
            sub.subtitle ||
            sub.release ||
            null;
        }

        let finalName = extractedName;
        if (!finalName || finalName.trim() === '') {
          const langName = originalLang || 'Unknown Language';
          const dlCount = parseInt(sub.downloads || sub.download_count || 0, 10) || 0;
          const typeInfo = sub.productionType || sub.releaseType || '';
          finalName = `SubSource ${langName}${typeInfo ? ` [${typeInfo}]` : ''}${dlCount > 0 ? ` (${dlCount} downloads)` : ''}`;
        } else {
          const typeInfo = sub.productionType || sub.releaseType || '';
          if (typeInfo && !finalName.toLowerCase().includes(typeInfo.toLowerCase())) {
            finalName = `${finalName} [${typeInfo}]`;
          }
        }

        const extractedDate = sub.createdAt || sub.created_at || sub.upload_date || sub.uploadDate || sub.date;
        const extractedDownloads = parseInt(sub.downloads || sub.download_count || sub.downloadCount || 0, 10) || 0;

        let extractedRating = 0;
        if (sub.rating && typeof sub.rating === 'object') {
          const good = parseInt(sub.rating.good, 10) || 0;
          const bad = parseInt(sub.rating.bad, 10) || 0;
          const total = good + bad;

          if (total > 0) {
            const CONFIDENCE = 5;
            const PRIOR_POSITIVE_RATIO = 0.7;
            const weightedGood = good + (CONFIDENCE * PRIOR_POSITIVE_RATIO);
            const weightedTotal = total + CONFIDENCE;
            extractedRating = (weightedGood / weightedTotal) * 10;
          }
        } else {
          extractedRating = parseFloat(sub.rating || sub.score || 0) || 0;
        }

        const directUrl = sub.download_url || sub.downloadUrl || sub.url;
        if (subtitleId && directUrl) {
          try { this.rememberDownloadLink(subtitleId, directUrl); } catch (_) { }
        }

        return {
          id: fileId,
          language: originalLang,
          languageCode: normalizedLang,
          name: finalName,
          downloads: extractedDownloads,
          rating: extractedRating,
          uploadDate: extractedDate,
          format: sub.format || 'srt',
          fileId: fileId,
          downloadLink: directUrl,
          hearing_impaired: isTrueishFlag(sub.hearingImpaired) || isTrueishFlag(sub.hearing_impaired) || isTrueishFlag(sub.hi),
          foreign_parts_only: sub.foreignParts || false,
          machine_translated: false,
          uploader: sub.uploader || sub.author || sub.user || 'Unknown',
          provider: 'subsource',
          subsource_id: subtitleId,
          productionType: sub.productionType || null,
          releaseType: sub.releaseType || null,
          framerate: sub.framerate || null,
          ratingDetails: sub.rating && typeof sub.rating === 'object' ? {
            good: parseInt(sub.rating.good, 10) || 0,
            bad: parseInt(sub.rating.bad, 10) || 0,
            total: parseInt(sub.rating.total, 10) || 0
          } : null
        };
      });

      let filteredSubtitles = subtitles;
      if ((type === 'episode' || type === 'anime-episode') && episode) {
        const targetSeason = season || 1;
        const targetEpisode = episode;

        log.debug(() => [`[SubSource] Filtering for S${String(targetSeason).padStart(2, '0')}E${String(targetEpisode).padStart(2, '0')} (${subtitles.length} pre-filter)`]);

        filteredSubtitles = subtitles.filter(sub => {
          const name = (sub.name || '').toLowerCase();

          if (hasExplicitSeasonEpisodeMismatch(name, targetSeason, targetEpisode)) {
            return false;
          }

          const seasonPackPatterns = [
            new RegExp(`(?:complete|full|entire)?\\s*(?:season|s)\\s*0*${targetSeason}(?:\\s+(?:complete|full|pack))?(?!.*e0*\\d)`, 'i'),
            new RegExp(`(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\\s+season(?!.*episode)`, 'i'),
            new RegExp(`s0*${targetSeason}\\s*(?:complete|full|pack)`, 'i'),
            /\d{1,3}\s*[-~]\s*\d{1,3}\s*(?:complete|batch|full|pack|\]|$)/i,
            /\[(?:batch|complete|full)\]/i,
            new RegExp(`\\.s0*${targetSeason}\\.(?!e0*\\d)(?:complete|720p|1080p|2160p|4k|blu\\.?ray|webrip|web[\\-\\.]?dl|hdtv|dvdrip|bdrip|brrip)`, 'i')
          ];

          const animeSeasonPackPatterns = [
            /(?:complete|batch|full(?:\s+series)?|\d{1,2}\s*[-~]\s*\d{1,2})/i,
            /\[(?:batch|complete|full)\]/i,
            /(?:episode\s*)?(?:01|001)\s*[-~]\s*(?:\d{2}|\d{3})/i
          ];

          let isSeasonPack = false;
          const hasEpisodeNumber = /s0*\d+e0*\d+|\d+x\d+|episode\s*\d+|ep\.?\s*\d+|\be\.?\s*\d{1,3}\b/i.test(name);

          if (type === 'anime-episode') {
            const episodeExclusionPattern = new RegExp(`(?:^|[^0-9])0*${targetEpisode}(?:v\\d+)?(?:[^0-9]|$)`);
            isSeasonPack = animeSeasonPackPatterns.some(pattern => pattern.test(name)) &&
              !episodeExclusionPattern.test(name);
          } else {
            isSeasonPack = seasonPackPatterns.some(pattern => pattern.test(name)) &&
              !hasEpisodeNumber;
          }

          if (isSeasonPack) {
            sub.is_season_pack = true;
            sub.season_pack_season = targetSeason;
            sub.season_pack_episode = targetEpisode;

            const originalFileId = sub.fileId || sub.id;
            sub.fileId = `${originalFileId}_seasonpack_s${targetSeason}e${targetEpisode}`;
            sub.id = sub.fileId;

            log.debug(() => `[SubSource] Detected season pack: ${sub.name}`);
            return true;
          }

          const seasonEpisodePatterns = [
            new RegExp(`s0*${targetSeason}e0*${targetEpisode}(?![0-9])`, 'i'),
            new RegExp(`${targetSeason}x0*${targetEpisode}(?![0-9])`, 'i'),
            new RegExp(`s0*${targetSeason}[\\s._-]*x[\\s._-]*e?0*${targetEpisode}(?![0-9])`, 'i'),
            new RegExp(`0*${targetSeason}[\\s._-]*x[\\s._-]*e?0*${targetEpisode}(?![0-9])`, 'i'),
            new RegExp(`s0*${targetSeason}\\.e0*${targetEpisode}(?![0-9])`, 'i'),
            new RegExp(`season\\s*0*${targetSeason}.*episode\\s*0*${targetEpisode}(?![0-9])`, 'i')
          ];

          const animeEpisodePatterns = [
            new RegExp(`(?<=\\b|\\s|\\[|\\(|-|_)e?p?\\s*0*${targetEpisode}(?:v\\d+)?(?=\\b|\\s|\\[\\]|\\(\\)|\\.|-|_|$)`, 'i'),
            new RegExp(`(?:^|[\\s\\[\\(\\-_])0*${targetEpisode}(?:v\\d+)?(?=$|[\\s\\[\\]\\(\\)\\-_.])`, 'i'),
            new RegExp(`(?:^|[\\s\\[\\(\\-_])0*${targetEpisode}(?:v\\d+)?[a-z]{2,3}(?=\\.|[\\s\\[\\]\\(\\)\\-_.]|$)`, 'i'),
            new RegExp(`(?:^|[\\s\\[\\(\\-_])episode\\s*0*${targetEpisode}(?=$|[\\s\\]\\)\\-_.])`, 'i'),
            new RegExp(`(?:^|[\\s\\[\\(\\-_])ep\\s*0*${targetEpisode}(?=$|[\\s\\]\\)\\-_.])`, 'i'),
            new RegExp(`(?:^|[\\s\\[\\(\\-_])cap(?:itulo|\\.)?\\s*0*${targetEpisode}(?=$|[\\s\\]\\)\\-_.])`, 'i'),
            new RegExp(`(?:^|[\\s\\[\\(\\-_])epis[oó]dio\\s*0*${targetEpisode}(?=$|[\\s\\]\\)\\-_.])`, 'i'),
            new RegExp(`第\\s*0*${targetEpisode}\\s*(?:話|集)`, 'i'),
            new RegExp(`(?:^|[\\s\\[\\(\\-_])0*${targetEpisode}\\s*(?:話|集|화)(?=$|[\\s\\]\\)\\-_.])`, 'i'),
            new RegExp(`(?:^|[\\s\\[\\(\\-_])0*${targetEpisode}\\s*[-~](?=\\s*\\d)`, 'i'),
            new RegExp(`(?:^|[\\s\\[\\(\\-_])\\d+\\s*[-~]\\s*0*${targetEpisode}(?=$|[\\s\\]\\)\\-_.])`, 'i')
          ];

          return seasonEpisodePatterns.some(pattern => pattern.test(name))
            || (type === 'anime-episode' && animeEpisodePatterns.some(p => p.test(name)));
        });

        if (filteredSubtitles.length === 0) {
          log.debug(() => '[SubSource] No matches after episode filtering; returning no results for this episode');
        }

        log.debug(() => [`[SubSource] After episode filtering: ${filteredSubtitles.length} subtitles (including ${filteredSubtitles.filter(s => s.is_season_pack).length} season packs)`]);
      }

      const MAX_RESULTS_PER_LANGUAGE = 14;
      const groupedByLanguage = {};

      for (const sub of filteredSubtitles) {
        const lang = sub.languageCode || 'unknown';
        if (!groupedByLanguage[lang]) {
          groupedByLanguage[lang] = [];
        }
        if (groupedByLanguage[lang].length < MAX_RESULTS_PER_LANGUAGE) {
          groupedByLanguage[lang].push(sub);
        }
      }

      const limitedSubtitles = Object.values(groupedByLanguage).flat();
      log.debug(() => [`[SubSource] Returning ${limitedSubtitles.length} subtitles after per-language limit`]);

      if (limitedSubtitles.length > 0) {
        setSubsourceCache(localCacheKey, limitedSubtitles);
      }

      return limitedSubtitles;

    } catch (error) {
      if (isSubSourceAuthFailure(error)) {
        await cacheProviderAuthFailure(this.authFailureCacheKey);
      }
      return handleSearchError(error, 'SubSource');
    }
  }

  async downloadSubtitle(fileId, options = {}) {
    let subsource_id = null;
    const timeout = options?.timeout || 12000;

    if (typeof options === 'string') {
      subsource_id = options;
    }

    try {
      log.debug(() => ['[SubSource] Downloading subtitle:', fileId]);

      let isSeasonPack = false;
      let seasonPackSeason = null;
      let seasonPackEpisode = null;

      if (!subsource_id) {
        const parts = fileId.split('_');
        if (parts.length >= 2 && parts[0] === 'subsource') {
          subsource_id = parts[1];

          if (parts.length >= 4 && parts[2] === 'seasonpack') {
            isSeasonPack = true;
            const match = parts[3].match(/s(\d+)e(\d+)/i);
            if (match) {
              seasonPackSeason = parseInt(match[1], 10);
              seasonPackEpisode = parseInt(match[2], 10);
              log.debug(() => `[SubSource] Season pack download requested: S${String(seasonPackSeason).padStart(2, '0')}E${String(seasonPackEpisode).padStart(2, '0')}`);
            }
          }
        } else {
          throw new Error('Invalid SubSource file ID format');
        }
      }

      log.debug(() => ['[SubSource] SubSource ID:', subsource_id]);

      if (!subsource_id || subsource_id === 'undefined') {
        throw new Error('Invalid or missing SubSource subtitle ID');
      }

      let response;
      try {
        const cachedDirect = this._linkCache.get(String(subsource_id));
        if (cachedDirect && /^https?:\/\//i.test(cachedDirect)) {
          log.debug(() => `[SubSource] Trying CDN/direct link first: ${cachedDirect.replace(/\?.*$/, '')}`);
          response = await this.client.get(cachedDirect, {
            responseType: 'arraybuffer',
            timeout: 4000,
            maxContentLength: MAX_ZIP_BYTES,
            headers: {
              'User-Agent': this.defaultHeaders['User-Agent'],
              'Accept': this.defaultHeaders['Accept'],
              'Accept-Encoding': this.defaultHeaders['Accept-Encoding'],
              'Referer': this.defaultHeaders['Referer'],
              'Origin': this.defaultHeaders['Origin']
            }
          });
        }
      } catch (cdnFirstErr) {
        log.warn(() => ['[SubSource] CDN-first attempt failed:', cdnFirstErr?.message || String(cdnFirstErr)]);
        response = null;
      }

      if (!response) {
        const url = `/subtitles/${subsource_id}/download`;
        const downloadHeaders = { ...this.defaultHeaders };
        delete downloadHeaders['Cache-Control'];
        delete downloadHeaders['Pragma'];

        let triggerFallbackResolve;
        let fallbackTriggered = false;
        const triggerFallback = () => {
          if (!fallbackTriggered) {
            fallbackTriggered = true;
            try { triggerFallbackResolve && triggerFallbackResolve(); } catch (_) { }
          }
        };

        const fallbackGate = new Promise((resolve) => { triggerFallbackResolve = resolve; });

        const fallbackPromise = (async () => {
          await fallbackGate;
          log.warn(() => '[SubSource] Primary started failing — launching details→CDN in parallel');

          const detailResp = await this.client.get(`/subtitles/${subsource_id}`, {
            headers: this.defaultHeaders,
            responseType: 'json',
            timeout: 5000
          }).catch(() => null);

          let directUrl = null;
          if (detailResp && detailResp.data) {
            const d = detailResp.data;
            directUrl = d.download_url || d.downloadUrl || d.url || (d.data && (d.data.download_url || d.data.downloadUrl || d.data.url)) || null;
          }

          if (directUrl && typeof directUrl === 'string' && /^https?:\/\//i.test(directUrl)) {
            log.debug(() => `[SubSource] Using CDN/direct link fallback: ${directUrl.replace(/\?.*$/, '')}`);
            return this.client.get(directUrl, {
              responseType: 'arraybuffer',
              timeout: 4000,
              maxContentLength: MAX_ZIP_BYTES,
              headers: {
                'User-Agent': this.defaultHeaders['User-Agent'],
                'Accept': this.defaultHeaders['Accept'],
                'Accept-Encoding': this.defaultHeaders['Accept-Encoding'],
                'Referer': this.defaultHeaders['Referer'],
                'Origin': this.defaultHeaders['Origin']
              }
            });
          } else {
            throw new Error('No direct URL available from details');
          }
        })();

        const primaryPromise = (async () => {
          return this.retryWithBackoff((attemptTimeout) => this.client.get(url, {
            headers: downloadHeaders,
            responseType: 'arraybuffer',
            timeout: attemptTimeout,
            maxContentLength: MAX_ZIP_BYTES
          }).catch((err) => {
            const code = err?.code || '';
            const status = err?.response?.status;
            const isTimeout = code === 'ECONNABORTED' || code === 'ETIMEDOUT' || /timeout/i.test(err.message || '');
            const isNetwork = code === 'ECONNRESET' || code === 'ECONNREFUSED';
            const isRetryableStatus = status === 429 || status === 503 || (status >= 500 && status <= 599);
            if (isTimeout || isNetwork || isRetryableStatus) triggerFallback();
            throw err;
          }), { totalTimeoutMs: timeout, maxRetries: 2, baseDelay: 800, minAttemptTimeoutMs: 2500 });
        })();

        try {
          response = await Promise.any([primaryPromise, fallbackPromise]);
        } catch (e) {
          const firstErr = Array.isArray(e?.errors) && e.errors.length ? e.errors[0] : e;
          throw firstErr;
        }
      }

      const contentType = response.headers && (response.headers['content-type'] || response.headers['Content-Type']) || '';
      const responseBody = response.data;
      const responseBuffer = Buffer.isBuffer(responseBody) ? responseBody : Buffer.from(responseBody);
      const contentAnalysis = analyzeResponseContent(responseBuffer);
      const archiveType = detectArchiveType(responseBuffer);
      const isZipByMagicBytes = contentAnalysis.type === 'zip';

      if (contentAnalysis.type === 'subtitle' && (contentType.includes('application/zip') || contentType.includes('application/x-zip'))) {
        log.debug(() => `[SubSource] Response declared as ZIP but contains direct subtitle content; processing as subtitle`);
        return detectAndConvertEncoding(responseBuffer, 'SubSource', options.languageHint || null);
      }

      if (archiveType || isZipByMagicBytes || contentType.includes('application/zip') ||
        contentType.includes('application/x-zip')) {

        if (!archiveType && !isZipByMagicBytes) {
          log.error(() => `[SubSource] Response declared as ZIP but missing valid archive signature. Content analysis: ${contentAnalysis.type} - ${contentAnalysis.hint}`);
          return createInvalidResponseSubtitle('SubSource', contentAnalysis, responseBuffer.length);
        }

        log.debug(() => `[SubSource] Detected ${(archiveType || 'ZIP').toUpperCase()} archive`);

        return await extractSubtitleFromArchive(responseBuffer, {
          providerName: 'SubSource',
          maxBytes: MAX_ZIP_BYTES,
          isSeasonPack: isSeasonPack,
          season: seasonPackSeason,
          episode: seasonPackEpisode,
          languageHint: options.languageHint || null,
          skipAssConversion: options.skipAssConversion
        });
      }

      log.debug(() => '[SubSource] Subtitle downloaded successfully');
      const content = detectAndConvertEncoding(responseBuffer, 'SubSource', options.languageHint || null);

      const ct = contentType.toLowerCase();
      if (ct.includes('text/vtt') || content.trim().startsWith('WEBVTT')) {
        log.debug(() => '[SubSource] Detected VTT in direct response; returning original VTT');
        return content;
      }

      if (!content || content.trim().length === 0) {
        throw new Error('Downloaded subtitle content is empty');
      }

      return content;

    } catch (error) {
      handleDownloadError(error, 'SubSource');
    }
  }

  normalizeLanguageCode(language) {
    if (!language) return null;

    const lower = language.toLowerCase().trim();

    const languageNameMap = {
      'english': 'eng', 'spanish': 'spa', 'spanish_latin_america': 'spn',
      'spanish (latin america)': 'spn', 'french': 'fre', 'german': 'ger',
      'portuguese': 'por', 'brazilian': 'pob', 'brazilian_portuguese': 'pob',
      'portuguese (brazil)': 'pob', 'portuguese-brazilian': 'pob',
      'italian': 'ita', 'russian': 'rus', 'japanese': 'jpn',
      'korean': 'kor', 'chinese': 'chi', 'chinese_simplified': 'zhs',
      'chinese (simplified)': 'zhs', 'chinese_traditional': 'zht',
      'chinese (traditional)': 'zht', 'arabic': 'ara', 'dutch': 'dut',
      'polish': 'pol', 'turkish': 'tur', 'swedish': 'swe',
      'danish': 'dan', 'finnish': 'fin', 'norwegian': 'nor',
      'hebrew': 'heb', 'hindi': 'hin', 'thai': 'tha',
      'vietnamese': 'vie', 'indonesian': 'ind', 'romanian': 'rum',
      'czech': 'cze', 'hungarian': 'hun', 'greek': 'gre',
      'bulgarian': 'bul', 'croatian': 'hrv', 'serbian': 'srp',
      'serbian (latin)': 'srp', 'serbian (cyrillic)': 'srp',
      'ukrainian': 'ukr', 'farsi_persian': 'per', 'farsi/persian': 'per',
      'farsi': 'per', 'persian': 'per', 'malay': 'may',
      'estonian': 'est', 'latvian': 'lav', 'lithuanian': 'lit',
      'slovak': 'slo', 'slovenian': 'slv', 'bengali': 'ben',
      'tagalog': 'tgl', 'filipino': 'tgl', 'bosnian': 'bos',
      'macedonian': 'mac', 'albanian': 'alb', 'georgian': 'geo',
      'icelandic': 'ice', 'catalan': 'cat', 'basque': 'baq',
      'galician': 'glg', 'welsh': 'wel', 'swahili': 'swa',
      'malayalam': 'mal', 'tamil': 'tam', 'telugu': 'tel',
      'urdu': 'urd', 'punjabi': 'pan', 'nepali': 'nep',
      'sinhala': 'sin', 'sinhalese': 'sin', 'khmer': 'khm',
      'lao': 'lao', 'burmese': 'bur', 'mongolian': 'mon',
      'afrikaans': 'afr', 'kurdish': 'kur',
      'brazillian portuguese': 'pob', 'abkhazian': 'abk', 'amharic': 'amh',
      'aragonese': 'arg', 'armenian': 'arm', 'assamese': 'asm',
      'asturian': 'ast', 'azerbaijani': 'aze', 'belarusian': 'bel',
      'big 5 code': 'zht', 'breton': 'bre', 'chinese (cantonese)': 'yue',
      'chinese bg code': 'chi', 'chinese bilingual': 'ze', 'dari': 'prs',
      'espranto': 'epo', 'esperanto': 'epo', 'extremaduran': 'ext',
      'french (canada)': 'fre', 'french (france)': 'fre', 'gaelic': 'gla',
      'gaelician': 'glg', 'greenlandic': 'kal', 'igbo': 'ibo',
      'interlingua': 'ina', 'irish': 'gle', 'kannada': 'kan',
      'kazakh': 'kaz', 'kyrgyz': 'kir', 'luxembourgish': 'ltz',
      'manipuri': 'mni', 'marathi': 'mar', 'montenegrin': 'mne',
      'navajo': 'nav', 'northen sami': 'sme', 'northern sami': 'sme',
      'occitan': 'oci', 'odia': 'ori', 'pashto': 'pus',
      'pushto': 'pus', 'santli': 'sat', 'santali': 'sat',
      'sindhi': 'snd', 'somali': 'som', 'sorbian': 'hsb',
      'spanish (spain)': 'spa', 'sylheti': 'syl', 'syriac': 'syr',
      'tatar': 'tat', 'tetum': 'tet', 'toki pona': 'tok',
      'turkmen': 'tuk', 'uzbek': 'uzb'
    };

    if (languageNameMap[lower]) {
      return languageNameMap[lower];
    }

    if (lower.includes('portuguese') && (lower.includes('brazil') || lower === 'pt-br' || lower === 'ptbr' || lower === 'br')) {
      return 'pob';
    }

    if (lower.length === 3) {
      return lower;
    }

    if (lower.length === 2) {
      const iso2Codes = toISO6392(lower);
      if (iso2Codes && iso2Codes.length > 0) {
        return iso2Codes[0].code2;
      }
    }

    return null;
  }
}

module.exports = SubSourceService;
module.exports.__testing = {
  isSubSourceAuthFailure
};
