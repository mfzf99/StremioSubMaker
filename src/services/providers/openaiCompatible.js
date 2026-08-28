const axios = require('axios');
const { handleTranslationError, logApiError } = require('../../utils/apiErrorHandler');
const { httpAgent, httpsAgent } = require('../../utils/httpAgents');
const log = require('../../utils/logger');
const { sanitizeApiKeyForHeader } = require('../../utils/security');
const { DEFAULT_TRANSLATION_PROMPT } = require('../gemini');
const {
  findISO6391ByName,
  getLanguageName,
  toISO6391,
  toISO6392
} = require('../../utils/languages');
const { resolveLanguageDisplayName } = require('../../utils/languageResolver');
const { normalizeTargetLanguageForPrompt } = require('../utils/normalizeTargetLanguageForPrompt');
const {
  getProviderAuthFailureCacheKey,
  hasCachedProviderAuthFailure,
  cacheProviderAuthFailure,
  clearCachedProviderAuthFailure
} = require('../../utils/providerAuthFailureCache');

/**
 * Universal OpenAI-Compatible Provider Wrapper
 * Calibrated 1:1 with Gemini translation architecture.
 * Supports OpenAI, DeepSeek, Kimi, GLM, MiniMax, Claude, and Proxy Gateways.
 */
class OpenAICompatibleProvider {
  constructor(options = {}) {
    this.apiKey = options.apiKey || '';
    this.model = options.model || '';
    this.baseUrl = (options.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
    this.providerName = options.providerName || 'custom';
    this.authFailureCacheKey = getProviderAuthFailureCacheKey(this.providerName, this.apiKey);
    this.headers = options.headers || {};
    this.temperature = options.temperature !== undefined ? options.temperature : 0.2;
    this.maxOutputTokens = options.maxOutputTokens || 65536;
    this.topP = options.topP !== undefined ? options.topP : 0.95;
    this.reasoningEffort = this.normalizeReasoningEffort(options.reasoningEffort);
    const timeoutSeconds = options.translationTimeout !== undefined ? options.translationTimeout : 120;
    this.translationTimeout = Math.max(5000, parseInt(timeoutSeconds * 1000, 10) || 120000);
    this.maxRetries = Number.isFinite(parseInt(options.maxRetries, 10))
      ? Math.max(0, parseInt(options.maxRetries, 10))
      : 2;
    this.enableJsonOutput = options.enableJsonOutput === true;
    this._ssrfLookup = options.ssrfLookup || null;
    if (this._ssrfLookup) {
      const http = require('http');
      const https = require('https');
      this._ssrfHttpAgent = new http.Agent({ keepAlive: true, lookup: this._ssrfLookup });
      this._ssrfHttpsAgent = new https.Agent({ keepAlive: true, lookup: this._ssrfLookup });
    }
  }

  normalizeReasoningEffort(value) {
    const allowed = ['disabled', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return allowed.includes(normalized) ? normalized : undefined;
  }

  getHttpAgents() {
    if (this._ssrfLookup) {
      return { httpAgent: this._ssrfHttpAgent, httpsAgent: this._ssrfHttpsAgent };
    }
    return { httpAgent, httpsAgent };
  }

  isCfTranslationModel() {
    const model = String(this.model || '').toLowerCase();
    return (
      model.includes('m2m100') ||
      model.includes('nllb-200')
    );
  }

  normalizeCfModelId() {
    const raw = String(this.model || '').trim();
    const lower = raw.toLowerCase();
    if (lower.startsWith('@cf/')) return raw;
    if (lower.startsWith('meta/')) return `@cf/${raw}`;
    return `@cf/meta/${raw}`;
  }

  normalizeTargetName(name) {
    const raw = String(name || '').trim();
    if (!raw) return 'target language';

    const code = this.normalizeLanguageCode(raw);
    const variantDisplay = this.variantNameFromCode(code);
    if (variantDisplay) return normalizeTargetLanguageForPrompt(variantDisplay);

    const displayFromUi = resolveLanguageDisplayName(code) || resolveLanguageDisplayName(raw);
    if (displayFromUi) {
      return normalizeTargetLanguageForPrompt(this.normalizeVariantDisplayName(displayFromUi));
    }

    const nameFromCode = getLanguageName(code) || getLanguageName(code.replace(/-/g, ''));
    if (nameFromCode) {
      return normalizeTargetLanguageForPrompt(this.normalizeVariantDisplayName(nameFromCode));
    }

    if (/^[a-z]{2}$/i.test(code)) {
      const iso2 = toISO6392(code);
      if (Array.isArray(iso2) && iso2.length > 0) {
        const display = getLanguageName(iso2[0].code2);
        if (display) {
          return normalizeTargetLanguageForPrompt(this.normalizeVariantDisplayName(display));
        }
      }
    }

    return normalizeTargetLanguageForPrompt(this.normalizeVariantDisplayName(raw) || raw);
  }

  normalizeVariantDisplayName(name) {
    const n = String(name || '').trim();
    if (!n) return '';
    const rules = [
      [/^brazilian portuguese$/i, 'Portuguese (Brazilian)'],
      [/^portuguese\s*\(brazil(ian)?\)$/i, 'Portuguese (Brazilian)'],
      [/^portuguese\s*\(portugal\)$/i, 'Portuguese (Portugal)'],
      [/^european portuguese$/i, 'Portuguese (Portugal)'],
      [/^portuguese$/i, 'Portuguese (Portugal)'],
      [/^spanish\s*\(latin america\)$/i, 'Spanish (Latin America)'],
      [/^latin american spanish$/i, 'Spanish (Latin America)'],
      [/^spanish$/i, 'Spanish (Spain)'],
      [/^chinese\s*\(traditional\)$/i, 'Chinese (Traditional)'],
      [/^chinese\s*\(simplified\)$/i, 'Chinese (Simplified)'],
      [/^chinese$/i, 'Chinese (Simplified)']
    ];
    for (const [re, out] of rules) {
      if (re.test(n)) return out;
    }
    return n;
  }

  variantNameFromCode(code) {
    const normalized = String(code || '').toLowerCase();
    switch (normalized) {
      case 'pt-br':
        return 'Portuguese (Brazilian)';
      case 'pt-pt':
        return 'Portuguese (Portugal)';
      case 'es-419':
        return 'Spanish (Latin America)';
      case 'zh-hant':
        return 'Chinese (Traditional)';
      case 'zh-hans':
        return 'Chinese (Simplified)';
      default:
        return null;
    }
  }

  normalizeCfLanguage(code) {
    const normalized = this.normalizeLanguageCode(code);
    if (!normalized || normalized === 'detected' || normalized === 'auto') return '';
    const base = normalized.split('-')[0];
    return base || normalized;
  }

  buildCfTranslationRequest(subtitleContent, sourceLanguage, targetLanguage) {
    const modelId = this.normalizeCfModelId();
    const url = `${this.baseUrl.replace(/\/v1$/, '')}/run/${modelId}`;
    const targetLang = this.normalizeCfLanguage(targetLanguage) || 'en';
    const sourceLang = this.normalizeCfLanguage(sourceLanguage);

    const body = {
      text: subtitleContent || '',
      target_lang: targetLang
    };

    if (sourceLang) body.source_lang = sourceLang;
    if (this.temperature !== undefined) body.temperature = this.temperature;
    if (this.topP !== undefined) body.top_p = this.topP;
    if (this.maxOutputTokens) body.max_tokens = this.maxOutputTokens;

    return { body, url };
  }

  buildChatRequest(userPrompt, stream = false, meta = {}) {
    const disableStructuredOutput = meta?.disableStructuredOutput === true;
    const isCfRun = this.isCfWorkersRunModel();
    const isCfTranslation = isCfRun && this.isCfTranslationModel();
    const isOpenAI = this.providerName === 'openai';
    const useResponsesApi = this.shouldUseOpenAIResponsesApi();

    if (isCfTranslation) {
      const { body, url } = this.buildCfTranslationRequest(
        meta.subtitleContent,
        meta.sourceLanguage,
        meta.targetLanguage
      );
      return { body, url, isCfRun: true, isCfTranslation: true };
    }

    const cappedMaxTokens = this.getCappedMaxOutputTokens();
    const isReasoning = this.isOpenAIReasoningModel();
    const openAIInstructionRole = (isOpenAI && isReasoning) ? 'developer' : 'system';

    const messages = [
      {
        role: openAIInstructionRole,
        content: 'You are an expert subtitle translation engine. Execute the translation strictly following all output constraints, XML tags, and rules.'
      },
      {
        role: 'user',
        content: userPrompt
      }
    ];

    const body = isCfRun
      ? { prompt: userPrompt, stream }
      : (isOpenAI && useResponsesApi)
        ? {
          model: this.model,
          instructions: messages[0].content,
          input: userPrompt,
          max_output_tokens: cappedMaxTokens,
          stream
        }
        : {
          model: this.model,
          messages,
          max_completion_tokens: (isOpenAI && isReasoning) ? cappedMaxTokens : undefined,
          max_tokens: (isOpenAI && isReasoning) ? undefined : cappedMaxTokens,
          stream
        };

    // Kawalan Mod Pemikiran (DeepSeek / OpenAI Reasoning / Gateway)
    if (!isCfRun) {
      const effort = this.reasoningEffort;
      if (effort === 'disabled' || effort === 'none' || effort === 'off') {
        body.thinking = { type: 'disabled' };
        if (isOpenAI) {
          if (useResponsesApi) body.reasoning = { effort: 'none' };
          else body.reasoning_effort = 'none';
        }
      } else if (effort) {
        body.thinking = { type: 'enabled' };
        const mappedEffort = (effort === 'minimal' || effort === 'low') ? 'low' : (effort === 'max' ? 'max' : 'high');
        body.reasoning_effort = mappedEffort;
        if (useResponsesApi) {
          body.reasoning = { effort: mappedEffort };
        }
      }
    }

    if (!isCfRun && this.enableJsonOutput && !disableStructuredOutput) {
      if (this.providerName === 'deepseek') {
        body.response_format = { type: 'json_object' };
      } else if (isOpenAI && useResponsesApi) {
        body.text = { format: this.buildResponsesJsonSchemaFormat() };
      } else {
        body.response_format = this.buildChatJsonSchemaResponseFormat();
      }
    }

    if (isCfRun) {
      if (this.temperature !== undefined) body.temperature = this.temperature;
      if (this.topP !== undefined) body.top_p = this.topP;
      if (this.maxOutputTokens) body.max_tokens = cappedMaxTokens;
    } else {
      const omitSampling = this.shouldOmitOpenAISamplingParams();
      if (!omitSampling && this.temperature !== undefined && !useResponsesApi) {
        body.temperature = this.temperature;
      }
      if (!omitSampling && this.topP !== undefined) {
        body.top_p = this.topP;
      }
    }

    const url = isCfRun
      ? `${this.baseUrl.replace(/\/v1$/, '')}/run/${this.model}`
      : (isOpenAI && useResponsesApi)
        ? `${this.baseUrl}/responses`
        : `${this.baseUrl}/chat/completions`;

    return { body, url, isCfRun, isCfTranslation: false, useResponsesApi };
  }

  shouldUseOpenAIResponsesApi() {
    if (this.providerName !== 'openai') return false;
    const model = String(this.model || '').trim().toLowerCase();
    return /^gpt-5(?:\.\d+)?-pro(?:$|-)/.test(model);
  }

  shouldOmitOpenAISamplingParams() {
    if (this.providerName !== 'openai') return false;
    const model = String(this.model || '').trim().toLowerCase();
    return /^gpt-5(?:[\.-]|$)/.test(model);
  }

  isOpenAIReasoningModel(modelName = this.model) {
    const model = String(modelName || '').trim().toLowerCase();
    return (
      model.includes('reasoner') ||
      model.includes('thinking') ||
      model.startsWith('o1') ||
      model.startsWith('o3') ||
      model.includes('k3') ||
      /^gpt-5(?:[\.-]|$)/.test(model)
    );
  }

  buildSubtitleEntriesJsonSchema() {
    const entrySchema = {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        text: { type: 'string' }
      },
      required: ['id', 'text'],
      additionalProperties: false
    };

    return {
      type: 'object',
      properties: {
        entries: {
          type: 'array',
          items: entrySchema
        }
      },
      required: ['entries'],
      additionalProperties: false
    };
  }

  buildChatJsonSchemaResponseFormat() {
    return {
      type: 'json_schema',
      json_schema: {
        name: 'subtitle_entries',
        strict: true,
        schema: this.buildSubtitleEntriesJsonSchema()
      }
    };
  }

  buildResponsesJsonSchemaFormat() {
    return {
      type: 'json_schema',
      name: 'subtitle_entries',
      strict: true,
      schema: this.buildSubtitleEntriesJsonSchema()
    };
  }

  getCappedMaxOutputTokens() {
    const raw = Number.isFinite(Number(this.maxOutputTokens))
      ? Number(this.maxOutputTokens)
      : 65536;
    const model = String(this.model || '').toLowerCase();

    // 🎯 Auto-Detect: Model generasi terkini / reasoning sentiasa mendapat siling 65,536+
    if (
      model.includes('deepseek') ||
      model.includes('kimi') ||
      model.includes('glm') ||
      model.includes('claude') ||
      model.includes('gpt-5') ||
      model.includes('o1') ||
      model.includes('o3') ||
      model.includes('thinking') ||
      model.includes('reasoner') ||
      model.includes('minimax')
    ) {
      return Math.max(raw, 65536);
    }

    return Math.max(1024, Math.min(Math.floor(raw), 131072));
  }

  buildUserPrompt(subtitleContent, targetLanguage, customPrompt = null) {
    const normalizedTarget = this.normalizeTargetName(targetLanguage);
    let systemPrompt = (customPrompt || DEFAULT_TRANSLATION_PROMPT).replace('{target_language}', normalizedTarget);

    // 1:1 Parity dengan Gemini — Suntik protokol pintasan pemikiran untuk mempercepatkan proses
    const universalReasoningChain = '\n\n[CRITICAL REASONING PROTOCOL]\n1. ANTI-ECHO: NEVER copy or repeat the original source text into your internal reasoning scratchpad.\n2. ANTI-CHECKLIST: XML syntax (<s id="N">) is a strict mechanical rule. Execute it automatically. DO NOT waste thought tokens writing validation checks for IDs or tags.\n3. ZERO-THOUGHT BYPASS (CRITICAL): For 95% of standard dialogue, literal translations, overlapping speech (-), sound/music tags (e.g., [sighs], ♪), song lyrics, and sentence fragments — bypass reasoning ENTIRELY. Output the XML immediately.\n4. SELECTIVE REASONING: ONLY activate reasoning for highly complex idioms or untranslatable slang. Resolve conceptually then output XML immediately.\n';

    if (systemPrompt.includes('<input>')) {
      systemPrompt = systemPrompt.replace('<input>', universalReasoningChain + '\n<input>');
    } else {
      systemPrompt = systemPrompt + universalReasoningChain;
    }

    let userPrompt;
    let isSelfContained = false;

    if (
      systemPrompt.includes('<input>') ||
      systemPrompt.includes('INPUT (') ||
      systemPrompt.includes('=== ENTRIES TO TRANSLATE ===') ||
      systemPrompt.includes('entries_to_translate')
    ) {
      userPrompt = systemPrompt;
      isSelfContained = true;
    } else {
      userPrompt = `Content to translate:\n\n${subtitleContent}`;
    }

    return { userPrompt, systemPrompt, normalizedTarget, subtitleContent, isSelfContained };
  }

  estimateTokenCount(text) {
    if (!text) return 0;
    const str = String(text);
    try {
      const { countTokens } = require('gpt-tokenizer');
      return countTokens(str);
    } catch (_) {
      const approx = Math.ceil(str.length / 3);
      return Math.ceil(approx * 1.1);
    }
  }

  getAuthHeaders() {
    const sanitizedKey = sanitizeApiKeyForHeader(this.apiKey) || '';
    if (!sanitizedKey) {
      return { ...this.headers };
    }
    return {
      Authorization: `Bearer ${sanitizedKey}`,
      'x-api-key': sanitizedKey,
      ...this.headers
    };
  }

  isCfWorkersRunModel() {
    return this.providerName === 'cfWorkers';
  }

  shouldUseAuthFailureCache() {
    return this.providerName !== 'custom' && !!this.authFailureCacheKey;
  }

  isAuthFailure(error) {
    const status = error?.response?.status || error?.statusCode || error?.status;
    return status === 401 || status === 403;
  }

  normalizeLanguageCode(code) {
    const raw = String(code || '').trim();
    if (!raw) return 'en';

    const fromName = findISO6391ByName(raw);
    if (fromName) return this.normalizeLanguageCode(fromName);

    let cleaned = raw.toLowerCase().replace(/[\s_]/g, '-');
    const variantMap = {
      'pob': 'pt-br',
      'ptbr': 'pt-br',
      'pt-br': 'pt-br',
      'ptbrazil': 'pt-br',
      'pt-brazil': 'pt-br',
      'pt-pt': 'pt-pt',
      'pt_portugal': 'pt-pt',
      'spn': 'es-419',
      'es-419': 'es-419',
      'es_la': 'es-419',
      'es-la': 'es-419',
      'es-latam': 'es-419',
      'zht': 'zh-hant',
      'zh-hant': 'zh-hant',
      'zh-tw': 'zh-hant',
      'zhs': 'zh-hans',
      'zh-hans': 'zh-hans',
      'zh-cn': 'zh-hans'
    };
    if (variantMap[cleaned]) return variantMap[cleaned];

    cleaned = cleaned.replace(/-tr$/, '');
    if (/^[a-z]{3}$/.test(cleaned)) {
      const iso1 = toISO6391(cleaned);
      if (iso1) cleaned = iso1.toLowerCase();
    }

    cleaned = cleaned.replace(/[^a-z-]/g, '');
    if (/^[a-z]{2}(-[a-z0-9]{2,})?$/.test(cleaned)) return cleaned;
    if (/^[a-z]{2}$/.test(cleaned)) return cleaned;

    return cleaned.slice(0, 2) || 'en';
  }

  async getAvailableModels() {
    if (this.shouldUseAuthFailureCache() && await hasCachedProviderAuthFailure(this.authFailureCacheKey)) {
      log.warn(() => `[${this.providerName}] Fetch models blocked: cached invalid API key detected`);
      return [];
    }

    try {
      const isCfWorkers = this.providerName === 'cfWorkers';
      const baseModelsUrl = isCfWorkers
        ? `${this.baseUrl.replace(/\/v1$/, '')}/models`
        : `${this.baseUrl}/models`;

      const agents = this.getHttpAgents();
      const requestConfig = {
        headers: this.getAuthHeaders(),
        timeout: 10000,
        httpAgent: agents.httpAgent,
        httpsAgent: agents.httpsAgent
      };

      let response;
      if (isCfWorkers) {
        const searchUrl = `${this.baseUrl.replace(/\/v1$/, '')}/models/search`;
        try {
          response = await axios.get(searchUrl, requestConfig);
        } catch (_) {
          response = await axios.get(baseModelsUrl, requestConfig);
        }
      } else {
        response = await axios.get(baseModelsUrl, requestConfig);
      }

      const data = response.data || {};
      const modelsRaw = Array.isArray(data?.data)
        ? data.data
        : Array.isArray(data?.models)
          ? data.models
          : Array.isArray(data?.result)
            ? data.result
            : (Array.isArray(data?.result?.models) ? data.result.models : undefined);

      const models = Array.isArray(modelsRaw)
        ? modelsRaw.map(m => {
          const isCf = this.providerName === 'cfWorkers';
          const name = isCf
            ? (m.name || m.slug || m.id || m.model)
            : (m.id || m.name || m.model);
          const displayName = m.display_name
            || m.displayName
            || m.name
            || m.slug
            || m.id
            || m.model;
          return {
            name,
            displayName,
            description: m.description || '',
            maxTokens: m.max_tokens || m.maxTokens || undefined
          };
        }).filter(m => !!m.name)
        : [];

      if (this.shouldUseAuthFailureCache()) {
        await clearCachedProviderAuthFailure(this.authFailureCacheKey);
      }
      return models;
    } catch (error) {
      if (this.shouldUseAuthFailureCache() && this.isAuthFailure(error)) {
        await cacheProviderAuthFailure(this.authFailureCacheKey);
      }
      logApiError(error, this.providerName, 'Fetch models', { skipResponseData: true });
      return [];
    }
  }

  isStructuredOutputUnsupportedError(error) {
    if (!error) return false;
    const status = error?.response?.status || error?.status || error?.statusCode || 0;
    const msg = String(
      error?.response?.data?.error?.message ||
      error?.response?.data?.message ||
      error?.message ||
      ''
    ).toLowerCase();
    const requestIssue = status === 400 || status === 404 || status === 405 || status === 415 || status === 422 || status === 501;
    const mentionsStructuredMode =
      msg.includes('response_format') ||
      msg.includes('json_schema') ||
      msg.includes('json_object') ||
      msg.includes('unknown parameter') ||
      msg.includes('unsupported') ||
      msg.includes('does not support');
    return requestIssue && mentionsStructuredMode;
  }

  async translateSubtitle(subtitleContent, sourceLanguage, targetLanguage, customPrompt = null, requestOptions = {}) {
    const promptData = this.buildUserPrompt(subtitleContent, targetLanguage, customPrompt);

    let lastError;
    let disableStructuredOutput = requestOptions?.disableStructuredOutput === true;
    let structuredDowngradeUsed = disableStructuredOutput;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const { body, url, isCfRun, useResponsesApi } = this.buildChatRequest(
          promptData.userPrompt,
          false,
          {
            subtitleContent,
            sourceLanguage,
            targetLanguage,
            systemPrompt: promptData.systemPrompt,
            isSelfContained: promptData.isSelfContained,
            disableStructuredOutput
          }
        );

        const agents = this.getHttpAgents();
        const response = await axios.post(
          url,
          body,
          {
            headers: this.getAuthHeaders(),
            timeout: this.translationTimeout,
            httpAgent: agents.httpAgent,
            httpsAgent: agents.httpsAgent
          }
        );

        let text;
        if (isCfRun) {
          text =
            response.data?.result?.translated_text ||
            response.data?.result?.output ||
            response.data?.result?.response ||
            response.data?.result;
        } else if (useResponsesApi) {
          text = this.extractResponsesText(response.data);
        } else {
          text = response.data?.choices?.[0]?.message?.content;
        }

        if (!text) {
          throw new Error('No translation returned from API');
        }

        return this.cleanTranslatedSubtitle(text);
      } catch (error) {
        lastError = error;
        if (
          this.enableJsonOutput &&
          !disableStructuredOutput &&
          !structuredDowngradeUsed &&
          this.isStructuredOutputUnsupportedError(error)
        ) {
          structuredDowngradeUsed = true;
          disableStructuredOutput = true;
          log.warn(() => [`[${this.providerName}] Structured output not supported by this model, retrying without response_format`]);
          continue;
        }
        if (attempt < this.maxRetries) {
          log.warn(() => [`[${this.providerName}] Retry ${attempt + 1}/${this.maxRetries} after error:`, error.message]);
          continue;
        }
        handleTranslationError(error, this.providerName, { skipResponseData: true });
      }
    }

    if (lastError) throw lastError;
  }

  async streamTranslateSubtitle(subtitleContent, sourceLanguage, targetLanguage, customPrompt = null, onPartial = null, requestOptions = {}) {
    const promptData = this.buildUserPrompt(subtitleContent, targetLanguage, customPrompt);
    const request = this.buildChatRequest(
      promptData.userPrompt,
      true,
      {
        subtitleContent,
        sourceLanguage,
        targetLanguage,
        systemPrompt: promptData.systemPrompt,
        isSelfContained: promptData.isSelfContained,
        disableStructuredOutput: requestOptions?.disableStructuredOutput === true
      }
    );

    if (request.isCfTranslation || request.useResponsesApi) {
      const full = await this.translateSubtitle(subtitleContent, sourceLanguage, targetLanguage, customPrompt, requestOptions);
      if (typeof onPartial === 'function') {
        try { await onPartial(full); } catch (_) { }
      }
      return full;
    }

    const { body, url, isCfRun } = request;

    const executeStream = async () => {
      const agents = this.getHttpAgents();
      const response = await axios.post(
        url,
        body,
        {
          headers: this.getAuthHeaders(),
          timeout: this.translationTimeout,
          httpAgent: agents.httpAgent,
          httpsAgent: agents.httpsAgent,
          responseType: 'stream'
        }
      );

      return await new Promise((resolve, reject) => {
        let buffer = '';
        let aggregated = '';
        let finishReason = null;
        let rawStream = '';

        const processPayload = (payloadStr) => {
          if (!payloadStr || !payloadStr.trim()) return;
          const cleaned = payloadStr.trim().startsWith('data:')
            ? payloadStr.trim().slice(5).trim()
            : payloadStr.trim();
          if (!cleaned || cleaned === '[DONE]') return;

          let data;
          try {
            data = JSON.parse(cleaned);
          } catch (_) {
            return;
          }

          if (isCfRun && (data.finished || data.done === true)) {
            finishReason = finishReason || 'stop';
          }

          const choice = data?.choices?.[0];
          if (choice?.finish_reason) {
            finishReason = choice.finish_reason;
          }

          const chunkText = isCfRun
            ? this.extractCfChunkText(data)
            : this.extractChunkText(choice);

          if (chunkText) {
            aggregated += chunkText;
            const cleanedAgg = this.cleanTranslatedSubtitle(aggregated);
            if (cleanedAgg && typeof onPartial === 'function') {
              try { onPartial(cleanedAgg); } catch (_) { }
            }
          }
        };

        response.data.on('data', (chunk) => {
          try {
            const str = chunk.toString('utf8');
            rawStream += str;
            buffer += str;
            const parts = buffer.split(/\r?\n/);
            buffer = parts.pop();
            parts.forEach(processPayload);
          } catch (err) {
            log.warn(() => [`[${this.providerName}] Stream chunk processing failed:`, err.message]);
          }
        });

        response.data.on('end', () => {
          try {
            if (buffer && buffer.trim()) {
              processPayload(buffer);
            }

            if (!aggregated && rawStream.trim()) {
              const recovered = this.recoverStreamPayload(rawStream, isCfRun);
              aggregated = recovered.text || aggregated;
              finishReason = finishReason || recovered.finishReason;
            }

            const cleaned = this.cleanTranslatedSubtitle(aggregated);

            if (!cleaned) {
              if (finishReason === 'content_filter') {
                const err = new Error('PROHIBITED_CONTENT: content_filter');
                err.translationErrorType = 'PROHIBITED_CONTENT';
                reject(err);
                return;
              }
              reject(new Error('No content returned from stream'));
              return;
            }

            resolve(cleaned);
          } catch (err) {
            reject(err);
          }
        });

        response.data.on('error', (err) => reject(err));
      });
    };

    let lastError;
    let fallbackUsed = false;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await executeStream();
      } catch (error) {
        lastError = error;

        const status = error?.response?.status;
        const rawErr = String(
          error?.response?.data?.error?.message ||
          error?.response?.data?.message ||
          error?.message ||
          ''
        ).toLowerCase();

        const looksUnsupported = status === 404 || status === 405 || status === 501
          || (status === 400 && (rawErr.includes('stream') || rawErr.includes('sse') || rawErr.includes('event-stream')))
          || (error.message && /stream/i.test(error.message));

        if (!fallbackUsed && looksUnsupported) {
          fallbackUsed = true;
          log.warn(() => [`[${this.providerName}] Streaming not supported, falling back to non-stream`]);
          const full = await this.translateSubtitle(subtitleContent, sourceLanguage, targetLanguage, customPrompt, requestOptions);
          if (typeof onPartial === 'function') {
            try { await onPartial(full); } catch (_) { }
          }
          return full;
        }

        if (attempt < this.maxRetries) {
          log.warn(() => [`[${this.providerName}] Stream retry ${attempt + 1}/${this.maxRetries} after error:`, error.message]);
          continue;
        }
        handleTranslationError(error, this.providerName, { skipResponseData: true });
      }
    }

    if (lastError) throw lastError;
  }

  async countTokensForTranslation() {
    return null;
  }

  extractChunkText(choice) {
    if (!choice) return '';
    const delta = choice.delta || {};
    if (typeof delta.content === 'string') return delta.content;
    if (typeof delta.text === 'string') return delta.text;
    if (choice.message?.content && typeof choice.message.content === 'string') {
      return choice.message.content;
    }
    return '';
  }

  extractCfChunkText(payload) {
    if (!payload || typeof payload !== 'object') return '';
    if (typeof payload.response === 'string') return payload.response;
    if (payload.result) {
      if (typeof payload.result.response === 'string') return payload.result.response;
      if (typeof payload.result.output === 'string') return payload.result.output;
    }
    return '';
  }

  cleanTranslatedSubtitle(text) {
    let cleaned = String(text || '');
    cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '');
    cleaned = cleaned.replace(/<think>[\s\S]*$/gi, '');
    cleaned = cleaned.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '');
    cleaned = cleaned.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    return cleaned.trim();
  }

  extractResponsesText(payload) {
    if (!payload || typeof payload !== 'object') return '';
    const direct = payload.output_text;
    if (typeof direct === 'string' && direct.trim()) return direct;

    const output = Array.isArray(payload.output) ? payload.output : [];
    const collect = [];
    for (const item of output) {
      if (!item || !Array.isArray(item.content)) continue;
      for (const part of item.content) {
        if (!part) continue;
        if (typeof part === 'string') collect.push(part);
        else if (typeof part.text === 'string') collect.push(part.text);
        else if (typeof part.output_text === 'string') collect.push(part.output_text);
      }
    }
    return collect.join('');
  }

  recoverStreamPayload(rawStream, isCfRun = false) {
    const result = { text: '', finishReason: null, payloadCount: 0 };
    if (!rawStream || typeof rawStream !== 'string') return result;

    const processPayload = (payloadStr) => {
      if (!payloadStr) return;
      let data;
      try { data = JSON.parse(payloadStr); } catch (_) { return; }

      if (isCfRun) {
        const chunkText = this.extractCfChunkText(data);
        if (chunkText) result.text += chunkText;
        result.payloadCount += 1;
        return;
      }

      const choice = data?.choices?.[0];
      if (choice?.finish_reason && !result.finishReason) {
        result.finishReason = choice.finish_reason;
      }
      const chunkText = this.extractChunkText(choice);
      if (chunkText) result.text += chunkText;
      result.payloadCount += 1;
    };

    const blocks = rawStream.split(/\r?\n\r?\n/);
    for (const block of blocks) {
      const cleaned = block.split(/\r?\n/).map(line => line.replace(/^data:\s*/, '').trim()).filter(Boolean).join('');
      processPayload(cleaned);
    }

    return result;
  }
}

module.exports = OpenAICompatibleProvider;
