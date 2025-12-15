const { allLanguages } = require('./allLanguages');
const { getLanguageName } = require('./languages');

function normalizeCodeKey(code) {
  return String(code || '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-');
}

function normalizeNameKey(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[()]/g, '')
    .replace(/_/g, ' ')
    .replace(/-/g, ' ')
    .trim();
}

const CODE_TO_NAME = new Map();
const NAME_TO_CODE = new Map();

for (const entry of allLanguages || []) {
  if (!entry) continue;
  const code = String(entry.code || '').trim();
  const name = String(entry.name || '').trim();
  if (!code || !name) continue;

  const codeKey = normalizeCodeKey(code);
  const nameKey = normalizeNameKey(name);

  if (codeKey) CODE_TO_NAME.set(codeKey, name);
  if (nameKey) NAME_TO_CODE.set(nameKey, code);
}

function resolveLanguageCode(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  const codeKey = normalizeCodeKey(raw);
  if (CODE_TO_NAME.has(codeKey)) {
    const display = CODE_TO_NAME.get(codeKey);
    const canonical = NAME_TO_CODE.get(normalizeNameKey(display));
    return canonical || raw;
  }

  const nameKey = normalizeNameKey(raw);
  if (NAME_TO_CODE.has(nameKey)) {
    return NAME_TO_CODE.get(nameKey);
  }

  if (/^[a-z]{3}(_tr)?$/i.test(raw)) {
    return raw.toLowerCase();
  }

  return null;
}

function resolveLanguageDisplayName(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  const iso = getLanguageName(raw);
  if (iso) return iso;

  const codeKey = normalizeCodeKey(raw);
  if (CODE_TO_NAME.has(codeKey)) {
    return CODE_TO_NAME.get(codeKey);
  }

  const nameKey = normalizeNameKey(raw);
  if (NAME_TO_CODE.has(nameKey)) {
    const code = NAME_TO_CODE.get(nameKey);
    const byCode = CODE_TO_NAME.get(normalizeCodeKey(code));
    if (byCode) return byCode;
  }

  return null;
}

module.exports = {
  resolveLanguageCode,
  resolveLanguageDisplayName
};

