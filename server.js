const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 8080;
const MAX_IPS = 8;
const IDLE_TIMEOUT = 5 * 60 * 1000; // 5 分鐘未活動則判定離線

// 儲存使用者資訊: Map<clientId, { res, ip, nickname, lastSeen, timer }>
const clients = new Map();

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

function broadcastUserList() {
  const userList = Array.from(clients.values()).map(c => c.nickname);
  broadcast({ type: 'userList', users: userList });
}

function safeNickname(name) {
  return (name || '').toString().trim().slice(0, 20) || `匿名者${Math.floor(Math.random() * 1000)}`;
}

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);

  // 1. 提供前端頁面
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

  // 2. SSE 連線
  if (parsedUrl.pathname === '/events') {
    const userId = parsedUrl.query.id;
    const nickname = safeNickname(parsedUrl.query.name);
    const ip = getIp(req);

    // 檢查 IP 限制 (排除已連線的同個 ID)
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
      'Connection': 'keep-alive'
    });

    // 如果是重連，先清除舊的計時器
    if (clients.has(userId)) {
      clearTimeout(clients.get(userId).timer);
    } else {
      broadcast({ type: 'system', text: `${nickname} 進入了聊天室。` });
    }

    const clientData = { res, ip, nickname, lastSeen: Date.now() };
    clients.set(userId, clientData);
    broadcastUserList();

    req.on('close', () => {
      // 斷線時不立即移除，等待 5 秒看是否為重整
      const timer = setTimeout(() => {
        if (clients.get(userId)?.res === res) {
          const currentNickname = clients.get(userId)?.nickname || nickname;
          clients.delete(userId);
          broadcast({ type: 'system', text: `${currentNickname} 離開了聊天室。` });
          broadcastUserList();
        }
      }, 5000);
      if (clients.has(userId)) clients.get(userId).timer = timer;
    });
    return;
  }

  // 3. 接收訊息與心跳
  if (parsedUrl.pathname === '/chat' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const data = JSON.parse(body);
      const client = clients.get(data.userId);
      if (client) {
        client.lastSeen = Date.now(); // 更新最後活動時間
        const safeText = (data.message || '').replace(/</g, "&lt;").replace(/>/g, "&gt;");
        if (safeText.trim()) {
          broadcast({ type: 'message', user: client.nickname, text: safeText, userId: data.userId });
        }
      }
      res.end('ok');
    });
    return;
  }

  // 4. 修改暱稱
  if (parsedUrl.pathname === '/nickname' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const data = JSON.parse(body || '{}');
      const client = clients.get(data.userId);
      if (client) {
        const newName = safeNickname(data.nickname);
        const oldName = client.nickname;
        client.nickname = newName;
        client.lastSeen = Date.now();
        if (newName !== oldName) {
          broadcast({ type: 'system', text: `${oldName} 已改名為 ${newName}。` });
          broadcastUserList();
        }
      }
      res.end('ok');
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// 定期檢查 5 分鐘未活動的使用者
setInterval(() => {
  const now = Date.now();
  clients.forEach((client, userId) => {
    if (now - client.lastSeen > IDLE_TIMEOUT) {
      client.res.end();
      clients.delete(userId);
      broadcast({ type: 'system', text: `${client.nickname} 因閒置過久被移出。` });
      broadcastUserList();
    }
  });
}, 30000);

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
