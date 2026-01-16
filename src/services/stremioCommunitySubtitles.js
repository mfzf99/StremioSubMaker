const axios = require('axios');
const { httpAgent, httpsAgent, dnsLookup } = require('../utils/httpAgents');
const log = require('../utils/logger');
const { version } = require('../utils/version');

const SCS_API_URL = 'https://stremio-community-subtitles.top';
const SCS_FALLBACK_TOKEN = 'yNejf3661w9R1Agdh7ARxE8MzhSVpL2TzMn5jueHFzw'; // Default community token
const USER_AGENT = `SubMaker v${version}`;

// Language code mapping
// SCS uses ISO 639-2/T codes (fra, deu, zho) in their languages.py
// SubMaker internally uses OpenSubtitles-style ISO 639-2/B codes (fre, ger, chi)
// This map converts SCS codes (T variant) to SubMaker codes (B variant) where they differ

// ISO 639-2/T to ISO 639-2/B mapping (only for codes that differ)
const SCS_TO_SUBMAKER_LANG = {
    'fra': 'fre',  // French: T=fra, B=fre
    'deu': 'ger',  // German: T=deu, B=ger
    'zho': 'chi',  // Chinese: T=zho, B=chi
    'ces': 'cze',  // Czech: T=ces, B=cze
    'nld': 'dut',  // Dutch: T=nld, B=dut
    'ell': 'gre',  // Greek: T=ell, B=gre
    'fas': 'per',  // Persian: T=fas, B=per
    'ron': 'rum',  // Romanian: T=ron, B=rum
    'slk': 'slo',  // Slovak: T=slk, B=slo
    'msa': 'may',  // Malay: T=msa, B=may
    'mya': 'bur',  // Burmese: T=mya, B=bur
    'sqi': 'alb',  // Albanian: T=sqi, B=alb
    'mkd': 'mac',  // Macedonian: T=mkd, B=mac
    'eus': 'baq',  // Basque: T=eus, B=baq
    'kat': 'geo',  // Georgian: T=kat, B=geo
    'hye': 'arm',  // Armenian: T=hye, B=arm
    'isl': 'ice',  // Icelandic: T=isl, B=ice
    'bod': 'tib',  // Tibetan: T=bod, B=tib
    'cym': 'wel',  // Welsh: T=cym, B=wel
};

// Reverse mapping (SubMaker B-codes to SCS T-codes) for request filtering if needed
const SUBMAKER_TO_SCS_LANG = Object.fromEntries(
    Object.entries(SCS_TO_SUBMAKER_LANG).map(([k, v]) => [v, k])
);

// Legacy ISO 639-1 (2-letter) to ISO 639-2/B mapping (fallback for any 2-letter codes)
const ISO1_TO_ISO2B = {
    'en': 'eng', 'es': 'spa', 'pt': 'por', 'fr': 'fre', 'de': 'ger',
    'it': 'ita', 'nl': 'dut', 'pl': 'pol', 'ru': 'rus', 'ja': 'jpn',
    'ko': 'kor', 'zh': 'chi', 'ar': 'ara', 'tr': 'tur', 'he': 'heb',
    'sv': 'swe', 'da': 'dan', 'no': 'nor', 'fi': 'fin', 'cs': 'cze',
    'hu': 'hun', 'ro': 'rum', 'el': 'gre', 'id': 'ind', 'th': 'tha',
    'vi': 'vie', 'uk': 'ukr', 'bg': 'bul', 'hr': 'hrv', 'sk': 'slo',
    'sl': 'slv', 'sr': 'srp', 'ms': 'may', 'hi': 'hin', 'bn': 'ben',
    'fa': 'per', 'ta': 'tam', 'te': 'tel'
};

/**
 * Normalize language code from SCS format to SubMaker's ISO 639-2/B format
 * SCS returns ISO 639-2/T codes (fra, deu, zho), SubMaker uses B codes (fre, ger, chi)
 * @param {string} lang - Language code from SCS (usually 3-letter ISO 639-2/T)
 * @returns {string} - Normalized 3-letter ISO 639-2/B code for SubMaker
 */
function normalizeLanguageCode(lang) {
    if (!lang) return '';
    const lower = lang.toLowerCase().replace(/[_-]/g, '');

    // Handle special case for Portuguese Brazilian
    if (lower === 'ptbr' || lower === 'pob') {
        return 'pob';
    }

    // If 3 letters (ISO 639-2), check if it needs T->B conversion
    if (lower.length === 3) {
        // Convert T variant to B variant if needed
        if (SCS_TO_SUBMAKER_LANG[lower]) {
            return SCS_TO_SUBMAKER_LANG[lower];
        }
        // Already a valid code (either B variant or same in both)
        return lower;
    }

    // If 2 letters (ISO 639-1), convert to ISO 639-2/B
    if (lower.length === 2 && ISO1_TO_ISO2B[lower]) {
        return ISO1_TO_ISO2B[lower];
    }

    return lang;
}

class StremioCommunitySubtitlesService {
    constructor() {
        // Use env var if set, otherwise use fallback community token
        this.manifestToken = process.env.SCS_MANIFEST_TOKEN || SCS_FALLBACK_TOKEN;

        this.client = axios.create({
            baseURL: SCS_API_URL,
            headers: {
                'User-Agent': USER_AGENT
            },
            httpAgent,
            httpsAgent,
            lookup: dnsLookup,
            timeout: 10000
        });

        if (process.env.SCS_MANIFEST_TOKEN) {
            log.debug(() => '[SCS] Initialized with custom manifest token from env');
        } else {
            log.debug(() => '[SCS] Initialized with default community token');
        }
    }

    /**
     * Search for subtitles using SCS addon API
     * @param {Object} params - Search parameters
     */
    async searchSubtitles(params) {
        // Token is always available (env or fallback)
        try {
            const { type, imdb_id, videoHash, videoSize, filename } = params;
            // videoHash is now only set when Stremio provides a real OpenSubtitles hash
            // (our derived MD5 hashes are no longer passed - they're useless for SCS matching)
            const hasRealHash = !!videoHash;

            // SCS requires content ID. It works best with videoHash, but filename is sufficient.
            // We always have IMDB ID from SubMaker, so we can search by content + filename
            if (!imdb_id) {
                log.debug(() => '[SCS] Skipping search: no IMDB ID provided');
                return [];
            }

            // Log what matching mode SCS will use
            if (hasRealHash) {
                log.debug(() => `[SCS] Hash matching enabled: ${videoHash.substring(0, 8)}...`);
            } else if (filename) {
                log.debug(() => '[SCS] No hash available, using filename matching');
            } else {
                log.debug(() => '[SCS] Searching by content ID only (no hash or filename)');
            }

            // Construct Stremio-style path params
            // Format: videoHash=xxx&videoSize=yyy&filename=zzz
            const queryParts = [];
            if (videoHash) queryParts.push(`videoHash=${videoHash}`);
            if (videoSize) queryParts.push(`videoSize=${videoSize}`);
            if (filename) queryParts.push(`filename=${encodeURIComponent(filename)}`);

            const paramsJson = queryParts.join('&') + '.json';

            // SCS endpoint: /{token}/subtitles/{type}/{id}/{params}.json
            // Note: type is 'movie' or 'series'
            let stremioType = type;
            if (type === 'episode' || type === 'anime-episode') stremioType = 'series';

            // For series, ID should be in Stremio format: tt12345:s:e
            // Also handle Kitsu IDs for anime content
            let contentId = imdb_id;

            // Support Kitsu IDs for anime
            if (params.kitsuId) {
                contentId = `kitsu:${params.kitsuId}`;
                if (params.episode) {
                    contentId = `${contentId}:${params.episode}`;
                }
                log.debug(() => `[SCS] Using Kitsu ID: ${contentId}`);
            } else if ((type === 'episode' || type === 'anime-episode') && params.season && params.episode) {
                // Stremio ID format for series: tt12345:1:2
                contentId = `${imdb_id}:${params.season}:${params.episode}`;
            }

            const url = `/${this.manifestToken}/subtitles/${stremioType}/${contentId}/${paramsJson}`;

            log.debug(() => `[SCS] Search: type=${stremioType}, id=${contentId}, hash=${videoHash || 'none'}, filename=${filename ? filename.substring(0, 50) : 'none'}`);

            const response = await this.client.get(url);

            if (!response.data || !response.data.subtitles) {
                log.debug(() => `[SCS] No subtitles in response`);
                return [];
            }

            log.debug(() => `[SCS] Found ${response.data.subtitles.length} subtitle(s)${hasRealHash ? ' (with real videoHash)' : ''}`);

            // Track unique languages for debugging and hash match assignment
            const langStats = new Map();
            // Track first result per language (for hash match priority)
            const firstPerLang = new Set();

            const results = response.data.subtitles.map((sub, index) => {
                // Normalize language code: SCS uses ISO 639-2/T, SubMaker uses ISO 639-2/B
                const normalizedLang = normalizeLanguageCode(sub.lang);

                // Track for stats
                const key = sub.lang === normalizedLang ? sub.lang : `${sub.lang}→${normalizedLang}`;
                langStats.set(key, (langStats.get(key) || 0) + 1);

                // Determine if this is a hash match:
                // When SCS receives a videoHash, it internally prioritizes hash-matched results
                // The first result per language is the best match for that hash
                const isFirstForThisLang = !firstPerLang.has(normalizedLang);
                if (isFirstForThisLang) {
                    firstPerLang.add(normalizedLang);
                }

                // hashMatch is true if: we sent a real hash AND this is the first result for this language
                // SCS pre-sorts by match quality, so first per language = best hash/filename match
                const hashMatch = hasRealHash && isFirstForThisLang;

                // Assign priority: lower = better
                // Hash matches get priority 0-99, others get 100+
                const hashMatchPriority = hashMatch ? index : 100 + index;

                return {
                    id: `scs_${sub.id}`, // Prefix to identify provider
                    language: sub.lang,
                    languageCode: normalizedLang, // Normalized to ISO 639-2/B for SubMaker filtering
                    name: hashMatch ? `[SCS] Hash Match` : `[SCS] Community Subtitle`, // Indicate hash match in name
                    url: sub.url,
                    score: hashMatch ? 200000 : 0, // Hash matches get max score for ranking
                    provider: 'stremio-community-subtitles',
                    is_season_pack: false, // SCS handles matching internally
                    fileId: `scs_${sub.id}`, // Ensure fileId is set for download handling
                    // Hash match metadata
                    hashMatch: hashMatch,
                    hashMatchPriority: hashMatchPriority,
                    _scsHasRealHash: hasRealHash // Internal flag for ranking logic
                };
            });

            // Log hash match stats
            const hashMatchCount = results.filter(r => r.hashMatch).length;
            if (hashMatchCount > 0) {
                log.info(() => `[SCS] ${hashMatchCount} hash-matched subtitle(s) found (prioritized)`);
            }

            // Log language stats
            if (langStats.size > 0) {
                const statsStr = Array.from(langStats.entries()).map(([k, v]) => `${k}:${v}`).join(', ');
                log.debug(() => `[SCS] Languages received: ${statsStr}`);
            }

            return results;

        } catch (error) {
            // Use warn instead of error for operational failures (API errors, network issues)
            const statusCode = error.response?.status || error.code || '';
            log.warn(() => `[SCS] Search failed (${statusCode}): ${error.message}`);
            return [];
        }
    }

    /**
     * Download subtitle content
     * @param {string} fileId - The file ID (e.g. comm_XXXX)
     */
    async downloadSubtitle(fileId) {
        try {
            // fileId should be "comm_XXXX" (scs_ prefix removed by handler)
            if (!fileId.startsWith('comm_')) {
                throw new Error(`Invalid SCS file ID format: ${fileId}`);
            }

            const identifier = fileId.replace('comm_', '');

            // Construct download URL: /{token}/download/{identifier}.vtt
            // SCS expects .vtt or .ass extension in the download URL
            const url = `/${this.manifestToken}/download/${identifier}.vtt`;

            log.debug(() => `[SCS] Downloading from: ${url}`);
            const response = await this.client.get(url, {
                responseType: 'arraybuffer',
                timeout: 15000
            });

            const buffer = Buffer.from(response.data);
            const text = buffer.toString('utf-8');

            // Basic validation
            if (text.trim().length === 0) {
                throw new Error('Empty subtitle file');
            }

            // Format detection and logging
            const trimmed = text.trimStart();
            if (trimmed.startsWith('WEBVTT')) {
                log.debug(() => '[SCS] Received VTT format subtitle');
            } else if (trimmed.startsWith('[Script Info]') || trimmed.startsWith('[V4+ Styles]')) {
                log.debug(() => '[SCS] Received ASS/SSA format subtitle');
            } else if (/^\d+\s*\r?\n\d{2}:\d{2}:\d{2}/.test(trimmed)) {
                log.debug(() => '[SCS] Received SRT format subtitle');
            }

            log.debug(() => `[SCS] Downloaded subtitle: ${text.length} bytes`);
            return text;

        } catch (error) {
            // Chain errors properly to preserve stack trace
            const statusCode = error.response?.status || error.code || '';
            const enhancedError = new Error(`SCS download failed (${statusCode}): ${error.message}`);
            enhancedError.cause = error;
            enhancedError.statusCode = error.response?.status;
            throw enhancedError;
        }
    }
}

module.exports = StremioCommunitySubtitlesService;
