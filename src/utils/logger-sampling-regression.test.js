const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const loggerPath = path.join(__dirname, 'logger.js');

function runLoggerSnippet(source, env = {}) {
  return spawnSync(process.execPath, ['-e', source], {
    cwd: path.join(__dirname, '..', '..'),
    env: {
      ...process.env,
      LOG_TO_FILE: 'false',
      LOG_LEVEL: 'debug',
      ...env
    },
    encoding: 'utf8'
  });
}

test('logger sampling never drops warn/error by default', () => {
  const script = `
    const log = require(${JSON.stringify(loggerPath)});
    for (let i = 0; i < 5; i++) log.warn(() => 'warn-visible-' + i);
    for (let i = 0; i < 5; i++) log.error(() => 'error-visible-' + i);
  `;

  const result = runLoggerSnippet(script, {
    LOG_LEVEL: 'warn',
    LOG_SAMPLE_RATE: '0.001'
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const output = `${result.stdout}\n${result.stderr}`;
  for (let i = 0; i < 5; i++) {
    assert.match(output, new RegExp(`warn-visible-${i}`));
    assert.match(output, new RegExp(`error-visible-${i}`));
  }
});

test('logger keeps operational warnings visible under request trace pressure', () => {
  const operationalWarnings = [
    '[ConfigResolver] Session token not found: bedadbea..., returning default config with error flag',
    '[Subtitles] Session token error detected - returning config error entry',
    '[SCS] Search failed (403): Request failed with status code 403',
    '[WyzieSubs] Search rejected: Invalid API key',
    '[WyzieSubs] API key is required for Wyzie search requests'
  ];
  const script = `
    const log = require(${JSON.stringify(loggerPath)});
    const operationalWarnings = ${JSON.stringify(operationalWarnings)};
    for (let i = 0; i < 2000; i++) {
      log.warn(() => '[Request Trace] >>> GET /addon/token/subtitles/movie/tt' + i + '/filename=x');
      if (i < operationalWarnings.length) log.warn(() => operationalWarnings[i]);
    }
  `;

  const result = runLoggerSnippet(script, {
    LOG_LEVEL: 'warn',
    LOG_SAMPLE_RATE: '0.001'
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const output = `${result.stdout}\n${result.stderr}`;
  for (const message of operationalWarnings) {
    assert.match(output, new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('logger allows sample rate 0 for debug/info while preserving warn/error', () => {
  const script = `
    const log = require(${JSON.stringify(loggerPath)});
    log.debug(() => 'debug-hidden');
    log.info(() => 'info-hidden');
    log.warn(() => 'warn-visible');
    log.error(() => 'error-visible');
  `;

  const result = runLoggerSnippet(script, {
    LOG_LEVEL: 'debug',
    LOG_SAMPLE_RATE: '0'
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const output = `${result.stdout}\n${result.stderr}`;
  assert.doesNotMatch(output, /debug-hidden/);
  assert.doesNotMatch(output, /info-hidden/);
  assert.match(output, /warn-visible/);
  assert.match(output, /error-visible/);
});
