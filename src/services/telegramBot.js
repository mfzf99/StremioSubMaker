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

// Pengesan Status Kunci API (Redis -> Session Manager -> ENV)
async function getActiveKeyInfo() {
  const adapter = await getStorageAdapter();

  // 1. Semak rekod status kunci yang dikemas kini dari proses terjemahan
  try {
    const savedStats = await adapter.get(KEY_STATS_REDIS_KEY, StorageAdapter.CACHE_TYPES.TRANSLATION);
    if (savedStats && typeof savedStats.totalKeys === 'number' && savedStats.totalKeys > 0) {
      return savedStats;
    }
  } catch (e) {}

  // 2. Semak Session Manager SubMaker dalam memori
  try {
    const { getSessionManager } = require('../utils/sessionManager');
    const sm = typeof getSessionManager === 'function' ? getSessionManager() : null;
    if (sm && sm.sessions) {
      for (const [, sess] of sm.sessions.entries()) {
        const cfg = sess?.config || sess;
        const validKeys = Array.isArray(cfg?.geminiApiKeys)
          ? cfg.geminiApiKeys.filter(k => typeof k === 'string' && k.trim())
          : [];

        if (validKeys.length > 0) {
          return {
            totalKeys: validKeys.length,
            isCrazyRouter: validKeys.some(k => String(k).trim().startsWith('sk-'))
          };
        }

        if (cfg?.geminiApiKey) {
          return {
            totalKeys: 1,
            isCrazyRouter: String(cfg.geminiApiKey).trim().startsWith('sk-')
          };
        }
      }
    }
  } catch (e) {}

  // 3. Semak Environment Variable (.env)
  const keyEnv = process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEYS || '';
  const keyArray = keyEnv.split(',').map(k => k.trim()).filter(Boolean);
  if (keyArray.length > 0) {
    return {
      totalKeys: keyArray.length,
      isCrazyRouter: keyArray.some(k => k.startsWith('sk-'))
    };
  }

  return { totalKeys: 0, isCrazyRouter: false };
}

// 1. Simpan rekod sarikata & status kunci ke Redis
async function registerCompletedSubtitle({ title, provider, targetLang, keys, keyCount, isCrazyRouter }) {
  try {
    const adapter = await getStorageAdapter();
    const id = 'sub_' + Math.random().toString(36).substring(2, 9);

    // Simpan maklumat kunci terkini
    if (typeof keyCount === 'number' && keyCount > 0) {
      await adapter.set(KEY_STATS_REDIS_KEY, {
        totalKeys: keyCount,
        isCrazyRouter: Boolean(isCrazyRouter),
        updatedAt: Date.now()
      }, StorageAdapter.CACHE_TYPES.TRANSLATION);
    }

    const entry = {
      id,
      title: title || 'Unknown Title',
      provider: provider || 'Unknown Provider',
      targetLang: (targetLang || 'MAY').toUpperCase(),
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

// 2. Paparan Menu Utama (Dashboard Utama)
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
    const isCrazyRouter = keyInfo.isCrazyRouter;
    const dailyCapacity = totalKeys > 0 ? Math.floor((totalKeys * 500) / 6) : 0;

    const text =
      `🔑 <b>Status Kolam API Kunci</b> 🛡️\n\n` +
      `🔢 <b>Jumlah Kunci Dikesan:</b> ${totalKeys} Kunci Aktif\n` +
      `🔄 <b>Mod Giliran:</b> Auto-Rotation (Beban Agihan Rata)\n` +
      `🎯 <b>Jenis Sambungan:</b> ${isCrazyRouter ? 'CrazyRouter Proxy (Diskaun 45%)' : 'Google Direct API'}\n` +
      `📊 <b>Kapasiti Batch 200:</b> ±${dailyCapacity.toLocaleString()} episod/hari (Flash-Lite)\n\n` +
      `<i>Semua kunci diputar secara automatik setiap batch/terjemahan.</i>`;

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

// 5. Paparan Senarai Sarikata (Pagination)
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
          chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', reply_markup: emptyMarkup
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

  // Navigasi Menu
  if (callbackData === 'menu:main') {
    await renderMainMenu(fromChatId, messageId, botToken);
    try { await axios.post(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, { callback_query_id: query.id }); } catch (e) {}
  } else if (callbackData === 'menu:server') {
    await renderServerStatus(fromChatId, messageId, botToken);
    try { await axios.post(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, { callback_query_id: query.id }); } catch (e) {}
  } else if (callbackData === 'menu:keys') {
    await renderApiKeysStatus(fromChatId, messageId, botToken);
    try { await axios.post(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, { callback_query_id: query.id }); } catch (e) {}
  }

  // Sahkan Flush Cache
  else if (callbackData === 'menu:flush_confirm') {
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
  }

  // Laksanakan Flush Cache
  else if (callbackData === 'menu:flush_do') {
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
  }

  // Navigasi Senarai Sarikata
  else if (callbackData.startsWith('page:')) {
    const targetPage = parseInt(callbackData.split(':')[1], 10) || 1;
    await renderRegistryPage(fromChatId, messageId, targetPage, botToken);
    try { await axios.post(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, { callback_query_id: query.id }); } catch (e) {}
  }

  // Padam Sarikata Spesifik
  else if (callbackData.startsWith('del_reg:')) {
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
