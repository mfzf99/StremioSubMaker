const { DEFAULT_TRANSLATION_PROMPT } = require('../services/gemini');
const DEFAULT_API_KEYS = require('../config/defaultApiKeys');
const { getSessionManager } = require('./sessionManager');
const { StorageUnavailableError } = require('../storage/errors');
const log = require('./logger');
const { getTranslator } = require('./i18n');
const { redactApiKey } = require('./security');

// Language selection limits (configurable via environment)
const DEFAULT_SOURCE_LANGUAGE_LIMIT = 3;
const DEFAULT_TARGET_LANGUAGE_LIMIT = 6;
const DEFAULT_NO_TRANSLATION_LANGUAGE_LIMIT = 9;
const KEY_OPTIONAL_PROVIDERS = new Set(['googletranslate', 'custom']);
const GEMINI_LOG_INTERVAL_MS = parseInt(process.env.GEMINI_CONFIG_LOG_INTERVAL_MS || `${5 * 60 * 1000}`, 10);
let lastGeminiConfigLog = 0;
let suppressedGeminiConfigLogs = 0;

const MAX_GEMINI_API_KEYS = parseInt(process.env.MAX_GEMINI_API_KEYS, 10) || Infinity;

function parseLanguageLimit(envVar, fallback, min = 1, max = 50) {
  const parsed = parseInt(process.env[envVar], 10);
  if (Number.isFinite(parsed) && parsed >= min) {
    return Math.min(max, parsed);
  }
  return fallback;
}

function getLanguageSelectionLimits() {
  return {
    maxSourceLanguages: parseLanguageLimit('MAX_SOURCE_LANGUAGES', DEFAULT_SOURCE_LANGUAGE_LIMIT),
    maxTargetLanguages: parseLanguageLimit('MAX_TARGET_LANGUAGES', DEFAULT_TARGET_LANGUAGE_LIMIT),
    maxNoTranslationLanguages: parseLanguageLimit('MAX_NO_TRANSLATION_LANGUAGES', DEFAULT_NO_TRANSLATION_LANGUAGE_LIMIT)
  };
}

function getDeepSeekDefaultMaxOutputTokens(modelName) {
  const model = String(modelName || '').trim().toLowerCase();
  return model.includes('reasoner') ? 65536 : 8192;
}

const PROVIDER_PARAMETER_DEFAULTS = {
  openai: {
    temperature: 0.2,
    topP: 0.95,
    maxOutputTokens: 32768,
    translationTimeout: 60,
    maxRetries: 2,
    reasoningEffort: undefined
  },
  anthropic: {
    temperature: 0.2,
    topP: 0.95,
    maxOutputTokens: 32768,
    translationTimeout: 60,
    maxRetries: 2,
    thinkingBudget: 0
  },
  xai: {
    temperature: 0.2,
    topP: 0.95,
    maxOutputTokens: 32768,
    translationTimeout: 60,
    maxRetries: 2
  },
  deepseek: {
    temperature: 0.2,
    topP: 0.95,
    maxOutputTokens: 8192,
    translationTimeout: 60,
    maxRetries: 2
  },
  deepl: {
    temperature: 0,
    topP: 1,
    maxOutputTokens: 32768,
    translationTimeout: 60,
    maxRetries: 2,
    modelType: 'quality_optimized',
    formality: 'default',
    preserveFormatting: true
  },
  mistral: {
    temperature: 0.2,
    topP: 0.95,
    maxOutputTokens: 32768,
    translationTimeout: 60,
    maxRetries: 2
  },
  cfworkers: {
    temperature: 0.2,
    topP: 0.9,
    maxOutputTokens: 32768,
    translationTimeout: 60,
    maxRetries: 2
  },
  openrouter: {
    temperature: 0.2,
    topP: 0.95,
    maxOutputTokens: 32768,
    translationTimeout: 60,
    maxRetries: 2
  },
  googletranslate: {
    temperature: 0,
    topP: 1,
    maxOutputTokens: 32768,
    translationTimeout: 60,
    maxRetries: 2
  },
  custom: {
    temperature: 0.2,
    topP: 0.95,
    maxOutputTokens: 32768,
    translationTimeout: 120,
    maxRetries: 2
  }
};

function sanitizeProviderNumber(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : parseFloat(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (min !== undefined && parsed < min) return min;
  if (max !== undefined && parsed > max) return max;
  return parsed;
}

function sanitizeReasoningEffort(value, fallback) {
  if (value === '' || value === null || value === undefined) {
    return undefined;
  }
  const allowed = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return allowed.includes(normalized) ? normalized : fallback;
}

function sanitizeGeminiThinkingLevel(value, fallback = '') {
  const allowed = ['disabled', 'minimal', 'low', 'medium', 'high'];
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (allowed.includes(normalized)) return normalized;
  const normalizedFallback = typeof fallback === 'string' ? fallback.trim().toLowerCase() : '';
  return allowed.includes(normalizedFallback) ? normalizedFallback : '';
}

function mergeProviderParameters(defaults, incoming) {
  const merged = {};
  const incomingParams = incoming || {};
  Object.keys(defaults || {}).forEach(key => {
    const matchKey = Object.keys(incomingParams).find(k => String(k).toLowerCase() === String(key).toLowerCase());
    const raw = matchKey ? incomingParams[matchKey] : {};
    const base = defaults[key] || {};
    merged[key] = {
      temperature: sanitizeProviderNumber(raw?.temperature, base.temperature, 0, 2),
      topP: sanitizeProviderNumber(raw?.topP, base.topP, 0, 1),
      maxOutputTokens: Math.max(1, sanitizeProviderNumber(raw?.maxOutputTokens, base.maxOutputTokens, 1, 200000)),
      translationTimeout: Math.max(5, sanitizeProviderNumber(raw?.translationTimeout, base.translationTimeout, 5, 720)),
      maxRetries: Math.max(0, Math.min(5, parseInt(raw?.maxRetries, 10) || base.maxRetries || 0)),
      reasoningEffort: sanitizeReasoningEffort(raw?.reasoningEffort, base.reasoningEffort),
      thinkingBudget: (() => {
        const requested = Number.isFinite(parseInt(raw?.thinkingBudget, 10))
          ? parseInt(raw.thinkingBudget, 10)
          : NaN;
        const fallback = Number.isFinite(parseInt(base.thinkingBudget, 10))
          ? parseInt(base.thinkingBudget, 10)
          : 0;
        const chosen = Number.isFinite(requested) ? requested : fallback;
        return Math.max(-1, Math.min(200000, chosen));
      })(),
      formality: typeof raw?.formality === 'string'
        ? raw.formality
        : (typeof base.formality === 'string' ? base.formality : 'default'),
      modelType: typeof raw?.modelType === 'string'
        ? raw.modelType
        : (typeof base.modelType === 'string' ? base.modelType : ''),
      preserveFormatting: raw?.preserveFormatting !== undefined
        ? raw.preserveFormatting === true
        : base.preserveFormatting === true
    };
  });
  return merged;
}

function logGeminiConfigThrottled(mergedConfig) {
  const now = Date.now();
  if (now - lastGeminiConfigLog < GEMINI_LOG_INTERVAL_MS) {
    suppressedGeminiConfigLogs += 1;
    return;
  }
  lastGeminiConfigLog = now;
  const suppressed = suppressedGeminiConfigLogs;
  suppressedGeminiConfigLogs = 0;

  const thinkingDisplay = (() => {
    const val = mergedConfig.advancedSettings?.thinkingBudget;
    if (val === undefined || val === null) return 'dynamic';
    if (Number(val) === 0) return 'disabled';
    return val;
  })();

  const effectiveModel = getEffectiveGeminiModel(mergedConfig);
  const baseModel = typeof mergedConfig.geminiModel === 'string' ? mergedConfig.geminiModel : '';
  const overrideModel = typeof mergedConfig.advancedSettings?.geminiModel === 'string'
    ? mergedConfig.advancedSettings.geminiModel.trim()
    : '';
  const modelLabel = overrideModel && overrideModel !== baseModel
    ? `${effectiveModel} (base=${baseModel || 'default'}, override=${overrideModel})`
    : effectiveModel;
  const suffix = suppressed > 0 ? ` (suppressed ${suppressed} duplicate logs)` : '';
  const topKDisplay = (mergedConfig.advancedSettings?.topK !== undefined && mergedConfig.advancedSettings.topK !== 40 && mergedConfig.advancedSettings.topK > 0)
    ? mergedConfig.advancedSettings.topK
    : 'disabled (Min-P Active)';
  log.debug(() => `[Config] Gemini API config: model=${modelLabel}, temperature=${mergedConfig.advancedSettings.temperature}, topK=${topKDisplay}, topP=${mergedConfig.advancedSettings.topP}, minP=${mergedConfig.advancedSettings.minP}, repPenalty=${mergedConfig.advancedSettings.repetitionPenalty}, thinkingBudget=${thinkingDisplay}, maxOutputTokens=${mergedConfig.advancedSettings.maxOutputTokens}, timeout=${mergedConfig.advancedSettings.translationTimeout}s, maxRetries=${mergedConfig.advancedSettings.maxRetries}, sendTimestampsToAI=${mergedConfig.advancedSettings.sendTimestampsToAI ? 'enabled' : 'disabled'}${suffix}`);
}

function getDefaultProviderParameters() {
  return JSON.parse(JSON.stringify(PROVIDER_PARAMETER_DEFAULTS));
}

const OVERRIDE_DEPRECATED_MODELS = true;
const GEMINI_31_FLASH_LITE_MODEL = 'gemini-3.1-flash-lite';
const GEMINI_FLASH_LATEST_MODEL = 'gemini-flash-latest';
const DEFAULT_GEMINI_MODEL = 'gemini-flash-lite-latest';

function normalizeGeminiModelName(modelName) {
  const normalized = typeof modelName === 'string' ? modelName.trim().replace(/^models\//, '') : '';
  if (normalized === `${GEMINI_31_FLASH_LITE_MODEL}-preview`) {
    return GEMINI_31_FLASH_LITE_MODEL;
  }
  if (normalized === 'gemini-3-pro-preview') {
    return DEFAULT_GEMINI_MODEL;
  }
  if (normalized === GEMINI_FLASH_LATEST_MODEL) {
    return DEFAULT_GEMINI_MODEL;
  }
  return normalized;
}

const DEPRECATED_MODEL_NAMES = [
  'gemini-2.0-flash-exp',
  'gemini-2.5-flash-lite-09-2025',
  GEMINI_FLASH_LATEST_MODEL,
  'gemini-2.5-flash-latest',
  'gemini-pro-latest',
  'gemini-2.5-pro-latest',
  'gemini-2.5-flash-preview-09-2025'
];

async function parseConfig(configStr, options = {}) {
  try {
    if (!configStr) {
      return getDefaultConfig();
    }

    const allowBase64 = options.allowBase64 === true || process.env.ALLOW_BASE64_CONFIG === 'true';
    const isSessionToken = /^[a-f0-9]{32}$/.test(configStr);

    if (isSessionToken) {
      const sessionManager = getSessionManager();
      const config = await sessionManager.getSession(configStr);

      if (config) {
        log.debug(() => '[Config] Retrieved config from session token');
        return normalizeConfig(config);
      } else {
        log.warn(() => `[Config] Session token not found: ${configStr}`);
        const defaultConfig = getDefaultConfig();
        defaultConfig.__sessionTokenError = true;
        return defaultConfig;
      }
    }

    if (allowBase64) {
      return parseBase64Config(configStr);
    }

    log.warn(() => '[Config] Base64 configs not allowed in production mode. Use session tokens.');
    return getDefaultConfig();

  } catch (error) {
    if (error instanceof StorageUnavailableError) {
      throw error;
    }
    log.error(() => ['[Config] Unexpected error during config parsing:', error.message]);
    return getDefaultConfig();
  }
}

function normalizeBase64Input(input) {
  if (!input || typeof input !== 'string') return input;
  let normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4;
  if (padding) {
    normalized += '='.repeat(4 - padding);
  }
  return normalized;
}

function parseBase64Config(configStr) {
  try {
    let decoded;
    try {
      const normalized = normalizeBase64Input(configStr);
      decoded = Buffer.from(normalized, 'base64').toString('utf-8');
    } catch (decodeError) {
      log.error(() => ['[Config] Base64 decode error. Config string length:', configStr.length]);
      log.error(() => ['[Config] First 50 chars:', configStr.substring(0, 50)]);
      return getDefaultConfig();
    }

    const trimmed = decoded.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      log.error(() => '[Config] Decoded content does not look like JSON');
      log.error(() => ['[Config] Decoded preview (first 100 chars):', decoded.substring(0, 100).replace(/[^\x20-\x7E]/g, ' ')]);
      return getDefaultConfig();
    }

    let config;
    try {
      config = JSON.parse(decoded);
    } catch (parseError) {
      log.error(() => ['[Config] JSON parse error:', parseError.message]);
      log.error(() => ['[Config] Problematic JSON preview (first 200 chars):', decoded.substring(0, 200)]);
      return getDefaultConfig();
    }

    return normalizeConfig(config);
  } catch (error) {
    log.error(() => ['[Config] Unexpected error during base64 config parsing:', error.message]);
    return getDefaultConfig();
  }
}

function sanitizeLanguages(list) {
  if (!Array.isArray(list)) return [];

  const blocked = new Set(['translate srt', '__']);
  const deduped = new Set();

  for (const lang of list) {
    let value = String(lang || '').trim().toLowerCase();
    if (!value || blocked.has(value) || value.startsWith('___')) continue;
    if (value === 'ptbr' || value === 'pt-br') value = 'pob';
    deduped.add(value);
  }

  return Array.from(deduped);
}

function normalizeProviderApiKey(value) {
  if (value === undefined || value === null) return '';
  const normalized = String(value).trim();
  if (normalized === '[object Object]' || normalized === '[object Array]') return '';
  return normalized;
}

function getLegacySubtitleProviderApiKey(config, providerKey) {
  const legacyFields = {
    subdl: ['SubDLAPIKey', 'SubDLApiKey', 'subDLAPIKey', 'subdlApiKey', 'subdl_api_key'],
    subsource: ['SubSourceAPIKey', 'SubSourceAPiKey', 'SubSourceApiKey', 'subSourceAPIKey', 'subsourceApiKey', 'subsource_api_key'],
    scs: ['SCS_MANIFEST_TOKEN', 'SCSManifestToken', 'scsManifestToken', 'scsAuthKey', 'scsApiKey']
  };
  const fields = legacyFields[providerKey] || [];
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(config || {}, field)) {
      const apiKey = normalizeProviderApiKey(config[field]);
      if (apiKey) return apiKey;
    }
  }
  return '';
}

function normalizeApiKeySubtitleProvider(mergedConfig, rawConfig, providerKey) {
  const providerConfig = mergedConfig.subtitleProviders?.[providerKey];
  if (!providerConfig || typeof providerConfig !== 'object') return;

  const rawProviders = rawConfig?.subtitleProviders && typeof rawConfig.subtitleProviders === 'object'
    ? rawConfig.subtitleProviders
    : {};
  const rawProviderPresent = Object.prototype.hasOwnProperty.call(rawProviders, providerKey);
  const legacyApiKey = getLegacySubtitleProviderApiKey(rawConfig, providerKey);
  const configuredApiKey = normalizeProviderApiKey(providerConfig.apiKey);
  const apiKey = configuredApiKey || legacyApiKey;

  providerConfig.apiKey = apiKey;

  if (!rawProviderPresent && !legacyApiKey) {
    providerConfig.enabled = providerConfig.enabled === true && !!apiKey;
    return;
  }

  if (legacyApiKey && !rawProviderPresent) {
    providerConfig.enabled = true;
  } else {
    providerConfig.enabled = providerConfig.enabled === true;
  }

  if (providerConfig.enabled && !apiKey) {
    providerConfig.enabled = false;
  }
}

function normalizeConfig(config) {
  if (config.opensubtitlesApiKey && !config.subtitleProviders) {
    log.debug(() => '[Config] Migrating old config format to new format');
    config = migrateOldConfig(config);
  }

  const configModel = normalizeGeminiModelName(config.geminiModel || process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL);
  const defaults = getDefaultConfig(configModel);
  const mergedConfig = {
    ...defaults,
    ...config,
    subtitleProviders: {
      ...defaults.subtitleProviders,
      ...(config.subtitleProviders || {})
    },
    translationCache: {
      ...defaults.translationCache,
      ...(config.translationCache || {})
    },
    providers: Object.keys(defaults.providers).reduce((acc, key) => {
      const incoming = config.providers || {};
      const matchKey = Object.keys(incoming).find(k => k.toLowerCase() === key.toLowerCase());
      acc[key] = {
        ...defaults.providers[key],
        ...(matchKey ? incoming[matchKey] : {})
      };
      return acc;
    }, {}),
    providerParameters: mergeProviderParameters(
      defaults.providerParameters,
      config.providerParameters || {}
    ),
    bypassCacheConfig: {
      ...defaults.bypassCacheConfig,
      ...(config.bypassCacheConfig || config.tempCache || {})
    },
    advancedSettings: {
      ...defaults.advancedSettings,
      ...(config.advancedSettings || {})
    },
    autoSubs: {
      ...defaults.autoSubs,
      ...(config.autoSubs || {})
    }
  };

  normalizeApiKeySubtitleProvider(mergedConfig, config, 'subdl');
  normalizeApiKeySubtitleProvider(mergedConfig, config, 'subsource');
  normalizeApiKeySubtitleProvider(mergedConfig, config, 'subsro');

  const rawProviderParams = config.providerParameters || {};
  const deepseekInputKey = Object.keys(rawProviderParams).find(k => String(k).toLowerCase() === 'deepseek');
  const deepseekInput = deepseekInputKey ? rawProviderParams[deepseekInputKey] : null;
  const deepseekMaxProvided =
    deepseekInput &&
    Object.prototype.hasOwnProperty.call(deepseekInput, 'maxOutputTokens') &&
    deepseekInput.maxOutputTokens !== null &&
    String(deepseekInput.maxOutputTokens).trim() !== '';
  if (!deepseekMaxProvided && mergedConfig.providerParameters?.deepseek) {
    const deepseekModel = mergedConfig.providers?.deepseek?.model || '';
    mergedConfig.providerParameters.deepseek.maxOutputTokens = getDeepSeekDefaultMaxOutputTokens(deepseekModel);
  }

  mergedConfig.learnPlacement = 'top';

  mergedConfig.sourceLanguages = sanitizeLanguages(mergedConfig.sourceLanguages);
  mergedConfig.targetLanguages = sanitizeLanguages(mergedConfig.targetLanguages);
  mergedConfig.noTranslationLanguages = sanitizeLanguages(mergedConfig.noTranslationLanguages);
  mergedConfig.learnTargetLanguages = sanitizeLanguages(mergedConfig.learnTargetLanguages);
  mergedConfig.uiLanguage = (() => {
    const lang = (config.uiLanguage || defaults.uiLanguage || 'en').toString().trim().toLowerCase();
    return lang || 'en';
  })();

  const { maxSourceLanguages, maxTargetLanguages, maxNoTranslationLanguages } = getLanguageSelectionLimits();
  if (mergedConfig.sourceLanguages.length > maxSourceLanguages) {
    mergedConfig.sourceLanguages = mergedConfig.sourceLanguages.slice(0, maxSourceLanguages);
  }

  const seenTargets = new Set();
  const trimmedTargets = [];
  const trimmedLearns = [];

  const pushWithLimit = (code, dest) => {
    if (!code) return;
    if (seenTargets.has(code)) {
      dest.push(code);
      return;
    }
    if (seenTargets.size >= maxTargetLanguages) return;
    seenTargets.add(code);
    dest.push(code);
  };

  (mergedConfig.targetLanguages || []).forEach(code => pushWithLimit(code, trimmedTargets));
  (mergedConfig.learnTargetLanguages || []).forEach(code => pushWithLimit(code, trimmedLearns));

  mergedConfig.targetLanguages = trimmedTargets;
  mergedConfig.learnTargetLanguages = trimmedLearns;

  const legacyToolboxEnabled = mergedConfig.fileTranslationEnabled === true || mergedConfig.syncSubtitlesEnabled === true;
  mergedConfig.subToolboxEnabled = mergedConfig.subToolboxEnabled === true || legacyToolboxEnabled;
  mergedConfig.fileTranslationEnabled = mergedConfig.subToolboxEnabled === true;
  mergedConfig.syncSubtitlesEnabled = mergedConfig.subToolboxEnabled === true;
  mergedConfig.singleBatchMode = mergedConfig.singleBatchMode === true;
  mergedConfig.multiProviderEnabled = mergedConfig.multiProviderEnabled === true;
  mergedConfig.excludeHearingImpairedSubtitles = mergedConfig.excludeHearingImpairedSubtitles === true;
  mergedConfig.forceSRTOutput = mergedConfig.forceSRTOutput === true;
  mergedConfig.convertAssToVtt = mergedConfig.forceSRTOutput === true || mergedConfig.convertAssToVtt !== false;
  if (mergedConfig.convertAssToVtt === false) {
    mergedConfig.urlExtensionTest = 'none';
  }

  const validExtensions = ['srt', 'sub', 'none', 'resolve'];
  mergedConfig.urlExtensionTest = validExtensions.includes(mergedConfig.urlExtensionTest)
    ? mergedConfig.urlExtensionTest
    : 'srt';

  const validAndroidCompatModes = ['off', 'safe', 'aggressive'];
  const normalizedAndroidCompatMode = String(mergedConfig.androidSubtitleCompatMode || '').toLowerCase();
  mergedConfig.androidSubtitleCompatMode = validAndroidCompatModes.includes(normalizedAndroidCompatMode)
    ? normalizedAndroidCompatMode
    : 'off';

  mergedConfig.enableSeasonPacks = mergedConfig.enableSeasonPacks !== false;
  mergedConfig.deduplicateSubtitles = mergedConfig.deduplicateSubtitles !== false;

  const rawTimeout = parseInt(mergedConfig.subtitleProviderTimeout, 10);
  mergedConfig.subtitleProviderTimeout = Number.isFinite(rawTimeout)
    ? Math.max(8, Math.min(30, rawTimeout))
    : 12;

  const advSettings = mergedConfig.advancedSettings || {};
  const normalizedAdvancedModel = normalizeGeminiModelName(advSettings.geminiModel);
  const advancedModelDefaults = getModelSpecificDefaults(normalizedAdvancedModel || configModel);
  mergedConfig.advancedSettings = {
    ...advSettings,
    geminiModel: normalizedAdvancedModel,
    thinkingLevel: sanitizeGeminiThinkingLevel(advSettings.thinkingLevel, advancedModelDefaults.thinkingLevel),
    enabled: advSettings.enabled === true,
    sendTimestampsToAI: advSettings.sendTimestampsToAI === true,
    translationWorkflow: (() => {
      const val = String(advSettings.translationWorkflow || '').toLowerCase();
      if (['original', 'ai', 'xml', 'json'].includes(val)) return val;
      if (advSettings.enableJsonOutput === true) return 'json';
      if (advSettings.sendTimestampsToAI === true) return 'ai';
      return 'xml';
    })(),
    enableJsonOutput: advSettings.enableJsonOutput === true,
    mismatchRetries: (() => {
      const val = parseInt(advSettings.mismatchRetries, 10);
      return Number.isFinite(val) ? Math.max(0, Math.min(3, val)) : 3;
    })()
  };

  // 🔥 Bersihkan topK legasi (40) daripada session yang telah disimpan
  if (mergedConfig.advancedSettings && (mergedConfig.advancedSettings.topK === 40 || mergedConfig.advancedSettings.topK === 0)) {
    delete mergedConfig.advancedSettings.topK;
  }

  mergedConfig.parallelBatchesEnabled = mergedConfig.parallelBatchesEnabled === true;
  mergedConfig.parallelBatchesCount = (() => {
    const val = parseInt(mergedConfig.parallelBatchesCount, 10);
    return Number.isFinite(val) ? Math.max(1, Math.min(5, val)) : 3;
  })();

  if (mergedConfig.noTranslationLanguages.length > maxNoTranslationLanguages) {
    mergedConfig.noTranslationLanguages = mergedConfig.noTranslationLanguages.slice(0, maxNoTranslationLanguages);
  }

  mergedConfig.geminiKeyRotationEnabled = mergedConfig.geminiKeyRotationEnabled === true;

  const looksEncrypted = (value) => {
    if (!value || typeof value !== 'string') return false;
    const parts = value.split(':');
    return parts.length === 4 && parts[0] === '1';
  };

  const rawKeys = Array.isArray(mergedConfig.geminiApiKeys) ? mergedConfig.geminiApiKeys : [];
  const seenKeys = new Set();
  const sanitizedKeys = [];
  let encryptedGeminiKeysDetected = false;
  for (const key of rawKeys) {
    const trimmed = typeof key === 'string' ? key.trim() : '';
    if (!trimmed) continue;

    if (looksEncrypted(trimmed)) {
      encryptedGeminiKeysDetected = true;
      log.warn(() => `[Config] Gemini API key appears to still be encrypted (decryption failed). Skipping this key.`);
      continue;
    }

    if (!seenKeys.has(trimmed)) {
      seenKeys.add(trimmed);
      sanitizedKeys.push(trimmed);
      if (sanitizedKeys.length >= MAX_GEMINI_API_KEYS) break;
    }
  }

  const rawSingleKey = typeof mergedConfig.geminiApiKey === 'string' ? mergedConfig.geminiApiKey.trim() : '';
  if (rawSingleKey && looksEncrypted(rawSingleKey)) {
    encryptedGeminiKeysDetected = true;
    log.warn(() => `[Config] Gemini API key (single) appears to still be encrypted (decryption failed). Clearing it.`);
    mergedConfig.geminiApiKey = '';
  }

  if (encryptedGeminiKeysDetected) {
    mergedConfig.__credentialDecryptionFailed = true;
    mergedConfig.__credentialDecryptionFailedFields = mergedConfig.__credentialDecryptionFailedFields || [];
    if (!mergedConfig.__credentialDecryptionFailedFields.includes('geminiApiKey')) {
      mergedConfig.__credentialDecryptionFailedFields.push('geminiApiKey');
    }
  }

  const singleKey = typeof mergedConfig.geminiApiKey === 'string' ? mergedConfig.geminiApiKey.trim() : '';
  if (sanitizedKeys.length === 0 && singleKey) {
    sanitizedKeys.push(singleKey);
  }

  mergedConfig.geminiApiKeys = sanitizedKeys;

  if (mergedConfig.geminiKeyRotationEnabled && sanitizedKeys.length > 0) {
    mergedConfig.geminiApiKey = sanitizedKeys[0];
  } else if (!singleKey && sanitizedKeys.length > 0) {
    mergedConfig.geminiApiKey = sanitizedKeys[0];
  } else {
    mergedConfig.geminiApiKey = singleKey;
  }

  const validRotationModes = ['per-request', 'per-batch'];
  if (!validRotationModes.includes(mergedConfig.geminiKeyRotationMode)) {
    mergedConfig.geminiKeyRotationMode = 'per-batch';
  }

  if (!mergedConfig.geminiModel || mergedConfig.geminiModel.trim() === '') {
    mergedConfig.geminiModel = defaults.geminiModel;
  } else {
    mergedConfig.geminiModel = normalizeGeminiModelName(mergedConfig.geminiModel);
  }

  if (OVERRIDE_DEPRECATED_MODELS && mergedConfig.geminiModel && DEPRECATED_MODEL_NAMES.includes(mergedConfig.geminiModel)) {
    const replacementModel = normalizeGeminiModelName(process.env.GEMINI_MODEL) || DEFAULT_GEMINI_MODEL;
    log.debug(() => `[Config] Overriding deprecated model '${mergedConfig.geminiModel}' with default '${replacementModel}'`);
    mergedConfig.geminiModel = replacementModel;
  }

  mergedConfig.translationCache.enabled = true;
  mergedConfig.translationCache.persistent = true;
  mergedConfig.translationCache.duration = 0;

  if (config.translationCache && config.translationCache.enabled === false) {
    mergedConfig.bypassCache = true;
  }

  mergedConfig.bypassCache = mergedConfig.bypassCache === true;

  mergedConfig.multiProviderEnabled = mergedConfig.multiProviderEnabled === true;
  mergedConfig.mainProvider = mergedConfig.multiProviderEnabled ? (mergedConfig.mainProvider || 'gemini') : 'gemini';
  mergedConfig.mainProvider = String(mergedConfig.mainProvider || 'gemini').toLowerCase();
  mergedConfig.secondaryProviderEnabled = mergedConfig.multiProviderEnabled && mergedConfig.secondaryProviderEnabled === true;
  mergedConfig.secondaryProvider = mergedConfig.secondaryProviderEnabled ? String(mergedConfig.secondaryProvider || '').toLowerCase() : '';
  const resolveProviderKey = (key) => {
    const lower = String(key || '').toLowerCase();
    const match = Object.keys(mergedConfig.providers || {}).find(k => String(k).toLowerCase() === lower);
    return match || key;
  };
  const providerIsConfigured = (key) => {
    const resolved = resolveProviderKey(key);
    const cfg = mergedConfig.providers?.[resolved] || {};
    if (KEY_OPTIONAL_PROVIDERS.has(String(key).toLowerCase())) {
      if (String(key).toLowerCase() === 'custom') {
        return !!(cfg.enabled === true && cfg.baseUrl && cfg.model);
      }
      return cfg.enabled === true;
    }
    return !!(cfg.enabled && cfg.apiKey && cfg.model);
  };
  const firstConfiguredProvider = () => {
    const entry = Object.entries(mergedConfig.providers || {}).find(([key, cfg]) => {
      if (!cfg || cfg.enabled !== true) return false;
      const isKeyOptional = KEY_OPTIONAL_PROVIDERS.has(String(key).toLowerCase());
      if (String(key).toLowerCase() === 'custom') {
        return !!(cfg.baseUrl && cfg.model);
      }
      return isKeyOptional || (cfg.apiKey && cfg.model);
    });
    return entry ? String(entry[0]).toLowerCase() : null;
  };
  if (mergedConfig.providers && typeof mergedConfig.providers === 'object') {
    for (const [key, value] of Object.entries(mergedConfig.providers)) {
      const normalizedKey = String(key).toLowerCase();
      mergedConfig.providers[key] = {
        enabled: value?.enabled === true,
        apiKey: typeof value?.apiKey === 'string' ? value.apiKey : '',
        model: typeof value?.model === 'string' ? value.model : ''
      };
      if (normalizedKey === 'custom') {
        mergedConfig.providers[key].baseUrl = typeof value?.baseUrl === 'string' ? value.baseUrl : '';
      }
    }
  }

  const allowedAutoModes = new Set(['cloudflare', 'assemblyai', 'local']);
  const requestedMode = (mergedConfig.autoSubs?.defaultMode || defaults.autoSubs.defaultMode || 'cloudflare')
    .toString()
    .toLowerCase();
  mergedConfig.autoSubs = mergedConfig.autoSubs || {};
  mergedConfig.autoSubs.defaultMode = allowedAutoModes.has(requestedMode) ? requestedMode : defaults.autoSubs.defaultMode;
  mergedConfig.autoSubs.sendFullVideoToAssembly = mergedConfig.autoSubs.sendFullVideoToAssembly === true;
  const allowedAssemblySpeechModels = new Set(['universal-2', 'universal-3-pro']);
  const requestedAssemblySpeechModel = (mergedConfig.autoSubs.assemblySpeechModel || defaults.autoSubs.assemblySpeechModel || 'universal-3-pro')
    .toString()
    .trim()
    .toLowerCase();
  mergedConfig.autoSubs.assemblySpeechModel = allowedAssemblySpeechModels.has(requestedAssemblySpeechModel)
    ? requestedAssemblySpeechModel
    : (defaults.autoSubs.assemblySpeechModel || 'universal-3-pro');
  mergedConfig.otherApiKeysEnabled = true;

  if (mergedConfig.multiProviderEnabled) {
    const mainKey = mergedConfig.mainProvider || 'gemini';
    const geminiConfigured = !!(mergedConfig.geminiApiKey && getEffectiveGeminiModel(mergedConfig));
    const mainConfigured = mainKey === 'gemini' ? geminiConfigured : providerIsConfigured(mainKey);
    if (!mainConfigured) {
      const fallbackProvider = firstConfiguredProvider();
      if (fallbackProvider) {
        log.warn(() => `[Config] Main provider '${mainKey}' is not fully configured, switching to '${fallbackProvider}'`);
        mergedConfig.mainProvider = fallbackProvider;
      } else if (geminiConfigured) {
        log.warn(() => `[Config] Main provider '${mainKey}' is not fully configured, falling back to Gemini`);
        mergedConfig.mainProvider = 'gemini';
      } else {
        log.warn(() => `[Config] No configured AI providers found; translations will fail until an API key is set`);
      }
    }
  } else {
    mergedConfig.mainProvider = 'gemini';
  }

  if (mergedConfig.secondaryProviderEnabled) {
    if (!mergedConfig.secondaryProvider || mergedConfig.secondaryProvider === mergedConfig.mainProvider) {
      log.warn(() => '[Config] Secondary provider not set or matches main provider; disabling fallback');
      mergedConfig.secondaryProviderEnabled = false;
      mergedConfig.secondaryProvider = '';
    } else if (mergedConfig.secondaryProvider === 'gemini') {
      if (!mergedConfig.geminiApiKey || !getEffectiveGeminiModel(mergedConfig)) {
        log.warn(() => '[Config] Secondary provider Gemini is missing API key/model; disabling fallback');
        mergedConfig.secondaryProviderEnabled = false;
        mergedConfig.secondaryProvider = '';
      }
    } else {
      const fallbackKey = resolveProviderKey(mergedConfig.secondaryProvider);
      const validFallback = providerIsConfigured(fallbackKey);
      if (!validFallback) {
        log.warn(() => `[Config] Secondary provider '${mergedConfig.secondaryProvider}' is not fully configured; disabling fallback`);
        mergedConfig.secondaryProviderEnabled = false;
        mergedConfig.secondaryProvider = '';
      }
    }
  }

  const hasActiveMultiProvider = mergedConfig.multiProviderEnabled && (
    mergedConfig.mainProvider !== 'gemini' || mergedConfig.secondaryProviderEnabled
  );
  if (!hasActiveMultiProvider) {
    mergedConfig.multiProviderEnabled = false;
    mergedConfig.secondaryProviderEnabled = false;
    mergedConfig.secondaryProvider = '';
  }

  const bypassReasons = [];
  if (mergedConfig.advancedSettings.enabled) bypassReasons.push('advanced-settings');
  if (mergedConfig.parallelBatchesEnabled === true) bypassReasons.push('parallel-batches');
  if (hasActiveMultiProvider) bypassReasons.push('multi-provider');
  if (bypassReasons.length > 0) {
    log.debug(() => `[Config] Forcing bypass cache (${bypassReasons.join(', ')})`);
    mergedConfig.bypassCache = true;
  }

  mergedConfig.bypassCacheConfig = mergedConfig.bypassCacheConfig || {};
  mergedConfig.bypassCacheConfig.enabled = mergedConfig.bypassCache === true;
  const bypassDur = Number(mergedConfig.bypassCacheConfig.duration);
  mergedConfig.bypassCacheConfig.duration = (Number.isFinite(bypassDur) && bypassDur > 0) ? Math.min(12, bypassDur) : 12;
  mergedConfig.tempCache = mergedConfig.bypassCacheConfig;
  mergedConfig.mobileMode = mergedConfig.mobileMode === true;

  logGeminiConfigThrottled(mergedConfig);

  const openSubConfig = mergedConfig.subtitleProviders?.opensubtitles;
  if (openSubConfig) {
    const normalizeCredential = (value) => {
      if (value === undefined || value === null) return '';
      const normalized = String(value).trim();
      if (normalized === '[object Object]' || normalized === '[object Array]') {
        log.warn(() => `[Config] OpenSubtitles credential appears to be a serialized object, clearing it`);
        return '';
      }
      return normalized;
    };
    const impl = typeof openSubConfig.implementationType === 'string'
      ? openSubConfig.implementationType.trim().toLowerCase()
      : '';
    openSubConfig.implementationType = impl || 'v3';
    openSubConfig.username = normalizeCredential(openSubConfig.username);
    openSubConfig.password = normalizeCredential(openSubConfig.password);

    const usernameStillEncrypted = looksEncrypted(openSubConfig.username);
    const passwordStillEncrypted = looksEncrypted(openSubConfig.password);

    if (usernameStillEncrypted || passwordStillEncrypted) {
      log.warn(() => `[Config] OpenSubtitles credentials appear to still be encrypted (decryption failed). Falling back to V3 mode.`);
      openSubConfig.username = '';
      openSubConfig.password = '';
      openSubConfig.implementationType = 'v3';
      mergedConfig.__credentialDecryptionFailed = true;
      const credentialFailureFields = new Set(mergedConfig.__credentialDecryptionFailedFields || []);
      if (usernameStillEncrypted) credentialFailureFields.add('opensubtitles.username');
      if (passwordStillEncrypted) credentialFailureFields.add('opensubtitles.password');
      mergedConfig.__credentialDecryptionFailedFields = Array.from(credentialFailureFields);
      mergedConfig.subtitleProviders.opensubtitles = openSubConfig;
    }

    const wantsAuth = openSubConfig.implementationType === 'auth';
    const missingCreds = !openSubConfig.username || !openSubConfig.password;
    if (wantsAuth && missingCreds) {
      log.warn(() => '[Config] OpenSubtitles Auth selected without credentials; switching to V3 (no login required).');
      mergedConfig.subtitleProviders.opensubtitles = {
        ...openSubConfig,
        implementationType: 'v3',
        username: openSubConfig.username,
        password: openSubConfig.password
      };
      mergedConfig.__needsSessionPersist = true;
      mergedConfig.__persistReason = 'opensubtitles-auth-to-v3';
    }
  }

  const scsConfig = mergedConfig.subtitleProviders?.scs;
  if (scsConfig) {
    const normalizeScsValue = (value) => {
      if (value === undefined || value === null) return '';
      const normalized = String(value).trim();
      if (normalized === '[object Object]' || normalized === '[object Array]') {
        return '';
      }
      return normalized;
    };

    const rawImpl = typeof scsConfig.implementationType === 'string'
      ? scsConfig.implementationType.trim().toLowerCase()
      : '';
    const implementationType = rawImpl === 'auth' ? 'auth' : 'community';
    const legacyApiKey = getLegacySubtitleProviderApiKey(config, 'scs');
    const apiKey = normalizeScsValue(scsConfig.apiKey) || legacyApiKey;
    const apiKeyStillEncrypted = looksEncrypted(apiKey);

    mergedConfig.subtitleProviders.scs = {
      ...scsConfig,
      enabled: scsConfig.enabled === true,
      implementationType,
      apiKey: apiKeyStillEncrypted ? '' : apiKey
    };

    if (apiKeyStillEncrypted) {
      log.warn(() => '[Config] SCS auth key appears to still be encrypted; falling back to Community mode.');
      mergedConfig.subtitleProviders.scs.implementationType = 'community';
      mergedConfig.__credentialDecryptionFailed = true;
      const credentialFailureFields = new Set(mergedConfig.__credentialDecryptionFailedFields || []);
      credentialFailureFields.add('scs.apiKey');
      mergedConfig.__credentialDecryptionFailedFields = Array.from(credentialFailureFields);
    }

    if (mergedConfig.subtitleProviders.scs.implementationType === 'auth' && !mergedConfig.subtitleProviders.scs.apiKey) {
      log.warn(() => '[Config] SCS Auth selected without an auth key; switching to Community mode.');
      mergedConfig.subtitleProviders.scs.implementationType = 'community';
      mergedConfig.__needsSessionPersist = true;
      mergedConfig.__persistReason = mergedConfig.__persistReason || 'scs-auth-to-community';
    }
  }

  const wyzieConfig = mergedConfig.subtitleProviders?.wyzie;
  if (wyzieConfig) {
    const normalizeWyzieValue = (value, fallback = '') => {
      if (value === undefined || value === null) return fallback;
      const normalized = String(value).trim();
      if (normalized === '[object Object]' || normalized === '[object Array]') {
        return fallback;
      }
      return normalized || fallback;
    };

    const previousApiKey = typeof wyzieConfig.apiKey === 'string' ? wyzieConfig.apiKey.trim() : '';
    const normalizedApiKey = normalizeWyzieValue(wyzieConfig.apiKey, '');
    const normalizedEnabled = wyzieConfig.enabled === true && !!normalizedApiKey;
    const hadLegacySources = Object.prototype.hasOwnProperty.call(wyzieConfig, 'sources');
    const needsPersist =
      previousApiKey !== normalizedApiKey
      || (wyzieConfig.enabled === true && !normalizedApiKey)
      || hadLegacySources;

    const { sources: _legacySources, ...currentWyzieConfig } = wyzieConfig;

    mergedConfig.subtitleProviders.wyzie = {
      ...currentWyzieConfig,
      enabled: normalizedEnabled,
      apiKey: normalizedApiKey
    };

    if (needsPersist) {
      mergedConfig.__needsSessionPersist = true;
      mergedConfig.__persistReason = mergedConfig.__persistReason || 'wyzie-dynamic-sources-migration';
    }
  }

  return mergedConfig;
}

function migrateOldConfig(oldConfig) {
  const newConfig = { ...oldConfig };
  const defaults = getDefaultConfig();

  newConfig.subtitleProviders = {
    ...defaults.subtitleProviders,
    opensubtitles: {
      enabled: true,
      username: '',
      password: ''
    }
  };

  newConfig.providerParameters = { ...defaults.providerParameters };
  delete newConfig.opensubtitlesApiKey;

  return newConfig;
}

function encodeConfig(config) {
  try {
    const json = JSON.stringify(config);
    return Buffer.from(json, 'utf-8').toString('base64');
  } catch (error) {
    log.error(() => ['[Config] Encode error:', error.message]);
    return '';
  }
}

/**
 * Model-specific default configurations (Universal Blueprint Temperature: 0.2)
 */
const MODEL_SPECIFIC_DEFAULTS = {
  'gemma-3-27b-it': {
    thinkingBudget: 0,
    thinkingLevel: '',
    temperature: 0.2
  },
  'gemini-2.5-flash-lite': {
    thinkingBudget: 0,
    thinkingLevel: '',
    temperature: 0.2
  },
  'gemini-2.5-flash-lite-preview-09-2025': {
    thinkingBudget: 0,
    thinkingLevel: '',
    temperature: 0.2
  },
  'gemini-2.5-flash': {
    thinkingBudget: -1,
    thinkingLevel: '',
    temperature: 0.2
  },
  'gemini-3-flash-preview': {
    thinkingBudget: -1,
    thinkingLevel: 'high',
    temperature: 0.2
  },
  'gemini-3.1-flash-lite': {
    thinkingBudget: 0,
    thinkingLevel: 'minimal',
    temperature: 0.2
  },
  'gemini-3.5-flash-lite': {
    thinkingBudget: 0,
    thinkingLevel: 'minimal',
    temperature: 0.2
  },
  'gemini-3.5-flash': {
    thinkingBudget: -1,
    thinkingLevel: 'high',
    temperature: 0.2
  },
  'gemini-3.6-flash': {
    thinkingBudget: -1,
    thinkingLevel: 'high',
    temperature: 0.2
  },
  'gemini-3.7-flash': {
    thinkingBudget: -1,
    thinkingLevel: 'high',
    temperature: 0.2
  },
  'gemini-flash-lite-latest': {
    thinkingBudget: 0,
    thinkingLevel: 'minimal',
    temperature: 0.2
  },
  'gemini-2.5-pro': {
    thinkingBudget: 1000,
    thinkingLevel: '',
    temperature: 0.2
  },
  'gemini-3.1-pro-preview': {
    thinkingBudget: 1000,
    thinkingLevel: 'high',
    temperature: 0.2
  }
};

function getModelSpecificDefaults(modelName) {
  const normalized = normalizeGeminiModelName(modelName).toLowerCase();
  const exactDefaults = MODEL_SPECIFIC_DEFAULTS[normalized];
  if (exactDefaults) return { ...exactDefaults };

  const isGemini3 = /^gemini-3(?:[.-]|$)/.test(normalized)
    || /^gemini-(?:flash|flash-lite|pro)-latest$/.test(normalized);
  if (isGemini3 && normalized.includes('flash-lite')) {
    return { thinkingBudget: 0, thinkingLevel: 'minimal', temperature: 0.2 };
  }
  if (isGemini3 && normalized.includes('flash')) {
    return { thinkingBudget: -1, thinkingLevel: 'high', temperature: 0.2 };
  }
  if (isGemini3 && normalized.includes('pro')) {
    return { thinkingBudget: 1000, thinkingLevel: 'high', temperature: 0.2 };
  }
  if (normalized.includes('gemma')) {
    return { thinkingBudget: 0, thinkingLevel: '', temperature: 0.2 };
  }
  if (normalized.includes('flash-lite')) {
    return { thinkingBudget: 0, thinkingLevel: '', temperature: 0.2 };
  }
  if (normalized.includes('flash')) {
    return { thinkingBudget: -1, thinkingLevel: '', temperature: 0.2 };
  }
  if (normalized.includes('pro')) {
    return { thinkingBudget: 1000, thinkingLevel: '', temperature: 0.2 };
  }
  return { thinkingBudget: 0, thinkingLevel: '', temperature: 0.2 };
}

function getEffectiveGeminiModel(config = {}) {
  const advancedSettings = config?.advancedSettings || {};
  const advancedOverride = normalizeGeminiModelName(advancedSettings.geminiModel);
  if (advancedSettings.enabled === true && advancedOverride) {
    return advancedOverride;
  }
  const baseModel = normalizeGeminiModelName(config?.geminiModel);
  return baseModel || normalizeGeminiModelName(process.env.GEMINI_MODEL) || DEFAULT_GEMINI_MODEL;
}

function getDefaultConfig(modelName = null) {
  const effectiveModel = normalizeGeminiModelName(modelName || process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL);
  const modelDefaults = getModelSpecificDefaults(effectiveModel);

  const advancedSettings = {
    maxOutputTokens: parseInt(process.env.GEMINI_MAX_OUTPUT_TOKENS, 10) || 65536,
    chunkSize: 12000,
    translationTimeout: parseInt(process.env.GEMINI_TRANSLATION_TIMEOUT, 10) || 720,
    maxRetries: process.env.GEMINI_MAX_RETRIES !== undefined ? parseInt(process.env.GEMINI_MAX_RETRIES, 10) : 3,
    sendTimestampsToAI: process.env.SEND_TIMESTAMPS_TO_AI === 'true',
    translationWorkflow: process.env.TRANSLATION_WORKFLOW || 'xml',
    enableJsonOutput: process.env.ENABLE_JSON_OUTPUT === 'true',
    thinkingBudget: process.env.GEMINI_THINKING_BUDGET !== undefined
      ? parseInt(process.env.GEMINI_THINKING_BUDGET, 10)
      : modelDefaults.thinkingBudget,
    thinkingLevel: sanitizeGeminiThinkingLevel(process.env.GEMINI_THINKING_LEVEL, modelDefaults.thinkingLevel),

    // Advanced Sampling Defaults (Blueprint Optimized)
    temperature: process.env.GEMINI_TEMPERATURE !== undefined
      ? parseFloat(process.env.GEMINI_TEMPERATURE)
      : modelDefaults.temperature,
    topP: process.env.GEMINI_TOP_P !== undefined ? parseFloat(process.env.GEMINI_TOP_P) : 0.95,
    topK: (process.env.GEMINI_TOP_K !== undefined && parseInt(process.env.GEMINI_TOP_K, 10) !== 40 && parseInt(process.env.GEMINI_TOP_K, 10) > 0)
      ? parseInt(process.env.GEMINI_TOP_K, 10)
      : undefined,
    minP: process.env.GEMINI_MIN_P !== undefined ? parseFloat(process.env.GEMINI_MIN_P) : 0.05,
    repetitionPenalty: process.env.GEMINI_REPETITION_PENALTY !== undefined ? parseFloat(process.env.GEMINI_REPETITION_PENALTY) : 1.05,

    enableBatchContext: process.env.ENABLE_BATCH_CONTEXT === 'true',
    contextSize: parseInt(process.env.BATCH_CONTEXT_SIZE, 10) || 20,
    mismatchRetries: process.env.MISMATCH_RETRIES !== undefined ? Math.max(0, Math.min(3, parseInt(process.env.MISMATCH_RETRIES, 10))) : 3
  };

  const envSubsPerLang = parseInt(process.env.MAX_SUBTITLES_PER_LANGUAGE, 10);
  const maxSubtitlesPerLanguage = (Number.isFinite(envSubsPerLang) && envSubsPerLang > 0)
    ? Math.min(50, envSubsPerLang)
    : 12;

  return {
    noTranslationMode: false,
    noTranslationLanguages: [],
    sourceLanguages: [],
    targetLanguages: [],
    uiLanguage: process.env.UI_LANGUAGE_DEFAULT || 'en',
    learnMode: false,
    learnTargetLanguages: [],
    learnOrder: 'source-top',
    learnPlacement: 'top',
    learnItalic: true,
    learnItalicTarget: 'target',
    geminiApiKey: '',
    geminiKeyRotationEnabled: false,
    geminiApiKeys: [],
    geminiKeyRotationMode: 'per-batch',
    parallelBatchesEnabled: false,
    parallelBatchesCount: 3,
    assemblyAiApiKey: DEFAULT_API_KEYS.ASSEMBLYAI || '',
    cloudflareWorkersApiKey: DEFAULT_API_KEYS.CF_WORKERS_AUTOSUBS || '',
    otherApiKeysEnabled: true,
    autoSubs: {
      defaultMode: 'cloudflare',
      sendFullVideoToAssembly: false,
      assemblySpeechModel: 'universal-3-pro'
    },
    geminiModel: effectiveModel,
    multiProviderEnabled: false,
    mainProvider: 'gemini',
    secondaryProviderEnabled: false,
    secondaryProvider: '',
    providers: {
      openai: { enabled: false, apiKey: '', model: '' },
      anthropic: { enabled: false, apiKey: '', model: '' },
      xai: { enabled: false, apiKey: '', model: '' },
      deepseek: { enabled: false, apiKey: '', model: '' },
      deepl: { enabled: false, apiKey: '', model: '' },
      mistral: { enabled: false, apiKey: '', model: '' },
      cfworkers: { enabled: false, apiKey: '', model: '' },
      openrouter: { enabled: false, apiKey: '', model: '' },
      googletranslate: { enabled: false, apiKey: '', model: 'web' },
      custom: { enabled: false, apiKey: '', model: '', baseUrl: '' }
    },
    providerParameters: getDefaultProviderParameters(),
    translationPrompt: DEFAULT_TRANSLATION_PROMPT,
    subtitleProviders: {
      opensubtitles: {
        enabled: true,
        username: '',
        password: ''
      },
      subdl: {
        enabled: true,
        apiKey: DEFAULT_API_KEYS.SUBDL
      },
      subsource: {
        enabled: true,
        apiKey: DEFAULT_API_KEYS.SUBSOURCE
      },
      scs: {
        enabled: false,
        implementationType: 'community',
        apiKey: ''
      },
      wyzie: {
        enabled: false,
        apiKey: ''
      },
      subsro: {
        enabled: false,
        apiKey: ''
      }
    },
    subtitleProviderTimeout: parseInt(process.env.SUBTITLE_PROVIDER_TIMEOUT, 10) || 12,
    translationCache: {
      enabled: true,
      duration: 0,
      persistent: true
    },
    bypassCache: false,
    bypassCacheConfig: {
      enabled: true,
      duration: 12
    },
    tempCache: {
      enabled: true,
      duration: 12
    },
    subToolboxEnabled: false,
    fileTranslationEnabled: false,
    syncSubtitlesEnabled: false,
    excludeHearingImpairedSubtitles: false,
    enableSeasonPacks: true,
    forceSRTOutput: false,
    convertAssToVtt: true,
    urlExtensionTest: 'srt',
    androidSubtitleCompatMode: 'off',
    mobileMode: false,
    singleBatchMode: false,
    minSubtitleSizeBytes: 200,
    maxSubtitlesPerLanguage,
    advancedSettings
  };
}

function validateConfig(config) {
  const errors = [];
  const t = getTranslator(config?.uiLanguage || 'en');

  if (!config) {
    errors.push(t('validation.configRequired', {}, 'Configuration is required'));
    return { valid: false, errors };
  }

  const { maxSourceLanguages, maxTargetLanguages, maxNoTranslationLanguages } = getLanguageSelectionLimits();
  const multiEnabled = config.multiProviderEnabled === true;
  const mainProvider = String(multiEnabled ? (config.mainProvider || 'gemini') : 'gemini').toLowerCase();
  const resolveProviderConfig = (key) => {
    const providers = config.providers || {};
    if (providers[key]) return providers[key];
    const matchKey = Object.keys(providers).find(k => String(k).toLowerCase() === String(key).toLowerCase());
    return matchKey ? providers[matchKey] : null;
  };

  const geminiConfigured = (() => {
    const hasModel = !!getEffectiveGeminiModel(config);
    if (!hasModel) return false;

    if (config.geminiKeyRotationEnabled === true) {
      const keys = Array.isArray(config.geminiApiKeys)
        ? config.geminiApiKeys.filter(k => typeof k === 'string' && k.trim() !== '')
        : [];
      return keys.length > 0;
    }

    return !!(config.geminiApiKey && config.geminiApiKey.trim() !== '');
  })();
  const providerIsConfigured = (key) => {
    const cfg = resolveProviderConfig(key);
    if (!cfg || cfg.enabled !== true) return false;
    if (KEY_OPTIONAL_PROVIDERS.has(String(key).toLowerCase())) {
      if (String(key).toLowerCase() === 'custom') {
        return !!(cfg.baseUrl && String(cfg.baseUrl).trim() !== '' && cfg.model && String(cfg.model).trim() !== '');
      }
      return true;
    }
    return !!(cfg.apiKey && String(cfg.apiKey).trim() !== '' && cfg.model && String(cfg.model).trim() !== '');
  };

  const configuredProviders = new Set();
  if (geminiConfigured) configuredProviders.add('gemini');
  Object.keys(config.providers || {}).forEach(key => {
    if (providerIsConfigured(key)) {
      configuredProviders.add(String(key).toLowerCase());
    }
  });

  if (!mainProvider) {
    errors.push(t('validation.mainProviderMissing', {}, 'Main provider must be selected'));
  } else if (mainProvider === 'gemini') {
    if (!geminiConfigured) {
      errors.push(t('validation.mainProviderGeminiMissing', {}, 'Gemini API key and model are required for the main provider'));
    }
  } else {
    if (!providerIsConfigured(mainProvider)) {
      errors.push(t('validation.mainProviderConfigured', { provider: mainProvider }, `API key, model, and enabled status are required for main provider '${mainProvider}'`));
    }
  }

  if (multiEnabled && config.secondaryProviderEnabled === true) {
    const secondaryKey = String(config.secondaryProvider || '').toLowerCase();
    if (!secondaryKey) {
      errors.push(t('validation.secondaryMissing', {}, 'Secondary provider must be selected when enabled'));
    } else if (secondaryKey === mainProvider) {
      errors.push(t('validation.secondaryDifferent', {}, 'Secondary provider must be different from main provider'));
    } else if (secondaryKey === 'gemini') {
      if (!geminiConfigured) {
        errors.push(t('validation.secondaryGemini', {}, 'Gemini API key and model are required for the secondary provider'));
      }
    } else if (!providerIsConfigured(secondaryKey)) {
      errors.push(t('validation.secondaryConfigured', { provider: secondaryKey }, `API key, model, and enabled status are required for secondary provider '${secondaryKey}'`));
    }
  }

  if (configuredProviders.size === 0) {
    errors.push(t('validation.atLeastOneProvider', {}, 'At least one AI provider must be enabled with an API key and model'));
  }

  if (multiEnabled && config.secondaryProviderEnabled === true && configuredProviders.size < 2) {
    errors.push(t('validation.secondaryTwoProviders', {}, 'Secondary Provider requires two configured AI providers with API keys'));
  }

  if (config.noTranslationMode) {
    if (!config.noTranslationLanguages || config.noTranslationLanguages.length === 0) {
      errors.push(t('validation.noTranslationMissing', {}, 'At least one no-translation language must be selected'));
    }
    if (config.noTranslationLanguages && config.noTranslationLanguages.length > maxNoTranslationLanguages) {
      errors.push(t('validation.noTranslationLimit', { limit: maxNoTranslationLanguages }, `Maximum of ${maxNoTranslationLanguages} no-translation languages allowed`));
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  if (!config.sourceLanguages || config.sourceLanguages.length === 0) {
    errors.push(t('validation.sourceMissing', {}, 'At least one source language must be selected'));
  }

  if (config.sourceLanguages && config.sourceLanguages.length > maxSourceLanguages) {
    errors.push(t('validation.sourceLimit', { limit: maxSourceLanguages }, `Maximum of ${maxSourceLanguages} source languages allowed`));
  }

  if (!config.targetLanguages || config.targetLanguages.length === 0) {
    errors.push(t('validation.targetMissing', {}, 'At least one target language must be selected'));
  }

  const combinedTargets = new Set([
    ...(config.targetLanguages || []),
    ...(config.learnTargetLanguages || [])
  ]);
  if (combinedTargets.size > maxTargetLanguages) {
    errors.push(t('validation.targetLimit', { limit: maxTargetLanguages }, `Maximum of ${maxTargetLanguages} total target languages allowed (including Learn Mode)`));
  }

  if (config.noTranslationLanguages && config.noTranslationLanguages.length > maxNoTranslationLanguages) {
    errors.push(t('validation.noTranslationLimit', { limit: maxNoTranslationLanguages }, `Maximum of ${maxNoTranslationLanguages} no-translation languages allowed`));
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

const { version } = require('./version');

function buildManifest(config, baseUrl = '') {
  const hasSessionTokenError = config.__sessionTokenError === true;
  const t = getTranslator((config && config.uiLanguage) || 'en');

  let sourceLanguageNames;
  let targetLanguageNames;
  let description;

  if (hasSessionTokenError) {
    sourceLanguageNames = 'ERROR';
    targetLanguageNames = 'ERROR';
    description = t('validation.sessionTokenError', {}, 'Configuration Error: Session token not found or expired.\n\nPlease reconfigure the addon to continue using it.');
  } else {
    sourceLanguageNames = (config.sourceLanguages || [])
      .map(code => code.toUpperCase())
      .join(', ');

    targetLanguageNames = (config.targetLanguages || [])
      .map(code => code.toUpperCase())
      .join(', ');

    const providerLabel = (() => {
      if (config.multiProviderEnabled && config.mainProvider && config.mainProvider !== 'gemini') {
        const key = String(config.mainProvider).toLowerCase();
        const labels = {
          openai: 'OpenAI',
          anthropic: 'Anthropic',
          xai: 'XAI',
          deepseek: 'DeepSeek',
          deepl: 'DeepL',
          mistral: 'Mistral',
          cfworkers: 'Cloudflare Workers AI',
          openrouter: 'OpenRouter',
          googletranslate: 'Google Translate (unofficial)'
        };
        return labels[key] || key.charAt(0).toUpperCase() + key.slice(1);
      }
      return 'Gemini';
    })();

    description = t('manifest.description', {
      provider: `${providerLabel} AI`,
      sources: sourceLanguageNames || 'N/A',
      targets: targetLanguageNames || 'N/A'
    }, `Take control of your subtitles! Fetch and translate subtitles from OpenSubtitles, SubScene and SubDL with a free Gemini AI key or other AI providers, without ever leaving Stremio.\n\nSource languages: ${sourceLanguageNames}\nTarget languages: ${targetLanguageNames}`);
  }

  const geminiConfigured = config.geminiApiKey && config.geminiApiKey.trim() !== '' &&
    getEffectiveGeminiModel(config);
  const providerIsConfigured = (key) => {
    const providers = config.providers || {};
    const matchKey = Object.keys(providers).find(k => String(k).toLowerCase() === String(key).toLowerCase()) || key;
    const cfg = providers[matchKey];
    if (!cfg || cfg.enabled !== true) return false;
    if (KEY_OPTIONAL_PROVIDERS.has(String(key).toLowerCase())) {
      if (String(key).toLowerCase() === 'custom') {
        return !!(cfg.baseUrl && String(cfg.baseUrl).trim() !== '' && cfg.model && String(cfg.model).trim() !== '');
      }
      return true;
    }
    return !!(cfg.apiKey && String(cfg.apiKey).trim() !== '' && cfg.model);
  };
  const configuredProviders = new Set();
  if (geminiConfigured) configuredProviders.add('gemini');
  Object.keys(config.providers || {}).forEach(key => {
    if (providerIsConfigured(key)) {
      configuredProviders.add(String(key).toLowerCase());
    }
  });
  const mainProviderKey = config.multiProviderEnabled
    ? String(config.mainProvider || 'gemini').toLowerCase()
    : 'gemini';
  const mainConfigured = mainProviderKey === 'gemini'
    ? geminiConfigured
    : providerIsConfigured(mainProviderKey);
  let isConfigured = mainConfigured || configuredProviders.size > 0;

  const logo = baseUrl ? `${baseUrl}/logo.png` : 'https://i.imgur.com/5qJc5Y5.png';
  const background = baseUrl ? `${baseUrl}/background.svg` : 'https://i.imgur.com/5qJc5Y5.png';

  const isElfHosted = process.env.ELFHOSTED === 'true';
  const addonName = isElfHosted
    ? 'SubMaker | ElfHosted'
    : t('manifest.name', {}, 'SubMaker - Subtitle Translator');

  return {
    id: 'com.stremio.submaker',
    version: version,
    name: addonName,
    description: description,
    catalogs: [],
    resources: ['subtitles'],
    types: ['movie', 'series', 'anime'],
    behaviorHints: {
      configurable: true,
      configurationRequired: false
    },
    logo: logo,
    icon: logo,
    background: background,
    contactEmail: 'support@submaker.example.com'
  };
}

const memoryRotationCounters = new Map();

async function selectGeminiApiKey(config) {
  if (!config) return '';

  if (config.geminiKeyRotationEnabled === true) {
    const keys = Array.isArray(config.geminiApiKeys)
      ? config.geminiApiKeys.filter(k => typeof k === 'string' && k.trim() !== '')
      : [];

    if (keys.length > 0) {
      const configHash = config.__configHash || 'default';
      let counter = 0;

      try {
        const StorageFactory = require('../storage/StorageFactory');
        const adapter = await StorageFactory.getStorageAdapter();

        if (adapter && adapter.client && typeof adapter.client.incr === 'function') {
          const redisKey = `keyrotation:${configHash}`;
          counter = await adapter.client.incr(redisKey);
          if (counter === 1) {
            await adapter.client.expire(redisKey, 86400);
          }
        } else {
          counter = (memoryRotationCounters.get(configHash) || 0) + 1;
          memoryRotationCounters.set(configHash, counter);
        }
      } catch (err) {
        log.warn(() => `[Config] Redis key rotation counter failed, using in-memory: ${err.message}`);
        counter = (memoryRotationCounters.get(configHash) || 0) + 1;
        memoryRotationCounters.set(configHash, counter);
      }

      const keyIndex = (counter - 1) % keys.length;
      const selectedKey = keys[keyIndex];
      log.info(() => `[Gemini] Key rotation: using key ${keyIndex + 1} of ${keys.length} (${redactApiKey(selectedKey)})`);
      return selectedKey;
    }
  }

  return config.geminiApiKey || '';
}

function getMaxGeminiApiKeys() {
  return MAX_GEMINI_API_KEYS;
}

module.exports = {
  parseConfig,
  encodeConfig,
  getDefaultConfig,
  getModelSpecificDefaults,
  validateConfig,
  buildManifest,
  normalizeConfig,
  getLanguageSelectionLimits,
  getDefaultProviderParameters,
  mergeProviderParameters,
  getEffectiveGeminiModel,
  normalizeGeminiModelName,
  sanitizeGeminiThinkingLevel,
  selectGeminiApiKey,
  getMaxGeminiApiKeys,
  MAX_GEMINI_API_KEYS
};
