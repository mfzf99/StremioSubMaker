const axios = require('axios');
const { getStorageAdapter } = require('../storage/StorageFactory');
const { StorageAdapter } = require('../storage');

const REGISTRY_REDIS_KEY = 'stremio:sub_registry';
const ITEMS_PER_PAGE = 5;

// Simpan rekod sarikata yang siap diterjemah ke dalam Redis
async function registerCompletedSubtitle({ title, provider, targetLang, keys }) {
  try {
    const adapter = await getStorageAdapter();
    const id = 'sub_' + Math.random().toString(36).substring(2, 9);
    
    const entry = {
      id,
      title: title || 'Unknown Title',
      provider: provider || 'Unknown Provider',
      targetLang: (targetLang || 'MAY').toUpperCase(),
      keys: Array.isArray(keys) ? keys : [keys].filter(Boolean),
      createdAt: Date.now()
    };

    // Ambil data sedia ada dari Redis
    const current = (await adapter.get(REGISTRY_REDIS_KEY, StorageAdapter.CACHE_TYPES.TRANSLATION)) || [];
    const list = Array.isArray(current) ? current : [];

    // Buang duplikasi jika file yang sama didaftar semula
    const filtered = list.filter(item => item.title !== entry.title || item.provider !== entry.provider);
    filtered.unshift(entry); // Masukkan paling atas

    // Simpan semula ke Redis
    await adapter.set(REGISTRY_REDIS_KEY, filtered, StorageAdapter.CACHE_TYPES.TRANSLATION);
    return id;
  } catch (err) {
    console.error(`[Telegram Bot] Gagal daftar registry: ${err.message}`);
    return null;
  }
}

async function startTelegramBot() {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const authorizedChatId = String(process.env.TELEGRAM_CHAT_ID || '').trim();

  if (!botToken || !authorizedChatId) return;

  console.log('[Telegram Bot] 🤖 Enjin bot interaktif 2-hala & Registry dimulakan...');

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

          // 1. Tangkap klik butang (Callback Query)
          if (update.callback_query) {
            await handleCallbackQuery(update.callback_query, botToken, authorizedChatId);
          }

          // 2. Tangkap arahan mesej teks (/list, /menu, /start)
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

// Paparan senarai sarikata mengikut halaman
async function renderRegistryPage(chatId, messageId, page = 1, botToken) {
  try {
    const adapter = await getStorageAdapter();
    const list = (await adapter.get(REGISTRY_REDIS_KEY, StorageAdapter.CACHE_TYPES.TRANSLATION)) || [];
    
    if (!Array.isArray(list) || list.length === 0) {
      const emptyText = '📭 <b>Tiada Sarikata Dalam Cache VPS</b>\n\nSemua cache sarikata kosong atau telah dipadam.';
      const emptyMarkup = { inline_keyboard: [[{ text: '🔄 Refresh', callback_data: 'page:1' }]] };
      
      if (messageId) {
        await axios.post(`https://api.telegram.org/bot${botToken}/editMessageText`, {
          chat_id: chatId, message_id: messageId, text: emptyText, parse_mode: 'HTML', reply_markup: emptyMarkup
        });
      } else {
        await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          chat_id: chatId, text: emptyText, parse_mode: 'HTML', reply_markup: emptyMarkup
        });
      }
      return;
    }

    const totalItems = list.length;
    const totalPages = Math.ceil(totalItems / ITEMS_PER_PAGE);
    const currentPage = Math.max(1, Math.min(page, totalPages));
    const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
    const pageItems = list.slice(startIndex, startIndex + ITEMS_PER_PAGE);

    let text = `📋 <b>Senarai Sarikata Cache VPS (Semua: ${totalItems})</b>\n`;
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

    // Susun butang padam (2 butang sebaris)
    for (let i = 0; i < deleteRow.length; i += 2) {
      buttons.push(deleteRow.slice(i, i + 2));
    }

    // Butang Navigasi (Next / Prev)
    const navRow = [];
    if (currentPage > 1) {
      navRow.push({ text: '⬅️ Prev', callback_data: `page:${currentPage - 1}` });
    }
    navRow.push({ text: '🔄 Refresh', callback_data: `page:${currentPage}` });
    if (currentPage < totalPages) {
      navRow.push({ text: 'Next ➡️', callback_data: `page:${currentPage + 1}` });
    }
    buttons.push(navRow);

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

async function handleTextMessage(message, botToken, authorizedChatId) {
  const fromChatId = String(message.chat?.id || '');
  const text = (message.text || '').trim();

  if (fromChatId !== authorizedChatId) return;

  if (text === '/list' || text === '/subtitles' || text === '/menu' || text === '/start') {
    await renderRegistryPage(fromChatId, null, 1, botToken);
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

  // 1. Navigasi Halaman
  if (callbackData.startsWith('page:')) {
    const targetPage = parseInt(callbackData.split(':')[1], 10) || 1;
    await renderRegistryPage(fromChatId, messageId, targetPage, botToken);
    try {
      await axios.post(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, { callback_query_id: query.id });
    } catch (e) {}
  }

  // 2. Padam Item dari Registry
  else if (callbackData.startsWith('del_reg:')) {
    const [, targetId, pageStr] = callbackData.split(':');
    const page = parseInt(pageStr, 10) || 1;

    try {
      const adapter = await getStorageAdapter();
      const list = (await adapter.get(REGISTRY_REDIS_KEY, StorageAdapter.CACHE_TYPES.TRANSLATION)) || [];
      
      const itemIndex = list.findIndex(item => item.id === targetId);
      if (itemIndex !== -1) {
        const item = list[itemIndex];
        
        // Padam semua key berkaitan di Redis
        for (const key of item.keys) {
          await adapter.delete(key, StorageAdapter.CACHE_TYPES.SUBTITLES);
          await adapter.delete(key, StorageAdapter.CACHE_TYPES.BYPASS);
          await adapter.delete(key, StorageAdapter.CACHE_TYPES.PARTIAL);
          await adapter.delete(key, StorageAdapter.CACHE_TYPES.TRANSLATION);
        }

        // Buang dari pendaftaran senarai
        list.splice(itemIndex, 1);
        await adapter.set(REGISTRY_REDIS_KEY, list, StorageAdapter.CACHE_TYPES.TRANSLATION);

        await axios.post(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
          callback_query_id: query.id, text: `🗑️ Sarikata berjaya dipadam!`, show_alert: false
        });

        // Kemas kini semula paparan halaman
        await renderRegistryPage(fromChatId, messageId, page, botToken);
      } else {
        await axios.post(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
          callback_query_id: query.id, text: 'ℹ️ Sarikata ini telah pun dipadam.', show_alert: false
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
