const axios = require('axios');
const { toISO6391, toISO6392 } = require('../utils/languages');
const { handleSearchError, handleDownloadError } = require('../utils/apiErrorHandler');
const { httpAgent, httpsAgent, dnsLookup } = require('../utils/httpAgents');
const { detectAndConvertEncoding } = require('../utils/encodingDetector');
const { appendHiddenInformationalNote } = require('../utils/subtitle');
const { redactSensitiveData } = require('../utils/logger');
const log = require('../utils/logger');
const { detectArchiveType, extractSubtitleFromArchive, isArchive, createEpisodeNotFoundSubtitle, createZipTooLargeSubtitle, convertSubtitleToVtt } = require('../utils/archiveExtractor');
const { analyzeResponseContent, createInvalidResponseSubtitle } = require('../utils/responseAnalyzer');
const {
  getProviderAuthFailureCacheKey,
  hasCachedProviderAuthFailure,
  cacheProviderAuthFailure
} = require('../utils/providerAuthFailureCache');

const SUBDL_API_URL = 'https://api.subdl.com/api/v1';
const CHROME_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_ZIP_BYTES = 25 * 1024 * 1024; // 25MB cap

// 🎯 RAM Cache dengan Siling Memori (Anti-Memory Leak + 30s Debounce)
const subdlMemoryCache = new Map();
const MAX_CACHE_ENTRIES = 500;
const DEBOUNCE_TTL_MS = 30000;

function setSubdlCache(key, data) {
  if (subdlMemoryCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = subdlMemoryCache.keys().next().value;
    subdlMemoryCache.delete(oldestKey);
  }
  subdlMemoryCache.set(key, { timestamp: Date.now(), data });
}

function getSubDLUpstreamMessage(payload, fallback = '') {
  if (typeof payload === 'string' && payload.trim()) {
    return payload.trim();
  }

  if (payload && typeof payload === 'object') {
    const message = typeof payload.message === 'string' ? payload.message.trim() : '';
    const error = typeof payload.error === 'string' ? payload.error.trim() : '';
    return message || error || fallback;
  }

  return fallback;
}

function isSubDLAuthFailure(error) {
  const status = error?.response?.status;
  if (status === 401) {
    return true;
  }

  if (status !== 403) {
    return false;
  }

  const message = getSubDLUpstreamMessage(error.response?.data, error.message || '').toLowerCase();
  return (
    message.includes('not authorized') ||
    message.includes('unauthorized') ||
    message.includes('invalid api') ||
    message.includes('api key') ||
    message.includes('authentication')
  );
}

function detectPlainSubtitleFormat(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  const preview = buffer.subarray(0, Math.min(buffer.length, 16384)).toString('latin1').replace(/^ï»¿/, '').trimStart();
  if (/^WEBVTT(?:\s|$)/i.test(preview)) return 'vtt';
  if (/^\{\d+\}\{\d+\}/m.test(preview)) return 'sub';
  if (/^\d+\s*\r?\n\d{2}:\d{2}:\d{2}[,.:]\d{2,3}\s*-->/m.test(preview)) return 'srt';
  if (/^\s*\[Script Info\]/im.test(preview) || /^\s*Dialogue\s*:/im.test(preview)) return 'ass';
  return null;
}

class SubDLService {
  static client = axios.create({
    baseURL: SUBDL_API_URL,
    headers: {
      'User-Agent': CHROME_USER_AGENT,
      'Accept': 'application/json'
    },
    httpAgent,
    httpsAgent,
    lookup: dnsLookup,
    timeout: 12000,
    maxRedirects: 5,
    decompress: true
  });

  static downloadClient = axios.create({
    headers: {
      'User-Agent': USER_AGENT, // 'StremioSubtitleTranslator v1.0' (elak sekatan Cloudflare)
      'Accept': '*/*'
    },
    httpAgent,
    httpsAgent,
    lookup: dnsLookup,
    timeout: 18000,
    maxRedirects: 5,
    decompress: true
  });

  constructor(apiKey = null) {
    this.apiKey = (typeof apiKey === 'string') ? apiKey.trim() : '';
    this.authFailureCacheKey = getProviderAuthFailureCacheKey('subdl', this.apiKey);
    this.client = SubDLService.client;

    if (this.apiKey && this.apiKey.trim() !== '') {
      log.debug(() => '[SubDL] Using API key for requests');
    } else {
      log.debug(() => '[SubDL] No API key provided');
    }
  }

  async searchSubtitles(params) {
    try {
      if (!this.apiKey || this.apiKey.trim() === '') {
        log.debug(() => '[SubDL] API key is missing; skipping search');
        return [];
      }

      if (await hasCachedProviderAuthFailure(this.authFailureCacheKey)) {
        log.warn(() => '[SubDL] Search blocked: cached invalid API key detected');
        return [];
      }

      const { imdb_id, type, season, episode, languages, providerTimeout } = params;

      if (!imdb_id || imdb_id === 'undefined') {
        log.debug(() => '[SubDL] No IMDB ID available, skipping search');
        return [];
      }

      // 🎯 Penapis Spam Request Stremio (Local RAM Hit)
      const localCacheKey = `${imdb_id}:${type}:${season || 1}:${episode || ''}:${(languages || []).join(',')}`;
      if (subdlMemoryCache.has(localCacheKey)) {
        const cachedEntry = subdlMemoryCache.get(localCacheKey);
        if (Date.now() - cachedEntry.timestamp < DEBOUNCE_TTL_MS) {
          log.debug(() => `[SubDL] Local RAM hit for ${localCacheKey} - Debouncing duplicate Stremio request`);
          return cachedEntry.data;
        }
        subdlMemoryCache.delete(localCacheKey);
      }

      const subdlLanguageMap = {
        'eng': 'EN', 'spa': 'ES', 'spn': 'ES', 'fre': 'FR', 'fra': 'FR', 'ger': 'DE', 'deu': 'DE',
        'por': 'PT', 'pob': 'BR_PT', 'pt-br': 'BR_PT', 'ptbr': 'BR_PT',
        'ita': 'IT', 'rus': 'RU', 'jpn': 'JA', 'chi': 'ZH', 'zho': 'ZH',
        'kor': 'KO', 'ara': 'AR', 'dut': 'NL', 'nld': 'NL', 'pol': 'PL',
        'tur': 'TR', 'swe': 'SV', 'nor': 'NO', 'dan': 'DA', 'fin': 'FI',
        'gre': 'EL', 'ell': 'EL', 'heb': 'HE', 'hin': 'HI', 'cze': 'CS',
        'ces': 'CS', 'hun': 'HU', 'rum': 'RO', 'ron': 'RO', 'tha': 'TH',
        'vie': 'VI', 'ind': 'ID', 'ukr': 'UK', 'bul': 'BG', 'hrv': 'HR',
        'srp': 'SR', 'slo': 'SK', 'slk': 'SK', 'slv': 'SL', 'est': 'ET',
        'lav': 'LV', 'lit': 'LT', 'per': 'FA', 'fas': 'FA', 'ben': 'BN',
        'cat': 'CA', 'baq': 'EU', 'eus': 'EU', 'glg': 'GL', 'bos': 'BS',
        'mac': 'MK', 'mkd': 'MK', 'alb': 'SQ', 'sqi': 'SQ', 'bel': 'BE',
        'aze': 'AZ', 'geo': 'KA', 'kat': 'KA', 'mal': 'ML', 'tam': 'TA',
        'tel': 'TE', 'urd': 'UR', 'may': 'MS', 'msa': 'MS', 'tgl': 'TL', 'fil': 'TL',
        'ice': 'IS', 'isl': 'IS', 'kur': 'KU', 'ckb': 'KU',
        'prs': 'FA', 'nob': 'NO', 'nno': 'NO', 'zhs': 'ZH', 'zht': 'ZH'
      };

      const convertedLanguages = [...new Set((languages || []).map(lang => {
        const lower = lang.toLowerCase().trim();
        if (subdlLanguageMap[lower]) return subdlLanguageMap[lower];
        const iso1Code = toISO6391(lang);
        if (iso1Code && iso1Code !== 'pb') return iso1Code.toUpperCase();
        return lang.substring(0, 2).toUpperCase();
      }))];

      const queryParams = {
        api_key: this.apiKey,
        imdb_id: imdb_id,
        type: type,
        subs_per_page: 30
      };

      if (convertedLanguages.length > 0) {
        queryParams.languages = convertedLanguages.join(',');
      }

      const isTvOrAnime = (type === 'episode' || type === 'anime-episode') && episode;
      if (isTvOrAnime) {
        queryParams.type = 'tv';
        queryParams.season_number = season || 1;
        queryParams.episode_number = episode;
      }

      log.debug(() => ['[SubDL] Searching with params:', JSON.stringify(redactSensitiveData(queryParams))]);

      const reqP1 = { params: { ...queryParams, page: 1 } };
      const reqP2 = { params: { ...queryParams, page: 2 } };

      if (providerTimeout) {
        reqP1.timeout = providerTimeout;
        reqP2.timeout = providerTimeout;
      }

      // 🛡️ Panggilan Selari Kebal: Menggunakan Promise.allSettled (Jika Page 2 gagal, Page 1 tetap selamat)
      const results = await Promise.allSettled([
        this.client.get('/subtitles', reqP1),
        this.client.get('/subtitles', reqP2)
      ]);

      const subsPage1 = (results[0].status === 'fulfilled' && results[0].value.data?.status === true && Array.isArray(results[0].value.data.subtitles))
        ? results[0].value.data.subtitles : [];
      const subsPage2 = (results[1].status === 'fulfilled' && results[1].value.data?.status === true && Array.isArray(results[1].value.data.subtitles))
        ? results[1].value.data.subtitles : [];

      const combinedSubtitles = [...subsPage1, ...subsPage2];

      if (combinedSubtitles.length === 0) {
        log.debug(() => '[SubDL] No subtitles found in response');
        return [];
      }

      const effectiveSeason = season || 1;

      let subtitles = combinedSubtitles.map(sub => {
        const originalLang = sub.lang || 'en';
        const normalizedLang = this.normalizeLanguageCode(originalLang);

        let sdId = null;
        let subtitleId = null;

        if (sub.url) {
          const urlMatch = sub.url.match(/\/subtitle\/(\d+)-(\d+)\.zip/);
          if (urlMatch) {
            sdId = urlMatch[1];
            subtitleId = urlMatch[2];
          }
        }

        let fileId = `subdl_${sdId}_${subtitleId}`;
        const downloadCount = parseInt(sub.download_count, 10);
        const downloads = (!isNaN(downloadCount) && downloadCount > 0) ? downloadCount : 0;
        const releases = Array.isArray(sub.releases) ? sub.releases : [];

        let isSeasonPack = false;
        let isMultiEpisodePack = false;
        if (isTvOrAnime) {
          const epFrom = sub.episode_from;
          const epEnd = sub.episode_end;
          const epValue = sub.episode;
          const normalizedEpEnd = (epEnd === 0 || epEnd == null) ? null : epEnd;

          if (epFrom != null && normalizedEpEnd != null && epFrom !== normalizedEpEnd) {
            isSeasonPack = true;
            isMultiEpisodePack = true;
          } else if (epValue == null && epFrom == null) {
            isSeasonPack = true;
            isMultiEpisodePack = false;
          }
        }

        const result = {
          id: fileId,
          language: originalLang,
          languageCode: normalizedLang,
          name: sub.release_name || sub.name || 'Unknown',
          downloads: downloads,
          rating: parseFloat(sub.rating) || 0,
          uploadDate: sub.upload_date || sub.created_at,
          format: 'srt',
          fileId: fileId,
          downloadLink: sub.url,
          hearing_impaired: sub.hi === 1 || false,
          foreign_parts_only: false,
          machine_translated: false,
          uploader: sub.author || 'Unknown',
          provider: 'subdl',
          subdl_id: sdId,
          subtitles_id: subtitleId,
          releases: releases,
          _subdlEpisode: sub.episode != null ? parseInt(sub.episode, 10) : null
        };

        if (isSeasonPack) {
          result.is_season_pack = true;
          result.is_multi_episode_pack = isMultiEpisodePack;
          result.season_pack_season = effectiveSeason;
          result.season_pack_episode = episode;
          if (isMultiEpisodePack) {
            result.episode_range = { from: sub.episode_from, to: sub.episode_end };
          }
          result.fileId = `${fileId}_seasonpack_s${effectiveSeason}e${episode}`;
          result.id = result.fileId;
        }

        return result;
      });

      if (isTvOrAnime) {
        subtitles = subtitles.filter(sub => {
          if (sub.is_season_pack) {
            if (sub.is_multi_episode_pack && sub.episode_range) {
              const from = parseInt(sub.episode_range.from, 10);
              const to = parseInt(sub.episode_range.to, 10);
              if (!Number.isNaN(from) && !Number.isNaN(to)) {
                return episode >= from && episode <= to;
              }
            }
            return true;
          }

          const subEp = sub._subdlEpisode;
          if (subEp != null && subEp !== episode) {
            return false;
          }
          return true;
        });
      }

      const MAX_RESULTS_PER_LANGUAGE = 14;
      const groupedByLanguage = {};

      for (const sub of subtitles) {
        const lang = sub.languageCode || 'unknown';
        if (!groupedByLanguage[lang]) {
          groupedByLanguage[lang] = [];
        }
        if (groupedByLanguage[lang].length < MAX_RESULTS_PER_LANGUAGE) {
          groupedByLanguage[lang].push(sub);
        }
      }

      const limitedSubtitles = Object.values(groupedByLanguage).flat();

      if (limitedSubtitles.length > 0) {
        setSubdlCache(localCacheKey, limitedSubtitles);
      }

      return limitedSubtitles;

    } catch (error) {
      if (isSubDLAuthFailure(error)) {
        await cacheProviderAuthFailure(this.authFailureCacheKey);
      }
      return handleSearchError(error, 'SubDL');
    }
  }

  async downloadSubtitle(fileId, options = {}) {
    let subdl_id = null;
    let subtitles_id = null;
    let timeout = options?.timeout || 18000;

    if (typeof options === 'string') {
      subdl_id = options;
      subtitles_id = arguments[2] || null;
      timeout = 18000;
    }

    try {
      log.debug(() => ['[SubDL] Downloading subtitle:', fileId]);

      if (!this.apiKey) {
        const authError = new Error('SubDL API key is required for subtitle downloads');
        authError.response = {
          status: 401,
          data: { message: 'SubDL API key is required for subtitle downloads' },
          headers: {}
        };
        throw authError;
      }

      let isSeasonPack = false;
      let seasonPackSeason = null;
      let seasonPackEpisode = null;

      if (!subdl_id || !subtitles_id) {
        const parts = fileId.split('_');
        if (parts.length >= 3 && parts[0] === 'subdl') {
          subdl_id = parts[1];
          subtitles_id = parts[2];

          if (parts.length >= 5 && parts[3] === 'seasonpack') {
            isSeasonPack = true;
            const match = parts[4].match(/s(\d+)e(\d+)/i);
            if (match) {
              seasonPackSeason = parseInt(match[1], 10);
              seasonPackEpisode = parseInt(match[2], 10);
            }
          }
        } else {
          throw new Error('Invalid SubDL file ID format');
        }
      }

      const downloadUrl = `https://dl.subdl.com/subtitle/${subdl_id}-${subtitles_id}.zip`;

      const MAX_RETRIES = 2;
      const BACKOFF_DELAYS = [2000, 4000];
      let subtitleResponse;
      let lastError;

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          // Percubaan 1: Cuba dengan API Key
          // Jika gagal 403 (isu Free Tier), percubaan seterusnya buang x-api-key secara automatik
          const useKeyHeader = this.apiKey && attempt === 0;

          subtitleResponse = await SubDLService.downloadClient.get(downloadUrl, {
            responseType: 'arraybuffer',
            timeout: timeout,
            maxContentLength: MAX_ZIP_BYTES,
            headers: {
              'User-Agent': 'StremioSubtitleTranslator v1.0',
              'Referer': 'https://subdl.com/',
              ...(useKeyHeader ? { 'x-api-key': this.apiKey } : {})
            }
          });
          break;
        } catch (err) {
          lastError = err;
          const status = err.response?.status;

          // Jika 403 dikesan semasa guna API key, cuba semula serta-merta tanpa API key
          if (status === 403 && attempt === 0 && this.apiKey) {
            log.warn(() => `[SubDL] 403 Forbidden with API key. Retrying download anonymously without x-api-key header...`);
            continue;
          }

          if (status === 503 && attempt < MAX_RETRIES) {
            const delay = BACKOFF_DELAYS[attempt];
            log.warn(() => `[SubDL] Download failed with 503, retrying in ${delay / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES})...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }

          throw err;
        }
      }

      if (!subtitleResponse) {
        throw lastError;
      }

      if (!subtitleResponse.data || subtitleResponse.data.length === 0) {
        throw new Error('Downloaded file is empty');
      }

      const responseBuffer = Buffer.isBuffer(subtitleResponse.data) ? subtitleResponse.data : Buffer.from(subtitleResponse.data);
      const contentAnalysis = analyzeResponseContent(responseBuffer);
      const archiveType = detectArchiveType(responseBuffer);

      if (!archiveType) {
        const plainFormat = detectPlainSubtitleFormat(responseBuffer);
        if (plainFormat) {
          log.debug(() => `[SubDL] Download endpoint returned a plain ${plainFormat.toUpperCase()} subtitle`);
          const decoded = detectAndConvertEncoding(responseBuffer, 'SubDL', options.languageHint || null);
          if (plainFormat === 'sub' || plainFormat === 'ass') {
            return await convertSubtitleToVtt(decoded, `subtitle.${plainFormat}`, 'SubDL', {
              skipAssConversion: options.skipAssConversion
            });
          }
          return decoded;
        }

        log.error(() => `[SubDL] Response is not a valid archive. Content analysis: ${contentAnalysis.type} - ${contentAnalysis.hint}`);
        return createInvalidResponseSubtitle('SubDL', contentAnalysis, responseBuffer.length);
      }

      return await extractSubtitleFromArchive(responseBuffer, {
        providerName: 'SubDL',
        maxBytes: MAX_ZIP_BYTES,
        isSeasonPack: isSeasonPack,
        season: seasonPackSeason,
        episode: seasonPackEpisode,
        languageHint: options.languageHint || null,
        skipAssConversion: options.skipAssConversion
      });

    } catch (error) {
      handleDownloadError(error, 'SubDL');
    }
  }

  normalizeLanguageCode(language) {
    if (!language) return null;

    const lower = language.toLowerCase().trim();

    const languageNameMap = {
      'english': 'eng', 'spanish': 'spa', 'french': 'fre', 'german': 'ger',
      'italian': 'ita', 'portuguese': 'por', 'portuguese (brazil)': 'pob',
      'portuguese-brazilian': 'pob', 'russian': 'rus', 'japanese': 'jpn',
      'chinese': 'chi', 'chinese bg code': 'chi', 'korean': 'kor',
      'arabic': 'ara', 'dutch': 'dut', 'polish': 'pol', 'turkish': 'tur',
      'swedish': 'swe', 'norwegian': 'nor', 'danish': 'dan', 'finnish': 'fin',
      'greek': 'gre', 'hebrew': 'heb', 'hindi': 'hin', 'czech': 'cze',
      'hungarian': 'hun', 'romanian': 'rum', 'thai': 'tha', 'vietnamese': 'vie',
      'indonesian': 'ind', 'malay': 'may', 'ukrainian': 'ukr', 'bulgarian': 'bul',
      'croatian': 'hrv', 'serbian': 'srp', 'serbian (latin)': 'srp',
      'serbian (cyrillic)': 'srp', 'serbian latin': 'srp', 'serbian cyrillic': 'srp',
      'slovak': 'slo', 'slovenian': 'slv', 'estonian': 'est', 'latvian': 'lav',
      'lithuanian': 'lit', 'farsi': 'per', 'persian': 'per', 'farsi_persian': 'per',
      'farsi/persian': 'per', 'bengali': 'ben', 'catalan': 'cat', 'basque': 'baq',
      'galician': 'glg', 'albanian': 'alb', 'azerbaijani': 'aze', 'belarusian': 'bel',
      'bosnian': 'bos', 'burmese': 'bur', 'esperanto': 'epo', 'georgian': 'geo',
      'greenlandic': 'kal', 'icelandic': 'ice', 'kurdish': 'kur', 'macedonian': 'mac',
      'malayalam': 'mal', 'manipuri': 'mni', 'sinhala': 'sin', 'sinhalese': 'sin',
      'tagalog': 'tgl', 'filipino': 'tgl', 'tamil': 'tam', 'telugu': 'tel',
      'urdu': 'urd', 'ukranian': 'ukr', 'mongolian': 'mon', 'afrikaans': 'afr',
      'swahili': 'swa', 'welsh': 'wel', 'nepali': 'nep', 'khmer': 'khm',
      'lao': 'lao', 'punjabi': 'pan', 'montenegrin': 'mne', 'luxembourgish': 'ltz',
      'occitan': 'oci', 'kazakh': 'kaz', 'uzbek': 'uzb', 'turkmen': 'tuk',
      'syriac': 'syr', 'breton': 'bre'
    };

    if (languageNameMap[lower]) return languageNameMap[lower];
    if (lower.includes('portuguese') && (lower.includes('brazil') || lower.includes('br'))) return 'pob';
    if (lower === 'brazilian' || lower === 'pt-br' || lower === 'ptbr') return 'pob';
    if (lower.length === 3 && /^[a-z]{3}$/.test(lower)) return lower;

    if (lower.length === 2 && /^[a-z]{2}$/.test(lower)) {
      const iso2Codes = toISO6392(lower);
      if (iso2Codes && iso2Codes.length > 0) return iso2Codes[0].code2;
    }

    log.warn(() => `[SubDL] Unknown language format: "${language}", filtering out`);
    return null;
  }
}

module.exports = SubDLService;
module.exports.__testing = {
  getSubDLUpstreamMessage,
  isSubDLAuthFailure,
  detectPlainSubtitleFormat
};
