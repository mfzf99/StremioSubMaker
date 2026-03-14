/**
 * ASS/SSA Translation Helper
 *
 * Provides utilities to translate ASS/SSA subtitles while preserving
 * the original document structure (Script Info, Styles, Events).
 *
 * Strategy:
 *   1. parseASSForTranslation()  — parse ASS, extract dialogue text + tags
 *   2. buildSRTFromASSDialogue() — build a temporary SRT for the translation engine
 *   3. reassembleASS()           — re-inject translated text into the original ASS structure
 */

const log = require('./logger');
const { parseSRT } = require('./subtitle');

/**
 * Convert ASS timecode (h:mm:ss.cc) to SRT timecode (HH:MM:SS,mmm)
 * @param {string} assTime - ASS format timecode, e.g. "0:01:23.45"
 * @returns {string} SRT format timecode, e.g. "00:01:23,450"
 */
function assTimeToSRT(assTime) {
  const m = String(assTime || '').trim().match(/(\d+):(\d{2}):(\d{2})\.(\d{2})/);
  if (!m) return '00:00:00,000';
  const h = parseInt(m[1], 10) || 0;
  const mi = parseInt(m[2], 10) || 0;
  const s = parseInt(m[3], 10) || 0;
  const cs = parseInt(m[4], 10) || 0;
  return (
    String(h).padStart(2, '0') + ':' +
    String(mi).padStart(2, '0') + ':' +
    String(s).padStart(2, '0') + ',' +
    String(cs * 10).padStart(3, '0')
  );
}

/**
 * Extract override tags and their positions from ASS dialogue text.
 * Tags are `{...}` blocks (typically starting with `\`).
 *
 * @param {string} rawText - Raw ASS dialogue text field (with tags and \N)
 * @returns {{ cleanText: string, tags: Array<{position: number, tag: string}> }}
 */
function extractTags(rawText) {
  const tags = [];
  let clean = '';
  let inTag = false;
  let currentTag = '';
  let cleanPos = 0;

  for (let i = 0; i < rawText.length; i++) {
    const ch = rawText[i];
    if (ch === '{') {
      inTag = true;
      currentTag = '{';
    } else if (ch === '}' && inTag) {
      currentTag += '}';
      tags.push({ position: cleanPos, tag: currentTag });
      inTag = false;
      currentTag = '';
    } else if (inTag) {
      currentTag += ch;
    } else {
      clean += ch;
      cleanPos++;
    }
  }

  // Convert ASS line breaks to \n for SRT, non-breaking space to space
  clean = clean
    .replace(/\\N/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\h/g, ' ');

  return { cleanText: clean, tags };
}

/**
 * Re-insert override tags into translated text using proportional position mapping.
 *
 * @param {string} translatedText - Translated clean text (may contain \n)
 * @param {Array<{position: number, tag: string}>} tags - Original tags with positions
 * @param {number} originalLength - Length of the original clean text (for proportion calc)
 * @returns {string} - Text with tags re-inserted and \n converted back to \N
 */
function reinsertTags(translatedText, tags, originalLength) {
  if (!tags || tags.length === 0) {
    // No tags to reinsert — just convert line breaks back
    return translatedText.replace(/\n/g, '\\N');
  }

  const translatedLen = translatedText.length;

  // Build an array of { mappedPos, tag } sorted by position
  const mappedTags = tags.map(t => {
    let mappedPos;
    if (t.position === 0) {
      mappedPos = 0; // Tags at start stay at start
    } else if (originalLength > 0 && t.position >= originalLength) {
      mappedPos = translatedLen; // Tags at end stay at end
    } else if (originalLength > 0) {
      // Proportional mapping
      mappedPos = Math.round((t.position / originalLength) * translatedLen);
      mappedPos = Math.min(mappedPos, translatedLen);
    } else {
      mappedPos = 0;
    }
    return { mappedPos, tag: t.tag };
  });

  // Sort by position descending so we can insert from right to left without shifting indices
  mappedTags.sort((a, b) => b.mappedPos - a.mappedPos);

  let result = translatedText;
  for (const { mappedPos, tag } of mappedTags) {
    const pos = Math.min(mappedPos, result.length);
    result = result.slice(0, pos) + tag + result.slice(pos);
  }

  // Convert \n back to ASS line breaks
  result = result.replace(/\n/g, '\\N');

  return result;
}

/**
 * Parse an ASS/SSA file for translation.
 * Extracts the document structure and dialogue entries with separated tags/text.
 *
 * @param {string} assContent - Raw ASS/SSA file content
 * @returns {{ header: string, formatLine: string, dialogueEntries: Array, footer: string, format: string }|null}
 */
function parseASSForTranslation(assContent) {
  if (!assContent || typeof assContent !== 'string') return null;

  const lines = assContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  // Detect format (ASS vs SSA)
  const hasV4Plus = /\[v4\+\s*styles\]/i.test(assContent);
  const format = hasV4Plus ? 'ass' : 'ssa';

  // Find [Events] section
  let eventsStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\[events\]\s*$/i.test(lines[i].trim())) {
      eventsStart = i;
      break;
    }
  }

  if (eventsStart === -1) {
    log.warn(() => '[ASSTranslationHelper] No [Events] section found');
    return null;
  }

  // Everything before [Events] is the header (Script Info, Styles, etc.)
  const header = lines.slice(0, eventsStart + 1).join('\n');

  // Find Format line in Events section
  let formatLine = '';
  let formatFields = [];
  let formatLineIndex = -1;

  for (let i = eventsStart + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (/^\[.*\]/.test(trimmed)) break; // Hit next section
    if (/^format\s*:/i.test(trimmed)) {
      formatLine = lines[i];
      formatLineIndex = i;
      formatFields = trimmed.split(':').slice(1).join(':').split(',').map(s => s.trim().toLowerCase());
      break;
    }
  }

  if (formatFields.length === 0) {
    log.warn(() => '[ASSTranslationHelper] No Format line found in [Events]');
    return null;
  }

  // Determine field indices
  const idxStart = formatFields.indexOf('start');
  const idxEnd = formatFields.indexOf('end');
  const idxText = formatFields.indexOf('text');

  if (idxText === -1) {
    log.warn(() => '[ASSTranslationHelper] No Text field in Format line');
    return null;
  }

  // The text field is always the last field — commas inside text are NOT separators
  const numFieldsBeforeText = idxText; // Number of commas to split on

  // Parse dialogue entries
  const dialogueEntries = [];
  const footerLines = [];
  let pastDialogue = false;

  for (let i = (formatLineIndex >= 0 ? formatLineIndex + 1 : eventsStart + 1); i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Check for next section (signals end of Events)
    if (/^\[.*\]/.test(trimmed)) {
      pastDialogue = true;
      footerLines.push(line);
      continue;
    }

    if (pastDialogue) {
      footerLines.push(line);
      continue;
    }

    // Skip non-Dialogue lines (Comments, empty lines, etc.) — preserve them
    if (!/^dialogue\s*:/i.test(trimmed)) {
      // Non-dialogue lines within Events (comments like "Comment:", empty lines)
      // We'll store them as non-dialogue entries to preserve order
      dialogueEntries.push({
        isDialogue: false,
        originalLine: line
      });
      continue;
    }

    // Parse Dialogue line
    // Split on commas, but only up to numFieldsBeforeText splits
    const colonPos = line.indexOf(':');
    if (colonPos === -1) continue;
    const payload = line.substring(colonPos + 1);

    const parts = [];
    let current = '';
    let splitCount = 0;
    for (let j = 0; j < payload.length; j++) {
      const ch = payload[j];
      if (ch === ',' && splitCount < numFieldsBeforeText) {
        parts.push(current);
        current = '';
        splitCount++;
      } else {
        current += ch;
      }
    }
    parts.push(current); // The remaining text field

    // Extract times and text
    const startTime = (idxStart >= 0 && idxStart < parts.length) ? parts[idxStart].trim() : '';
    const endTime = (idxEnd >= 0 && idxEnd < parts.length) ? parts[idxEnd].trim() : '';
    const rawText = parts[parts.length - 1] || ''; // Text is always last

    // Build prefix: everything before the text field (for reconstruction)
    const prefix = 'Dialogue:' + parts.slice(0, numFieldsBeforeText).join(',') + ',';

    // Extract tags and clean text
    const { cleanText, tags } = extractTags(rawText);

    dialogueEntries.push({
      isDialogue: true,
      originalLine: line,
      prefix,
      rawText,
      cleanText,
      tags,
      startTime,
      endTime,
      originalCleanLength: cleanText.length
    });
  }

  const actualDialogueCount = dialogueEntries.filter(e => e.isDialogue).length;
  if (actualDialogueCount === 0) {
    log.warn(() => '[ASSTranslationHelper] No Dialogue entries found');
    return null;
  }

  log.debug(() => `[ASSTranslationHelper] Parsed ${actualDialogueCount} dialogue entries (${format.toUpperCase()})`);

  return {
    header,
    formatLine,
    dialogueEntries,
    footer: footerLines.join('\n'),
    format
  };
}

/**
 * Build a temporary SRT string from parsed ASS dialogue entries.
 * This SRT is fed to the translation engine (which is SRT-in/SRT-out).
 *
 * @param {Array} dialogueEntries - Parsed dialogue entries from parseASSForTranslation
 * @returns {string} - SRT formatted content
 */
function buildSRTFromASSDialogue(dialogueEntries) {
  const srtBlocks = [];
  let srtIndex = 1;

  for (const entry of dialogueEntries) {
    if (!entry.isDialogue) continue;

    // Skip entries with empty clean text (e.g., drawing commands only)
    const text = entry.cleanText.trim();
    if (!text) continue;

    const startSRT = assTimeToSRT(entry.startTime);
    const endSRT = assTimeToSRT(entry.endTime);

    srtBlocks.push(
      `${srtIndex}\n${startSRT} --> ${endSRT}\n${text}`
    );
    srtIndex++;
  }

  return srtBlocks.join('\n\n') + '\n';
}

/**
 * Reassemble a complete ASS/SSA file by injecting translated text
 * back into the original document structure.
 *
 * @param {Object} parsedASS - Result from parseASSForTranslation
 * @param {string} translatedSRTContent - Translated SRT output from the translation engine
 * @returns {string} - Complete ASS/SSA file with translated dialogue text
 */
function reassembleASS(parsedASS, translatedSRTContent) {
  if (!parsedASS || !translatedSRTContent) {
    log.warn(() => '[ASSTranslationHelper] reassembleASS: missing input');
    return translatedSRTContent || '';
  }

  // Parse the translated SRT
  const translatedEntries = parseSRT(translatedSRTContent);
  if (!translatedEntries || translatedEntries.length === 0) {
    log.warn(() => '[ASSTranslationHelper] reassembleASS: no entries in translated SRT, returning original');
    // Rebuild the original ASS untranslated
    return rebuildASSFromParsed(parsedASS, null);
  }

  // Build translated text lookup by SRT index (1-based)
  const translatedTexts = new Map();
  for (const entry of translatedEntries) {
    translatedTexts.set(entry.id, entry.text);
  }

  return rebuildASSFromParsed(parsedASS, translatedTexts);
}

/**
 * Rebuild the ASS file from parsed structure, optionally replacing dialogue text.
 *
 * @param {Object} parsedASS - Parsed ASS structure
 * @param {Map<number, string>|null} translatedTexts - Map of SRT index → translated text (null = keep original)
 * @returns {string}
 */
function rebuildASSFromParsed(parsedASS, translatedTexts) {
  const outputLines = [];

  // Header (Script Info + Styles + [Events])
  outputLines.push(parsedASS.header);

  // Format line
  if (parsedASS.formatLine) {
    outputLines.push(parsedASS.formatLine);
  }

  // Dialogue entries (and non-dialogue lines like comments)
  let srtIndex = 1;
  for (const entry of parsedASS.dialogueEntries) {
    if (!entry.isDialogue) {
      // Non-dialogue line — preserve as-is
      outputLines.push(entry.originalLine);
      continue;
    }

    // Skip empty-text entries (same as buildSRTFromASSDialogue)
    const originalClean = entry.cleanText.trim();
    if (!originalClean) {
      // Preserve the original line (no SRT entry was generated for this)
      outputLines.push(entry.originalLine);
      continue;
    }

    // Look up translated text
    const translated = translatedTexts ? translatedTexts.get(srtIndex) : null;
    srtIndex++;

    if (translated !== undefined && translated !== null) {
      // Re-insert tags into translated text
      const taggedText = reinsertTags(translated, entry.tags, entry.originalCleanLength);
      outputLines.push(entry.prefix + taggedText);
    } else {
      // No translation available — keep original line
      outputLines.push(entry.originalLine);
    }
  }

  // Footer (any sections after Events, or trailing content)
  if (parsedASS.footer) {
    outputLines.push(parsedASS.footer);
  }

  return outputLines.join('\n');
}

module.exports = {
  parseASSForTranslation,
  buildSRTFromASSDialogue,
  reassembleASS,
  // Exported for testing
  assTimeToSRT,
  extractTags,
  reinsertTags
};
