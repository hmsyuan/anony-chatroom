const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 8080;
const MAX_IPS = 8;
const IDLE_TIMEOUT = 10 * 60 * 1000;
const SSE_KEEPALIVE_MS = 25000;

const clients = new Map();
const messages = [];
let nextMessageId = 1;
const MAX_MESSAGE_HISTORY = 200;
const MAX_ATTACHMENT_DATA_URL_LENGTH = 3 * 1024 * 1024;
const LINK_PREVIEW_TIMEOUT_MS = 4000;

const builtInGifPools = {
  cats: [
    { name: 'Cat typing', url: 'https://media.giphy.com/media/JIX9t2j0ZTN9S/giphy.gif' },
    { name: 'Cat hi', url: 'https://media.giphy.com/media/mlvseq9yvZhba/giphy.gif' },
    { name: 'Happy cat', url: 'https://media.giphy.com/media/v6aOjy0Qo1fIA/giphy.gif' },
    { name: 'Cat wow', url: 'https://media.giphy.com/media/ICOgUNjpvO0PC/giphy.gif' }
  ],
  memes: [
    { name: 'Mind blown', url: 'https://media.giphy.com/media/26ufdipQqU2lhNA4g/giphy.gif' },
    { name: 'Thumbs up', url: 'https://media.giphy.com/media/111ebonMs90YLu/giphy.gif' },
    { name: 'Nice', url: 'https://media.giphy.com/media/yJFeycRK2DB4c/giphy.gif' },
    { name: 'Oh no', url: 'https://media.giphy.com/media/l3q2K5jinAlChoCLS/giphy.gif' }
  ],
  reactions: [
    { name: 'Clap', url: 'https://media.giphy.com/media/3o6Zt481isNVuQI1l6/giphy.gif' },
    { name: 'LOL', url: 'https://media.giphy.com/media/10JhviFuU2gWD6/giphy.gif' },
    { name: 'Facepalm', url: 'https://media.giphy.com/media/TJawtKM6OCKkvwCIqX/giphy.gif' },
    { name: 'Party', url: 'https://media.giphy.com/media/MeIucAjPKoA120R7sN/giphy.gif' }
  ],
  anime: [
    { name: 'Anime wow', url: 'https://media.giphy.com/media/13borq7Zo2kulO/giphy.gif' },
    { name: 'Nod', url: 'https://media.giphy.com/media/KzJkzjggfGN5Py6nkT/giphy.gif' },
    { name: 'Wave', url: 'https://media.giphy.com/media/xT9IgG50Fb7Mi0prBC/giphy.gif' },
    { name: 'Excited', url: 'https://media.giphy.com/media/1yldusVtwRA9r9EUan/giphy.gif' }
  ]
};

function getIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0];
  return req.socket.remoteAddress;
}

function broadcast(data) {
  const json = JSON.stringify(data);
  clients.forEach(client => {
    client.res.write(`data: ${json}\n\n`);
  });
}

function broadcastSystem(text) {
  broadcast({ type: 'system', text, createdAt: new Date().toISOString() });
}

function broadcastUserList() {
  const userList = Array.from(clients.values()).map(c => c.nickname);
  broadcast({ type: 'userList', users: userList });
}

function safeNickname(name) {
  return (name || '').toString().trim().slice(0, 20) || `匿名者${Math.floor(Math.random() * 1000)}`;
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}

function sanitizeAttachment(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const name = (raw.name || '').toString().slice(0, 120);
  const type = (raw.type || '').toString().slice(0, 120);
  const dataUrl = (raw.dataUrl || '').toString();
  const size = Number(raw.size) || 0;

  const isDataUrl = /^data:[^;]+;base64,/i.test(dataUrl);
  if (!isDataUrl || dataUrl.length > MAX_ATTACHMENT_DATA_URL_LENGTH) return null;

  return { name, type, dataUrl, size };
}

function readBody(req, cb) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => cb(safeJsonParse(body)));
}

function pickBuiltInGifs(refreshSeed = 0, limit = 8) {
  const pools = Object.values(builtInGifPools);
  const flat = pools.flat();
  const start = Math.abs(Number(refreshSeed) || 0) % flat.length;
  const rotated = [...flat.slice(start), ...flat.slice(0, start)];
  return rotated.slice(0, limit);
}

function fetchJson(targetUrl) {
  return new Promise((resolve, reject) => {
    https.get(targetUrl, (resp) => {
      let data = '';
      resp.on('data', chunk => data += chunk);
      resp.on('end', () => {
        try {
          resolve(JSON.parse(data || '{}'));
        } catch (err) {
          reject(err);
        }
      });
    }).on('error', reject);
  });
}

function fetchText(targetUrl) {
  return new Promise((resolve, reject) => {
    const req = https.get(targetUrl, { timeout: LINK_PREVIEW_TIMEOUT_MS, headers: { 'User-Agent': 'anony-chatroom-link-preview' } }, (resp) => {
      let data = '';
      resp.on('data', chunk => {
        data += chunk;
        if (data.length > 250000) resp.destroy();
      });
      resp.on('end', () => resolve(data));
    });

    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function extractMeta(html, property, attrName = 'property') {
  const regex = new RegExp(`<meta[^>]+${attrName}=["']${property}["'][^>]+content=["']([^"']+)["'][^>]*>`, 'i');
  const m = html.match(regex);
  return m ? m[1] : '';
}

function extractTitle(html) {
  const ogTitle = extractMeta(html, 'og:title');
  if (ogTitle) return ogTitle;
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return m ? m[1].trim() : '';
}

function sanitizeUrl(rawUrl) {
  const t = (rawUrl || '').toString().trim();
  if (!/^https?:\/\//i.test(t)) return '';
  return t.slice(0, 600);
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);

  if (parsedUrl.pathname === '/' || parsedUrl.pathname === '/index.html') {
    fs.readFile(path.join(__dirname, 'public/index.html'), (err, data) => {
      if (err) {
        res.writeHead(500);
        res.end('Error loading index.html');
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(data);
      }
    });
    return;
  }

  if (parsedUrl.pathname === '/events') {
    const userId = parsedUrl.query.id;
    const nickname = safeNickname(parsedUrl.query.name);
    const ip = getIp(req);

    const uniqueIps = new Set();
    clients.forEach(c => uniqueIps.add(c.ip));
    if (!clients.has(userId) && uniqueIps.size >= MAX_IPS) {
      res.writeHead(403);
      res.end('Room full');
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });

    if (clients.has(userId)) {
      const old = clients.get(userId);
      clearTimeout(old.timer);
      clearInterval(old.keepAliveTimer);
      old.lastSeen = Date.now();
    } else {
      broadcastSystem(`${nickname} 進入了聊天室。`);
    }

    const keepAliveTimer = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(keepAliveTimer);
      }
    }, SSE_KEEPALIVE_MS);

    const clientData = { res, ip, nickname, lastSeen: Date.now(), keepAliveTimer };
    clients.set(userId, clientData);
    broadcastUserList();

    req.on('close', () => {
      const timer = setTimeout(() => {
        if (clients.get(userId)?.res === res) {
          const currentNickname = clients.get(userId)?.nickname || nickname;
          clearInterval(clients.get(userId)?.keepAliveTimer);
          clients.delete(userId);
          broadcastSystem(`${currentNickname} 離開了聊天室。`);
          broadcastUserList();
        }
      }, 5000);
      if (clients.has(userId)) clients.get(userId).timer = timer;
    });
    return;
  }

  if (parsedUrl.pathname === '/gifs' && req.method === 'GET') {
    const q = (parsedUrl.query.q || '').toString().trim();
    const refresh = (parsedUrl.query.refresh || '0').toString();
    const limit = 8;
    const apiKey = process.env.GIPHY_API_KEY || 'dc6zaTOxFJmzC';

    if (!q) {
      const local = pickBuiltInGifs(refresh, limit);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ source: 'builtin', items: local }));
      return;
    }

    try {
      const offset = Math.abs(Number(refresh) || 0) % 60;
      const target = `https://api.giphy.com/v1/gifs/search?api_key=${encodeURIComponent(apiKey)}&q=${encodeURIComponent(q)}&limit=${limit}&rating=g&offset=${offset}`;
      const body = await fetchJson(target);
      const items = (body.data || []).map(gif => ({
        name: gif.title || q || 'GIF',
        url: gif.images?.fixed_height_small?.url || gif.images?.downsized_medium?.url
      })).filter(item => item.url);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ source: 'giphy', items }));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ source: 'builtin_fallback', items: pickBuiltInGifs(refresh, limit) }));
    }
    return;
  }

  if (parsedUrl.pathname === '/link-preview' && req.method === 'GET') {
    const targetUrl = sanitizeUrl(parsedUrl.query.url);
    if (!targetUrl) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid url' }));
      return;
    }

    try {
      const html = await fetchText(targetUrl);
      const pageTitle = extractTitle(html);
      const description = extractMeta(html, 'og:description') || extractMeta(html, 'description', 'name');
      const image = extractMeta(html, 'og:image');
      const host = new URL(targetUrl).host;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        url: targetUrl,
        title: pageTitle || host,
        description: (description || '').slice(0, 220),
        image: image || '',
        host
      }));
    } catch {
      const host = (() => {
        try { return new URL(targetUrl).host; } catch { return ''; }
      })();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ url: targetUrl, title: host || targetUrl, description: '', image: '', host }));
    }
    return;
  }

  if (parsedUrl.pathname === '/chat' && req.method === 'POST') {
    readBody(req, data => {
      const client = clients.get(data.userId);
      if (client) {
        client.lastSeen = Date.now();
        const text = (data.message || '').toString();
        const messageType = data.messageType === 'gif' ? 'gif' : 'text';
        const gifUrl = (data.gifUrl || '').toString().trim();

        const attachment = sanitizeAttachment(data.attachment);
        const isValidGifUrl = messageType === 'gif' && /^https:\/\/.+/i.test(gifUrl);
        const hasValidText = messageType === 'text' && text.trim();
        const hasAttachment = messageType === 'text' && Boolean(attachment);
        const replyTo = data.replyTo && typeof data.replyTo === 'object' ? {
          messageId: (data.replyTo.messageId || '').toString().slice(0, 40),
          user: (data.replyTo.user || '').toString().slice(0, 40),
          text: (data.replyTo.text || '').toString().slice(0, 160)
        } : null;

        if (hasValidText || isValidGifUrl || hasAttachment) {
          const messageId = `m_${nextMessageId++}`;
          messages.push({ id: messageId, senderId: data.userId, readers: new Set(), deleted: false });
          if (messages.length > MAX_MESSAGE_HISTORY) messages.shift();

          broadcast({
            type: 'message',
            messageId,
            user: client.nickname,
            text,
            gifUrl: isValidGifUrl ? gifUrl : '',
            messageType,
            userId: data.userId,
            encrypted: messageType === 'text' ? Boolean(data.encrypted) : false,
            attachment: messageType === 'text' ? attachment : null,
            replyTo,
            createdAt: new Date().toISOString()
          });
        }
      }
      res.end('ok');
    });
    return;
  }

  if (parsedUrl.pathname === '/message/delete' && req.method === 'POST') {
    readBody(req, data => {
      const client = clients.get(data.userId);
      const message = messages.find(item => item.id === data.messageId);

      if (client && message && message.senderId === data.userId && !message.deleted) {
        message.deleted = true;
        broadcast({ type: 'messageDeleted', messageId: message.id, by: client.nickname, createdAt: new Date().toISOString() });
      }

      res.end('ok');
    });
    return;
  }

  if (parsedUrl.pathname === '/nickname' && req.method === 'POST') {
    readBody(req, data => {
      const client = clients.get(data.userId);
      if (client) {
        const newName = safeNickname(data.nickname);
        const oldName = client.nickname;
        client.nickname = newName;
        client.lastSeen = Date.now();
        if (newName !== oldName) {
          broadcastSystem(`${oldName} 已改名為 ${newName}。`);
          broadcastUserList();
        }
      }
      res.end('ok');
    });
    return;
  }

  if (parsedUrl.pathname === '/read' && req.method === 'POST') {
    readBody(req, data => {
      const client = clients.get(data.userId);
      const message = messages.find(item => item.id === data.messageId);

      if (client && message && !message.deleted && message.senderId !== data.userId) {
        message.readers.add(data.userId);
        broadcast({ type: 'readReceipt', messageId: message.id, readCount: message.readers.size });
      }

      res.end('ok');
    });
    return;
  }

  if (parsedUrl.pathname === '/heartbeat' && req.method === 'POST') {
    readBody(req, data => {
      const client = clients.get(data.userId);
      if (client) client.lastSeen = Date.now();
      res.end('ok');
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

setInterval(() => {
  const now = Date.now();
  clients.forEach((client, userId) => {
    if (now - client.lastSeen > IDLE_TIMEOUT) {
      clearInterval(client.keepAliveTimer);
      client.res.end();
      clients.delete(userId);
      broadcastSystem(`${client.nickname} 因閒置超過 10 分鐘被移出。`);
      broadcastUserList();
    }
  });
}, 30000);

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
