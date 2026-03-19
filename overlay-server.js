// Overlay server - serves overlay pages for TikTok Live Studio
// URLs are added as "Browser Source" in TikTok Live Studio / OBS

const http = require('http');
const path = require('path');
const fs = require('fs');
const url = require('url');

const PORT = 55000;
let server = null;

// State shared with main process
let overlayState = {
  edits: [],        // { giftName, filePath, duration, minCount, isGif }
  coinsRanking: {}, // { uniqueId: { nickname, profilePictureUrl, coins } }
  likesRanking: {}, // { uniqueId: { nickname, profilePictureUrl, likes } }
  currentEdit: null, // currently playing edit
  events: []        // SSE event queue
};

// SSE clients
let sseClients = {
  edits: [],
  coins: [],
  likes: []
};

function startOverlayServer() {
  server = http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    // Health check
    if (pathname === '/ping') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: true, message: 'Overlay Server ready!' }));
      return;
    }

    // Edits overlay page
    if (pathname === '/overlay/edits') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(getEditsOverlayHTML());
      return;
    }

    // Coins ranking overlay page
    if (pathname === '/overlay/ranking/coins') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(getRankingOverlayHTML('coins'));
      return;
    }

    // Likes ranking overlay page
    if (pathname === '/overlay/ranking/likes') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(getRankingOverlayHTML('likes'));
      return;
    }

    // SSE endpoint for edits
    if (pathname === '/sse/edits') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      res.write('data: {"type":"connected"}\n\n');
      sseClients.edits.push(res);
      req.on('close', () => {
        sseClients.edits = sseClients.edits.filter(c => c !== res);
      });
      return;
    }

    // SSE endpoint for coins ranking
    if (pathname === '/sse/ranking/coins') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      // Send current state
      res.write(`data: ${JSON.stringify({ type: 'full', data: overlayState.coinsRanking })}\n\n`);
      sseClients.coins.push(res);
      req.on('close', () => {
        sseClients.coins = sseClients.coins.filter(c => c !== res);
      });
      return;
    }

    // SSE endpoint for likes ranking
    if (pathname === '/sse/ranking/likes') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      res.write(`data: ${JSON.stringify({ type: 'full', data: overlayState.likesRanking })}\n\n`);
      sseClients.likes.push(res);
      req.on('close', () => {
        sseClients.likes = sseClients.likes.filter(c => c !== res);
      });
      return;
    }

    // Serve media files for edits
    if (pathname.startsWith('/media/')) {
      const filePath = decodeURIComponent(pathname.replace('/media/', ''));
      serveFile(res, filePath);
      return;
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  server.listen(PORT, () => {
    console.log(`Overlay server running on http://localhost:${PORT}`);
  });

  server.on('error', (err) => {
    console.error('Overlay server error:', err.message);
  });
}

function serveFile(res, filePath) {
  // Normalize path for Windows
  const normalizedPath = filePath.replace(/\//g, path.sep);

  if (!fs.existsSync(normalizedPath)) {
    res.writeHead(404);
    res.end('File not found');
    return;
  }

  const ext = path.extname(normalizedPath).toLowerCase();
  const mimeTypes = {
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.avi': 'video/x-msvideo',
    '.mov': 'video/quicktime',
    '.mkv': 'video/x-matroska',
    '.gif': 'image/gif',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg'
  };

  const contentType = mimeTypes[ext] || 'application/octet-stream';
  const stat = fs.statSync(normalizedPath);

  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': stat.size,
    'Accept-Ranges': 'bytes'
  });

  fs.createReadStream(normalizedPath).pipe(res);
}

// Send edit trigger to all SSE clients
function triggerEdit(edit) {
  const mediaUrl = `http://localhost:${PORT}/media/${encodeURIComponent(edit.filePath.replace(/\\/g, '/'))}`;
  const event = {
    type: 'play',
    giftName: edit.giftName,
    mediaUrl: mediaUrl,
    filePath: edit.filePath,
    duration: edit.duration,
    isGif: edit.isGif
  };

  sseClients.edits.forEach(client => {
    try {
      client.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch (e) {}
  });
}

// Update coins ranking for overlay
function updateCoinsRanking(ranking) {
  overlayState.coinsRanking = ranking;
  sseClients.coins.forEach(client => {
    try {
      client.write(`data: ${JSON.stringify({ type: 'full', data: ranking })}\n\n`);
    } catch (e) {}
  });
}

// Update likes ranking for overlay
function updateLikesRanking(ranking) {
  overlayState.likesRanking = ranking;
  sseClients.likes.forEach(client => {
    try {
      client.write(`data: ${JSON.stringify({ type: 'full', data: ranking })}\n\n`);
    } catch (e) {}
  });
}

// ============================================
// OVERLAY HTML PAGES
// ============================================

function getEditsOverlayHTML() {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: transparent;
    overflow: hidden;
    width: 100vw;
    height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  #media-container {
    display: none;
    width: 100%;
    height: 100%;
    align-items: center;
    justify-content: center;
  }
  #media-container.active {
    display: flex;
  }
  #media-container video,
  #media-container img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }
  .gift-toast {
    position: fixed;
    top: 20px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(0,0,0,0.75);
    color: white;
    padding: 10px 24px;
    border-radius: 30px;
    font-family: 'Segoe UI', sans-serif;
    font-size: 18px;
    font-weight: 600;
    display: none;
    z-index: 10;
    animation: fadeInDown 0.4s ease-out;
  }
  .gift-toast.active { display: block; }
  @keyframes fadeInDown {
    from { opacity: 0; transform: translateX(-50%) translateY(-20px); }
    to { opacity: 1; transform: translateX(-50%) translateY(0); }
  }
</style>
</head>
<body>
<div class="gift-toast" id="toast"></div>
<div id="media-container">
  <video id="video" autoplay></video>
  <img id="gif" style="display:none">
</div>
<script>
  const container = document.getElementById('media-container');
  const video = document.getElementById('video');
  const gif = document.getElementById('gif');
  const toast = document.getElementById('toast');
  let hideTimeout = null;

  const evtSource = new EventSource('/sse/edits');

  evtSource.onmessage = (e) => {
    const data = JSON.parse(e.data);
    if (data.type === 'play') {
      playMedia(data);
    }
  };

  function playMedia(data) {
    if (hideTimeout) clearTimeout(hideTimeout);

    video.style.display = 'none';
    gif.style.display = 'none';
    video.pause();
    video.src = '';

    // Show toast
    toast.textContent = '🎁 ' + data.giftName;
    toast.classList.add('active');

    container.classList.add('active');

    if (data.isGif) {
      gif.src = data.mediaUrl;
      gif.style.display = 'block';
    } else {
      video.src = data.mediaUrl;
      video.style.display = 'block';
      video.play().catch(() => {});
    }

    hideTimeout = setTimeout(() => {
      container.classList.remove('active');
      toast.classList.remove('active');
      video.pause();
      video.src = '';
      gif.src = '';
    }, data.duration * 1000);
  }
</script>
</body>
</html>`;
}

function getRankingOverlayHTML(type) {
  const title = type === 'coins' ? '🪙 Ranking de Moedas' : '❤️ Ranking de Likes';
  const sseUrl = `/sse/ranking/${type}`;
  const valueKey = type === 'coins' ? 'coins' : 'likes';
  const valueIcon = type === 'coins' ? '🪙' : '❤️';
  const accentColor = type === 'coins' ? '#f1c40f' : '#e74c3c';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: transparent;
    font-family: 'Segoe UI', -apple-system, sans-serif;
    color: white;
    padding: 16px;
    overflow-y: auto;
  }
  .ranking-title {
    font-size: 20px;
    font-weight: 800;
    text-align: center;
    margin-bottom: 12px;
    text-shadow: 0 2px 8px rgba(0,0,0,0.6);
    color: ${accentColor};
  }
  .ranking-list { display: flex; flex-direction: column; gap: 6px; }
  .ranking-item {
    display: flex;
    align-items: center;
    gap: 10px;
    background: rgba(20, 25, 40, 0.85);
    border-radius: 12px;
    padding: 8px 14px;
    border: 1px solid rgba(255,255,255,0.08);
    backdrop-filter: blur(8px);
    animation: slideIn 0.3s ease-out;
  }
  @keyframes slideIn {
    from { opacity: 0; transform: translateX(-20px); }
    to { opacity: 1; transform: translateX(0); }
  }
  .pos {
    width: 28px; height: 28px;
    border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-size: 13px; font-weight: 800;
    flex-shrink: 0;
  }
  .pos-1 { background: linear-gradient(135deg, #f1c40f, #e67e22); color: #1a1a2e; }
  .pos-2 { background: linear-gradient(135deg, #bdc3c7, #95a5a6); color: #1a1a2e; }
  .pos-3 { background: linear-gradient(135deg, #e67e22, #d35400); color: #1a1a2e; }
  .pos-other { background: rgba(255,255,255,0.1); color: rgba(255,255,255,0.6); }
  .avatar {
    width: 36px; height: 36px;
    border-radius: 50%;
    background: rgba(255,255,255,0.1);
    overflow: hidden;
    flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
    font-size: 16px;
  }
  .avatar img { width: 100%; height: 100%; object-fit: cover; }
  .user-info { flex: 1; min-width: 0; }
  .user-name {
    font-size: 14px; font-weight: 700;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .user-id {
    font-size: 10px; color: rgba(255,255,255,0.4);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .value {
    font-size: 15px; font-weight: 800;
    color: ${accentColor};
    flex-shrink: 0;
    text-shadow: 0 0 8px ${accentColor}40;
  }
  .empty {
    text-align: center;
    color: rgba(255,255,255,0.3);
    padding: 40px;
    font-size: 14px;
  }
</style>
</head>
<body>
<div class="ranking-title">${title}</div>
<div class="ranking-list" id="list"></div>
<script>
  const list = document.getElementById('list');
  const valueKey = '${valueKey}';
  const valueIcon = '${valueIcon}';

  const evtSource = new EventSource('${sseUrl}');

  evtSource.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'full') {
      renderRanking(msg.data);
    }
  };

  function renderRanking(data) {
    const sorted = Object.entries(data)
      .map(([id, d]) => ({ id, ...d }))
      .sort((a, b) => b[valueKey] - a[valueKey])
      .slice(0, 20);

    if (sorted.length === 0) {
      list.innerHTML = '<div class="empty">Aguardando dados...</div>';
      return;
    }

    list.innerHTML = sorted.map((user, i) => {
      const pos = i + 1;
      const posClass = pos <= 3 ? 'pos-' + pos : 'pos-other';
      const avatar = user.profilePictureUrl
        ? '<img src="' + user.profilePictureUrl + '" onerror="this.parentElement.innerHTML=\\'👤\\'">'
        : '👤';
      const val = user[valueKey].toLocaleString();
      return '<div class="ranking-item">' +
        '<div class="pos ' + posClass + '">' + pos + '</div>' +
        '<div class="avatar">' + avatar + '</div>' +
        '<div class="user-info">' +
          '<div class="user-name">' + escHtml(user.nickname) + '</div>' +
          '<div class="user-id">@' + escHtml(user.id) + '</div>' +
        '</div>' +
        '<div class="value">' + valueIcon + ' ' + val + '</div>' +
      '</div>';
    }).join('');
  }

  function escHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }
</script>
</body>
</html>`;
}

module.exports = {
  startOverlayServer,
  triggerEdit,
  updateCoinsRanking,
  updateLikesRanking,
  overlayState,
  PORT
};
