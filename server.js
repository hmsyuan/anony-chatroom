const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const MAX_IPS = 8;

// 儲存連線的使用者 { id, res, ip }
const clients = new Map();

// 取得真實 IP (Cloud Run 會在 header 帶入 x-forwarded-for)
function getIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0];
  return req.socket.remoteAddress;
}

// 廣播訊息給所有人
function broadcast(data) {
  clients.forEach(client => {
    client.res.write(`data: ${JSON.stringify(data)}\n\n`);
  });
}

// 計算當前不重複 IP 數量
function getUniqueIpCount() {
  const ips = new Set();
  clients.forEach(c => ips.add(c.ip));
  return ips.size;
}

const server = http.createServer((req, res) => {
  // 1. 提供前端 HTML 頁面
  if (req.url === '/' || req.url === '/index.html') {
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

  // 2. SSE 連線端點 (使用者進入聊天室)
  if (req.url === '/events') {
    const ip = getIp(req);
    const currentUniqueIps = getUniqueIpCount();

    // 檢查 IP 限制 (如果是新 IP 且已滿 8 人，則拒絕)
    let isNewIp = true;
    clients.forEach(c => { if(c.ip === ip) isNewIp = false; });

    if (isNewIp && currentUniqueIps >= MAX_IPS) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '聊天室已滿 (最多8個不同IP)' }));
      return;
    }

    // 建立 SSE 連線
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });

    const clientId = Date.now();
    const nickname = `匿名者${Math.floor(Math.random() * 1000)}`;
    
    clients.set(clientId, { res, ip, nickname });

    // 歡迎訊息
    broadcast({ type: 'system', text: `${nickname} 加入了聊天室。 (在線: ${clients.size}人)` });

    // 當連線中斷 (使用者關閉網頁)
    req.on('close', () => {
      clients.delete(clientId);
      broadcast({ type: 'system', text: `${nickname} 離開了聊天室。` });
      
      // 如果完全沒人了，你可以選擇讓程式自殺 (Cloud Run 會重啟) 
      // 或單純讓它閒置直到 Cloud Run 自動縮減資源
      if (clients.size === 0) {
        console.log('聊天室清空，記憶體重置。');
      }
    });
    return;
  }

  // 3. 接收訊息端點
  if (req.url === '/chat' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const data = JSON.parse(body);
      // 簡單的防護，避免 HTML 注入
      const safeText = (data.message || '').replace(/</g, "&lt;").replace(/>/g, "&gt;");
      
      if(safeText.trim()) {
        broadcast({ type: 'message', user: data.nickname, text: safeText });
      }
      res.end('ok');
    });
    return;
  }
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
