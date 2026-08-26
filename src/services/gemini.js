const axios = require('axios');
const { sanitizeApiKeyForHeader } = require('../utils/security');
const { handleTranslationError, logApiError } = require('../utils/apiErrorHandler');
const { httpAgent, httpsAgent } = require('../utils/httpAgents');
const log = require('../utils/logger');
const { resolveLanguageDisplayName } = require('../utils/languageResolver');
const { normalizeTargetLanguageForPrompt } = require('./utils/normalizeTargetLanguageForPrompt');
const {
  getProviderAuthFailureCacheKey,
  hasCachedProviderAuthFailure,
  cacheProviderAuthFailure,
  clearCachedProviderAuthFailure
} = require('../utils/providerAuthFailureCache');

// Use v1beta endpoint - v1 endpoint doesn't support /models/{model} operations
const GEMINI_API_URL = process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta';

function normalizeGeminiModelId(model) {
  return String(model || '').trim().replace(/^models\//, '');
}

function isGemini3Model(model) {
  const modelId = normalizeGeminiModelId(model);
  return /^gemini-3(?:[.-]|$)/i.test(modelId) || /^gemini-(?:flash|flash-lite|pro)-latest$/i.test(modelId);
}

function getFallbackOutputTokenLimit(model) {
  const modelName = normalizeGeminiModelId(model).toLowerCase();
  if (modelName.includes('2.0') || modelName.includes('-flash-001') || modelName.includes('-flash-lite-001')) {
    return 8192;
  }
  if (modelName.includes('2.5') || isGemini3Model(modelName)) {
    return 65536;
  }
  return 8192;
}

// Normalize human-readable target language names for Gemini prompts
function normalizeTargetName(name) {
  const raw = String(name || '').trim();
  if (!raw) return 'target language';

  const resolved = resolveLanguageDisplayName(raw) || raw;
  return normalizeTargetLanguageForPrompt(resolved);
}

function getGeminiErrorMessage(error) {
  const dataError = error?.response?.data?.error;
  if (typeof dataError === 'string') {
    return dataError;
  }
  if (dataError && typeof dataError === 'object') {
    return dataError.message || JSON.stringify(dataError);
  }
  return String(error?.response?.data?.message || error?.message || '');
}

function isGeminiAuthFailure(error) {
  const status = error?.response?.status || error?.statusCode;
  if (status === 401 || status === 403) {
    return true;
  }
  if (status !== 400) {
    return false;
  }

  const message = getGeminiErrorMessage(error).toLowerCase();
  return message.includes('api key') && (
    message.includes('invalid') ||
    message.includes('not valid') ||
    message.includes('permission') ||
    message.includes('authentication')
  );
}

// Default translation prompt (base - thinking rules added conditionally)
const DEFAULT_TRANSLATION_PROMPT = `Translate the following subtitles while:

1. Preserving the timing and structure exactly as given
2. Maintaining natural dialogue flow and colloquialisms appropriate to the target language
3. Keeping the same number of lines and line breaks
4. Preserving any formatting tags or special characters
5. Ensuring translations are contextually accurate for film/TV dialogue

Translate to {target_language}.

Do NOT include acknowledgements, explanations, notes or alternative translations.

Output ONLY the translated content, nothing else.`;

class GeminiService {
  constructor(apiKey, model = '', advancedSettings = {}) {
    this.apiKey = typeof apiKey === 'string' ? apiKey.trim() : apiKey;
    this.authFailureCacheKey = getProviderAuthFailureCacheKey('gemini', this.apiKey);
    this.model = normalizeGeminiModelId(model || process.env.GEMINI_MODEL || 'gemini-flash-lite-latest');
    this.isGemmaModel = String(this.model).toLowerCase().includes('gemma');
    this.isGemini3Model = typeof isGemini3Model === 'function' ? isGemini3Model(this.model) : String(this.model).toLowerCase().includes('gemini-3');

    // Auto-detect key type (Google Direct vs CrazyRouter Proxy)
    this.keyType = this.detectKeyType(this.apiKey);

    if (this.keyType === 'crazyrouter') {
      this.baseUrl = process.env.CRAZYROUTER_API_BASE || 'https://cn.crazyrouter.com/v1beta';
    } else {
      this.baseUrl = process.env.GEMINI_API_BASE || GEMINI_API_URL;
    }

    // FinOps Usage Ledger
    this.usageStats = {
      inputTokens: 0,
      outputTokens: 0,
      thoughtTokens: 0,
      cachedTokens: 0
    };

    // Output limits & timeouts
    this.maxOutputTokens = advancedSettings.maxOutputTokens
      || parseInt(process.env.GEMINI_MAX_OUTPUT_TOKENS, 10)
      || 65536;

    const timeoutSeconds = advancedSettings.translationTimeout
      || parseInt(process.env.GEMINI_TRANSLATION_TIMEOUT, 10)
      || 720;
    this.timeout = timeoutSeconds * 1000;

    this.maxRetries = advancedSettings.maxRetries !== undefined
      ? advancedSettings.maxRetries
      : (process.env.GEMINI_MAX_RETRIES !== undefined ? parseInt(process.env.GEMINI_MAX_RETRIES, 10) : 3);

    // Thinking Budget
    const envThinking = process.env.GEMINI_THINKING_BUDGET !== undefined
      ? parseInt(process.env.GEMINI_THINKING_BUDGET, 10)
      : 0;
    this.thinkingBudget = advancedSettings.thinkingBudget !== undefined
      ? advancedSettings.thinkingBudget
      : envThinking;
    this.thinkingLevel = typeof advancedSettings.thinkingLevel === 'string'
      ? advancedSettings.thinkingLevel.trim().toLowerCase()
      : String(process.env.GEMINI_THINKING_LEVEL || '').trim().toLowerCase();

    // Blueprint Sampling Defaults (Temperature: 0.2, Top-P: 0.95, Min-P: 0.05, Repetition: 1.05)
    this.temperature = advancedSettings.temperature !== undefined
      ? advancedSettings.temperature
      : (process.env.GEMINI_TEMPERATURE !== undefined ? parseFloat(process.env.GEMINI_TEMPERATURE) : 0.2);

    this.topP = advancedSettings.topP !== undefined
      ? advancedSettings.topP
      : (process.env.GEMINI_TOP_P !== undefined ? parseFloat(process.env.GEMINI_TOP_P) : 0.95);

    // Top-K (Omitted by default to unleash dynamic Min-P pruning; active only if manually set)
    this.topK = advancedSettings.topK !== undefined
      ? advancedSettings.topK
      : (process.env.GEMINI_TOP_K !== undefined ? parseInt(process.env.GEMINI_TOP_K, 10) : undefined);

    this.minP = advancedSettings.minP !== undefined
      ? advancedSettings.minP
      : (process.env.GEMINI_MIN_P !== undefined ? parseFloat(process.env.GEMINI_MIN_P) : 0.05);

    this.repetitionPenalty = advancedSettings.repetitionPenalty !== undefined
      ? advancedSettings.repetitionPenalty
      : (process.env.GEMINI_REPETITION_PENALTY !== undefined ? parseFloat(process.env.GEMINI_REPETITION_PENALTY) : 1.05);

    if (this.isGemmaModel) {
      this.maxOutputTokens = 8192;
      this.gemmaRetryConfig = {
        maxRetries: 2,
        baseDelay: 8000
      };
    }

    this.enableJsonOutput = advancedSettings.enableJsonOutput === true;
  }

  detectKeyType(apiKey) {
    if (!apiKey) return 'google';
    const key = String(apiKey).trim();
    if (key.startsWith('sk-')) return 'crazyrouter';
    return 'google';
  }

  getAuthHeaders() {
    const sanitizedKey = sanitizeApiKeyForHeader(this.apiKey) || '';
    if (this.keyType === 'crazyrouter') {
      return { 'Authorization': `Bearer ${sanitizedKey}`, 'Content-Type': 'application/json' };
    }
    return { 'x-goog-api-key': sanitizedKey, 'Content-Type': 'application/json' };
  }

  updateUsageStats(usage, streamId = 'default') {
    if (!usage) return;

    if (!global.geminiFinOps) {
      global.geminiFinOps = { streams: {} };
    }

    const input = usage.promptTokenCount || 0;
    const cached = usage.cachedContentTokenCount || 0;
    const thought = usage.thoughtsTokenCount || usage.thoughtTokenCount || 0;
    const textOut = usage.candidatesTokenCount || 0;

    global.geminiFinOps.streams[streamId] = {
      input,
      cached,
      thought,
      output: textOut
    };
  }

  getEffectiveThinkingBudget() {
    return this.isGemmaModel ? 0 : this.thinkingBudget;
  }

  getGemini3ThinkingLevel(thinkingBudget) {
    const allowedLevels = new Set(['disabled', 'minimal', 'low', 'medium', 'high']);
    const requiresLowMinimum = /^gemini-3\.7-flash(?:[-.]|$)/.test(this.model)
      || this.model.includes('3.1-pro')
      || this.model === 'gemini-pro-latest';

    if (allowedLevels.has(this.thinkingLevel)) {
      const requestedLevel = this.thinkingLevel === 'disabled' ? 'minimal' : this.thinkingLevel;
      if (requestedLevel === 'minimal' && requiresLowMinimum) {
        return 'low';
      }
      return requestedLevel;
    }
    if (!Number.isFinite(thinkingBudget) || thinkingBudget < 0) {
      return null;
    }
    if (thinkingBudget === 0) {
      return requiresLowMinimum ? 'low' : 'minimal';
    }
    if (thinkingBudget <= 2048) {
      return 'low';
    }
    if (thinkingBudget <= 8192) {
      return 'medium';
    }
    return 'high';
  }

  isThinkingEnabled() {
    if (this.isGemini3Model) {
      return !!this.getGemini3ThinkingLevel(this.getEffectiveThinkingBudget());
    }
    return this.getEffectiveThinkingBudget() !== 0;
  }

  buildGenerationConfig(maxOutputTokens) {
    const generationConfig = {
      maxOutputTokens,
      temperature: this.temperature,
      topP: this.topP,
      frequencyPenalty: 0.0,
      presencePenalty: 0.0
    };

    // Attach Top-K only if explicitly defined by user/environment
    if (this.topK !== undefined && Number.isFinite(this.topK) && this.topK > 0) {
      generationConfig.topK = this.topK;
    }

    // Inject advanced dynamic sampling parameters for CrazyRouter proxy
    if (this.keyType === 'crazyrouter') {
      if (this.minP !== undefined && Number.isFinite(this.minP)) {
        generationConfig.min_p = this.minP;
      }
      if (this.repetitionPenalty !== undefined && Number.isFinite(this.repetitionPenalty)) {
        generationConfig.repetition_penalty = this.repetitionPenalty;
      }
    }

    const thinkingBudget = this.getEffectiveThinkingBudget();

    if (this.isGemini3Model) {
      const thinkingLevel = this.getGemini3ThinkingLevel(thinkingBudget);
      if (thinkingLevel) {
        generationConfig.thinkingConfig = { thinkingLevel };
      }
      return generationConfig;
    }

    if (thinkingBudget === -1) {
      generationConfig.thinkingConfig = { thinkingBudget: null };
    } else if (thinkingBudget > 0) {
      generationConfig.thinkingConfig = { thinkingBudget };
    }

    return generationConfig;
  }

  isPrefillSupported() {
    if (this.isGemmaModel) return false;

    const modelNameLower = String(this.model).toLowerCase();
    const matchVer = modelNameLower.match(/gemini-(\d+(?:\.\d+)?)/);
    if (matchVer) {
      const geminiVersion = parseFloat(matchVer[1]);
      return geminiVersion <= 3.1;
    }

    return false;
  }

  async getAvailableModels(options = {}) {
    const silent = !!options.silent;
    const throwOnError = options.throwOnError === true;
    if (await hasCachedProviderAuthFailure(this.authFailureCacheKey)) {
      log.warn(() => '[Gemini] Fetch models blocked: cached invalid API key detected');
      return [];
    }

    try {
      const response = await axios.get(`${this.baseUrl}/models`, {
        headers: this.getAuthHeaders(),
        timeout: 10000,
        httpAgent,
        httpsAgent
      });

      if (!response.data || !response.data.models) {
        return [];
      }

      const models = response.data.models
        .filter(model => model.supportedGenerationMethods?.includes('generateContent'))
        .map(model => ({
          name: model.name.replace('models/', ''),
          displayName: model.displayName || model.name,
          description: model.description || '',
          maxTokens: model.inputTokenLimit || 30000
        }));

      await clearCachedProviderAuthFailure(this.authFailureCacheKey);
      return models;

    } catch (error) {
      if (isGeminiAuthFailure(error)) {
        await cacheProviderAuthFailure(this.authFailureCacheKey);
      }
      if (!silent) {
        logApiError(error, 'Gemini', 'Fetch models', { skipResponseData: true });
      }
      if (throwOnError) {
        throw error;
      }
      return [];
    }
  }

  async getModelLimits() {
    if (this._modelLimits) {
      return this._modelLimits;
    }

    const modelName = String(this.model).toLowerCase();

    if (this.keyType === 'crazyrouter') {
      let outputLimit = 8192;
      if (modelName.includes('2.5') || modelName.includes('gemini-3') || modelName.includes('gemini-4')) {
        outputLimit = 65535;
      }
      const limits = {
        inputTokenLimit: undefined,
        outputTokenLimit: outputLimit
      };
      log.debug(() => `[Gemini] CrazyRouter proxy bypass applied for ${this.model}. Output limit forced to: ${limits.outputTokenLimit}`);

      const effectiveThinkingBudget = this.getEffectiveThinkingBudget();
      const thinkingDisplay = effectiveThinkingBudget === -1 ? 'dynamic' : effectiveThinkingBudget === 0 ? 'disabled' : effectiveThinkingBudget;
      const topKDisplay = this.topK !== undefined ? this.topK : 'disabled (Min-P Active)';
      log.debug(() => `[Gemini] API config (Bypass Mode): temperature=${this.temperature}, topK=${topKDisplay}, topP=${this.topP}, minP=${this.minP}, repetitionPenalty=${this.repetitionPenalty}, thinkingBudget=${thinkingDisplay}, maxOutputTokens=${this.maxOutputTokens}, timeout=${this.timeout / 1000}s, maxRetries=${this.maxRetries}`);

      this._modelLimits = limits;
      return limits;
    }

    try {
      const response = await axios.get(`${this.baseUrl}/models/${this.model}`, {
        headers: this.getAuthHeaders(),
        timeout: 10000,
        httpAgent,
        httpsAgent
      });

      const data = response.data || {};
      const limits = {
        inputTokenLimit: data.inputTokenLimit,
        outputTokenLimit: data.outputTokenLimit
      };

      if (!limits.outputTokenLimit) {
        limits.outputTokenLimit = typeof getFallbackOutputTokenLimit === 'function'
          ? getFallbackOutputTokenLimit(this.model)
          : ((modelName.includes('2.5') || modelName.includes('gemini-3') || modelName.includes('gemini-4')) ? 65536 : 8192);
      }

      log.debug(() => `[Gemini] Model: ${this.model}, Output limit: ${limits.outputTokenLimit}, Input limit: ${limits.inputTokenLimit || 'unlimited'}`);

      const effectiveThinkingBudget = this.getEffectiveThinkingBudget();
      const thinkingDisplay = effectiveThinkingBudget === -1 ? 'dynamic' :
        effectiveThinkingBudget === 0 ? 'disabled' :
          effectiveThinkingBudget;
      const topKDisplay = this.topK !== undefined ? this.topK : 'disabled (Min-P Active)';
      const generationControls = this.isGemini3Model
        ? `thinkingLevel=${this.getGemini3ThinkingLevel(effectiveThinkingBudget) || 'model-default'}, temperature=${this.temperature}, topK=${topKDisplay}, topP=${this.topP}`
        : `temperature=${this.temperature}, topK=${topKDisplay}, topP=${this.topP}, thinkingBudget=${thinkingDisplay}`;
      log.debug(() => `[Gemini] API config: ${generationControls}, maxOutputTokens=${this.maxOutputTokens}, timeout=${this.timeout / 1000}s, maxRetries=${this.maxRetries}${this._totalKeys ? `, keys=${this._totalKeys}` : ''}`);

      this._modelLimits = limits;
      return limits;
    } catch (error) {
      log.warn(() => ['[Gemini] Could not fetch model limits, using conservative defaults:', error.message]);
      const limits = {
        inputTokenLimit: undefined,
        outputTokenLimit: typeof getFallbackOutputTokenLimit === 'function'
          ? getFallbackOutputTokenLimit(this.model)
          : ((modelName.includes('2.5') || modelName.includes('gemini-3') || modelName.includes('gemini-4')) ? 65536 : 8192)
      };
      log.debug(() => `[Gemini] Fallback limits for ${this.model}: ${limits.outputTokenLimit} output tokens`);
      this._modelLimits = limits;
      return limits;
    }
  }

  getDefaultModels() {
    return [];
  }

  async retryWithBackoff(fn, maxRetries = null, baseDelay = 3000) {
    const useGemmaConfig = this.isGemmaModel && this.gemmaRetryConfig;
    const effectiveMaxRetries = maxRetries !== null ? maxRetries :
      (useGemmaConfig ? this.gemmaRetryConfig.maxRetries : this.maxRetries);
    const effectiveBaseDelay = useGemmaConfig ? this.gemmaRetryConfig.baseDelay : baseDelay;

    for (let attempt = 0; attempt <= effectiveMaxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        const isLastAttempt = attempt === effectiveMaxRetries;
        const isTimeout = error.message.includes('timeout') || error.code === 'ECONNABORTED';
        const isNetworkError = error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND';
        const isSocketHangup = error.message.includes('socket hang up') || error.code === 'ECONNRESET';
        const isRateLimit = error.response?.status === 429 || error.statusCode === 429;
        const isServiceUnavailable = error.response?.status === 503 || error.statusCode === 503;
        const isMarkedRetryable = error.isRetryable === true;

        const isRetryable = isTimeout || isNetworkError || isSocketHangup || isRateLimit || isServiceUnavailable || isMarkedRetryable;

        if (isLastAttempt || !isRetryable) {
          throw error;
        }

        const delay = useGemmaConfig
          ? effectiveBaseDelay * Math.pow(3, attempt)
          : effectiveBaseDelay * Math.pow(2, attempt);
        const errorType = isRateLimit ? '429 rate limit' :
          isServiceUnavailable ? '503 service unavailable' :
            isSocketHangup ? 'socket hang up' :
              isTimeout ? 'timeout' :
                isMarkedRetryable ? 'transient error (OTHER)' : 'network error';
        log.debug(() => `[Gemini] Attempt ${attempt + 1} failed (${errorType}), retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  buildUserPrompt(subtitleContent, targetLanguage, customPrompt = null) {
    const normalizedTarget = normalizeTargetName(targetLanguage);

    let systemPrompt = (customPrompt || DEFAULT_TRANSLATION_PROMPT)
      .replace('{target_language}', normalizedTarget);

    const thinkingEnabled = typeof this.isThinkingEnabled === 'function'
      ? this.isThinkingEnabled()
      : (this.getEffectiveThinkingBudget ? this.getEffectiveThinkingBudget() !== 0 : true);

    if (thinkingEnabled) {
      const universalReasoningChain = '\n\n[CRITICAL REASONING PROTOCOL]\n1. ANTI-ECHO: NEVER copy or repeat the original source text into your internal reasoning scratchpad.\n2. ANTI-CHECKLIST: XML syntax (<s id="N">) is a strict mechanical rule. Execute it automatically. DO NOT waste thought tokens writing validation checks for IDs or tags.\n3. ZERO-THOUGHT BYPASS (CRITICAL): For 95% of standard dialogue, literal translations, overlapping speech (-), sound/music tags (e.g., [sighs], ♪), song lyrics, and sentence fragments — bypass reasoning ENTIRELY. Output the XML immediately.\n4. SELECTIVE REASONING: ONLY activate reasoning for highly complex idioms or untranslatable slang. Resolve conceptually then output XML immediately.\n';

      if (systemPrompt.includes('<input>')) {
        systemPrompt = systemPrompt.replace('<input>', universalReasoningChain + '\n<input>');
      } else if (systemPrompt.includes('Do NOT include acknowledgements')) {
        systemPrompt = systemPrompt.replace(/(Do NOT include acknowledgements[^\n]+)\n/, '$1' + universalReasoningChain);
      } else if (systemPrompt.includes('Output ONLY')) {
        systemPrompt = systemPrompt.replace(/\n(Output ONLY)/, universalReasoningChain + '\n$1');
      } else {
        systemPrompt = systemPrompt + universalReasoningChain;
      }
    }

    let userPrompt;
    if (systemPrompt.includes('<input>') || systemPrompt.includes('INPUT (')) {
      userPrompt = systemPrompt;
    } else {
      userPrompt = `${systemPrompt}\n\nContent to translate:\n\n${subtitleContent}`;
    }

    return { userPrompt, systemPrompt, normalizedTarget };
  }

  async countTokensForTranslation(subtitleContent, targetLanguage, customPrompt = null) {
    if (this.keyType === 'crazyrouter') {
      return null;
    }

    const { userPrompt } = this.buildUserPrompt(subtitleContent, targetLanguage, customPrompt);

    try {
      const response = await axios.post(
        `${this.baseUrl}/models/${this.model}:countTokens`,
        {
          contents: [{
            parts: [{ text: userPrompt }]
          }]
        },
        {
          headers: this.getAuthHeaders(),
          timeout: 10000,
          httpAgent,
          httpsAgent
        }
      );

      if (response.data && typeof response.data.totalTokens === 'number') {
        return response.data.totalTokens;
      }

      log.warn(() => '[Gemini] Token count response missing totalTokens, falling back to estimate');
      return null;
    } catch (error) {
      logApiError(error, 'Gemini', 'Count tokens', { skipResponseData: true });
      return null;
    }
  }

  async translateSubtitle(subtitleContent, sourceLanguage, targetLanguage, customPrompt = null) {
    return this.retryWithBackoff(async () => {
      try {
        const { userPrompt } = this.buildUserPrompt(subtitleContent, targetLanguage, customPrompt);

        const estimatedSubtitleTokens = this.estimateTokenCount(subtitleContent);

        const limits = await this.getModelLimits();
        const modelOutputCap = typeof limits.outputTokenLimit === 'number' ? limits.outputTokenLimit : this.maxOutputTokens;
        const safetyMargin = Math.floor(modelOutputCap * 0.05);

        const thinkingBudget = this.getEffectiveThinkingBudget();
        const thinkingReserve = thinkingBudget > 0 ? thinkingBudget : 0;
        const availableForOutput = Math.max(1024, Math.min(this.maxOutputTokens, modelOutputCap - safetyMargin - thinkingReserve));

        let estimatedOutputTokens;
        if (this.isThinkingEnabled()) {
          estimatedOutputTokens = availableForOutput;
        } else {
          estimatedOutputTokens = Math.floor(Math.min(
            availableForOutput,
            Math.max(8192, estimatedSubtitleTokens * 3.5)
          ));
        }

        const generationConfig = this.buildGenerationConfig(estimatedOutputTokens + thinkingReserve);

        if (this.enableJsonOutput && (this.isGemini3Model || !generationConfig.thinkingConfig)) {
          generationConfig.responseMimeType = 'application/json';
        }

        const safetySettings = [
          { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
          { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' },
        ];

        let contents = [];
        if (this.isPrefillSupported()) {
          let processedUserPrompt = userPrompt;
          let modelPrefill = "Task confirmed. Executing the strictly isolated raw data pipe localization stream now.\n";

          if (userPrompt.endsWith('<s id="')) {
            processedUserPrompt = userPrompt.slice(0, -7);
            modelPrefill += '<s id="';
          }

          contents = [
            {
              role: "user",
              parts: [{ text: processedUserPrompt }]
            },
            {
              role: "model",
              parts: [{ text: modelPrefill }]
            }
          ];
        } else {
          contents = [
            {
              role: "user",
              parts: [{ text: userPrompt }]
            }
          ];
        }

        const response = await axios.post(
          `${this.baseUrl}/models/${this.model}:generateContent`,
          {
            contents,
            generationConfig,
            safetySettings
          },
          {
            headers: this.getAuthHeaders(),
            timeout: this.timeout,
            httpAgent,
            httpsAgent
          }
        );

        if (!response.data) {
          log.warn(() => '[Gemini] No data in response');
          throw new Error('No data returned from Gemini API');
        }

        if (!response.data.candidates || response.data.candidates.length === 0) {
          const pf = response.data.promptFeedback || {};
          const blockReason = pf.blockReason || null;
          const safetyRatings = pf.safetyRatings || null;

          const truncatedResponse = (() => {
            try {
              const serialized = JSON.stringify(response.data, null, 2);
              const MAX_LEN = 2000;
              return serialized.length > MAX_LEN
                ? `${serialized.slice(0, MAX_LEN)}... [truncated]`
                : serialized;
            } catch (err) {
              return '[unserializable Gemini response]';
            }
          })();

          log.warn(() => ['[Gemini] No candidates in response (truncated):', truncatedResponse]);

          if (blockReason || safetyRatings) {
            const err = new Error(`PROHIBITED_CONTENT: ${blockReason || 'SAFETY'}`);
            err.translationErrorType = 'PROHIBITED_CONTENT';
            throw err;
          }

          throw new Error('No response candidates from Gemini API');
        }

        const candidate = response.data.candidates[0];
        const aggregatedText = candidate?.content?.parts?.map(p => (p && typeof p.text === 'string') ? p.text : '').join('') || '';

        if (candidate.finishReason && candidate.finishReason !== 'STOP') {
          log.warn(() => ['[Gemini] Unusual finish reason:', candidate.finishReason]);

          if (candidate.finishReason === 'SAFETY' || candidate.finishReason === 'PROHIBITED_CONTENT') {
            const err = new Error(`PROHIBITED_CONTENT: ${candidate.finishReason}`);
            err.translationErrorType = 'PROHIBITED_CONTENT';
            throw err;
          } else if (candidate.finishReason === 'RECITATION') {
            throw new Error('Translation blocked due to recitation concerns');
          } else if (candidate.finishReason === 'MAX_TOKENS') {
            log.warn(() => '[Gemini] MAX_TOKENS reached - translation may be incomplete');

            if (aggregatedText.length < subtitleContent.length * 0.3) {
              throw new Error('Translation exceeded maximum token limit with minimal output');
            }

            log.warn(() => '[Gemini] Continuing with partial translation due to MAX_TOKENS');
          } else {
            const err = new Error(`Translation stopped with reason: ${candidate.finishReason}`);
            err.isRetryable = true;
            throw err;
          }
        }

        if (!candidate.content || !candidate.content.parts || candidate.content.parts.length === 0) {
          log.warn(() => ['[Gemini] No content in candidate:', JSON.stringify(candidate, null, 2)]);
          throw new Error('No content in response candidate');
        }

        if (!candidate.content.parts[0].text && aggregatedText.length === 0) {
          log.warn(() => ['[Gemini] No text in content parts:', JSON.stringify(candidate.content.parts, null, 2)]);
          throw new Error('No text in response content');
        }

        const translatedText = aggregatedText.length > 0 ? aggregatedText : candidate.content.parts[0].text;
        return this.cleanTranslatedSubtitle(translatedText);

      } catch (error) {
        handleTranslationError(error, 'Gemini', { skipResponseData: true });
      }
    });
  }

  async streamTranslateSubtitle(subtitleContent, sourceLanguage, targetLanguage, customPrompt = null, onChunk = null) {
    return this.retryWithBackoff(async () => {
      try {
        const { userPrompt } = this.buildUserPrompt(subtitleContent, targetLanguage, customPrompt);

        const estimatedSubtitleTokens = this.estimateTokenCount(subtitleContent);

        const limits = await this.getModelLimits();
        const modelOutputCap = typeof limits.outputTokenLimit === 'number' ? limits.outputTokenLimit : this.maxOutputTokens;
        const safetyMargin = Math.floor(modelOutputCap * 0.05);

        const thinkingBudget = this.getEffectiveThinkingBudget();
        const thinkingReserve = thinkingBudget > 0 ? thinkingBudget : 0;
        const availableForOutput = Math.max(1024, Math.min(this.maxOutputTokens, modelOutputCap - safetyMargin - thinkingReserve));

        let estimatedOutputTokens;
        if (this.isThinkingEnabled()) {
          estimatedOutputTokens = availableForOutput;
        } else {
          estimatedOutputTokens = Math.floor(Math.min(
            availableForOutput,
            Math.max(8192, estimatedSubtitleTokens * 3.5)
          ));
        }

        const generationConfig = this.buildGenerationConfig(estimatedOutputTokens + thinkingReserve);

        if (this.enableJsonOutput && (this.isGemini3Model || !generationConfig.thinkingConfig)) {
          generationConfig.responseMimeType = 'application/json';
        }

        const safetySettings = [
          { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
          { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' },
        ];

        let contents = [];
        if (this.isPrefillSupported()) {
          let processedUserPrompt = userPrompt;
          let modelPrefill = "Task confirmed. Executing the strictly isolated raw data pipe localization stream now.\n";

          if (userPrompt.endsWith('<s id="')) {
            processedUserPrompt = userPrompt.slice(0, -7);
            modelPrefill += "<s id=\"";
          }

          contents = [
            {
              role: "user",
              parts: [{ text: processedUserPrompt }]
            },
            {
              role: "model",
              parts: [{ text: modelPrefill }]
            }
          ];
        } else {
          contents = [
            {
              role: "user",
              parts: [{ text: userPrompt }]
            }
          ];
        }

        const response = await axios.post(
          `${this.baseUrl}/models/${this.model}:streamGenerateContent`,
          {
            contents,
            generationConfig,
            safetySettings
          },
          {
            headers: {
              ...this.getAuthHeaders(),
              'Accept': 'text/event-stream'
            },
            params: { alt: 'sse' },
            timeout: this.timeout,
            httpAgent,
            httpsAgent,
            responseType: 'stream'
          }
        );

        const contentType = (response.headers && (response.headers['content-type'] || response.headers['Content-Type'])) || '';

        return await new Promise((resolve, reject) => {
          let buffer = '';
          let aggregated = '';
          let finishReason = null;
          let blockReason = null;
          let safetyRatings = null;
          let rawStream = '';

          const processPayload = (payloadStr) => {
            if (!payloadStr || !payloadStr.trim()) return;
            const cleaned = payloadStr.trim().startsWith('data:')
              ? payloadStr.trim().slice(5).trim()
              : payloadStr.trim();
            if (!cleaned) return;
            let data;
            try {
              data = JSON.parse(cleaned);
            } catch (_) {
              return;
            }

            if (data.usageMetadata) {
              if (!processPayload.streamId) processPayload.streamId = 'batch_' + Date.now() + Math.random();
              this.updateUsageStats(data.usageMetadata, processPayload.streamId);
            }

            if (data.promptFeedback) {
              blockReason = data.promptFeedback.blockReason || blockReason;
              if (Array.isArray(data.promptFeedback.safetyRatings) && data.promptFeedback.safetyRatings.length > 0) {
                safetyRatings = data.promptFeedback.safetyRatings;
              }
            }

            const candidate = data?.candidates?.[0];
            if (candidate && candidate.finishReason) {
              finishReason = candidate.finishReason;
            }
            if (candidate && Array.isArray(candidate.safetyRatings) && candidate.safetyRatings.length > 0) {
              safetyRatings = candidate.safetyRatings;
            }

            const parts = candidate?.content?.parts || [];
            const chunkText = parts.map(p => (p && typeof p.text === 'string') ? p.text : '').join('');
            if (chunkText) {
              aggregated += chunkText;
              const cleanedAgg = this.cleanTranslatedSubtitle(aggregated);
              if (typeof onChunk === 'function') {
                try { onChunk(cleanedAgg); } catch (_) { }
              }
            }
          };

          response.data.on('data', (chunk) => {
            try {
              const chunkStr = chunk.toString('utf8');
              rawStream += chunkStr;
              buffer += chunkStr;
              const parts = buffer.split(/\r?\n/);
              buffer = parts.pop();
              parts.forEach(processPayload);
            } catch (err) {
              log.warn(() => ['[Gemini] Stream chunk processing failed:', err.message]);
            }
          });

          response.data.on('end', () => {
            try {
              if (buffer && buffer.trim()) {
                processPayload(buffer);
              }

              if (!aggregated && rawStream.trim()) {
                try {
                  const recovered = this.recoverStreamPayload(rawStream);
                  if (recovered.text) {
                    aggregated = recovered.text;
                    finishReason = finishReason || recovered.finishReason;
                    blockReason = blockReason || recovered.blockReason;
                    safetyRatings = safetyRatings || recovered.safetyRatings;
                    log.debug(() => `[Gemini] Stream parsed via fallback (${recovered.payloadCount} payloads, content-type=${contentType || 'unknown'})`);
                  } else if (contentType && !contentType.includes('text/event-stream')) {
                    log.warn(() => `[Gemini] Streaming response was '${contentType}' with no text; check API base/alt=sse config`);
                  }
                } catch (recoverErr) {
                  log.warn(() => ['[Gemini] Stream recovery parse failed:', recoverErr.message]);
                }
              }

              const cleaned = this.cleanTranslatedSubtitle(aggregated);

              if (!cleaned && (blockReason || safetyRatings)) {
                const reason = blockReason || 'SAFETY';
                const err = new Error(`PROHIBITED_CONTENT: ${reason}`);
                err.translationErrorType = 'PROHIBITED_CONTENT';
                reject(err);
                return;
              }

              if (finishReason && finishReason !== 'STOP') {
                if (finishReason === 'SAFETY' || finishReason === 'RECITATION' || finishReason === 'PROHIBITED_CONTENT') {
                  const err = new Error(finishReason === 'RECITATION'
                    ? 'RECITATION: Translation blocked due to recitation concerns'
                    : `PROHIBITED_CONTENT: ${finishReason}`);
                  err.translationErrorType = 'PROHIBITED_CONTENT';
                  reject(err);
                  return;
                }

                if (finishReason === 'MAX_TOKENS') {
                  if (cleaned.length < subtitleContent.length * 0.3) {
                    const err = new Error('MAX_TOKENS: Translation exceeded maximum token limit with minimal output');
                    err.translationErrorType = 'MAX_TOKENS';
                    reject(err);
                    return;
                  }
                  log.warn(() => '[Gemini] MAX_TOKENS reached in stream - continuing with partial translation');
                } else {
                  const err = new Error(`Translation stopped with reason: ${finishReason}`);
                  err.isRetryable = true;
                  reject(err);
                  return;
                }
              }

              if (!cleaned) {
                reject(new Error('No content returned from Gemini stream'));
                return;
              }

              resolve(cleaned);
            } catch (err) {
              reject(err);
            }
          });

          response.data.on('error', (err) => reject(err));
        });

      } catch (error) {
        handleTranslationError(error, 'Gemini', { skipResponseData: true });
      }
    });
  }

  cleanTranslatedSubtitle(text) {
    let cleaned = text.replace(/```srt\n?/g, '').replace(/```\n?/g, '');
    cleaned = cleaned.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    cleaned = cleaned.trim();
    return cleaned;
  }

  estimateTokenCount(text) {
    if (!text) return 0;
    const approx = Math.ceil(text.length / 3);
    return Math.ceil(approx * 1.1);
  }

  recoverStreamPayload(rawStream) {
    const result = {
      text: '',
      finishReason: null,
      blockReason: null,
      safetyRatings: null,
      payloadCount: 0
    };

    if (!rawStream || typeof rawStream !== 'string') {
      return result;
    }

    const processPayload = (payloadStr) => {
      if (!payloadStr) return;
      let data;
      try {
        data = JSON.parse(payloadStr);
      } catch (_) {
        return;
      }

      if (data.usageMetadata) {
        if (!processPayload.streamId) processPayload.streamId = 'recv_' + Date.now() + Math.random();
        this.updateUsageStats(data.usageMetadata, processPayload.streamId);
      }

      const candidate = data?.candidates?.[0];
      if (data?.promptFeedback?.blockReason) {
        result.blockReason = result.blockReason || data.promptFeedback.blockReason;
      }
      if (Array.isArray(data?.promptFeedback?.safetyRatings) && data.promptFeedback.safetyRatings.length > 0) {
        result.safetyRatings = result.safetyRatings || data.promptFeedback.safetyRatings;
      }
      if (candidate) {
        if (candidate.finishReason && !result.finishReason) {
          result.finishReason = candidate.finishReason;
        }
        if (Array.isArray(candidate.safetyRatings) && candidate.safetyRatings.length > 0 && !result.safetyRatings) {
          result.safetyRatings = candidate.safetyRatings;
        }
        const parts = candidate?.content?.parts || [];
        const chunkText = parts.map(p => (p && typeof p.text === 'string') ? p.text : '').join('');
        if (chunkText) {
          result.text += chunkText;
        }
      }

      result.payloadCount += 1;
    };

    const blocks = rawStream.split(/\r?\n\r?\n/);
    for (const block of blocks) {
      const cleaned = block.split(/\r?\n/).map(line => line.replace(/^data:\s*/, '').trim()).filter(Boolean).join('');
      processPayload(cleaned);
    }

    if (result.payloadCount === 0) {
      const lines = rawStream.split(/\r?\n/);
      for (const line of lines) {
        const cleaned = line.replace(/^data:\s*/, '').trim();
        processPayload(cleaned);
      }
    }

    if (result.payloadCount === 0 && rawStream.includes('}{')) {
      const pieces = rawStream.split(/}\s*(?=\{)/).map((piece, idx, arr) => {
        if (idx < arr.length - 1) return piece + '}';
        return piece;
      });
      for (let i = 0; i < pieces.length; i++) {
        let segment = pieces[i];
        if (segment && segment[0] !== '{') segment = `{${segment}`;
        processPayload(segment.trim());
      }
    }

    return result;
  }
}

module.exports = GeminiService;
module.exports.DEFAULT_TRANSLATION_PROMPT = DEFAULT_TRANSLATION_PROMPT;
module.exports.__testing = {
  getGeminiErrorMessage,
  isGeminiAuthFailure
};
