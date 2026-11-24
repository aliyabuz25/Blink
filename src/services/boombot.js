const { run, get } = require('../db/sqlite');
const redisModule = require('../db/redis');

async function triggerBoomBotReply(io, conversationId, userText) {
  if (!conversationId || !conversationId.includes('boombot')) {
    return;
  }
  const lower = userText.toLowerCase().trim();
  let reply = '';

  if (userText.startsWith('http') && (userText.includes('wx.qq.com') || userText.includes('fluentui-emoji'))) {
    const cuteStickers = [
      'https://res.wx.qq.com/mpres/htmledition/images/icon/emotion/6.gif',
      'https://res.wx.qq.com/mpres/htmledition/images/icon/emotion/21.gif',
      'https://res.wx.qq.com/mpres/htmledition/images/icon/emotion/33.gif',
      'https://res.wx.qq.com/mpres/htmledition/images/icon/emotion/63.gif',
      'https://cdn.jsdelivr.net/gh/microsoft/fluentui-emoji@main/assets/Strawberry/3D/strawberry_3d.png',
      'https://cdn.jsdelivr.net/gh/microsoft/fluentui-emoji@main/assets/Sparkles/3D/sparkles_3d.png'
    ];
    reply = cuteStickers[Math.floor(Math.random() * cuteStickers.length)];
  } else if (lower.includes('sushi') || lower.includes('dinner') || lower.includes('yemek') || lower.includes('akşam')) {
    reply = "Sushi place reservation is confirmed for 7 PM! Can't wait 🍣✨";
  } else if (lower.includes('ready') || lower.includes('hazır')) {
    reply = "Awesome! I'm on my way, see you in 10 minutes 🚗";
  } else if (lower.includes('saat') || lower.includes('time') || lower.includes('kaç')) {
    reply = "Let's meet there at 7 PM sharp! 🎉";
  } else if (lower.includes('selam') || lower.includes('merhaba') || lower.includes('hey') || lower.includes('hi')) {
    reply = 'Hey! How are you doing? 🌸';
  } else if (lower.includes('see you') || lower.includes('görüşürüz')) {
    reply = 'See you later! 👋';
  } else {
    const friendlyReplies = [
      "Sounds like a plan! See you at 7 🥳",
      "Great! Looking forward to tonight 🍜",
      "Perfect! Text me when you're leaving 🚗",
      "Awesome, got it! 🌸"
    ];
    reply = friendlyReplies[Math.floor(Math.random() * friendlyReplies.length)];
  }

  setTimeout(async () => {
    const botMsgId = 'm_' + Date.now();
    const now = new Date().toISOString();

    const conv = await get(`SELECT name, avatar FROM conversations WHERE id = ?`, [conversationId]);
    const senderName = conv ? conv.name : 'BoomBot';
    const senderAvatar = conv ? conv.avatar : 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&w=200&q=80';

    // Trigger typing indicator immediately
    if (io) {
      io.to(`conv_${conversationId}`).emit('user_typing', {
        conversationId,
        userId: 'usr_boombot',
        userName: senderName
      });
    }

    await run(
      `INSERT INTO messages (id, conversation_id, sender_id, content, status, created_at) VALUES (?, ?, ?, ?, 'delivered', ?)`,
      [botMsgId, conversationId, 'usr_boombot', reply, now]
    );

    const botMessage = {
      id: botMsgId,
      conversation_id: conversationId,
      sender_id: 'usr_boombot',
      sender_name: senderName,
      sender_avatar: senderAvatar,
      content: reply,
      created_at: now
    };

    if (io) {
      io.to(`conv_${conversationId}`).emit('new_message', botMessage);
      io.emit('new_message_notification', { conversationId, message: botMessage });
    }

    await redisModule.cacheMessage(conversationId, botMessage);
    await redisModule.publishEvent('messages', { conversationId, message: botMessage });

    if (io) {
      io.to(`conv_${conversationId}`).emit('user_stop_typing', {
        conversationId,
        userId: 'usr_boombot'
      });
    }
  }, 120);
}

module.exports = { triggerBoomBotReply };
