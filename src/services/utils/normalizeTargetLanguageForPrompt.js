const { resolveLanguageCode, resolveLanguageDisplayName } = require('../../utils/languageResolver');

function normalizeKey(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeTargetLanguageForPrompt(targetLanguage) {
  const raw = String(targetLanguage || '').trim();
  if (!raw) return 'target language';

  const resolvedName = resolveLanguageDisplayName(raw) || raw;
  const resolvedCode = resolveLanguageCode(raw) || raw;

  const nameKey = normalizeKey(resolvedName);
  const codeKey = normalizeKey(resolvedCode).replace(/_/g, '-');

  if (codeKey === 'pt-pt' || nameKey === 'portuguese (portugal)' || nameKey === 'portuguese portugal') {
    return 'European Portuguese (Português de Portugal)';
  }
  if (
    codeKey === 'pt-br' ||
    codeKey === 'pob' ||
    nameKey === 'portuguese (brazil)' ||
    nameKey === 'portuguese (brazilian)' ||
    nameKey === 'portuguese brazil' ||
    nameKey === 'portuguese brazilian' ||
    nameKey === 'brazilian portuguese'
  ) {
    return 'Brazilian Portuguese (Português do Brasil)';
  }
  if (nameKey === 'portuguese' || codeKey === 'pt') {
    return 'European Portuguese (Português de Portugal)';
  }

  if (codeKey === 'es-419' || nameKey.includes('latin america') || nameKey.includes('latam')) {
    return 'Latin American Spanish (Español de Latinoamérica)';
  }
  if (nameKey === 'spanish' || codeKey === 'es') {
    return 'Castilian Spanish (Español de España)';
  }

  if (codeKey === 'zh-hant' || nameKey.includes('traditional')) {
    return 'Traditional Chinese (繁體中文)';
  }
  if (codeKey === 'zh-hans' || nameKey.includes('simplified')) {
    return 'Simplified Chinese (简体中文)';
  }
  if (nameKey === 'chinese' || codeKey === 'zh') {
    return 'Simplified Chinese (简体中文)';
  }

  return resolvedName;
}

module.exports = { normalizeTargetLanguageForPrompt };
