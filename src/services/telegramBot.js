const axios = require('axios');
const { getStorageAdapter } = require('../storage/StorageFactory');
const { StorageAdapter } = require('../storage');

// Peta memori untuk simpan kunci panjang (elak had 64-byte Telegram callback_data)
const deleteActionMap = new Map();

function registerDeletionTarget(targetData) {
  const shortId = Math.random().toString(36).substring(2, 10);
  deleteActionMap.set(shortId, {
    ...targetData,
    createdAt: Date.now()
  });

  // Bersihkan rekod lama melebihi 24 jam
  if (deleteActionMap.size > 500) {
    const now = Date.now();
    for (const [id, data] of deleteActionMap.entries()) {
      if (now - data.createdAt > 86400000) {
        deleteActionMap.delete(id);
      }
    }
  }

  return shortId;
}

async function startTelegramBot() {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const authorizedChatId = String(process.env.TELEGRAM_CHAT_ID || '').trim();

  if (!botToken || !authorizedChatId) {
    return;
  }

  console.log('[Telegram Bot] 🤖 Enjin bot interaktif 2-hala dimulakan...');

  let offset = 0;

  const poll = async () => {
    try {
      const response = await axios.get(`https://api.telegram.org/bot${botToken}/getUpdates`, {
        params: {
          offset: offset,
          timeout: 25
        },
        timeout: 30000
      });

      if (response.data && response.data.ok && Array.isArray(response.data.result)) {
        for (const update of response.data.result) {
          offset = update.update_id + 1;

          if (update.callback_query) {
            await handleCallbackQuery(update.callback_query, botToken, authorizedChatId);
          }
        }
      }
    } catch (err) {
      // Jika timeout biasa, teruskan loop; jika error lain rehat 3 saat
      if (err.code !== 'ECONNABORTED') {
        await new Promise((res) => setTimeout(res, 3000));
      }
    }

    setImmediate(poll);
  };

  poll();
}

async function handleCallbackQuery(query, botToken, authorizedChatId) {
  const fromChatId = String(query.message?.chat?.id || query.from?.id || '');
  const callbackData = String(query.data || '');

  // 🛡️ KESELAMATAN: Hanya respon kepada Chat ID pemilik sah
  if (fromChatId !== authorizedChatId) {
    try {
      await axios.post(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
        callback_query_id: query.id,
        text: '⛔ Akses Ditolak: Anda bukan pentadbir sistem ini!',
        show_alert: true
      });
    } catch (e) {}
    return;
  }

  if (callbackData.startsWith('del:')) {
    const shortId = callbackData.replace('del:', '');
    const target = deleteActionMap.get(shortId);

    try {
      const adapter = await getStorageAdapter();
      let deletedCount = 0;

      if (target) {
        if (target.runtimeKey) {
          await adapter.delete(target.runtimeKey, StorageAdapter.CACHE_TYPES.SUBTITLES);
          await adapter.delete(target.runtimeKey, StorageAdapter.CACHE_TYPES.BYPASS);
          await adapter.delete(target.runtimeKey, StorageAdapter.CACHE_TYPES.PARTIAL);
          deletedCount++;
        }
        if (target.bypassKey) {
          await adapter.delete(target.bypassKey, StorageAdapter.CACHE_TYPES.BYPASS);
          deletedCount++;
        }
        if (target.sourceFileId) {
          await adapter.delete(target.sourceFileId, StorageAdapter.CACHE_TYPES.SUBTITLES);
          deletedCount++;
        }
        deleteActionMap.delete(shortId);
      }

      // 1. Popup notifikasi segera di Telegram
      await axios.post(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
        callback_query_id: query.id,
        text: '🗑️ Subtitle berjaya dipadam daripada Cache VPS!',
        show_alert: false
      });

      // 2. Kemas kini butang supaya status bertukar dan tidak boleh ditekan lagi
      const originalText = query.message.text || '';
      await axios.post(`https://api.telegram.org/bot${botToken}/editMessageReplyMarkup`, {
        chat_id: fromChatId,
        message_id: query.message.message_id,
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '✅ Telah Dipadam dari Cache',
                callback_data: 'done'
              }
            ]
          ]
        }
      });
    } catch (err) {
      console.error(`[Telegram Bot] Ralat semasa memadam cache: ${err.message}`);
      try {
        await axios.post(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
          callback_query_id: query.id,
          text: `⚠️ Gagal padam: ${err.message}`,
          show_alert: true
        });
      } catch (e) {}
    }
  } else if (callbackData === 'done') {
    try {
      await axios.post(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
        callback_query_id: query.id,
        text: 'ℹ️ Subtitle ini telah pun dipadam sebelum ini.',
        show_alert: false
      });
    } catch (e) {}
  }
}

module.exports = {
  startTelegramBot,
  registerDeletionTarget
};
