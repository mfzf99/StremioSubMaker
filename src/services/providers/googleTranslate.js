const axios = require('axios');
const { parseSRT, toSRT } = require('../../utils/subtitle');
const { findISO6391ByName, toISO6391 } = require('../../utils/languages');
const { httpAgent, httpsAgent } = require('../../utils/httpAgents');
const log = require('../../utils/logger');

// Unofficial, keyless Google Translate provider using the public web endpoint.
// This mirrors the "google-translate-api-browser" behavior (join with a delimiter,
// single request, then split back into entries). Because it relies on the free
// web endpoint, it may be rate-limited or change without notice.
class GoogleTranslateProvider {
  constructor(options = {}) {
    this.providerName = options.providerName || 'googletranslate';
    this.translationTimeout = Math.max(5000, parseInt(options.translationTimeout * 1000, 10) || 60000);
    this.maxRetries = Number.isFinite(parseInt(options.maxRetries, 10))
      ? Math.max(0, parseInt(options.maxRetries, 10))
      : 2;
    this.baseUrl = process.env.GOOGLE_TRANSLATE_ENDPOINT
      || 'https://translate.googleapis.com/translate_a/single';
    this.delimiter = '|||'; // Separator to preserve entry boundaries
  }

  normalizeLanguage(targetLanguage) {
    if (!targetLanguage) return null;
    const raw = String(targetLanguage || '').trim();
    const lower = raw.toLowerCase();

    // Already ISO-639-1
    if (/^[a-z]{2}(-[a-z]{2})?$/i.test(raw)) {
      return raw;
    }

    // ISO-639-2 -> ISO-639-1
    const iso1 = toISO6391(raw);
    if (iso1) return iso1;

    // Human readable name -> ISO-639-1
    const fromName = findISO6391ByName(raw);
    if (fromName) return fromName;

    // Fallback to lowercased original
    return lower;
  }

  stripContext(subtitleContent) {
    if (!subtitleContent) return '';
    const marker = '=== ENTRIES TO TRANSLATE';
    const idx = subtitleContent.indexOf(marker);
    if (idx >= 0) {
      return subtitleContent.slice(idx + marker.length).replace(/^\s*\n+/, '');
    }
    return subtitleContent;
  }

  extractEntries(subtitleContent) {
    const content = this.stripContext(String(subtitleContent || '')).replace(/\r\n/g, '\n').trim();
    if (!content) return { type: 'raw', entries: [] };

    // SRT-style payload
    if (content.includes('-->')) {
      const parsed = parseSRT(content);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return {
          type: 'srt',
          entries: parsed.map((entry, idx) => ({
            index: idx,
            text: entry.text || '',
            timecode: entry.timecode || '',
            id: entry.id
          }))
        };
      }
    }

    // Numbered list format (1. text)
    const entries = [];
    const pattern = /(\d+)[.):-]+\s+([\s\S]*?)(?=\n+\d+[.):-]+\s+|$)/g;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const text = (match[2] || '').trim();
      if (!text) continue;
      entries.push({ index: entries.length, text });
    }

    if (entries.length > 0) {
      return { type: 'numbered', entries };
    }

    // Fallback: single block
    return { type: 'raw', entries: [{ index: 0, text: content }] };
  }

  buildRequestPayload(text) {
    return {
      client: 'gtx',
      sl: 'auto',
      tl: this.targetCode,
      dt: 't',
      q: text
    };
  }

  async callTranslate(text) {
    const payload = this.buildRequestPayload(text);
    const response = await axios.get(this.baseUrl, {
      params: payload,
      headers: { 'User-Agent': 'SubMaker/1.0' },
      timeout: this.translationTimeout,
      httpAgent,
      httpsAgent
    });

    if (!response.data || !Array.isArray(response.data)) {
      throw new Error('Unexpected Google Translate response');
    }

    // response.data[0] is an array of segments: [[translated, original, ...], ...]
    const segments = Array.isArray(response.data[0]) ? response.data[0] : [];
    const translated = segments.map(seg => (Array.isArray(seg) ? seg[0] : '')).join('');
    if (!translated) {
      throw new Error('Empty translation from Google Translate');
    }
    return translated;
  }

  splitResult(translatedJoined, expected) {
    let parts = translatedJoined.split(this.delimiter);
    if (parts.length !== expected && parts.length > 0) {
      // Try to heal small mismatches (e.g., delimiter spacing removal)
      const diff = expected - parts.length;
      if (diff > 0 && parts.length === 1) {
        // Split on spaces if all merged
        const words = parts[0].split(' ');
        if (words.length >= expected) {
          parts = words.slice(0, expected);
        }
      }
    }
    // Pad or trim to expected length
    if (parts.length < expected) {
      while (parts.length < expected) parts.push(parts[parts.length - 1] || '');
    } else if (parts.length > expected) {
      parts = parts.slice(0, expected);
    }
    return parts.map(p => String(p || '').trim());
  }

  rebuildOutput(type, originalEntries, translatedParts) {
    if (type === 'srt') {
      const rebuilt = originalEntries.map((entry, idx) => ({
        id: entry.id || idx + 1,
        timecode: entry.timecode || '00:00:00,000 --> 00:00:05,000',
        text: translatedParts[idx] || entry.text || ''
      }));
      return toSRT(rebuilt).trim();
    }

    // Numbered/Raw formats -> numbered list
    return translatedParts
      .map((text, idx) => `${idx + 1}. ${text || originalEntries[idx]?.text || ''}`)
      .join('\n\n');
  }

  async translateSubtitle(subtitleContent, sourceLanguage, targetLanguage) {
    const targetCode = this.normalizeLanguage(targetLanguage);
    if (!targetCode) {
      throw new Error('Target language is required for Google Translate');
    }
    this.targetCode = targetCode;

    const { type, entries } = this.extractEntries(subtitleContent);
    if (!entries || entries.length === 0) {
      throw new Error('No subtitle entries to translate');
    }

    const texts = entries.map(e => e.text);
    const joined = texts.join(` ${this.delimiter} `);

    let lastError;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const translatedJoined = await this.callTranslate(joined);
        const parts = this.splitResult(translatedJoined, texts.length);
        const cleaned = parts.map(p => this.cleanTranslatedText(p));
        return this.rebuildOutput(type, entries, cleaned);
      } catch (error) {
        lastError = error;
        if (attempt < this.maxRetries) {
          log.warn(() => [`[${this.providerName}] Retry ${attempt + 1}/${this.maxRetries} after error:`, error.message]);
          continue;
        }
        error.translationErrorType = 'PROVIDER_ERROR';
        throw error;
      }
    }
    if (lastError) throw lastError;
    throw new Error('Google Translate failed');
  }

  async streamTranslateSubtitle(subtitleContent, sourceLanguage, targetLanguage, customPrompt = null, onPartial = null) {
    // Streaming is not supported; fall back to full translation
    const full = await this.translateSubtitle(subtitleContent, sourceLanguage, targetLanguage, customPrompt);
    if (typeof onPartial === 'function') {
      try { await onPartial(full); } catch (_) {}
    }
    return full;
  }

  async countTokensForTranslation() {
    return null; // Not supported
  }

  estimateTokenCount(text) {
    if (!text) return 0;
    // Google Translate doesn't use tokens — this is just a size proxy for the engine.
    return Math.max(1, Math.ceil(String(text).length / 4));
  }

  buildUserPrompt(subtitleContent, targetLanguage) {
    // Provided for API compatibility; Google Translate ignores prompts
    return {
      userPrompt: subtitleContent,
      systemPrompt: '',
      normalizedTarget: this.normalizeLanguage(targetLanguage) || ''
    };
  }

  cleanTranslatedText(text) {
    let cleaned = String(text || '').trim();
    cleaned = cleaned.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '');
    cleaned = cleaned.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    return cleaned.trim();
  }
}

module.exports = GoogleTranslateProvider;
