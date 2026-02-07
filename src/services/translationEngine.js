/**
 * Translation Engine - Unified Subtitle Translation
 *
 * Clean, simple, predictable translation workflow:
 * 1. Parse SRT into entries
 * 2. Translate in batches (real-time progress after each batch)
 * 3. Auto-chunk large batches transparently when needed
 * 4. Stream results entry-by-entry as they complete
 * 5. No time-based checkpoints - everything is event-driven
 *
 * Benefits:
 * - Single code path for all files (small/large)
 * - Perfect timing preservation
 * - Real-time progressive delivery
 * - Simple, predictable behavior
 * - Automatic optimization
 */

const { parseSRT, toSRT } = require('../utils/subtitle');
const GeminiService = require('./gemini');
const { DEFAULT_TRANSLATION_PROMPT } = GeminiService;
const crypto = require('crypto');
const log = require('../utils/logger');
const { normalizeTargetLanguageForPrompt } = require('./utils/normalizeTargetLanguageForPrompt');

// Extract normalized tokens from a language label/code (split on common separators)
function tokenizeLanguageValue(value) {
  return String(value || '')
    .normalize('NFKD') // strip accents/diacritics for safer comparisons
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9+]+/g)
    .filter(Boolean);
}

// RTL language detection (codes and human-readable names)
function isRtlLanguage(lang) {
  const tokens = tokenizeLanguageValue(lang);
  if (tokens.length === 0) return false;

  const rtlTokens = new Set([
    'ar', 'ara', 'arabic',
    'he', 'heb', 'hebrew',
    'fa', 'fas', 'per', 'persian', 'farsi',
    'ur', 'urd', 'urdu',
    'ps', 'pus', 'pushto', 'pashto',
    'ku', 'ckb', 'kur', 'kurdish', 'sorani',
    'dv', 'div', 'dhivehi',
    'yi', 'yid', 'yiddish'
  ]);

  // Match against individual tokens only (prevents false positives like "Turkish" matching "ur")
  return tokens.some(token => {
    // Avoid false positives like "Sichuan Yi" (Yi is LTR; Yiddish uses the same ISO-639-1 code)
    if (token === 'yi') {
      return tokens.length === 1 || tokens.includes('yid') || tokens.includes('yiddish');
    }
    return rtlTokens.has(token);
  });
}

function wrapRtlText(text) {
  const str = String(text || '');
  // Skip if already contains bidi markers
  if (/(?:\u200e|\u200f|\u202a|\u202b|\u202c|\u202d|\u202e)/u.test(str)) {
    return str;
  }
  const start = '\u202B'; // RLE - start RTL embedding
  const end = '\u202C';   // PDF - pop directional formatting
  return str
    .split('\n')
    .map(line => (line ? `${start}${line}${end}` : line))
    .join('\n');
}

// Entry-level cache for translated subtitle entries
const entryCache = new Map();
const MAX_ENTRY_CACHE_SIZE = parseInt(process.env.ENTRY_CACHE_SIZE) || 100000;

// Configuration constants
const MAX_TOKENS_PER_BATCH = parseInt(process.env.MAX_TOKENS_PER_BATCH) || 25000; // Max tokens before auto-chunking
const SINGLE_BATCH_MAX_TOKENS_PER_CHUNK = parseInt(process.env.SINGLE_BATCH_MAX_TOKENS_PER_CHUNK) || 120000;
const SINGLE_BATCH_TOKEN_SOFT_LIMIT = Math.floor(SINGLE_BATCH_MAX_TOKENS_PER_CHUNK * 0.9);
// Entry cache disabled by default - causes stale data on cache resets and not HA-aware
// Only useful for repeated translations with identical config (rare)
const CACHE_TRANSLATIONS = process.env.CACHE_TRANSLATIONS === 'true'; // Enable/disable entry caching

/**
 * Get batch size for model (model-specific optimization)
 * Priority: Environment variable > Model-specific > Default (250)
 *
 * Model-specific batch sizes are hardcoded in backend and safe from client manipulation.
 * Different models have different processing speeds and capabilities:
 * - Flash models: 250 entries (faster, more capable)
 * - Flash-lite models: 200 entries (more conservative for stability)
 *
 * @param {string} model - Gemini model name
 * @returns {number} - Batch size for this model
 */
function getBatchSizeForModel(model) {
  // Environment variable override (highest priority)
  if (process.env.TRANSLATION_BATCH_SIZE) {
    return parseInt(process.env.TRANSLATION_BATCH_SIZE);
  }

  // Model-specific batch sizes (hardcoded, safe from client manipulation)
  const modelStr = String(model || '').toLowerCase();

  // Gemini 3.0 Flash: Large context window, higher batch size for throughput
  if (modelStr.includes('gemini-3-flash')) {
    return 400;
  }

  // Gemma models: Lower batch size for stability
  if (modelStr.includes('gemma')) {
    return 200;
  }

  // Flash-lite models: More conservative batch size for stability
  if (modelStr.includes('flash-lite')) {
    return 200;
  }

  // Flash models (non-lite): Larger batch size for better throughput
  if (modelStr.includes('flash')) {
    return 250;
  }

  // Default batch size for unknown models
  return 250;
}

class TranslationEngine {
  constructor(geminiService, model = null, advancedSettings = {}, options = {}) {
      this.gemini = geminiService?.primary || geminiService;
      this.fallbackProvider = geminiService?.fallback || null;
      this.providerName = options.providerName || 'gemini';
      this.fallbackProviderName = options.fallbackProviderName || (this.fallbackProvider ? 'fallback' : '');
      if (!this.fallbackProviderName && this.fallbackProvider?.providerName) {
        this.fallbackProviderName = this.fallbackProvider.providerName;
      }
      this.model = model;
      this.batchSize = getBatchSizeForModel(model);
      this.singleBatchMode = options.singleBatchMode === true;
      this.enableStreaming = options.enableStreaming !== false
        && typeof (this.gemini?.streamTranslateSubtitle) === 'function';
      this.maxTokensPerBatch = this.singleBatchMode ? SINGLE_BATCH_MAX_TOKENS_PER_CHUNK : MAX_TOKENS_PER_BATCH;
      this.advancedSettings = advancedSettings || {};

      // Context settings (disabled by default)
      this.enableBatchContext = this.advancedSettings.enableBatchContext === true;
      this.contextSize = parseInt(this.advancedSettings.contextSize) || 3;

      // Mismatch retry: number of retries when AI returns wrong entry count (default: 1)
      const rawMismatchRetries = parseInt(this.advancedSettings.mismatchRetries);
      this.mismatchRetries = Number.isFinite(rawMismatchRetries) ? Math.max(0, Math.min(3, rawMismatchRetries)) : 1;

      // Translation workflow mode: 'original' (numbered list), 'ai' (send timestamps), 'xml' (XML-tagged entries)
      const rawWorkflow = String(this.advancedSettings.translationWorkflow || '').toLowerCase();
      if (rawWorkflow === 'xml') {
        this.translationWorkflow = 'xml';
        this.sendTimestampsToAI = false;
      } else if (rawWorkflow === 'ai' || this.advancedSettings.sendTimestampsToAI === true) {
        this.translationWorkflow = 'ai';
        this.sendTimestampsToAI = true;
      } else {
        this.translationWorkflow = 'original';
        this.sendTimestampsToAI = false;
      }

      // JSON structured output mode (disabled by default, opt-in via config)
      this.enableJsonOutput = this.advancedSettings.enableJsonOutput === true;

      // Key rotation configuration for per-batch rotation
      // keyRotationConfig: { enabled: boolean, mode: 'per-request' | 'per-batch', keys: string[], advancedSettings: {} }
      // SECURITY: Store keys in a non-enumerable property to prevent accidental serialization
      if (options.keyRotationConfig && Array.isArray(options.keyRotationConfig.keys)) {
        const sanitizedConfig = {
          enabled: options.keyRotationConfig.enabled === true,
          mode: options.keyRotationConfig.mode || 'per-batch',
          advancedSettings: options.keyRotationConfig.advancedSettings || {}
        };
        // Make keys non-enumerable so they won't appear in JSON.stringify or Object.keys
        Object.defineProperty(sanitizedConfig, 'keys', {
          value: options.keyRotationConfig.keys,
          enumerable: false,
          writable: false,
          configurable: false
        });
        this.keyRotationConfig = sanitizedConfig;
      } else {
        this.keyRotationConfig = null;
      }
      this.perBatchRotationEnabled = this.keyRotationConfig?.enabled === true &&
        this.keyRotationConfig?.mode === 'per-batch' &&
        Array.isArray(this.keyRotationConfig?.keys) &&
        this.keyRotationConfig.keys.length > 1 &&
        this.providerName === 'gemini';

      if (this.perBatchRotationEnabled) {
        log.debug(() => `[TranslationEngine] Per-batch key rotation enabled with ${this.keyRotationConfig.keys.length} keys`);
      }

      // Non-LLM providers (DeepL, Google Translate) handle batching natively.
      // Skip numbered-list prompt construction and send raw SRT directly.
      const NON_LLM_PROVIDERS = new Set(['deepl', 'googletranslate']);
      this.isNativeBatchProvider = NON_LLM_PROVIDERS.has(this.providerName);

      log.debug(() => `[TranslationEngine] Initialized with model: ${model || 'unknown'}, batch size: ${this.batchSize}, batch context: ${this.enableBatchContext ? 'enabled' : 'disabled'}, workflow: ${this.translationWorkflow}, mode: ${this.singleBatchMode ? 'single-batch' : 'batched'}, mismatchRetries: ${this.mismatchRetries}, jsonOutput: ${this.enableJsonOutput}${this.perBatchRotationEnabled ? ', key-rotation: per-batch' : ''}${this.isNativeBatchProvider ? ', native-batch: true' : ''}`);
    }

  /**
   * Rotate to a new API key before translating a batch (when per-batch rotation is enabled)
   * Creates a fresh GeminiService instance with a sequentially selected key (round-robin)
   */
  maybeRotateKeyForBatch(batchIndex) {
    if (!this.perBatchRotationEnabled) return;

    const keys = this.keyRotationConfig.keys;
    // Sequential (round-robin) selection based on batch index
    const keyIndex = batchIndex % keys.length;
    const selectedKey = keys[keyIndex];

    // Create a new GeminiService with the rotated key
    this.gemini = new GeminiService(
      selectedKey,
      this.model,
      this.keyRotationConfig.advancedSettings || this.advancedSettings
    );

    log.debug(() => `[TranslationEngine] Rotated to key index ${keyIndex + 1}/${keys.length} for batch ${batchIndex + 1} (sequential)`);
  }

  /**
   * Main translation method - unified approach for all files
   * @param {string} srtContent - Original SRT content
   * @param {string} targetLanguage - Target language name
   * @param {string} customPrompt - Optional custom prompt
   * @param {Function} onProgress - Callback for real-time progress (entry-by-entry)
   * @returns {Promise<string>} - Translated SRT content
   */
  async translateSubtitle(srtContent, targetLanguage, customPrompt = null, onProgress = null) {
    // Track per-run RTL so all cleanups (including streaming) can apply markers consistently
    this.isRtlTarget = isRtlLanguage(targetLanguage);

    // Step 1: Parse SRT into structured entries
    const entries = parseSRT(srtContent);
    if (!entries || entries.length === 0) {
      throw new Error('Invalid SRT content: no valid entries found');
    }

    // Single-batch mode: translate the whole file (with limited auto-splitting)
    if (this.singleBatchMode) {
      return this.translateSubtitleSingleBatch(entries, targetLanguage, customPrompt, onProgress);
    }

    log.info(() => `[TranslationEngine] Starting translation: ${entries.length} entries, ${Math.ceil(entries.length / this.batchSize)} batches`);

    const streamingEnabled = this.enableStreaming && !this.singleBatchMode;
    let globalStreamSequence = 0;

    // Step 2: Create batches
    const batches = this.createBatches(entries, this.batchSize);

    // Step 3: Translate each batch with smart progress tracking
    const translatedEntries = [];
    // Streaming optimization: keep a pre-built SRT string for completed batches
    // so we only rebuild the current streaming batch on each progress callback.
    let completedSRT = '';
    let completedEntryCount = 0;

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      const batchStartId = batch[0]?.id || 1;
      const streamingBatchEntries = new Map();

      try {
        // Rotate API key for this batch if per-batch rotation is enabled
        this.maybeRotateKeyForBatch(batchIndex);

        // Prepare context for this batch (if enabled)
        const context = this.enableBatchContext
          ? this.prepareContextForBatch(batch, entries, translatedEntries, batchIndex)
          : null;

        // Translate batch (with auto-chunking if needed)
        const translatedBatch = await this.translateBatch(
          batch,
          targetLanguage,
          customPrompt,
          batchIndex,
          batches.length,
          context,
          {
            streaming: streamingEnabled,
            onStreamProgress: async (payload) => {
              if (typeof onProgress !== 'function' || !payload?.partialSRT) return;

              const parsed = parseSRT(payload.partialSRT) || [];
              const offset = (payload.batchStartId || batchStartId) - 1;
              for (const entry of parsed) {
                const globalId = (entry.id || 0) + offset;
                if (globalId <= 0) continue;
                streamingBatchEntries.set(globalId, {
                  id: globalId,
                  timecode: entry.timecode,
                  text: this.cleanTranslatedText(entry.text || '')
                });
              }

              // Only rebuild SRT for the current streaming batch entries,
              // then prepend the already-built completed SRT string.
              const streamEntries = Array.from(streamingBatchEntries.values()).sort((a, b) => a.id - b.id);
              const streamNormalized = streamEntries.map((entry, idx) => ({
                id: completedEntryCount + idx + 1,
                timecode: entry.timecode,
                text: entry.text
              }));
              const streamSRT = toSRT(streamNormalized);
              const partialSRT = completedSRT
                ? completedSRT + '\n\n' + streamSRT
                : streamSRT;

              const seq = ++globalStreamSequence;
              try {
                await onProgress({
                  totalEntries: entries.length,
                  completedEntries: Math.min(entries.length, completedEntryCount + streamingBatchEntries.size),
                  currentBatch: payload.currentBatch || (batchIndex + 1),
                  totalBatches: batches.length,
                  partialSRT,
                  streaming: true,
                  streamSequence: seq
                });
              } catch (err) {
                log.warn(() => ['[TranslationEngine] Streaming progress callback error (batched):', err.message]);
              }
            }
          }
        );

        // Merge translated text with original structure
        for (let i = 0; i < batch.length; i++) {
          const original = batch[i];
          const translated = translatedBatch[i] || {};

          // Clean translated text
          const cleanedText = this.cleanTranslatedText(translated.text || original.text);

          // Create entry with timing from AI when requested, otherwise preserve original timing
          const timecode = (this.sendTimestampsToAI && translated.timecode) ? translated.timecode : original.timecode;
          translatedEntries.push({
            id: original.id,
            timecode,
            text: cleanedText
          });
        }

        // Update the completed SRT snapshot for streaming optimization
        completedEntryCount = translatedEntries.length;
        completedSRT = toSRT(translatedEntries);

        // Progress callback after each batch
        if (typeof onProgress === 'function') {
          try {
            await onProgress({
              totalEntries: entries.length,
              completedEntries: translatedEntries.length,
              currentBatch: batchIndex + 1,
              totalBatches: batches.length,
              partialSRT: completedSRT
            });
          } catch (err) {
            log.warn(() => ['[TranslationEngine] Progress callback error:', err.message]);
          }
        }

        // Log progress only at milestones
        const progress = Math.floor((translatedEntries.length / entries.length) * 100);
        if (batchIndex === 0 || batchIndex === batches.length - 1 || progress % 25 === 0) {
          log.info(() => `[TranslationEngine] Progress: ${progress}% (${translatedEntries.length}/${entries.length} entries, batch ${batchIndex + 1}/${batches.length})`);
        }

      } catch (error) {
        // Only log if not already logged by upstream handler
        if (!error._alreadyLogged) {
          log.error(() => [`[TranslationEngine] Error in batch ${batchIndex + 1}:`, error.message]);
        }
        // Wrap error but preserve original error properties (translationErrorType, statusCode, etc.)
        const wrappedError = new Error(`Translation failed at batch ${batchIndex + 1}: ${error.message}`);
        // Copy all properties from original error to preserved type information
        if (error.translationErrorType) wrappedError.translationErrorType = error.translationErrorType;
        if (error.statusCode) wrappedError.statusCode = error.statusCode;
        if (error.type) wrappedError.type = error.type;
        if (error.isRetryable !== undefined) wrappedError.isRetryable = error.isRetryable;
        if (error.originalError) wrappedError.originalError = error.originalError;
        // Preserve the already-logged flag
        if (error._alreadyLogged) wrappedError._alreadyLogged = true;
        throw wrappedError;
      }
    }

    // Step 4: Final validation
    if (translatedEntries.length !== entries.length) {
      log.warn(() => `[TranslationEngine] Entry count mismatch: expected ${entries.length}, got ${translatedEntries.length}`);
    }

    log.info(() => `[TranslationEngine] Translation completed: ${translatedEntries.length} entries`);

    // Final safety: strip any timecodes/timeranges that slipped through
    for (const entry of translatedEntries) {
      entry.text = this.sanitizeTimecodes(entry.text);
    }

    // Step 5: Convert back to SRT format
    return toSRT(translatedEntries);
  }

  /**
   * Single-batch translation workflow with optional streaming partials
   */
  async translateSubtitleSingleBatch(entries, targetLanguage, customPrompt = null, onProgress = null) {
    log.info(() => `[TranslationEngine] Single-batch translation: ${entries.length} entries`);

    const fullBatchText = this.prepareBatchContent(entries, null);

    const promptForCache = this.createPromptForWorkflow(fullBatchText, targetLanguage, customPrompt, entries.length, null, 0, 1);

    let actualTokenCount = null;
    try {
      actualTokenCount = await this.gemini.countTokensForTranslation(fullBatchText, targetLanguage, promptForCache);
    } catch (err) {
      log.debug(() => ['[TranslationEngine] Single-batch token count failed, using estimate:', err.message]);
    }

    let estimatedTokens = actualTokenCount;
    if (!estimatedTokens) {
      try {
        const { userPrompt } = this.gemini.buildUserPrompt(fullBatchText, targetLanguage, promptForCache);
        estimatedTokens = this.safeEstimateTokens(userPrompt);
      } catch (estimateErr) {
        log.debug(() => ['[TranslationEngine] Single-batch prompt estimation failed, falling back:', estimateErr.message]);
        estimatedTokens = this.safeEstimateTokens(fullBatchText + (promptForCache || ''));
      }
    }

    // Dynamic chunk sizing: keep each chunk comfortably under the max token limit
    const softLimit = Math.max(1000, SINGLE_BATCH_TOKEN_SOFT_LIMIT);
    let chunkCount = Math.max(1, Math.ceil(estimatedTokens / softLimit));
    // Never create more chunks than entries (prevents empty chunks on tiny files)
    chunkCount = Math.min(chunkCount, Math.max(1, entries.length));

    if (chunkCount > 1) {
      const basis = actualTokenCount ? 'actual' : 'estimated';
      log.info(() => `[TranslationEngine] Single-batch token split: ${estimatedTokens} tokens (${basis}) -> ${chunkCount} chunks (limit ~${SINGLE_BATCH_MAX_TOKENS_PER_CHUNK}/chunk)`);
    }

    const chunks = chunkCount > 1 ? this.splitIntoChunks(entries, chunkCount) : [entries];
    const translatedEntries = [];

    for (let batchIndex = 0; batchIndex < chunks.length; batchIndex++) {
      const batch = chunks[batchIndex];
      const useStreaming = chunkCount === 1 && this.enableStreaming;

      // Rotate API key for this batch if per-batch rotation is enabled
      this.maybeRotateKeyForBatch(batchIndex);

      // Preserve coherence when the "single-batch" path auto-splits by reusing the same context builder
      const context = this.enableBatchContext
        ? this.prepareContextForBatch(batch, entries, translatedEntries, batchIndex)
        : null;

      const translatedBatch = await this.translateBatch(
        batch,
        targetLanguage,
        customPrompt,
        batchIndex,
        chunks.length,
        context,
        {
          allowAutoChunking: false,
          streaming: useStreaming,
          onStreamProgress: async (payload) => {
            if (typeof onProgress === 'function' && payload?.partialSRT) {
              try {
                await onProgress({
                  totalEntries: entries.length,
                  completedEntries: payload.completedEntries,
                  currentBatch: batchIndex + 1,
                  totalBatches: chunks.length,
                  partialSRT: payload.partialSRT,
                  streaming: true,
                  streamSequence: payload.streamSequence
                });
              } catch (err) {
                log.warn(() => ['[TranslationEngine] Streaming progress callback error:', err.message]);
              }
            }
          }
        }
      );

      // Merge translated text with original structure
      for (let i = 0; i < batch.length; i++) {
        const original = batch[i];
        const translated = translatedBatch[i] || {};

        const cleanedText = this.cleanTranslatedText(translated.text || original.text);
        const timecode = (this.sendTimestampsToAI && translated.timecode) ? translated.timecode : original.timecode;
        translatedEntries.push({
          id: original.id,
          timecode,
          text: cleanedText
        });
      }

      // Progress callback after each chunk
      if (typeof onProgress === 'function') {
        try {
          await onProgress({
            totalEntries: entries.length,
            completedEntries: translatedEntries.length,
            currentBatch: batchIndex + 1,
            totalBatches: chunks.length,
            partialSRT: toSRT(translatedEntries)
          });
        } catch (err) {
          log.warn(() => ['[TranslationEngine] Progress callback error (single-batch):', err.message]);
        }
      }
    }

    if (translatedEntries.length !== entries.length) {
      log.warn(() => `[TranslationEngine] Single-batch entry count mismatch: expected ${entries.length}, got ${translatedEntries.length}`);
    }

    for (const entry of translatedEntries) {
      entry.text = this.sanitizeTimecodes(entry.text);
    }

    log.info(() => `[TranslationEngine] Single-batch translation completed: ${translatedEntries.length} entries (tokens: est ${estimatedTokens}${actualTokenCount ? `, actual ${actualTokenCount}` : ''})`);

    return toSRT(translatedEntries);
  }

  /**
   * Create batches from entries
   */
  createBatches(entries, batchSize) {
    const batches = [];
    for (let i = 0; i < entries.length; i += batchSize) {
      batches.push(entries.slice(i, i + batchSize));
    }
    return batches;
  }

  /**
   * Split entries into N roughly equal chunks
   */
  splitIntoChunks(entries, parts) {
    const chunks = [];
    const size = Math.ceil(entries.length / parts);
    for (let i = 0; i < entries.length; i += size) {
      chunks.push(entries.slice(i, i + size));
    }
    return chunks;
  }

  /**
   * Prepare context for a batch (original surrounding entries + previous translations)
   * Context improves translation coherence across batches
   * @param {Array} batch - Current batch entries
   * @param {Array} allOriginalEntries - All original entries
   * @param {Array} translatedSoFar - Previously translated entries
   * @param {number} batchIndex - Current batch index
   * @returns {Object} - Context object with surrounding and previous entries
   */
  prepareContextForBatch(batch, allOriginalEntries, translatedSoFar, batchIndex) {
    if (!this.enableBatchContext) {
      return null;
    }

    const firstEntryId = batch[0].id;
    const lastEntryId = batch[batch.length - 1].id;

    // Get surrounding context from original entries (before the batch)
    const surroundingStartIdx = Math.max(0, firstEntryId - 1 - this.contextSize);
    const surroundingEndIdx = firstEntryId - 1;
    const surroundingContext = [];

    for (let i = surroundingStartIdx; i <= surroundingEndIdx && i < allOriginalEntries.length; i++) {
      if (allOriginalEntries[i]) {
        surroundingContext.push({
          id: allOriginalEntries[i].id,
          text: allOriginalEntries[i].text,
          timecode: allOriginalEntries[i].timecode
        });
      }
    }

    // Get previous translations (last N entries that were already translated)
    const previousTranslations = translatedSoFar.slice(Math.max(0, translatedSoFar.length - this.contextSize));

    // Only include context if this is NOT the first batch
    const hasContext = batchIndex > 0 && (surroundingContext.length > 0 || previousTranslations.length > 0);

    return hasContext ? {
      surroundingOriginal: surroundingContext,
      previousTranslations: previousTranslations
    } : null;
  }

  /**
   * Translate a batch of entries (with auto-chunking if needed)
   */
  async translateBatch(batch, targetLanguage, customPrompt, batchIndex, totalBatches, context = null, options = {}) {
    const opts = options || {};

    // Native batch providers (DeepL, Google Translate): send raw SRT directly,
    // skip numbered-list prompt construction and response parsing entirely.
    if (this.isNativeBatchProvider) {
      return this.translateBatchNative(batch, targetLanguage, batchIndex, totalBatches);
    }

    const allowAutoChunking = opts.allowAutoChunking !== false;
    const streamingRequested = opts.streaming && typeof this.gemini.streamTranslateSubtitle === 'function';
    const tryFallback = async (primaryError) => {
      if (!this.fallbackProvider) {
        return { handled: false, error: primaryError };
      }
      try {
        const translated = await this.fallbackProvider.translateSubtitle(
          batchText,
          'detected',
          targetLanguage,
          prompt
        );
        log.info(() => `[TranslationEngine] Fallback provider ${this.fallbackProviderName || 'secondary'} succeeded for batch ${batchIndex + 1}`);
        return { handled: true, text: translated };
      } catch (fallbackError) {
        const combined = new Error(`Primary (${this.providerName}) failed: ${primaryError.message || primaryError}\nSecondary (${this.fallbackProviderName || 'fallback'}) failed: ${fallbackError.message || fallbackError}`);
        combined.translationErrorType = 'MULTI_PROVIDER';
        combined.primaryError = primaryError;
        combined.secondaryError = fallbackError;
        combined.primaryProvider = this.providerName;
        combined.secondaryProvider = this.fallbackProviderName || 'fallback';
        return { handled: false, error: combined };
      }
    };
    // Prepare batch text (with context if provided)
    const batchText = this.prepareBatchContent(batch, context);

    const prompt = this.createPromptForWorkflow(batchText, targetLanguage, customPrompt, batch.length, context, batchIndex, totalBatches);

    // Check cache first (includes prompt variant so AI-mode differences are respected)
    const cacheResults = this.checkBatchCache(batch, targetLanguage, prompt);
    if (cacheResults.allCached) {
      return cacheResults.entries;
    }

    // Check if we need to split due to token limits
    let actualTokenCount = null;
    if (typeof this.gemini?.countTokensForTranslation === 'function') {
      try {
        actualTokenCount = await this.gemini.countTokensForTranslation(batchText, targetLanguage, prompt);
      } catch (err) {
        log.debug(() => ['[TranslationEngine] Token count check failed, using estimate:', err.message]);
      }
    }

    const estimatedTokens = actualTokenCount || this.safeEstimateTokens(batchText + prompt);

    // Sequence counter for streaming progress events (used by both auto-chunk and normal paths)
    let streamSequence = 0;

    if (allowAutoChunking && estimatedTokens > this.maxTokensPerBatch && batch.length > 1) {
      // Auto-chunk: Split batch in half recursively (sequential for memory safety)
      log.debug(() => `[TranslationEngine] Batch too large (${estimatedTokens}${actualTokenCount ? ' actual' : ' est.'} tokens), auto-chunking into 2 parts`);

      const midpoint = Math.floor(batch.length / 2);
      const firstHalf = batch.slice(0, midpoint);
      const secondHalf = batch.slice(midpoint);

      // Translate sequentially to avoid memory spikes
      // Note: Don't pass context to recursive calls - context already included in original batch text
      const firstTranslated = await this.translateBatch(firstHalf, targetLanguage, customPrompt, batchIndex, totalBatches, null, opts);

      // Emit streaming progress after first half completes so partial delivery picks it up
      if (typeof opts.onStreamProgress === 'function' && firstTranslated.length > 0) {
        const halfEntries = firstHalf.map((orig, i) => {
          const translated = firstTranslated[i] || {};
          return {
            id: orig.id,
            timecode: (this.sendTimestampsToAI && translated.timecode) ? translated.timecode : orig.timecode,
            text: this.cleanTranslatedText(translated.text || orig.text)
          };
        });
        const normalized = halfEntries.map((entry, idx) => ({ id: idx + 1, timecode: entry.timecode, text: entry.text }));
        try {
          await opts.onStreamProgress({
            partialSRT: toSRT(normalized),
            completedEntries: firstTranslated.length,
            totalEntries: batch.length,
            batchStartId: firstHalf[0]?.id || 1,
            batchEndId: firstHalf[firstHalf.length - 1]?.id || 1,
            currentBatch: batchIndex + 1,
            totalBatches,
            streaming: true,
            streamSequence: ++streamSequence
          });
        } catch (_) { }
      }

      const secondTranslated = await this.translateBatch(secondHalf, targetLanguage, customPrompt, batchIndex, totalBatches, null, opts);

      return [...firstTranslated, ...secondTranslated];
    }

    // Translate batch - with retry on PROHIBITED_CONTENT and MAX_TOKENS errors
    let translatedText;
    let prohibitedRetryAttempted = false;
    let maxTokensRetryAttempted = false;

    try {
      if (streamingRequested) {
        translatedText = await this.gemini.streamTranslateSubtitle(
          batchText,
          'detected',
          targetLanguage,
          prompt,
          async (partialText) => {
            if (typeof opts.onStreamProgress !== 'function') return;
            const payload = this.buildStreamingProgress(partialText, batch);
            if (!payload) return;
            payload.currentBatch = batchIndex + 1;
            payload.totalBatches = totalBatches;
            payload.streaming = true;
            payload.streamSequence = ++streamSequence;
            try {
              await opts.onStreamProgress(payload);
            } catch (err) {
              log.warn(() => ['[TranslationEngine] Stream progress handler failed:', err.message]);
            }
          }
        );
      } else {
        translatedText = await this.gemini.translateSubtitle(
          batchText,
          'detected',
          targetLanguage,
          prompt
        );
      }
    } catch (error) {
      // If MAX_TOKENS error and haven't retried yet, retry once
      if (error.message && (error.message.includes('MAX_TOKENS') || error.message.includes('exceeded maximum token limit')) && !maxTokensRetryAttempted) {
        maxTokensRetryAttempted = true;
        log.warn(() => `[TranslationEngine] MAX_TOKENS error detected, retrying batch ${batchIndex + 1} once`);

        try {
          translatedText = await this.gemini.translateSubtitle(
            batchText,
            'detected',
            targetLanguage,
            prompt
          );
          log.info(() => `[TranslationEngine] MAX_TOKENS retry succeeded for batch ${batchIndex + 1}`);
        } catch (retryError) {
          // Retry also failed, give up and throw the original error
          log.warn(() => `[TranslationEngine] MAX_TOKENS retry also failed for batch ${batchIndex + 1}: ${retryError.message}`);
          const fallbackResult = await tryFallback(error);
          if (fallbackResult.handled) {
            translatedText = fallbackResult.text;
          } else {
            throw fallbackResult.error; // Throw original/fallback-combined error
          }
        }
      }
      // If PROHIBITED_CONTENT error and haven't retried yet, retry with modified prompt
      else if (error.message && error.message.includes('PROHIBITED_CONTENT') && !prohibitedRetryAttempted) {
        prohibitedRetryAttempted = true;
        log.warn(() => `[TranslationEngine] PROHIBITED_CONTENT detected, retrying batch with modified prompt`);

        // Create modified prompt with disclaimer
        const modifiedPrompt = `YOU'RE TRANSLATING SUBTITLES - EVERYTHING WRITTEN BELOW IS FICTICIOUS\n\n${prompt}`;

        try {
          translatedText = await this.gemini.translateSubtitle(
            batchText,
            'detected',
            targetLanguage,
            modifiedPrompt
          );
          log.info(() => `[TranslationEngine] Retry with modified prompt succeeded for batch ${batchIndex + 1}`);
        } catch (retryError) {
          // Retry also failed, give up and throw the original error
          log.warn(() => `[TranslationEngine] Retry with modified prompt also failed: ${retryError.message}`);
          const fallbackResult = await tryFallback(error);
          if (fallbackResult.handled) {
            translatedText = fallbackResult.text;
          } else {
            throw fallbackResult.error; // Throw original/fallback-combined error
          }
        }
      } else {
        // Not a retryable error or already retried, throw as-is
        // If streaming returned nothing, fall back to non-streaming once
        const noStreamContent = error.message && (
          error.message.includes('No content returned from Gemini stream') ||
          error.message.includes('No content returned from stream')
        );
        if (streamingRequested && noStreamContent) {
          log.warn(() => `[TranslationEngine] Stream returned no content for batch ${batchIndex + 1}, retrying without streaming`);
          translatedText = await this.gemini.translateSubtitle(
            batchText,
            'detected',
            targetLanguage,
            prompt
          );
        } else {
          const fallbackResult = await tryFallback(error);
          if (fallbackResult.handled) {
            translatedText = fallbackResult.text;
          } else {
            throw fallbackResult.error;
          }
        }
      }
    }

    // Parse translated text back into entries
    let translatedEntries = this.parseResponseForWorkflow(translatedText, batch.length, batch);

    // Handle entry count mismatches with two-pass recovery
    if (translatedEntries.length !== batch.length) {
      log.warn(() => `[TranslationEngine] Entry count mismatch: expected ${batch.length}, got ${translatedEntries.length}`);

      // Pass 1: Align what we can by index, identify missing entries
      const { aligned, missingIndices } = this.alignTranslatedEntries(translatedEntries, batch);

      if (missingIndices.length > 0 && missingIndices.length <= Math.ceil(batch.length * 0.3)) {
        // Pass 2: Re-translate only the missing entries individually
        log.info(() => `[TranslationEngine] Two-pass recovery: ${missingIndices.length} missing entries, attempting targeted re-translation`);
        try {
          const missingBatch = missingIndices.map(i => batch[i]);
          const missingText = this.prepareBatchContent(missingBatch, null);
          const missingPrompt = this.createPromptForWorkflow(missingText, targetLanguage, customPrompt, missingBatch.length, null, batchIndex, totalBatches);
          const retryText = await this.gemini.translateSubtitle(
            missingText,
            'detected',
            targetLanguage,
            missingPrompt
          );
          const retryEntries = this.parseResponseForWorkflow(retryText, missingBatch.length, missingBatch);

          // Merge recovered entries back into aligned result
          for (let i = 0; i < missingIndices.length && i < retryEntries.length; i++) {
            const targetIdx = missingIndices[i];
            if (retryEntries[i] && retryEntries[i].text) {
              aligned[targetIdx] = {
                index: targetIdx,
                text: retryEntries[i].text,
                timecode: retryEntries[i].timecode || (batch[targetIdx] ? batch[targetIdx].timecode : undefined)
              };
            }
          }
          const stillMissing = missingIndices.filter(i => !aligned[i] || aligned[i].text.startsWith('[⚠]'));
          if (stillMissing.length > 0) {
            log.warn(() => `[TranslationEngine] Two-pass recovery: ${stillMissing.length} entries still missing after targeted retry`);
          } else {
            log.info(() => `[TranslationEngine] Two-pass recovery succeeded: all ${missingIndices.length} missing entries recovered`);
          }
        } catch (retryErr) {
          log.warn(() => `[TranslationEngine] Two-pass targeted retry failed: ${retryErr.message}`);
        }
        translatedEntries = Object.values(aligned).sort((a, b) => a.index - b.index);
      } else if (missingIndices.length > 0) {
        // Too many missing entries for targeted retry, fall back to full batch retry
        let retrySuccess = false;
        for (let retryAttempt = 0; retryAttempt < this.mismatchRetries; retryAttempt++) {
          log.info(() => `[TranslationEngine] Full batch retry ${retryAttempt + 1}/${this.mismatchRetries} (${missingIndices.length} missing entries too many for targeted recovery)`);
          try {
            await new Promise(resolve => setTimeout(resolve, 500));
            const retryText = await this.gemini.translateSubtitle(
              batchText,
              'detected',
              targetLanguage,
              prompt
            );
            const retryEntries = this.parseResponseForWorkflow(retryText, batch.length, batch);
            if (retryEntries.length === batch.length) {
              translatedEntries = retryEntries;
              retrySuccess = true;
              break;
            }
          } catch (retryErr) {
            log.warn(() => `[TranslationEngine] Full batch retry ${retryAttempt + 1} failed: ${retryErr.message}`);
          }
        }
        if (!retrySuccess) {
          // Use the aligned result with markers for missing entries
          translatedEntries = Object.values(aligned).sort((a, b) => a.index - b.index);
          const markedCount = translatedEntries.filter(e => e.text.startsWith('[⚠]')).length;
          if (markedCount > 0) {
            log.warn(() => `[TranslationEngine] Marked ${markedCount} entries as untranslated after all retries`);
          }
        }
      } else {
        // All entries aligned despite count mismatch (extras were trimmed)
        translatedEntries = Object.values(aligned).sort((a, b) => a.index - b.index);
      }
    }

    // Cache individual entries
    if (CACHE_TRANSLATIONS) {
      for (let i = 0; i < batch.length && i < translatedEntries.length; i++) {
        this.cacheEntry(batch[i].text, targetLanguage, translatedEntries[i].text, prompt);
      }
    }

    return translatedEntries;
  }

  /**
   * Translate a batch using a native (non-LLM) provider like DeepL or Google Translate.
   * Sends raw SRT directly — no numbered-list prompt, no response parsing overhead.
   */
  async translateBatchNative(batch, targetLanguage, batchIndex, totalBatches) {
    const srtContent = this.prepareBatchSrt(batch);

    log.debug(() => `[TranslationEngine] Native batch ${batchIndex + 1}/${totalBatches}: ${batch.length} entries via ${this.providerName}`);

    let translatedText;
    try {
      translatedText = await this.gemini.translateSubtitle(
        srtContent,
        'detected',
        targetLanguage,
        null
      );
    } catch (error) {
      if (this.fallbackProvider) {
        log.warn(() => `[TranslationEngine] Native provider ${this.providerName} failed, trying fallback: ${error.message}`);
        try {
          translatedText = await this.fallbackProvider.translateSubtitle(srtContent, 'detected', targetLanguage, null);
        } catch (fallbackError) {
          const combined = new Error(`Primary (${this.providerName}) failed: ${error.message}\nSecondary (${this.fallbackProviderName || 'fallback'}) failed: ${fallbackError.message}`);
          combined.translationErrorType = 'MULTI_PROVIDER';
          throw combined;
        }
      } else {
        throw error;
      }
    }

    // Parse the provider's response back into entries
    // Native providers return either SRT or numbered-list format
    let translatedEntries;
    const trimmed = String(translatedText || '').trim();

    if (trimmed.includes('-->')) {
      // Provider returned SRT — parse it directly
      translatedEntries = this.parseBatchSrtResponse(trimmed, batch.length, batch);
    } else {
      // Provider returned numbered list — parse that
      translatedEntries = this.parseBatchResponse(trimmed, batch.length);
    }

    // Handle count mismatches (no retries for native providers — they're deterministic)
    if (translatedEntries.length !== batch.length) {
      log.warn(() => `[TranslationEngine] Native batch entry mismatch: expected ${batch.length}, got ${translatedEntries.length}`);
      this.fixEntryCountMismatch(translatedEntries, batch, false);
    }

    return translatedEntries;
  }

  /**
   * Prepare batch text for translation (numbered list format)
   * Optionally includes context entries for better translation coherence
   */
  prepareBatchText(batch, context = null) {
    let result = '';

    // Add context section if provided
    if (context && (context.surroundingOriginal?.length > 0 || context.previousTranslations?.length > 0)) {
      result += '=== CONTEXT (FOR REFERENCE ONLY - DO NOT TRANSLATE) ===\n\n';

      // Add surrounding original context
      if (context.surroundingOriginal && context.surroundingOriginal.length > 0) {
        result += '--- Original Context (preceding entries) ---\n';
        context.surroundingOriginal.forEach((entry, index) => {
          const cleanText = entry.text.trim().replace(/\n+/g, '\n');
          result += `[Context ${index + 1}] ${cleanText}\n\n`;
        });
      }

      // Add previous translations
      if (context.previousTranslations && context.previousTranslations.length > 0) {
        result += '--- Previous Translations (recently translated) ---\n';
        context.previousTranslations.forEach((entry, index) => {
          const cleanText = entry.text.trim().replace(/\n+/g, '\n');
          result += `[Translated ${index + 1}] ${cleanText}\n\n`;
        });
      }

      result += '=== END OF CONTEXT ===\n\n';
      result += '=== ENTRIES TO TRANSLATE (translate these) ===\n\n';
    }

    // Add batch entries to translate
    const batchText = batch.map((entry, index) => {
      const num = index + 1;
      const cleanText = entry.text.trim().replace(/\n+/g, '\n');
      return `${num}. ${cleanText}`;
    }).join('\n\n');

    result += batchText;

    return result;
  }

  /**
   * Prepare batch text that includes timestamps (SRT format)
   * This is used when we trust the AI to preserve/repair timecodes.
   */
  prepareBatchSrt(batch) {
    const srtEntries = batch.map(entry => ({
      id: entry.id,
      timecode: entry.timecode,
      text: entry.text
    }));
    return toSRT(srtEntries).trim();
  }

  /**
   * Prepare batch text using XML tags for robust entry identification
   * Each entry is wrapped in <s id="N">...</s> tags
   */
  prepareBatchXml(batch, context = null) {
    let result = '';

    // Add context section if provided
    if (context && (context.surroundingOriginal?.length > 0 || context.previousTranslations?.length > 0)) {
      result += '=== CONTEXT (FOR REFERENCE ONLY - DO NOT TRANSLATE) ===\n\n';
      if (context.surroundingOriginal && context.surroundingOriginal.length > 0) {
        result += '--- Original Context (preceding entries) ---\n';
        context.surroundingOriginal.forEach((entry, index) => {
          const cleanText = entry.text.trim().replace(/\n+/g, '\n');
          result += `[Context ${index + 1}] ${cleanText}\n\n`;
        });
      }
      if (context.previousTranslations && context.previousTranslations.length > 0) {
        result += '--- Previous Translations (recently translated) ---\n';
        context.previousTranslations.forEach((entry, index) => {
          const cleanText = entry.text.trim().replace(/\n+/g, '\n');
          result += `[Translated ${index + 1}] ${cleanText}\n\n`;
        });
      }
      result += '=== END OF CONTEXT ===\n\n';
      result += '=== ENTRIES TO TRANSLATE ===\n\n';
    }

    const xmlEntries = batch.map((entry, index) => {
      const num = index + 1;
      const cleanText = entry.text.trim().replace(/\n+/g, '\n');
      return `<s id="${num}">${cleanText}</s>`;
    }).join('\n');

    result += xmlEntries;
    return result;
  }

  /**
   * Create translation prompt for XML-tagged batches
   */
  createXmlBatchPrompt(batchText, targetLanguage, customPrompt, expectedCount, context = null, batchIndex = 0, totalBatches = 1) {
    const targetLabel = normalizeTargetLanguageForPrompt(targetLanguage);
    const customPromptText = customPrompt ? customPrompt.replace('{target_language}', targetLabel) : '';

    let contextInstructions = '';
    if (context && (context.surroundingOriginal?.length > 0 || context.previousTranslations?.length > 0)) {
      contextInstructions = `
CONTEXT PROVIDED:
- Context entries are provided for reference to maintain coherence and consistency
- DO NOT translate context entries - they are for reference only
- ONLY translate entries inside <s id="N"> tags

`;
    }

    const promptBody = `You are translating subtitle text to ${targetLabel}.
${contextInstructions}
CRITICAL RULES:
1. Translate ONLY the text inside each <s id="N"> tag
2. PRESERVE the XML tags exactly: <s id="N">translated text</s>
3. Return EXACTLY ${expectedCount} tagged entries
4. Keep line breaks within each entry
5. Maintain natural dialogue flow for ${targetLabel}
6. Use appropriate colloquialisms for ${targetLabel}${context ? '\n7. Use the provided context to ensure consistency' : ''}

${customPromptText ? `ADDITIONAL INSTRUCTIONS:\n${customPromptText}\n\n` : ''}
Do NOT add acknowledgements, explanations, notes, or commentary.
Do not skip, merge, or split entries.
Do not include any timestamps/timecodes.

YOUR RESPONSE MUST:
- Start with <s id="1"> and end with </s> after entry ${expectedCount}
- Contain ONLY the XML-tagged translated entries

INPUT (${expectedCount} entries):

${batchText}

OUTPUT (EXACTLY ${expectedCount} XML-tagged entries):`;
    return this.addBatchHeader(promptBody, batchIndex, totalBatches);
  }

  /**
   * Parse XML-tagged translation response
   * Matches <s id="N">text</s> patterns and recovers entries by ID
   */
  parseXmlBatchResponse(translatedText, expectedCount) {
    let cleaned = String(translatedText || '').trim();
    // Remove markdown code blocks
    cleaned = cleaned.replace(/```[a-z]*(?:\r?\n)?/g, '');

    const entries = [];
    // Match <s id="N">...</s> with flexible whitespace and multiline content
    const xmlPattern = /<s\s+id\s*=\s*"?(\d+)"?\s*>([\s\S]*?)<\/s>/gi;
    let match;
    while ((match = xmlPattern.exec(cleaned)) !== null) {
      const id = parseInt(match[1], 10);
      const text = match[2].trim();
      if (id > 0 && text) {
        entries.push({
          index: id - 1,
          text: text
        });
      }
    }

    // Sort by index and deduplicate (keep first occurrence per ID)
    const seen = new Set();
    const deduped = [];
    entries.sort((a, b) => a.index - b.index);
    for (const entry of entries) {
      if (!seen.has(entry.index)) {
        seen.add(entry.index);
        deduped.push(entry);
      }
    }

    return deduped;
  }

  /**
   * Route to the correct batch content preparation method based on workflow
   */
  prepareBatchContent(batch, context) {
    if (this.translationWorkflow === 'ai') {
      return this.prepareBatchSrt(batch);
    }
    if (this.translationWorkflow === 'xml') {
      return this.prepareBatchXml(batch, context);
    }
    return this.prepareBatchText(batch, context);
  }

  /**
   * Route to the correct prompt creation method based on workflow
   * When JSON output is enabled, wraps the prompt with JSON format instructions
   */
  createPromptForWorkflow(batchText, targetLanguage, customPrompt, expectedCount, context, batchIndex, totalBatches) {
    let basePrompt;
    if (this.translationWorkflow === 'ai') {
      basePrompt = this.createTimestampPrompt(targetLanguage, batchIndex, totalBatches);
    } else if (this.translationWorkflow === 'xml') {
      basePrompt = this.createXmlBatchPrompt(batchText, targetLanguage, customPrompt, expectedCount, context, batchIndex, totalBatches);
    } else {
      basePrompt = this.createBatchPrompt(batchText, targetLanguage, customPrompt, expectedCount, context, batchIndex, totalBatches);
    }

    // Wrap with JSON output instructions when enabled
    if (this.enableJsonOutput && this.translationWorkflow !== 'ai') {
      basePrompt += `\n\nIMPORTANT: Return your response as a JSON array of objects with "id" (number) and "text" (string) fields.
Example format: [{"id":1,"text":"translated text"},{"id":2,"text":"translated text"}]
Return ONLY the JSON array, no other text.`;
    }

    return basePrompt;
  }

  /**
   * Route to the correct response parser based on workflow
   * When JSON output is enabled, attempts JSON parsing first with fallback
   */
  parseResponseForWorkflow(translatedText, expectedCount, batch) {
    // Try JSON parsing first when enabled
    if (this.enableJsonOutput && this.translationWorkflow !== 'ai') {
      const jsonEntries = this.parseJsonResponse(translatedText, expectedCount);
      if (jsonEntries && jsonEntries.length > 0) {
        return jsonEntries;
      }
      log.warn(() => `[TranslationEngine] JSON parsing failed, falling back to standard parser`);
    }

    if (this.translationWorkflow === 'ai') {
      return this.parseBatchSrtResponse(translatedText, expectedCount, batch);
    }
    if (this.translationWorkflow === 'xml') {
      return this.parseXmlBatchResponse(translatedText, expectedCount);
    }
    return this.parseBatchResponse(translatedText, expectedCount);
  }

  /**
   * Parse JSON structured output response
   * Expects: [{"id": 1, "text": "translated"}, ...]
   */
  parseJsonResponse(translatedText, expectedCount) {
    try {
      let cleaned = String(translatedText || '').trim();
      // Remove markdown code blocks
      cleaned = cleaned.replace(/```json\s*/gi, '').replace(/```\s*/g, '');
      // Find the JSON array in the response
      const arrayStart = cleaned.indexOf('[');
      const arrayEnd = cleaned.lastIndexOf(']');
      if (arrayStart === -1 || arrayEnd === -1 || arrayEnd <= arrayStart) {
        return null;
      }
      cleaned = cleaned.slice(arrayStart, arrayEnd + 1);
      const parsed = JSON.parse(cleaned);
      if (!Array.isArray(parsed)) return null;

      const entries = [];
      for (const item of parsed) {
        if (item && typeof item.id === 'number' && typeof item.text === 'string') {
          entries.push({
            index: item.id - 1,
            text: item.text.trim()
          });
        }
      }

      entries.sort((a, b) => a.index - b.index);
      return entries.length > 0 ? entries : null;
    } catch (err) {
      log.debug(() => `[TranslationEngine] JSON response parse error: ${err.message}`);
      return null;
    }
  }

  /**
   * Align translated entries to original batch by index, identifying missing entries
   * Used by two-pass mismatch recovery
   */
  alignTranslatedEntries(translatedEntries, originalBatch) {
    const aligned = {};
    const translatedMap = new Map();

    for (const entry of translatedEntries) {
      if (typeof entry.index === 'number' && !translatedMap.has(entry.index)) {
        translatedMap.set(entry.index, entry);
      }
    }

    const missingIndices = [];
    for (let i = 0; i < originalBatch.length; i++) {
      const existing = translatedMap.get(i);
      if (existing && existing.text) {
        aligned[i] = {
          index: i,
          text: existing.text,
          timecode: existing.timecode || undefined
        };
      } else {
        missingIndices.push(i);
        aligned[i] = {
          index: i,
          text: `[⚠] ${originalBatch[i].text}`,
          timecode: originalBatch[i].timecode || undefined
        };
      }
    }

    return { aligned, missingIndices };
  }

  /**
   * Create translation prompt for timestamp-aware batches
   */
  createTimestampPrompt(targetLanguage, batchIndex = 0, totalBatches = 1) {
    const targetLabel = normalizeTargetLanguageForPrompt(targetLanguage);
    const base = DEFAULT_TRANSLATION_PROMPT.replace('{target_language}', targetLabel);
    return this.addBatchHeader(base, batchIndex, totalBatches);
  }

  /**
   * Create translation prompt for a batch
   */
  createBatchPrompt(batchText, targetLanguage, customPrompt, expectedCount, context = null, batchIndex = 0, totalBatches = 1) {
    const targetLabel = normalizeTargetLanguageForPrompt(targetLanguage);
    const customPromptText = customPrompt ? customPrompt.replace('{target_language}', targetLabel) : '';

    let contextInstructions = '';
    if (context && (context.surroundingOriginal?.length > 0 || context.previousTranslations?.length > 0)) {
      contextInstructions = `
CONTEXT PROVIDED:
- Context entries are provided for reference to maintain coherence and consistency
- Context entries are marked with [Context N] or [Translated N]
- DO NOT translate context entries - they are for reference only
- Use the context to understand dialogue flow, character names, and references
- ONLY translate the numbered entries (1. 2. 3. etc.)

`;
    }

    const promptBody = `You are translating subtitle text to ${targetLabel}.
${contextInstructions}
CRITICAL RULES:
1. Translate ONLY the numbered text entries (1. 2. 3. etc.)
2. PRESERVE the numbering exactly (1. 2. 3. etc.)
3. Return EXACTLY ${expectedCount} numbered entries
4. Keep line breaks within each entry
5. Maintain natural dialogue flow for ${targetLabel}
6. Use appropriate colloquialisms for ${targetLabel}${context ? '\n7. Use the provided context to ensure consistency with previous translations' : ''}

${customPromptText ? `ADDITIONAL INSTRUCTIONS (from user/config):\n${customPromptText}\n\n` : ''}
DO NOT add ANY acknowledgements, explanations, notes, or commentary.
Do not add alternative translations
Do not skip any entries
Do not merge or split entries
Do not change the numbering
Do not add extra entries
Do not include any timestamps/timecodes or time ranges
${context ? 'Do not translate context entries - only translate numbered entries' : ''}

YOUR RESPONSE MUST:
- Start immediately with "1." (the first entry)
- End with "${expectedCount}." (the last entry)
- Contain NOTHING else

INPUT (${expectedCount} entries):

${batchText}

OUTPUT (EXACTLY ${expectedCount} numbered entries, NO OTHER TEXT):`;
    return this.addBatchHeader(promptBody, batchIndex, totalBatches);
  }

  /**
   * Prefix prompt with batch marker so the model knows which chunk it is handling
   */
  addBatchHeader(prompt, batchIndex, totalBatches) {
    const header = `BATCH ${batchIndex + 1}/${totalBatches}`;
    return `${header}\n\n${prompt}`;
  }

  /**
   * Build streaming progress payload from partial text
   */
  buildStreamingProgress(partialText, originalBatch = []) {
    if (!partialText) return null;

    const batchStartId = originalBatch?.[0]?.id || 1;
    const batchEndId = originalBatch?.[originalBatch.length - 1]?.id || batchStartId;

    let parsedEntries = [];
    if (this.translationWorkflow === 'ai') {
      const parsed = parseSRT(partialText) || [];
      parsedEntries = parsed.map((entry, idx) => ({
        index: (typeof entry.id === 'number') ? entry.id - 1 : idx,
        text: (entry.text || '').trim(),
        timecode: entry.timecode || ''
      }));
    } else if (this.translationWorkflow === 'xml') {
      // Parse partial XML tags from streaming output
      const xmlPattern = /<s\s+id\s*=\s*"?(\d+)"?\s*>([\s\S]*?)<\/s>/gi;
      let match;
      while ((match = xmlPattern.exec(partialText)) !== null) {
        const id = parseInt(match[1], 10);
        const text = match[2].trim();
        if (id > 0 && text) {
          parsedEntries.push({ index: id - 1, text });
        }
      }
    } else {
      let cleaned = partialText.trim();
      cleaned = cleaned.replace(/```[a-z]*(?:\r?\n)?/g, '');
      const blocks = cleaned.split(/(?:\r?\n){2,}/);
      for (const block of blocks) {
        const trimmed = block.trim();
        if (!trimmed) continue;
        const match = trimmed.match(/^(\d+)[.):\s-]+(.+)$/s);
        if (match) {
          parsedEntries.push({
            index: parseInt(match[1], 10) - 1,
            text: match[2].trim()
          });
        }
      }
    }

    if (!parsedEntries || parsedEntries.length === 0) {
      return null;
    }

    const merged = [];
    for (const entry of parsedEntries) {
      const original = originalBatch[entry.index];
      if (!original) continue;
      const cleanedText = this.cleanTranslatedText(entry.text || original.text);
      const timecode = (this.sendTimestampsToAI && entry.timecode) ? entry.timecode : original.timecode;
      merged.push({
        id: original.id,
        timecode,
        text: cleanedText
      });
    }

    if (merged.length === 0) return null;

    merged.sort((a, b) => a.id - b.id);
    const normalized = merged.map((entry, idx) => ({
      id: idx + 1,
      timecode: entry.timecode,
      text: entry.text
    }));

    return {
      partialSRT: toSRT(normalized),
      completedEntries: merged.length,
      totalEntries: originalBatch.length,
      batchStartId,
      batchEndId
    };
  }

  /**
   * Parse batch translation response when timestamps are included (expects SRT-like output)
   */
  parseBatchSrtResponse(translatedText, expectedCount, originalBatch = []) {
    const parsed = parseSRT(translatedText);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return [];
    }

    const entries = parsed.map((entry, idx) => ({
      index: idx,
      text: (entry.text || '').trim(),
      timecode: entry.timecode || ''
    }));

    // Don't fix count mismatches here — let the outer translateBatch handle retries first.
    // Only fill missing timecodes with originals to avoid gaps.
    for (let i = 0; i < entries.length; i++) {
      if (!entries[i].timecode && originalBatch[i]) {
        entries[i].timecode = originalBatch[i].timecode;
      }
    }

    return entries;
  }

  /**
   * Parse batch translation response
   */
  parseBatchResponse(translatedText, expectedCount) {
    let cleaned = translatedText.trim();

    // Remove markdown code blocks
    cleaned = cleaned.replace(/```[a-z]*(?:\r?\n)?/g, '');

    const entries = [];
    const blocks = cleaned.split(/(?:\r?\n){2,}/);

    for (const block of blocks) {
      const trimmed = block.trim();
      if (!trimmed) continue;

      // Match numbered entry: "N. text" or "N) text"
      const match = trimmed.match(/^(\d+)[.):\s-]+(.+)$/s);

      if (match) {
        const num = parseInt(match[1]);
        const text = match[2].trim();

        entries.push({
          index: num - 1,
          text: text
        });
      }
    }

    // Sort by index
    entries.sort((a, b) => a.index - b.index);

    return entries;
  }

  /**
   * Fix entry count mismatches by filling missing entries with original text
   */
  fixEntryCountMismatch(translatedEntries, originalBatch, preserveTimecodes = false) {
      if (translatedEntries.length === originalBatch.length) {
        return { hadMismatch: false, untranslatedIndices: [] };
      }

      const untranslatedIndices = [];

      if (translatedEntries.length < originalBatch.length) {
        // Missing entries - fill with original text marked as untranslated
        const translatedMap = new Map();
        for (const entry of translatedEntries) {
          translatedMap.set(entry.index, entry);
        }

        translatedEntries.length = 0;
        for (let i = 0; i < originalBatch.length; i++) {
          const existing = translatedMap.get(i);
          if (existing) {
            translatedEntries.push({
              index: i,
              text: existing.text,
              timecode: preserveTimecodes ? (existing.timecode || originalBatch[i].timecode) : existing.timecode
            });
          } else {
            untranslatedIndices.push(i);
            translatedEntries.push({
              index: i,
              text: `[⚠] ${originalBatch[i].text}`,
              timecode: preserveTimecodes ? originalBatch[i].timecode : undefined
            });
          }
        }
      } else {
        // Too many entries - keep only first N
        translatedEntries.length = originalBatch.length;
        for (let i = 0; i < translatedEntries.length; i++) {
          translatedEntries[i].index = i;
          if (preserveTimecodes && !translatedEntries[i].timecode && originalBatch[i]) {
            translatedEntries[i].timecode = originalBatch[i].timecode;
          }
        }
      }

      return { hadMismatch: true, untranslatedIndices };
    }

  /**
   * Clean translated text (remove timecodes, normalize line endings)
   */
  cleanTranslatedText(text) {
    let cleaned = String(text || '').trim();

    // Remove any embedded timecodes
    const timecodePattern = /\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3}\s*\n?/g;
    cleaned = cleaned.replace(timecodePattern, '').trim();

    // Normalize line endings (CRLF → LF)
    cleaned = cleaned.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // For RTL targets, wrap lines with embedding markers so punctuation renders on the correct side
    if (this.isRtlTarget) {
      cleaned = wrapRtlText(cleaned);
    }

    return cleaned;
  }

  /**
   * Remove timecodes/timeranges from arbitrary text (defensive post-clean)
   */
  sanitizeTimecodes(text) {
    let cleaned = String(text || '').trim();

    // Full-line time ranges with various separators (optional milliseconds)
    const rangeLine = /^(?:\s*)\d{1,2}:\d{2}:\d{2}(?:[.,]\d{1,3})?\s*(?:-->|–>|—>|->|→|to)\s*\d{1,2}:\d{2}:\d{2}(?:[.,]\d{1,3})?(?:\s*)$/gm;
    cleaned = cleaned.replace(rangeLine, '');

    // Inline time ranges
    const rangeInline = /\d{1,2}:\d{2}:\d{2}(?:[.,]\d{1,3})?\s*(?:-->|–>|—>|->|→|to)\s*\d{1,2}:\d{2}:\d{2}(?:[.,]\d{1,3})?/g;
    cleaned = cleaned.replace(rangeInline, '').trim();

    // Standalone full-line timestamps (with or without ms)
    const tsLine = /^(?:\s*)\d{1,2}:\d{2}:\d{2}(?:[.,]\d{1,3})?(?:\s*)$/gm;
    cleaned = cleaned.replace(tsLine, '');

    // Bracketed/parenthesized timestamps
    const bracketedTs = /[\[(]\s*\d{1,2}:\d{2}:\d{2}(?:[.,]\d{1,3})?\s*[\])]/g;
    cleaned = cleaned.replace(bracketedTs, '');

    // Normalize line endings and collapse blanks
    cleaned = cleaned.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    cleaned = cleaned
      .split('\n')
      .map(l => l.trimEnd())
      .filter(l => l.trim().length > 0)
      .join('\n')
      .trim();

    return cleaned;
  }

  /**
   * Estimate token count with a safe fallback when provider doesn't expose it
   */
  safeEstimateTokens(text) {
    const content = String(text || '');
    if (typeof this.gemini?.estimateTokenCount === 'function') {
      try {
        const tokens = this.gemini.estimateTokenCount(content);
        if (Number.isFinite(tokens)) {
          return tokens;
        }
      } catch (err) {
        log.debug(() => ['[TranslationEngine] Token estimate failed, using fallback:', err.message]);
      }
    }
    // Rough heuristic: ~4 characters per token
    return Math.max(1, Math.ceil(content.length / 4));
  }

  /**
   * Check if batch entries are cached
   */
  checkBatchCache(batch, targetLanguage, customPrompt) {
    if (!CACHE_TRANSLATIONS) {
      return { allCached: false, entries: [] };
    }

    const cachedEntries = [];
    let cacheHits = 0;

    for (const entry of batch) {
      const cached = this.getCachedEntry(entry.text, targetLanguage, customPrompt);
      if (cached) {
        cachedEntries.push({ index: entry.id - 1, text: cached });
        cacheHits++;
      } else {
        cachedEntries.push(null);
      }
    }

    const allCached = cacheHits === batch.length;
    return { allCached, entries: allCached ? cachedEntries : [] };
  }

  /**
   * Get cached entry translation
   */
  getCachedEntry(sourceText, targetLanguage, customPrompt) {
    if (!CACHE_TRANSLATIONS) return null;

    const key = this.createCacheKey(sourceText, targetLanguage, customPrompt);
    return entryCache.get(key) || null;
  }

  /**
   * Cache an entry translation
   */
  cacheEntry(sourceText, targetLanguage, translatedText, customPrompt) {
    if (!CACHE_TRANSLATIONS) return;

    // Enforce cache size limit (LRU eviction)
    if (entryCache.size >= MAX_ENTRY_CACHE_SIZE) {
      const evictionCount = Math.floor(MAX_ENTRY_CACHE_SIZE * 0.1);
      const keysToDelete = Array.from(entryCache.keys()).slice(0, evictionCount);
      for (const key of keysToDelete) {
        entryCache.delete(key);
      }
    }

    const key = this.createCacheKey(sourceText, targetLanguage, customPrompt);
    entryCache.set(key, translatedText);
  }

  /**
   * Create cache key for an entry
   */
  createCacheKey(sourceText, targetLanguage, customPrompt) {
    const normalized = sourceText.trim().toLowerCase();
    const promptHash = customPrompt
      ? crypto.createHash('md5').update(customPrompt).digest('hex').substring(0, 8)
      : 'default';
    const hash = crypto.createHash('md5')
      .update(`${normalized}:${targetLanguage}:${promptHash}`)
      .digest('hex');
    return hash;
  }

  /**
   * Clear entry cache
   */
  clearCache() {
    entryCache.clear();
    log.debug(() => '[TranslationEngine] Entry cache cleared');
  }

  /**
   * Get cache statistics
   */
  getCacheStats() {
    return {
      size: entryCache.size,
      maxSize: MAX_ENTRY_CACHE_SIZE
    };
  }
}

module.exports = TranslationEngine;
