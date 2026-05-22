const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.LOG_TO_FILE = 'false';
process.env.LOG_LEVEL = 'error';
process.env.OPENSUBTITLES_API_KEY = process.env.OPENSUBTITLES_API_KEY || 'test-api-key';

test('OpenSubtitles Auth does not define login backoff/cooldown controls', () => {
  const OpenSubtitlesService = require('./opensubtitles');
  const source = fs.readFileSync(path.join(__dirname, 'opensubtitles.js'), 'utf8');
  const exportedTestingApi = OpenSubtitlesService.__testing || {};

  for (const token of [
    'OPENSUBTITLES_LOGIN_BACKOFF',
    'LOGIN_RATE_LIMIT_BACKOFF',
    'DISTRIBUTED_LOGIN_BACKOFF',
    'recordOpenSubtitlesLoginRateLimit',
    'getOpenSubtitlesLoginBackoff',
    'clearOpenSubtitlesLoginBackoff',
    'assertOpenSubtitlesLoginBackoffClear',
    'createLoginBackoffError',
    'temporarily cooling down'
  ]) {
    assert.equal(source.includes(token), false, `${token} should not exist in opensubtitles.js`);
  }

  assert.equal('recordOpenSubtitlesLoginRateLimit' in exportedTestingApi, false);
  assert.equal('getOpenSubtitlesLoginBackoff' in exportedTestingApi, false);
  assert.equal('clearOpenSubtitlesLoginBackoff' in exportedTestingApi, false);
});
