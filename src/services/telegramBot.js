const axios = require('axios');
const os = require('os');
const { getStorageAdapter } = require('../storage/StorageFactory');
const { StorageAdapter } = require('../storage');

const REGISTRY_REDIS_KEY = 'stremio:sub_registry';
const KEY_STATS_REDIS_KEY = 'stremio:key_stats';
const ITEMS_PER_PAGE = 5;

// Format saiz bait ke format mudah dibaca (MB/GB)
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`;
}

// Format masa operasi (Uptime)
function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts = [];
  if (d > 0) parts.push(`${d}h`);
  if (h > 0) parts.push(`${h}j`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

// Hierarki Resolusi Bahasa Sasaran
function resolveTargetLang(lang) {
  if (lang && typeof lang === 'string' && lang.trim().length > 0) {
    return lang.trim().toUpperCase();
  }
  const envDefault = process.env.DEFAULT_TARGET_LANG || process.env.TARGET_LANGUAGE;
  if (envDefault && typeof envDefault === 'string' && envDefault.trim().length > 0) {
    return envDefault.trim().toUpperCase();
  }
  return 'EN';
}

/**
 * Resolves the optimal translation batch size based on model architecture and versioning.
 * Implements a future-proof tiered heuristic balancing token throughput, inference latency, and context integrity.
 *
 * Tier Hierarchy:
 * - ENV Override > Lightweight/Gemma (200) > Flash 3.0+ (400) > Pro 2.5+ / Flash 2.x (300) > Default (250)
 *
 * @param {string} model - Gemini/LLM model identifier
 * @returns {number} Batch size (entries per translation payload)
 */
function getBatchSizeForModel(model) {
  // 1. Environment variable override (highest priority)
  if (process.env.TRANSLATION_BATCH_SIZE) {
    return parseInt(process.env.TRANSLATION_BATCH_SIZE, 10);
  }

  const modelStr = String(model || '').toLowerCase().replace(/_/g, '-');

  // 2. Lightweight & edge tier: Conservative batch sizing to preserve strict formatting and context stability
  if (modelStr.includes('gemma') || modelStr.includes('flash-lite') || modelStr.includes('lite')) {
    return 200;
  }

  // 3. Extract semantic version (handles 'gemini-3.5-flash', 'gemini-4-flash', '3-flash', etc.)
  const versionMatch = modelStr.match(/(?:gemini-)?(\d+(?:\.\d+)?)/);
  const version = versionMatch ? parseFloat(versionMatch[1]) : 0;

  // 4. Reasoning & Pro tier: Balanced against latency penalty and retry overhead
  if (modelStr.includes('pro')) {
    if (version >= 2.5) return 300; // Modern Pro architectures (2.5, 3.1, 3.7, 4.0+)
    return 250;                     // Legacy Pro (1.5)
  }

  // 5. Flash tier: Optimized for high-throughput context windows
  if (modelStr.includes('flash')) {
    if (version >= 3.0) return 400; // Next-gen Flash architectures (3.0, 3.5, 3.7, 4.0+)
    if (version >= 2.0) return 300; // Mid-gen Flash (2.0, 2.5)
    return 250;                     // Legacy Flash (1.5)
  }

  // 6. Safe baseline fallback for unmapped architectures
  return 250;
}

// Pangkalan Data Harga & Spesifikasi Model AI
function getModelSpec(modelName) {
  const m = String(modelName || '').toLowerCase().replace(/_/g, '-');
  const batchSize = getBatchSizeForModel(m);

  let inputPrice = 0.25;
  let outputPrice = 1.50;
  let cleanName = '3.1-Flash-Lite';

  if (m.includes('3.1-pro')) {
    inputPrice = 2.00; outputPrice = 12.00; cleanName = '3.1-Pro';
  } else if (m.includes('2.5-pro')) {
    inputPrice = 1.25; outputPrice = 10.00; cleanName = '2.5-Pro';
  } else if (m.includes('1.5-pro')) {
    inputPrice = 1.25; outputPrice = 5.00; cleanName = '1.5-Pro';
  } else if (m.includes('3.5-flash-lite')) {
    inputPrice = 0.30; outputPrice = 2.50; cleanName = '3.5-Flash-Lite';
  } else if (m.includes('3.1-flash-lite') || m.includes('flash-lite')) {
    inputPrice = 0.25; outputPrice = 1.50; cleanName = '3.1-Flash-Lite';
  } else if (m.includes('2.5-flash-lite')) {
    inputPrice = 0.10; outputPrice = 0.40; cleanName = '2.5-Flash-Lite';
  } else if (m.includes('3.7-flash')) {
    inputPrice = 0.75; outputPrice = 3.75; cleanName = '3.7-Flash';
  } else if (m.includes('3.6-flash')) {
    inputPrice = 0.75; outputPrice = 3.75; cleanName = '3.6-Flash';
  } else if (m.includes('3.5-flash')) {
    inputPrice = 1.50; outputPrice = 9.00; cleanName = '3.5-Flash';
  } else if (m.includes('3-flash') || m.includes('3.0-flash')) {
    inputPrice = 0.50; outputPrice = 3.00; cleanName = '3-Flash';
  } else if (m.includes('2.5-flash')) {
    inputPrice = 0.30; outputPrice = 2.50; cleanName = '2.5-Flash';
  } else if (m.includes('1.5-flash')) {
    inputPrice = 0.075; outputPrice = 0.30; cleanName = '1.5-Flash';
  } else if (m.includes('pro')) {
    inputPrice = 1.25; outputPrice = 10.00; cleanName = 'Gemini-Pro';
  } else if (m.includes('flash')) {
    inputPrice = 0.50; outputPrice = 3.00; cleanName = '3-Flash';
  }

  return {
    input: inputPrice,
    output: outputPrice,
    batchSize,
    name: cleanName
  };
}

// Semak baki langsung dari API CrazyRouter secara mandiri
async function fetchLiveCrazyRouterBalance() {
  const token = process.env.CRAZYROUTER_ACCESS_TOKEN;
  const userId = process.env.CRAZYROUTER_USER_ID;
  if (!token || !userId) return null;

  try {
    const res = await axios.get('https://crazyrouter.com/api/user/self', {
      headers: {
        'Authorization': `Bearer ${token}`,
        'New-Api-User': userId
      },
      timeout: 5000
    });
    if (res?.data?.success && res?.data?.data && typeof res.data.data.quota === 'number') {
      return res.data.data.quota / 500000;
    }
  } catch (err) {}
  return null;
}

// Analisis Kunci & Pengiraan Kapasiti Dinamik
function analyzeKeyList(rawKeys, currentModel = 'gemini-3.1-flash-lite', walletBalanceUSD = 0) {
  let keyList = [];
  if (Array.isArray(rawKeys)) {
    keyList = rawKeys.filter(k => typeof k === 'string' && k.trim().length > 0);
  } else if (typeof rawKeys === 'string' && rawKeys.trim().length > 0) {
    keyList = rawKeys.split(',').map(k => k.trim()).filter(Boolean);
  }

  const totalKeys = keyList.length;
  const crazyKeys = keyList.filter(k => k.startsWith('sk-')).length;
  const googleKeys = totalKeys - crazyKeys;

  const spec = getModelSpec(currentModel);
  const batchesPerEp = Math.ceil(1200 / spec.batchSize);

  // 1. Kapasiti Google Direct (Kuota 500 RPD)
  const googleDailyCapacity = googleKeys > 0 ? Math.floor((googleKeys * 500) / batchesPerEp) : 0;

  // 2. Kapasiti CrazyRouter (Baki Dompet USD & Diskaun 45%)
  const retailCostPerEp = ((25000 / 1000000) * spec.input) + ((15000 / 1000000) * spec.output);
  const crazyCostPerEp = retailCostPerEp * 0.55;
  const crazyWalletCapacity = (crazyCostPerEp > 0 && walletBalanceUSD > 0)
    ? Math.floor(walletBalanceUSD / crazyCostPerEp)
    : 0;

  let connectionType = 'Tiada Kunci Dikesan';
  if (crazyKeys > 0 && googleKeys > 0) {
    connectionType = 'Hybrid Pool (Google Direct + CrazyRouter)';
  } else if (crazyKeys > 0) {
    connectionType = 'CrazyRouter Proxy (Diskaun 45%)';
  } else if (googleKeys > 0) {
    connectionType = 'Google Direct API';
  }

  return {
    totalKeys,
    googleKeys,
    crazyKeys,
    connectionType,
    isCrazyRouter: crazyKeys > 0,
    modelName: spec.name,
    batchSize: spec.batchSize,
    batchesPerEp,
    walletBalanceUSD,
    googleDailyCapacity,
    crazyWalletCapacity,
    crazyCostPerEp
  };
}

// Pengesan Status Kunci Pintar (Live CrazyRouter Fetch + Redis Cache + Session)
async function getActiveKeyInfo() {
  const adapter = await getStorageAdapter();

  let savedStats = null;
  try {
    savedStats = await adapter.get(KEY_STATS_REDIS_KEY, StorageAdapter.CACHE_TYPES.TRANSLATION);
  } catch (e) {}

  const liveWalletUSD = await fetchLiveCrazyRouterBalance();
  let walletBalanceUSD = (typeof liveWalletUSD === 'number')
    ? liveWalletUSD
    : (typeof savedStats?.walletBalanceUSD === 'number' ? savedStats.walletBalanceUSD : 0);

  let discoveredKeys = [];
  let detectedModel = savedStats?.modelName || process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';

  try {
    const { getSessionManager } = require('../utils/sessionManager');
    const sm = typeof getSessionManager === 'function' ? getSessionManager() : null;
    if (sm) {
      const sessionList = sm.sessions instanceof Map
        ? Array.from(sm.sessions.values())
        : (sm.sessions && typeof sm.sessions === 'object' ? Object.values(sm.sessions) : []);

      for (const sess of sessionList) {
        const cfg = sess?.config || sess;
        if (cfg?.geminiModel || cfg?.model) detectedModel = cfg.geminiModel || cfg.model;

        const valid = Array.isArray(cfg?.geminiApiKeys)
          ? cfg.geminiApiKeys.filter(k => typeof k === 'string' && k.trim())
          : (cfg?.geminiApiKey ? [cfg.geminiApiKey] : (cfg?.apiKey ? [cfg.apiKey] : []));

        if (valid.length > 0) {
          discoveredKeys = valid;
          break;
        }
      }
    }
  } catch (e) {}

  if (discoveredKeys.length === 0) {
    const keyEnv = process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEYS || '';
    discoveredKeys = keyEnv.split(',').map(k => k.trim()).filter(Boolean);
  }

  if (discoveredKeys.length === 0 && savedStats && savedStats.totalKeys > 0) {
    discoveredKeys = savedStats.crazyKeys > 0 ? ['sk-cached'] : ['AIzaSy-cached'];
  } else if (discoveredKeys.length === 0 && process.env.CRAZYROUTER_ACCESS_TOKEN) {
    discoveredKeys = ['sk-crazyrouter'];
  }

  const result = analyzeKeyList(discoveredKeys, detectedModel, walletBalanceUSD);

  if (savedStats && discoveredKeys.length === 1 && (discoveredKeys[0] === 'sk-cached' || discoveredKeys[0] === 'AIzaSy-cached')) {
    result.totalKeys = savedStats.totalKeys;
    result.googleKeys = savedStats.googleKeys;
    result.crazyKeys = savedStats.crazyKeys;
    result.connectionType = savedStats.connectionType;
  }

  if (result.totalKeys > 0) {
    try {
      await adapter.set(KEY_STATS_REDIS_KEY, { ...result, updatedAt: Date.now() }, StorageAdapter.CACHE_TYPES.TRANSLATION);
    } catch (e) {}
  }

  return result;
}

// 1. Simpan rekod sarikata & status kunci ke Redis
async function registerCompletedSubtitle({ title, provider, targetLang, keys, apiKeys, model, walletBalanceUSD }) {
  try {
    const adapter = await getStorageAdapter();
    const id = 'sub_' + Math.random().toString(36).substring(2, 9);

    let existingStats = null;
    try {
      existingStats = await adapter.get(KEY_STATS_REDIS_KEY, StorageAdapter.CACHE_TYPES.TRANSLATION);
    } catch (e) {}

    let validKeys = [];
    if (Array.isArray(apiKeys)) {
      validKeys = apiKeys.filter(k => typeof k === 'string' && k.trim());
    } else if (typeof apiKeys === 'string' && apiKeys.trim()) {
      validKeys = apiKeys.split(',').map(k => k.trim()).filter(Boolean);
    }

    const usedKeys = validKeys.length > 0
      ? validKeys
      : (existingStats?.totalKeys ? (existingStats.crazyKeys > 0 ? ['sk-cached'] : ['AIzaSy-cached']) : ['sk-crazyrouter']);
    const usedModel = model || existingStats?.modelName || 'gemini-3.1-flash-lite';

    let finalWalletUSD = (typeof walletBalanceUSD === 'number' && walletBalanceUSD > 0) ? walletBalanceUSD : 0;
    if (finalWalletUSD === 0) {
      const live = await fetchLiveCrazyRouterBalance();
      finalWalletUSD = (typeof live === 'number' && live > 0) ? live : (existingStats?.walletBalanceUSD || 0);
    }

    const stats = analyzeKeyList(usedKeys, usedModel, finalWalletUSD);
    if (existingStats && validKeys.length === 0) {
      stats.totalKeys = existingStats.totalKeys;
      stats.googleKeys = existingStats.googleKeys;
      stats.crazyKeys = existingStats.crazyKeys;
      stats.connectionType = existingStats.connectionType;
    }

    await adapter.set(KEY_STATS_REDIS_KEY, { ...stats, updatedAt: Date.now() }, StorageAdapter.CACHE_TYPES.TRANSLATION);

    const entry = {
      id,
      title: title || 'Untitled Media',
      provider: provider || 'Generic Provider',
      targetLang: resolveTargetLang(targetLang),
      keys: Array.isArray(keys) ? keys : [keys].filter(Boolean),
      createdAt: Date.now()
    };

    const current = (await adapter.get(REGISTRY_REDIS_KEY, StorageAdapter.CACHE_TYPES.TRANSLATION)) || [];
    const list = Array.isArray(current) ? current : [];

    const filtered = list.filter(item => item.title !== entry.title || item.provider !== entry.provider);
    filtered.unshift(entry);

    await adapter.set(REGISTRY_REDIS_KEY, filtered, StorageAdapter.CACHE_TYPES.TRANSLATION);
    return id;
  } catch (err) {
    console.error(`[Telegram Bot] Gagal daftar registry: ${err.message}`);
    return null;
  }
}

// 2. Paparan Menu Utama
async function renderMainMenu(chatId, messageId, botToken) {
  try {
    const adapter = await getStorageAdapter();
    const list = (await adapter.get(REGISTRY_REDIS_KEY, StorageAdapter.CACHE_TYPES.TRANSLATION)) || [];
    const totalSubtitles = Array.isArray(list) ? list.length : 0;

    const text =
      `🎛️ <b>Papan Pemuka SubMaker VPS</b> ⚡\n\n` +
      `📦 <b>Sarikata Berdaftar:</b> ${totalSubtitles} fail\n` +
      `⏱️ <b>Bot Uptime:</b> ${formatUptime(process.uptime())}\n` +
      `🟢 <b>Status Enjin:</b> Aktif & Bersedia\n\n` +
      `Sila pilih menu di bawah untuk pengurusan:`;

    const reply_markup = {
      inline_keyboard: [
        [{ text: '📋 Senarai Subtitle Cache', callback_data: 'page:1' }],
        [
          { text: '📊 Status VPS & Server', callback_data: 'menu:server' },
          { text: '🔑 Status Kunci API', callback_data: 'menu:keys' }
        ],
        [
          { text: '💥 Flush Semua Cache', callback_data: 'menu:flush_confirm' },
          { text: '🔄 Refresh', callback_data: 'menu:main' }
        ]
      ]
    };

    if (messageId) {
      await axios.post(`https://api.telegram.org/bot${botToken}/editMessageText`, {
        chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', reply_markup
      });
    } else {
      await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        chat_id: chatId, text, parse_mode: 'HTML', reply_markup
      });
    }
  } catch (err) {
    console.error(`[Telegram Bot] Ralat render main menu: ${err.message}`);
  }
}

// 3. Paparan Status Server VPS
async function renderServerStatus(chatId, messageId, botToken) {
  try {
    const mem = process.memoryUsage();
    const freeMem = os.freemem();
    const totalMem = os.totalmem();
    const usedMem = totalMem - freeMem;

    let redisStatus = '🟢 Bersambung (Sihat)';
    try {
      const adapter = await getStorageAdapter();
      const isHealthy = await adapter.healthCheck();
      if (!isHealthy) redisStatus = '🔴 Terputus / Ralat';
    } catch (e) {
      redisStatus = '🔴 Ralat Sambungan';
    }

    const text =
      `📊 <b>Status Pelayan & VPS (Live)</b> 🖥️\n\n` +
      `🧠 <b>RAM VPS:</b> ${formatBytes(usedMem)} / ${formatBytes(totalMem)} (${Math.round((usedMem / totalMem) * 100)}%)\n` +
      `📦 <b>RAM Node.js:</b> ${formatBytes(mem.rss)} (Heap: ${formatBytes(mem.heapUsed)})\n` +
      `⏱️ <b>VPS Uptime:</b> ${formatUptime(os.uptime())}\n` +
      `⚡ <b>Container Uptime:</b> ${formatUptime(process.uptime())}\n` +
      `🗄️ <b>Storan Redis:</b> ${redisStatus}\n` +
      `💻 <b>Platform:</b> ${os.type()} ${os.arch()} (${os.cpus().length} vCPU)\n\n` +
      `<i>Status disemak secara langsung dari proses VPS.</i>`;

    const reply_markup = {
      inline_keyboard: [
        [
          { text: '🔄 Muat Semula Status', callback_data: 'menu:server' },
          { text: '🔙 Menu Utama', callback_data: 'menu:main' }
        ]
      ]
    };

    if (messageId) {
      await axios.post(`https://api.telegram.org/bot${botToken}/editMessageText`, {
        chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', reply_markup
      });
    } else {
      await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        chat_id: chatId, text, parse_mode: 'HTML', reply_markup
      });
    }
  } catch (err) {
    console.error(`[Telegram Bot] Ralat render server: ${err.message}`);
  }
}

// 4. Paparan Status API Keys
async function renderApiKeysStatus(chatId, messageId, botToken) {
  try {
    const keyInfo = await getActiveKeyInfo();
    const totalKeys = keyInfo.totalKeys;

    let keyDetail = `🔢 <b>Jumlah Kunci Dikesan:</b> ${totalKeys} Kunci Aktif\n`;
    if (keyInfo.googleKeys > 0 && keyInfo.crazyKeys > 0) {
      keyDetail = `🔢 <b>Jumlah Kunci Dikesan:</b> ${totalKeys} Kunci Aktif (Hybrid)\n` +
                  `   ├ 🌐 <b>Google Direct:</b> ${keyInfo.googleKeys} Kunci\n` +
                  `   └ ⚡ <b>CrazyRouter:</b> ${keyInfo.crazyKeys} Kunci\n`;
    }

    let capacityLine = '';
    if (keyInfo.crazyKeys > 0 && keyInfo.googleKeys === 0) {
      const walletTxt = keyInfo.walletBalanceUSD > 0
        ? `$${keyInfo.walletBalanceUSD.toFixed(2)} (RM ${(keyInfo.walletBalanceUSD * 4.05).toFixed(2)})`
        : 'Sila tunggu pengesahan baki';
      capacityLine =
        `💳 <b>Baki Dompet:</b> ${walletTxt}\n` +
        `📊 <b>Baki Kapasiti Dompet:</b> ±${keyInfo.crazyWalletCapacity.toLocaleString()} episod (${keyInfo.modelName}, Batch ${keyInfo.batchSize})\n` +
        `💸 <b>Anggaran Kos / Episod:</b> ~$${keyInfo.crazyCostPerEp.toFixed(4)} (Diskaun 45% Aktif)`;
    } else if (keyInfo.googleKeys > 0 && keyInfo.crazyKeys === 0) {
      capacityLine = `📊 <b>Kapasiti Batch ${keyInfo.batchSize}:</b> ±${keyInfo.googleDailyCapacity.toLocaleString()} episod/hari (${keyInfo.modelName})`;
    } else {
      capacityLine =
        `📊 <b>Kapasiti Google (RPD):</b> ±${keyInfo.googleDailyCapacity.toLocaleString()} episod/hari\n` +
        `💳 <b>Kapasiti Dompet CrazyRouter:</b> ±${keyInfo.crazyWalletCapacity.toLocaleString()} episod ($${keyInfo.walletBalanceUSD.toFixed(2)})`;
    }

    const text =
      `🔑 <b>Status Kolam API Kunci</b> 🛡️\n\n` +
      keyDetail +
      `🧠 <b>Enjin Semasa:</b> ${keyInfo.modelName}\n` +
      `🔄 <b>Mod Giliran:</b> Auto-Rotation (${keyInfo.batchesPerEp} Batch / Episod)\n` +
      `🎯 <b>Jenis Sambungan:</b> ${keyInfo.connectionType}\n` +
      `${capacityLine}\n\n` +
      `<i>Kapasiti dikira secara dinamik berpandukan model AI dan baki dompet aktif.</i>`;

    const reply_markup = {
      inline_keyboard: [
        [
          { text: '🔄 Semak Semula', callback_data: 'menu:keys' },
          { text: '🔙 Menu Utama', callback_data: 'menu:main' }
        ]
      ]
    };

    if (messageId) {
      await axios.post(`https://api.telegram.org/bot${botToken}/editMessageText`, {
        chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', reply_markup
      });
    } else {
      await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        chat_id: chatId, text, parse_mode: 'HTML', reply_markup
      });
    }
  } catch (err) {
    console.error(`[Telegram Bot] Ralat render keys: ${err.message}`);
  }
}

// 5. Paparan Senarai Sarikata
async function renderRegistryPage(chatId, messageId, page = 1, botToken) {
  try {
    const adapter = await getStorageAdapter();
    const list = (await adapter.get(REGISTRY_REDIS_KEY, StorageAdapter.CACHE_TYPES.TRANSLATION)) || [];

    if (!Array.isArray(list) || list.length === 0) {
      const emptyText = '📭 <b>Tiada Sarikata Dalam Cache VPS</b>\n\nSemua cache sarikata kosong atau telah dipadam.';
      const emptyMarkup = {
        inline_keyboard: [
          [{ text: '🔄 Refresh', callback_data: 'page:1' }],
          [{ text: '🔙 Menu Utama', callback_data: 'menu:main' }]
        ]
      };

      if (messageId) {
        await axios.post(`https://api.telegram.org/bot${botToken}/editMessageText`, {
          chat_id: chatId, message_id: messageId, text: emptyText, parse_mode: 'HTML', reply_markup: emptyMarkup
        });
      } else {
        await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          chat_id: chatId, text, parse_mode: 'HTML', reply_markup: emptyMarkup
        });
      }
      return;
    }

    const totalItems = list.length;
    const totalPages = Math.ceil(totalItems / ITEMS_PER_PAGE);
    const currentPage = Math.max(1, Math.min(page, totalPages));
    const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
    const pageItems = list.slice(startIndex, startIndex + ITEMS_PER_PAGE);

    let text = `📋 <b>Senarai Sarikata Cache VPS (Jumlah: ${totalItems})</b>\n`;
    text += `📄 <i>Halaman ${currentPage} daripada ${totalPages}</i>\n\n`;

    const buttons = [];
    const deleteRow = [];

    pageItems.forEach((item, index) => {
      const itemNum = startIndex + index + 1;
      const safeTitle = item.title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

      text += `<b>${itemNum}.</b> 🎬 <code>${safeTitle}</code>\n`;
      text += `   └ 📥 <b>Source:</b> ${item.provider} | 🌐 ${item.targetLang}\n\n`;

      deleteRow.push({ text: `🗑️ Padam #${itemNum}`, callback_data: `del_reg:${item.id}:${currentPage}` });
    });

    for (let i = 0; i < deleteRow.length; i += 2) {
      buttons.push(deleteRow.slice(i, i + 2));
    }

    const navRow = [];
    if (currentPage > 1) {
      navRow.push({ text: '⬅️ Prev', callback_data: `page:${currentPage - 1}` });
    }
    navRow.push({ text: '🔄 Refresh', callback_data: `page:${currentPage}` });
    if (currentPage < totalPages) {
      navRow.push({ text: 'Next ➡️', callback_data: `page:${currentPage + 1}` });
    }
    buttons.push(navRow);
    buttons.push([{ text: '🔙 Menu Utama', callback_data: 'menu:main' }]);

    if (messageId) {
      await axios.post(`https://api.telegram.org/bot${botToken}/editMessageText`, {
        chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons }
      });
    } else {
      await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        chat_id: chatId, text, parse_mode: 'HTML', reply_markup: { inline_keyboard: buttons }
      });
    }
  } catch (err) {
    console.error(`[Telegram Bot] Ralat render page: ${err.message}`);
  }
}

// 6. Enjin Pemula & Polling
async function startTelegramBot() {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const authorizedChatId = String(process.env.TELEGRAM_CHAT_ID || '').trim();

  if (!botToken || !authorizedChatId) return;

  console.log('[Telegram Bot] 🤖 Enjin bot interaktif Dashboard & 2-Hala dimulakan...');

  let offset = 0;

  const poll = async () => {
    try {
      const response = await axios.get(`https://api.telegram.org/bot${botToken}/getUpdates`, {
        params: { offset, timeout: 25 },
        timeout: 30000
      });

      if (response.data && response.data.ok && Array.isArray(response.data.result)) {
        for (const update of response.data.result) {
          offset = update.update_id + 1;

          if (update.callback_query) {
            await handleCallbackQuery(update.callback_query, botToken, authorizedChatId);
          }

          if (update.message && update.message.text) {
            await handleTextMessage(update.message, botToken, authorizedChatId);
          }
        }
      }
    } catch (err) {
      if (err.code !== 'ECONNABORTED') {
        await new Promise(res => setTimeout(res, 3000));
      }
    }

    setImmediate(poll);
  };

  poll();
}

async function handleTextMessage(message, botToken, authorizedChatId) {
  const fromChatId = String(message.chat?.id || '');
  const text = (message.text || '').trim();

  if (fromChatId !== authorizedChatId) return;

  if (text === '/start') {
    await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      chat_id: fromChatId,
      text: '👋 <b>Selamat Datang ke Panel Kawalan SubMaker!</b>\n\nPapan kekunci menu telah diaktifkan:',
      parse_mode: 'HTML',
      reply_markup: {
        keyboard: [
          [{ text: '🎛️ Menu Utama' }, { text: '📋 Senarai Subtitle' }],
          [{ text: '📊 Status VPS' }, { text: '🔑 Status Keys' }]
        ],
        resize_keyboard: true
      }
    });
    await renderMainMenu(fromChatId, null, botToken);
    return;
  }

  if (text === '/menu' || text === '🎛️ Menu Utama') {
    await renderMainMenu(fromChatId, null, botToken);
  } else if (text === '/list' || text === '📋 Senarai Subtitle') {
    await renderRegistryPage(fromChatId, null, 1, botToken);
  } else if (text === '/server' || text === '📊 Status VPS') {
    await renderServerStatus(fromChatId, null, botToken);
  } else if (text === '/keys' || text === '🔑 Status Keys') {
    await renderApiKeysStatus(fromChatId, null, botToken);
  }
}

async function handleCallbackQuery(query, botToken, authorizedChatId) {
  const fromChatId = String(query.message?.chat?.id || query.from?.id || '');
  const callbackData = String(query.data || '');
  const messageId = query.message?.message_id;

  if (fromChatId !== authorizedChatId) {
    try {
      await axios.post(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
        callback_query_id: query.id, text: '⛔ Akses Ditolak!', show_alert: true
      });
    } catch (e) {}
    return;
  }

  if (callbackData === 'menu:main') {
    await renderMainMenu(fromChatId, messageId, botToken);
    try { await axios.post(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, { callback_query_id: query.id }); } catch (e) {}
  } else if (callbackData === 'menu:server') {
    await renderServerStatus(fromChatId, messageId, botToken);
    try { await axios.post(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, { callback_query_id: query.id }); } catch (e) {}
  } else if (callbackData === 'menu:keys') {
    await renderApiKeysStatus(fromChatId, messageId, botToken);
    try { await axios.post(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, { callback_query_id: query.id }); } catch (e) {}
  } else if (callbackData === 'menu:flush_confirm') {
    const text =
      `⚠️ <b>AMARAN: Kosongkan Semua Cache?</b>\n\n` +
      `Tindakan ini akan memadam semua pendaftaran sarikata di Redis. Semua terjemahan seterusnya akan dijana semula dari awal.`;

    const reply_markup = {
      inline_keyboard: [
        [
          { text: '💥 Ya, Padam Semua!', callback_data: 'menu:flush_do' },
          { text: '❌ Batal', callback_data: 'menu:main' }
        ]
      ]
    };

    await axios.post(`https://api.telegram.org/bot${botToken}/editMessageText`, {
      chat_id: fromChatId, message_id: messageId, text, parse_mode: 'HTML', reply_markup
    });
    try { await axios.post(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, { callback_query_id: query.id }); } catch (e) {}
  } else if (callbackData === 'menu:flush_do') {
    try {
      const adapter = await getStorageAdapter();
      const list = (await adapter.get(REGISTRY_REDIS_KEY, StorageAdapter.CACHE_TYPES.TRANSLATION)) || [];

      if (Array.isArray(list)) {
        for (const item of list) {
          for (const key of (item.keys || [])) {
            await adapter.delete(key, StorageAdapter.CACHE_TYPES.SUBTITLES);
            await adapter.delete(key, StorageAdapter.CACHE_TYPES.BYPASS);
            await adapter.delete(key, StorageAdapter.CACHE_TYPES.PARTIAL);
            await adapter.delete(key, StorageAdapter.CACHE_TYPES.TRANSLATION);
          }
        }
      }

      await adapter.delete(REGISTRY_REDIS_KEY, StorageAdapter.CACHE_TYPES.TRANSLATION);

      await axios.post(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
        callback_query_id: query.id, text: '💥 Semua cache sarikata telah dibersihkan!', show_alert: true
      });
      await renderMainMenu(fromChatId, messageId, botToken);
    } catch (err) {
      console.error(`[Telegram Bot] Ralat flush: ${err.message}`);
    }
  } else if (callbackData.startsWith('page:')) {
    const targetPage = parseInt(callbackData.split(':')[1], 10) || 1;
    await renderRegistryPage(fromChatId, messageId, targetPage, botToken);
    try { await axios.post(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, { callback_query_id: query.id }); } catch (e) {}
  } else if (callbackData.startsWith('del_reg:')) {
    const [, targetId, pageStr] = callbackData.split(':');
    const page = parseInt(pageStr, 10) || 1;

    try {
      const adapter = await getStorageAdapter();
      const list = (await adapter.get(REGISTRY_REDIS_KEY, StorageAdapter.CACHE_TYPES.TRANSLATION)) || [];

      const itemIndex = list.findIndex(item => item.id === targetId);
      if (itemIndex !== -1) {
        const item = list[itemIndex];

        for (const key of item.keys) {
          await adapter.delete(key, StorageAdapter.CACHE_TYPES.SUBTITLES);
          await adapter.delete(key, StorageAdapter.CACHE_TYPES.BYPASS);
          await adapter.delete(key, StorageAdapter.CACHE_TYPES.PARTIAL);
          await adapter.delete(key, StorageAdapter.CACHE_TYPES.TRANSLATION);
        }

        list.splice(itemIndex, 1);
        await adapter.set(REGISTRY_REDIS_KEY, list, StorageAdapter.CACHE_TYPES.TRANSLATION);

        await axios.post(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
          callback_query_id: query.id, text: '🗑️ Sarikata berjaya dipadam!', show_alert: false
        });

        await renderRegistryPage(fromChatId, messageId, page, botToken);
      } else {
        await axios.post(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
          callback_query_id: query.id, text: 'ℹ️ Sarikata ini telah pun dipadam sebelum ini.', show_alert: false
        });
        await renderRegistryPage(fromChatId, messageId, page, botToken);
      }
    } catch (err) {
      console.error(`[Telegram Bot] Ralat padam registry: ${err.message}`);
    }
  }
}

module.exports = {
  startTelegramBot,
  registerCompletedSubtitle
};
