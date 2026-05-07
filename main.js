const { app, BrowserWindow, ipcMain, dialog, globalShortcut, session } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { exec } = require('child_process');
const WebSocket = require('ws');
const crypto = require('crypto');

let mainWindow;
let lockWindow = null;

// ============================================
// ACCESS KEY SYSTEM
// ============================================
const KEY_FILE = () => path.join(app.getPath('userData'), 'access.json');

function getSavedKey() {
  try { return JSON.parse(fs.readFileSync(KEY_FILE(), 'utf-8')).key || ''; } catch(e) { return ''; }
}

function saveKey(key) {
  try { fs.writeFileSync(KEY_FILE(), JSON.stringify({ key })); } catch(e) {}
}

function validateKeyOnline(key) {
  return new Promise((resolve) => {
    const url = DEFAULT_RELAY_URL + '/validate-key?k=' + encodeURIComponent(key);
    https.get(url, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve({ valid: false, offline: true }); }
      });
    }).on('error', () => resolve({ valid: false, offline: true }));
  });
}

function createLockWindow() {
  lockWindow = new BrowserWindow({
    width: 400,
    height: 360,
    resizable: false,
    frame: false,
    center: true,
    backgroundColor: '#0e1120',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  lockWindow.loadFile('renderer/lock.html');
  lockWindow.on('closed', () => { lockWindow = null; });

  lockWindow.webContents.once('did-finish-load', () => {
    const saved = getSavedKey();
    if (saved) lockWindow.webContents.send('try-saved-key', saved);
  });
}

ipcMain.on('lock-close', () => { if (lockWindow) lockWindow.close(); app.quit(); });

ipcMain.on('validate-key', async (event, key) => {
  const result = await validateKeyOnline(key);
  if (result.valid) {
    saveKey(key);
    if (lockWindow) { lockWindow.close(); lockWindow = null; }
    const config = getRelayConfig();
    connectToRelay(config.relayUrl || DEFAULT_RELAY_URL);
    createWindow();
  } else if (result.offline && key) {
    // No internet but has a key — allow with grace
    if (lockWindow) { lockWindow.close(); lockWindow = null; }
    const config = getRelayConfig();
    connectToRelay(config.relayUrl || DEFAULT_RELAY_URL);
    createWindow();
  } else {
    if (lockWindow && !lockWindow.isDestroyed())
      lockWindow.webContents.send('key-result', result);
  }
});

// ============================================
// RELAY SERVER CONNECTION
// ============================================
let relayWs = null;
let relayUrl = '';
let roomId = '';
const DEFAULT_RELAY_URL = 'https://tiktok-live-relay.onrender.com';

// Load or generate unique room ID
function getRoomId() {
  const configPath = path.join(app.getPath('userData'), 'room-config.json');
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    if (config.roomId) return config.roomId;
  } catch (e) {}
  const newId = crypto.randomBytes(12).toString('hex');
  try {
    fs.writeFileSync(configPath, JSON.stringify({ roomId: newId }));
  } catch (e) {}
  return newId;
}

// Load relay server URL
function getRelayConfig() {
  const configPath = path.join(app.getPath('userData'), 'room-config.json');
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (e) {
    return {};
  }
}

function saveRelayConfig(config) {
  const configPath = path.join(app.getPath('userData'), 'room-config.json');
  const current = getRelayConfig();
  fs.writeFileSync(configPath, JSON.stringify({ ...current, ...config }));
}

let keepAliveInterval = null;
let reconnectTimeout = null;

function connectToRelay(serverUrl) {
  if (reconnectTimeout) { clearTimeout(reconnectTimeout); reconnectTimeout = null; }
  if (relayWs) {
    try { relayWs.close(); } catch (e) {}
  }

  relayUrl = serverUrl.replace(/\/$/, '');
  const wsUrl = relayUrl.replace(/^http/, 'ws');

  relayWs = new WebSocket(wsUrl);

  relayWs.on('open', () => {
    console.log('Relay connected');
    relayWs.send(JSON.stringify({ type: 'join', roomId }));
    if (mainWindow) {
      mainWindow.webContents.send('relay-status', { connected: true, serverUrl: relayUrl, roomId });
    }
    // Re-sync state to relay after (re)connect so it survives server restarts
    setTimeout(() => {
      relaySend({ type: 'scoreboard', ...scoreboardState });
    }, 500);
    // Start keep-alive ping every 4 minutes to prevent Render free tier spin-down
    if (keepAliveInterval) clearInterval(keepAliveInterval);
    keepAliveInterval = setInterval(() => {
      if (relayWs && relayWs.readyState === WebSocket.OPEN) {
        relayWs.send(JSON.stringify({ type: 'ping' }));
        console.log('Keep-alive ping sent');
      }
    }, 4 * 60 * 1000); // 4 minutes
  });

  relayWs.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'joined') {
        console.log('Joined relay room:', msg.roomId);
      }
    } catch (e) {}
  });

  relayWs.on('close', () => {
    console.log('Relay disconnected, will reconnect in 3s...');
    if (keepAliveInterval) { clearInterval(keepAliveInterval); keepAliveInterval = null; }
    if (mainWindow) {
      mainWindow.webContents.send('relay-status', { connected: false });
    }
    // Auto-reconnect after 3s
    reconnectTimeout = setTimeout(() => {
      if (relayUrl) connectToRelay(relayUrl);
    }, 3000);
  });

  relayWs.on('error', (err) => {
    console.error('Relay connection error:', err.message);
    if (mainWindow) {
      mainWindow.webContents.send('relay-status', { connected: false, error: err.message });
    }
  });
}

function relaySend(data) {
  if (relayWs && relayWs.readyState === WebSocket.OPEN) {
    relayWs.send(JSON.stringify(data));
  }
}

// ============================================
// UNIFIED CHAT STATE
// ============================================
let chatWindow = null;
let chatHistory = [];
const MAX_CHAT_HISTORY = 300;
const chatPlatformStatus = { tiktok: false, twitch: false, kick: false, youtube: false };

// Event notification config (which event types are enabled)
let chatEventConfig = {
  tiktok:  { follow: true,  gift: true,  subscribe: true, share: false, member: false, like: false },
  twitch:  { sub: true,     giftsub: true, raid: true,    bits: false },
  kick:    { follow: true,  subscribe: true, giftsub: true },
  youtube: { superchat: true, membership: true, subscribe: true, like: true }
};

function isEventEnabled(platform, type) {
  const pc = chatEventConfig[platform];
  if (!pc) return true;
  return pc[type] !== false;
}

function sendChatMessage(msg) {
  chatHistory.push(msg);
  if (chatHistory.length > MAX_CHAT_HISTORY) chatHistory.shift();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('chat-message', msg);
  if (chatWindow && !chatWindow.isDestroyed()) chatWindow.webContents.send('chat-message', msg);
}

function sendChatEvent(evt) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('chat-event', evt);
  if (chatWindow && !chatWindow.isDestroyed()) chatWindow.webContents.send('chat-event', evt);
}

function updateChatPlatformStatus(platform, connected) {
  chatPlatformStatus[platform] = connected;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('chat-platform-status', { platform, connected });
  if (chatWindow && !chatWindow.isDestroyed()) chatWindow.webContents.send('chat-platform-status', { platform, connected });
}

// ============================================
// WINDOW
// ============================================
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 750,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    backgroundColor: '#1a1f2e',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadFile('renderer/index.html');

  // Re-focus webContents whenever the window is focused so inputs always work
  mainWindow.on('focus', () => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.focus();
  });

  mainWindow.on('close', () => {
    // Destroy hidden BrowserWindows so the process doesn't stay alive
    if (livepixBrowserWin && !livepixBrowserWin.isDestroyed()) {
      try { livepixBrowserWin.webContents.debugger.detach(); } catch(e) {}
      livepixBrowserWin.destroy();
      livepixBrowserWin = null;
    }
    if (livepixWindow && !livepixWindow.isDestroyed()) {
      try { livepixWindow.destroy(); } catch(e) {}
      livepixWindow = null;
    }
    if (tikfinityWindow && !tikfinityWindow.isDestroyed()) {
      try { tikfinityWindow.destroy(); } catch(e) {}
      tikfinityWindow = null;
    }
    if (youtubeChatBW && !youtubeChatBW.isDestroyed()) {
      try { youtubeChatBW.destroy(); } catch(e) {}
      youtubeChatBW = null;
    }
    if (chatWindow && !chatWindow.isDestroyed()) {
      try { chatWindow.destroy(); } catch(e) {}
      chatWindow = null;
    }
  });
}

// Window controls
ipcMain.on('refocus-window', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.focus();
});

ipcMain.on('window-minimize', () => mainWindow.minimize());
ipcMain.on('window-maximize', () => {
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('window-close', () => mainWindow.close());

// ============================================
// RELAY SERVER CONFIG
// ============================================
ipcMain.on('connect-relay', (event, serverUrl) => {
  saveRelayConfig({ relayUrl: serverUrl });
  connectToRelay(serverUrl);
});

ipcMain.handle('get-relay-config', () => {
  return { relayUrl, roomId };
});

ipcMain.handle('get-overlay-urls', () => {
  if (!relayUrl) {
    return { configured: false };
  }
  return {
    edits1: `${relayUrl}/overlay/${roomId}/edits/1`,
    edits2: `${relayUrl}/overlay/${roomId}/edits/2`,
    edits3: `${relayUrl}/overlay/${roomId}/edits/3`,
    coinsRanking: `${relayUrl}/overlay/${roomId}/ranking/coins`,
    pointsRanking: `${relayUrl}/overlay/${roomId}/ranking/points`,
    membrosAcao: `${relayUrl}/overlay/${roomId}/membros-acao`,
    likesRanking: `${relayUrl}/overlay/${roomId}/ranking/likes`,
    jar: `${relayUrl}/overlay/${roomId}/jar`,
    scoreboard: `${relayUrl}/overlay/${roomId}/scoreboard`,
    timer: `${relayUrl}/overlay/${roomId}/timer`,
    goalCoins: `${relayUrl}/overlay/${roomId}/goal/coins`,
    goalLikes: `${relayUrl}/overlay/${roomId}/goal/likes`,
    membros: `${relayUrl}/overlay/${roomId}/membros`,
    topScore: `${relayUrl}/overlay/${roomId}/top-score`,
    topGift: `${relayUrl}/overlay/${roomId}/top-gift`,
    topCombo: `${relayUrl}/overlay/${roomId}/top-combo`,
    goalPix: `${relayUrl}/overlay/${roomId}/goal/pix`,
    configured: true
  };
});

// ============================================
// FETCH TIKTOK PROFILE (para adicionar membros manualmente)
// ============================================
ipcMain.handle('fetch-tiktok-profile', async (event, username) => {
  const cleanUser = username.replace(/^@/, '').trim();
  if (!cleanUser) return { ok: false, error: 'Nome vazio' };

  return new Promise((resolve) => {
    const tiktokSess = session.fromPartition('persist:tiktok-live');
    const win = new BrowserWindow({
      width: 800, height: 600,
      show: false,
      webPreferences: { session: tiktokSess, nodeIntegration: false, contextIsolation: true }
    });

    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      try { win.destroy(); } catch (e) {}
      resolve(result);
    };

    const timeout = setTimeout(() => finish({ ok: false, error: 'Tempo esgotado' }), 15000);

    win.webContents.on('did-finish-load', async () => {
      // Aguarda React renderizar os componentes (página é CSR)
      await new Promise(r => setTimeout(r, 3000));
      if (done) return;
      try {
        const jsCode = `
          (function() {
            let profilePictureUrl = '';
            let nickname = null;

            // 1) Avatar renderizado no DOM (src já resolvido pelo browser)
            const selectors = [
              '[data-e2e="user-avatar"] img',
              '[class*="UserAvatar"] img',
              '[class*="avatar"] img',
              'img[src*="tiktokcdn"][width]',
              'img[src*="tiktokcdn"]'
            ];
            for (const sel of selectors) {
              const el = document.querySelector(sel);
              if (el && el.src && el.src.includes('tiktokcdn')) {
                profilePictureUrl = el.src;
                break;
              }
            }

            // 2) Nickname do DOM
            const nameSelectors = [
              '[data-e2e="user-title"]',
              '[class*="UserTitle"]',
              'h1[class*="title"]',
              'h2[class*="title"]'
            ];
            for (const sel of nameSelectors) {
              const el = document.querySelector(sel);
              if (el && el.textContent.trim()) {
                nickname = el.textContent.trim();
                break;
              }
            }

            // 3) Fallback og:image / og:title se DOM falhar
            if (!profilePictureUrl) {
              const img = document.querySelector('meta[property="og:image"]');
              if (img && img.content) profilePictureUrl = img.content;
            }
            if (!nickname) {
              const title = document.querySelector('meta[property="og:title"]');
              if (title && title.content) {
                nickname = title.content
                  .replace(/\\s*\\(@[^)]+\\)/g, '')
                  .replace(/\\s*\\|.*$/g, '')
                  .trim() || null;
              }
            }

            return { ok: !!profilePictureUrl, profilePictureUrl, nickname };
          })()
        `;
        const result = await win.webContents.executeJavaScript(jsCode);
        clearTimeout(timeout);
        finish({
          ok: result.ok,
          userId: cleanUser,
          nickname: result.nickname || cleanUser,
          profilePictureUrl: result.profilePictureUrl || ''
        });
      } catch (e) {
        clearTimeout(timeout);
        finish({ ok: false, error: 'Erro ao ler página' });
      }
    });

    win.webContents.on('did-fail-load', () => {
      clearTimeout(timeout);
      finish({ ok: false, error: 'Falha ao carregar página' });
    });

    win.loadURL(`https://www.tiktok.com/@${cleanUser}`, {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36'
    });
  });
});

// ============================================
// TIKTOK CONNECTION
// ============================================
let tiktokConnection = null;
let tiktokUsername = null;
let tiktokAutoReconnect = false;
let tiktokReconnectTimeout = null;
let tiktokReconnectDelay = 5000; // starts at 5s, increases up to 30s
let tiktokSenderEvent = null; // stores the event to reply to renderer

function clearTiktokReconnect() {
  if (tiktokReconnectTimeout) {
    clearTimeout(tiktokReconnectTimeout);
    tiktokReconnectTimeout = null;
  }
}

function scheduleReconnect() {
  if (!tiktokAutoReconnect || !tiktokUsername || !tiktokSenderEvent) return;
  clearTiktokReconnect();
  console.log(`TikTok: reconnecting in ${tiktokReconnectDelay / 1000}s...`);
  if (mainWindow) {
    mainWindow.webContents.send('tiktok-status', {
      connected: false,
      reason: 'reconnecting',
      retryIn: tiktokReconnectDelay / 1000
    });
  }
  tiktokReconnectTimeout = setTimeout(() => {
    if (tiktokAutoReconnect) connectTikTok(tiktokSenderEvent, tiktokUsername);
  }, tiktokReconnectDelay);
  // Increase delay up to 30s
  tiktokReconnectDelay = Math.min(tiktokReconnectDelay * 2, 30000);
}

// Extrai o roomId do TikTok usando BrowserWindow oculto + sessão persistente.
// TikTok usa CSR: o roomId só aparece nas requisições de rede após o JS executar.
// Usamos sessão persistente para acumular cookies do TikTok (msToken, etc.)
// que são necessários para o JS completar o fluxo da live.
function fetchTikTokRoomId(username) {
  const clean = username.replace(/^@/, '').trim();

  return new Promise((resolve) => {
    let resolved = false;
    let bw = null;

    const finish = (val) => {
      if (resolved) return;
      resolved = true;
      resolve(val);
    };

    const cleanup = () => {
      // Remove listener antes de fechar para evitar memory leaks
      try { tiktokLiveSess.webRequest.onBeforeRequest(null); } catch (e) {}
      setTimeout(() => {
        try { if (bw && !bw.isDestroyed()) bw.close(); } catch (e) {}
      }, 300);
    };

    // Sessão PERSISTENTE — acumula cookies do TikTok (msToken etc.) entre conexões.
    // Isso é crítico: sem msToken, o JS do TikTok não faz chamadas webcast.
    const tiktokLiveSess = session.fromPartition('persist:tiktok-live');

    // onBeforeRequest captura TODAS as requisições antes de enviadas
    // (funciona para HTTP, HTTPS e WebSocket upgrades)
    tiktokLiveSess.webRequest.onBeforeRequest(
      { urls: ['*://*.tiktok.com/*', '*://tiktok.com/*'] },
      (details, callback) => {
        if (!resolved) {
          const url = details.url;
          // Captura room_id de URLs de webcast (GET ou WebSocket upgrade)
          const m = url.match(/[?&]room_id=(\d{5,})/) || url.match(/[?&]roomId=(\d{5,})/);
          if (m) {
            console.log('TikTok roomId capturado:', m[1], 'URL:', url.substring(0, 100));
            finish(m[1]);
            cleanup();
          }
        }
        callback({});
      }
    );

    bw = new BrowserWindow({
      width: 1024, height: 768,
      show: false,
      focusable: false,
      webPreferences: {
        session: tiktokLiveSess,
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: false, // permite carregar recursos cross-origin
      }
    });

    // Após carregamento completo, aguarda JS executar e faz checagem DOM
    bw.webContents.on('did-finish-load', async () => {
      if (resolved) return;
      // Aguarda 3s para React renderizar e fazer chamadas de API
      await new Promise(r => setTimeout(r, 3000));
      if (resolved) return;

      try {
        const result = await bw.webContents.executeJavaScript(`
          (function() {
            // Tenta ler o roomId do SIGI_STATE após JS atualizar
            try {
              var el = document.getElementById('SIGI_STATE');
              if (el) {
                var d = JSON.parse(el.textContent);
                if (d && d.CurrentRoom && d.CurrentRoom.roomId) return d.CurrentRoom.roomId;
              }
            } catch(e) {}
            // Varre todos os scripts em busca de roomId
            var scripts = Array.from(document.querySelectorAll('script'));
            for (var i = 0; i < scripts.length; i++) {
              var m = scripts[i].textContent.match(/"roomId"\s*:\s*"(\d{6,})"/);
              if (m) return m[1];
            }
            // Verifica estado offline no texto da página
            var bodyText = (document.body && document.body.innerText) || '';
            if (/isn.t hosting a LIVE|not hosting a LIVE|live encerrada|não está em live/i.test(bodyText)) {
              return 'offline';
            }
            return null;
          })()
        `);

        if (result && result !== 'null' && result !== 'offline') {
          console.log('TikTok roomId extraído do DOM após JS:', result);
          finish(result);
          cleanup();
        } else if (result === 'offline') {
          console.log('TikTok: usuário offline detectado pelo DOM');
          finish(null);
          cleanup();
        }
        // else: aguarda timeout — pode vir via onBeforeRequest
      } catch (e) {}
    });

    // Timeout de 15 segundos (sessão persistente já tem cookies)
    const timeout = setTimeout(() => {
      console.log('TikTok roomId: timeout após 15s');
      finish(null);
      cleanup();
    }, 15000);

    bw.on('closed', () => {
      clearTimeout(timeout);
      finish(null);
    });

    bw.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
      console.log('TikTok page load failed:', errorCode, errorDescription);
    });

    bw.loadURL(`https://www.tiktok.com/@${clean}/live`, {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    });
  });
}

async function connectTikTok(event, username) {
  try {
    const { WebcastPushConnection } = require('tiktok-live-connector');

    if (tiktokConnection) {
      try { tiktokConnection.disconnect(); } catch (e) {}
      tiktokConnection = null;
    }

    // Informa que está verificando a live
    if (mainWindow) mainWindow.webContents.send('tiktok-status', { connected: false, reason: 'checking' });

    tiktokConnection = new WebcastPushConnection(username, {
      processInitialData: true,
      fetchRoomInfoOnConnect: false,
    });

    // ── Método 1 (rápido ~1-2s): API-Live do TikTok via biblioteca ──────────
    // Funciona quando o usuário está ao vivo. Retorna roomId em ~1-2 segundos.
    let roomId = null;
    try {
      roomId = await tiktokConnection.fetchRoomId();
      console.log('TikTok roomId via API-Live:', roomId);
    } catch (libErr) {
      console.log('API-Live failed, falling back to BrowserWindow:', (libErr.message || '').substring(0, 100));
    }

    // ── Método 2 (lento ~10-20s): BrowserWindow com sessão persistente ──────
    // Usado quando API-Live falha. Carrega a página real e captura room_id
    // das requisições de rede feitas pelo JS do TikTok.
    if (!roomId) {
      try {
        roomId = await fetchTikTokRoomId(username);
        console.log('TikTok roomId via BrowserWindow:', roomId);
      } catch (fetchErr) {
        console.log('BrowserWindow fetch also failed:', fetchErr.message);
      }
    }

    if (!roomId) {
      if (mainWindow) mainWindow.webContents.send('tiktok-status', { connected: false, error: 'Usuário não encontrado ou não está em live.' });
      tiktokAutoReconnect = false;
      return;
    }

    const state = await tiktokConnection.connect(roomId);

    tiktokReconnectDelay = 5000;
    updateChatPlatformStatus('tiktok', true);
    if (mainWindow) mainWindow.webContents.send('tiktok-status', { connected: true, roomId: state.roomId });

    tiktokConnection.on('chat', (data) => {
      if (mainWindow) mainWindow.webContents.send('tiktok-event', { type: 'chat', data });
      sendChatMessage({ platform: 'tiktok', username: data.nickname || data.uniqueId || 'anon', message: data.comment || '', color: '#ff2d55' });
    });

    tiktokConnection.on('gift', (data) => {
      if (mainWindow) mainWindow.webContents.send('tiktok-event', { type: 'gift', data });
      if (isEventEnabled('tiktok', 'gift')) {
        const giftName = data.giftName || 'Presente';
        const count = data.repeatCount || 1;
        sendChatEvent({ platform: 'tiktok', eventType: 'gift', username: data.nickname || data.uniqueId || 'anon', detail: giftName + (count > 1 ? ' x' + count : ''), color: '#ff2d55' });
      }
    });

    tiktokConnection.on('like', (data) => {
      if (mainWindow) mainWindow.webContents.send('tiktok-event', { type: 'like', data });
      if (isEventEnabled('tiktok', 'like')) {
        sendChatEvent({ platform: 'tiktok', eventType: 'like', username: data.nickname || data.uniqueId || 'anon', detail: data.likeCount > 1 ? 'x' + data.likeCount : '', color: '#ff2d55' });
      }
    });

    tiktokConnection.on('member', (data) => {
      if (mainWindow) mainWindow.webContents.send('tiktok-event', { type: 'member', data });
      if (isEventEnabled('tiktok', 'member')) {
        sendChatEvent({ platform: 'tiktok', eventType: 'member', username: data.nickname || data.uniqueId || 'anon', color: '#ff2d55' });
      }
    });

    tiktokConnection.on('follow', (data) => {
      if (mainWindow) mainWindow.webContents.send('tiktok-event', { type: 'follow', data });
      if (isEventEnabled('tiktok', 'follow')) {
        sendChatEvent({ platform: 'tiktok', eventType: 'follow', username: data.nickname || data.uniqueId || 'anon', color: '#ff2d55' });
      }
    });

    tiktokConnection.on('share', (data) => {
      if (mainWindow) mainWindow.webContents.send('tiktok-event', { type: 'share', data });
      if (isEventEnabled('tiktok', 'share')) {
        sendChatEvent({ platform: 'tiktok', eventType: 'share', username: data.nickname || data.uniqueId || 'anon', color: '#ff2d55' });
      }
    });

    tiktokConnection.on('subscribe', (data) => {
      if (mainWindow) mainWindow.webContents.send('tiktok-event', { type: 'subscribe', data });
      if (isEventEnabled('tiktok', 'subscribe')) {
        sendChatEvent({ platform: 'tiktok', eventType: 'subscribe', username: data.nickname || data.uniqueId || 'anon', color: '#ff2d55' });
      }
    });

    tiktokConnection.on('roomUser', (data) => {
      if (mainWindow) mainWindow.webContents.send('tiktok-event', { type: 'roomUser', data });
    });

    tiktokConnection.on('streamEnd', () => {
      tiktokConnection = null;
      updateChatPlatformStatus('tiktok', false);
      if (tiktokAutoReconnect) scheduleReconnect();
      else if (mainWindow) mainWindow.webContents.send('tiktok-status', { connected: false, reason: 'stream_ended' });
    });

    tiktokConnection.on('disconnected', () => {
      tiktokConnection = null;
      updateChatPlatformStatus('tiktok', false);
      if (tiktokAutoReconnect) scheduleReconnect();
      else if (mainWindow) mainWindow.webContents.send('tiktok-status', { connected: false, reason: 'disconnected' });
    });

    tiktokConnection.on('error', (err) => {
      console.error('TikTok error:', err.message);
    });

  } catch (err) {
    tiktokConnection = null;
    let errorMsg = err.message || String(err);
    console.error('TikTok connect error:', errorMsg);

    if (errorMsg.includes('offline') || errorMsg.includes('not live') || errorMsg.includes('UserOffline') ||
        errorMsg.includes('not found') || errorMsg.includes('404')) {
      if (mainWindow) mainWindow.webContents.send('tiktok-status', { connected: false, error: 'Usuário não encontrado ou não está em live.' });
      tiktokAutoReconnect = false;
      return;
    }
    if (errorMsg.includes('LIVE has ended') || errorMsg.includes('stream_ended')) {
      if (mainWindow) mainWindow.webContents.send('tiktok-status', { connected: false, error: 'A live já foi encerrada.' });
      tiktokAutoReconnect = false;
      return;
    }
    if (errorMsg.includes('429')) errorMsg = 'Muitas tentativas. Aguardando...';

    if (mainWindow) mainWindow.webContents.send('tiktok-status', { connected: false, error: errorMsg, reason: 'reconnecting' });
    if (tiktokAutoReconnect) scheduleReconnect();
  }
}

ipcMain.on('connect-tiktok', async (event, username) => {
  clearTiktokReconnect();
  tiktokUsername = username;
  tiktokAutoReconnect = true;
  tiktokSenderEvent = event;
  tiktokReconnectDelay = 5000;
  await connectTikTok(event, username);
});

ipcMain.on('disconnect-tiktok', (event) => {
  tiktokAutoReconnect = false;
  tiktokUsername = null;
  tiktokSenderEvent = null;
  clearTiktokReconnect();
  if (tiktokConnection) {
    try { tiktokConnection.disconnect(); } catch (e) {}
    tiktokConnection = null;
  }
  event.reply('tiktok-status', { connected: false, reason: 'user_disconnected' });
});

ipcMain.on('get-gifts', async (event) => {
  if (tiktokConnection) {
    try {
      const gifts = await tiktokConnection.getAvailableGifts();
      event.reply('gifts-list', gifts);
    } catch (e) { event.reply('gifts-list', []); }
  }
});

// ============================================
// RELAY EVENTS (from renderer)
// ============================================

// Send edit trigger to relay + send media file
ipcMain.on('trigger-edit-overlay', (event, edit) => {
  if (!relayWs || relayWs.readyState !== WebSocket.OPEN) return;

  // Read file and send as base64
  try {
    const fileData = fs.readFileSync(edit.filePath);
    const base64 = fileData.toString('base64');
    const ext = path.extname(edit.filePath).toLowerCase();
    const mimeTypes = {
      '.mp4': 'video/mp4', '.webm': 'video/webm', '.gif': 'image/gif',
      '.avi': 'video/x-msvideo', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska'
    };
    const mediaId = crypto.randomBytes(8).toString('hex');

    // Send media data first
    relaySend({
      type: 'media',
      id: mediaId,
      data: base64,
      mimeType: mimeTypes[ext] || 'video/mp4'
    });

    // Then send play command
    setTimeout(() => {
      relaySend({
        type: 'edit',
        giftName: edit.giftName,
        mediaId: mediaId,
        duration: edit.duration,
        isGif: edit.isGif,
        scene: edit.scene || 1,
        senderNickname: edit.senderNickname || '',
        senderPhoto: edit.senderPhoto || '',
        volume: edit.volume !== undefined ? edit.volume : 100
      });
    }, 100);
  } catch (e) {
    console.error('Error sending edit to relay:', e.message);
  }
});

ipcMain.on('update-coins-ranking', (event, ranking) => {
  relaySend({ type: 'coins', data: ranking });
});

ipcMain.on('update-likes-ranking', (event, ranking) => {
  relaySend({ type: 'likes', data: ranking });
});

ipcMain.on('update-points-ranking', (event, ranking) => {
  relaySend({ type: 'points', data: ranking });
});

ipcMain.on('membros-acao-config', (event, data) => {
  relaySend({ type: 'membros-acao-config', ...data });
});
ipcMain.on('membros-acao-add', (event, data) => {
  relaySend({ type: 'membros-acao-add', ...data });
});
ipcMain.on('membros-acao-reset', () => {
  relaySend({ type: 'membros-acao-reset' });
});

ipcMain.on('update-ranking-config', (event, config) => {
  relaySend({ type: 'ranking-config', ranking: config.ranking, bg: config.bg, side: config.side, theme: config.theme, customColor: config.customColor });
});

ipcMain.on('update-points-config', (event, config) => {
  relaySend({ type: 'points-config', ...config });
});

// Scoreboard events
let scoreboardState = { left: 0, right: 0, leftName: 'Streamer', rightName: 'Chat', theme: 'neon', style: 'default', customColor: '' };
let scoreboardEnabled = false;

ipcMain.on('scoreboard-update', (event, data) => {
  scoreboardState = { ...scoreboardState, ...data };
  relaySend({ type: 'scoreboard', ...scoreboardState });
});

ipcMain.on('scoreboard-toggle', (event, enabled) => {
  scoreboardEnabled = enabled;
  if (enabled) {
    registerScoreboardShortcuts();
  } else {
    unregisterScoreboardShortcuts();
  }
});

ipcMain.on('scoreboard-get-state', (event) => {
  event.reply('scoreboard-state', scoreboardState);
});

function registerScoreboardShortcuts() {
  try {
    globalShortcut.register("'", () => {});
    globalShortcut.unregister("'");
    globalShortcut.register("Shift+'", () => {});
    globalShortcut.unregister("Shift+'");
  } catch (e) {}
  try {
    globalShortcut.register('Ctrl+1', () => {
      scoreboardState.left++;
      relaySend({ type: 'scoreboard', ...scoreboardState });
      if (mainWindow) mainWindow.webContents.send('scoreboard-state', scoreboardState);
    });
    globalShortcut.register('Ctrl+2', () => {
      scoreboardState.right++;
      relaySend({ type: 'scoreboard', ...scoreboardState });
      if (mainWindow) mainWindow.webContents.send('scoreboard-state', scoreboardState);
    });
    globalShortcut.register('Ctrl+3', () => {
      const tmp = scoreboardState.left;
      scoreboardState.left = scoreboardState.right;
      scoreboardState.right = tmp;
      relaySend({ type: 'scoreboard', ...scoreboardState });
      if (mainWindow) mainWindow.webContents.send('scoreboard-state', scoreboardState);
    });
    globalShortcut.register('Ctrl+4', () => {
      scoreboardState.left = 0;
      scoreboardState.right = 0;
      relaySend({ type: 'scoreboard', ...scoreboardState });
      if (mainWindow) mainWindow.webContents.send('scoreboard-state', scoreboardState);
    });
  } catch (e) {
    console.error('Failed to register scoreboard shortcuts:', e);
  }
}

function unregisterScoreboardShortcuts() {
  try {
    globalShortcut.unregister('Ctrl+1');
    globalShortcut.unregister('Ctrl+2');
    globalShortcut.unregister('Ctrl+3');
    globalShortcut.unregister('Ctrl+4');
  } catch (e) {}
}

// Jar events
ipcMain.on('jar-gift', (event, data) => {
  relaySend({ type: 'jar-gift', giftImage: data.giftImage, giftName: data.giftName, count: data.count, coins: data.coins || 0 });
});

ipcMain.on('jar-reset', () => {
  relaySend({ type: 'jar-reset' });
});

ipcMain.on('jar-config', (event, data) => {
  relaySend({ type: 'jar-config', theme: data.theme, customColor: data.customColor, capacity: data.capacity, visual: data.visual });
});

// Goal events
ipcMain.on('goal-update', (event, data) => {
  relaySend({ type: 'goal-update', goalType: data.type, text: data.text, target: data.target, current: data.current, theme: data.theme, customColor: data.customColor, style: data.style });
});

ipcMain.on('top-score-update', (event, data) => {
  relaySend({ type: 'top-score-update', title: data.title, desc: data.desc, subtitle: data.subtitle, name: data.name, avatar: data.avatar, valor: data.valor });
});

ipcMain.on('top-gift-update', (event, data) => {
  relaySend({ type: 'top-gift-update', giftName: data.giftName, giftPictureUrl: data.giftPictureUrl, diamonds: data.diamonds, nickname: data.nickname, profilePictureUrl: data.profilePictureUrl });
});

ipcMain.on('top-combo-update', (event, data) => {
  relaySend({ type: 'top-combo-update', giftName: data.giftName, giftPictureUrl: data.giftPictureUrl, comboCount: data.comboCount, nickname: data.nickname, profilePictureUrl: data.profilePictureUrl });
});

ipcMain.on('top-gift-config', (event, data) => {
  relaySend({ type: 'top-gift-config', label: data.label, labelColor: data.labelColor, nameColor: data.nameColor, valueColor: data.valueColor });
});

ipcMain.on('top-combo-config', (event, data) => {
  relaySend({ type: 'top-combo-config', label: data.label, labelColor: data.labelColor, nameColor: data.nameColor, comboColor: data.comboColor });
});

ipcMain.on('top-gift-reset', () => {
  relaySend({ type: 'top-gift-reset' });
});

ipcMain.on('top-combo-reset', () => {
  relaySend({ type: 'top-combo-reset' });
});

// ============================================
// LIVEPIX GOAL POLLING (Meta de PIX)
// ============================================
let livepixGoalPollInterval = null;

let livepixBrowserWin = null;

ipcMain.on('livepix-start-poll', async (event, { url }) => {
  if (livepixGoalPollInterval) { clearInterval(livepixGoalPollInterval); livepixGoalPollInterval = null; }
  if (livepixBrowserWin && !livepixBrowserWin.isDestroyed()) {
    try { livepixBrowserWin.webContents.debugger.detach(); } catch(e) {}
    livepixBrowserWin.destroy(); livepixBrowserWin = null;
  }

  const clean = url.trim().replace(/\/$/, '');
  if (!/livepix\.gg/i.test(clean)) {
    if (mainWindow) mainWindow.webContents.send('livepix-status', { error: '❌ URL inválida. Use: livepix.gg/seuusuario ou widget.livepix.gg/embed/...' });
    return;
  }

  livepixBrowserWin = new BrowserWindow({
    width: 900, height: 600, show: false, focusable: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });

  // Use Chrome DevTools Protocol to intercept API responses
  const dbg = livepixBrowserWin.webContents.debugger;
  try { dbg.attach('1.3'); } catch(e) {}
  dbg.sendCommand('Network.enable');

  dbg.on('message', async (evt, method, params) => {
    if (method !== 'Network.responseReceived') return;
    const respUrl = params.response.url || '';
    // Capture any API call that might contain goal/amount data
    if (!/livepix\.gg/i.test(respUrl)) return;
    if (params.response.mimeType && !params.response.mimeType.includes('json')) return;
    try {
      const r = await dbg.sendCommand('Network.getResponseBody', { requestId: params.requestId });
      const data = JSON.parse(r.body);
      const findAmount = (obj, depth) => {
        if (!obj || typeof obj !== 'object' || depth > 10) return null;
        for (const key of ['current', 'collected', 'totalCollected', 'amount', 'raised', 'total', 'value', 'progress']) {
          const v = obj[key];
          if (typeof v === 'number' && v >= 0) return v;
          if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v)) return Number(v);
        }
        for (const v of Object.values(obj)) { const res = findAmount(v, depth + 1); if (res !== null) return res; }
        return null;
      };
      const amount = findAmount(data, 0);
      if (amount !== null && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('livepix-update', { total: amount });
      }
    } catch(e) {}
  });

  // Load the page — the page's own JS will call LivePix API, we intercept that
  livepixBrowserWin.loadURL(clean);

  // Poll: reload page every 30s so the API is called again
  const reload = () => {
    if (livepixBrowserWin && !livepixBrowserWin.isDestroyed()) livepixBrowserWin.loadURL(clean);
  };
  livepixGoalPollInterval = setInterval(reload, 30000);

  if (mainWindow) mainWindow.webContents.send('livepix-status', { ok: true, username: clean });
});

ipcMain.on('livepix-stop-poll', () => {
  if (livepixGoalPollInterval) { clearInterval(livepixGoalPollInterval); livepixGoalPollInterval = null; }
  if (livepixBrowserWin && !livepixBrowserWin.isDestroyed()) { livepixBrowserWin.destroy(); livepixBrowserWin = null; }
});

ipcMain.handle('fetch-tiktok-user', async (event, username) => {
  const https = require('https');
  const clean = username.replace(/^@/, '').trim();

  function get(url) {
    return new Promise((resolve, reject) => {
      const req = https.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
          'Accept-Encoding': 'identity',
          'Cache-Control': 'no-cache',
          'sec-fetch-dest': 'document',
          'sec-fetch-mode': 'navigate',
          'sec-fetch-site': 'none',
          'upgrade-insecure-requests': '1'
        }
      }, (res) => {
        if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
          return get(res.headers.location).then(resolve).catch(reject);
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', c => body += c);
        res.on('end', () => resolve(body));
      });
      req.on('error', reject);
      req.setTimeout(12000, () => { req.destroy(); reject(new Error('timeout')); });
    });
  }

  try {
    const html = await get(`https://www.tiktok.com/@${encodeURIComponent(clean)}`);

    // Method 1: __UNIVERSAL_DATA_FOR_REHYDRATION__ (newer TikTok)
    const m1 = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
    if (m1) {
      try {
        const json = JSON.parse(m1[1]);
        const u = json?.['__DEFAULT_SCOPE__']?.['webapp.user-detail']?.userInfo?.user;
        if (u && u.nickname) {
          return { success: true, nickname: u.nickname, avatar: u.avatarLarger || u.avatarMedium || '', uniqueId: u.uniqueId };
        }
      } catch(e) {}
    }

    // Method 2: SIGI_STATE (older TikTok format)
    const m2 = html.match(/<script id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/);
    if (m2) {
      try {
        const json = JSON.parse(m2[1]);
        const users = json?.UserModule?.users || {};
        const u = Object.values(users)[0];
        if (u && u.nickname) {
          return { success: true, nickname: u.nickname, avatar: u.avatarLarger || u.avatarMedium || '', uniqueId: u.uniqueId };
        }
      } catch(e) {}
    }

    // Method 3: look for nickname/avatar in any JSON blob
    const m3 = html.match(/"nickname":"([^"]+)"[\s\S]{0,200}"avatarLarger":"([^"]+)"/);
    if (m3) {
      return { success: true, nickname: m3[1], avatar: m3[2].replace(/\\u002F/g, '/'), uniqueId: clean };
    }

    return { success: false, reason: 'not_found' };
  } catch(e) {
    return { success: false, reason: e.message };
  }
});

ipcMain.on('membros-title', (event, data) => {
  relaySend({ type: 'membros-title', title: data.title });
});
ipcMain.on('membros-add', (event, data) => {
  relaySend({ type: 'membros-add', userId: data.userId, nickname: data.nickname, profilePictureUrl: data.profilePictureUrl });
});
ipcMain.on('membros-reset', () => {
  relaySend({ type: 'membros-reset' });
});

// ============================================
// KEYBOARD SIMULATION
// ============================================
const keyNameMap = {
  'space': '{SPACE}', 'enter': '{ENTER}', 'tab': '{TAB}',
  'escape': '{ESC}', 'backspace': '{BACKSPACE}', 'delete': '{DELETE}',
  'up': '{UP}', 'down': '{DOWN}', 'left': '{LEFT}', 'right': '{RIGHT}',
  'f1': '{F1}', 'f2': '{F2}', 'f3': '{F3}', 'f4': '{F4}',
  'f5': '{F5}', 'f6': '{F6}', 'f7': '{F7}', 'f8': '{F8}',
  'f9': '{F9}', 'f10': '{F10}', 'f11': '{F11}', 'f12': '{F12}',
  'home': '{HOME}', 'end': '{END}', 'pageup': '{PGUP}', 'pagedown': '{PGDN}',
  'insert': '{INSERT}'
};

ipcMain.on('simulate-key', (event, keyData) => {
  try {
    const mods = keyData.modifiers || [];
    let key = keyNameMap[keyData.key] || keyData.key.toUpperCase();
    if (key.length === 1) key = key.toLowerCase();
    let prefix = '';
    if (mods.includes('control')) prefix += '^';
    if (mods.includes('alt')) prefix += '%';
    if (mods.includes('shift')) prefix += '+';
    const sendKey = prefix + key;
    const psCommand = `powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${sendKey.replace(/'/g, "''")}')"`;
    exec(psCommand, (err) => {
      if (err) console.error('Key simulation error:', err.message);
    });
  } catch (e) {
    console.error('Keyboard simulation error:', e.message);
  }
});

// File dialog - media
ipcMain.handle('open-file-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Mídia', extensions: ['mp4', 'webm', 'gif', 'avi', 'mov', 'mkv'] }]
  });
  if (!result.canceled && result.filePaths.length > 0) return result.filePaths[0];
  return null;
});

// ============================================
// TIMER SYSTEM
// ============================================
let timerState = { seconds: 0, running: false, theme: 'neon' };
let tikfinityWindow = null;
let livepixWindow = null;
let tikfinityLastSeconds = -1;
let livepixLastSeconds = -1;
let tikfinityPollInterval = null;
let livepixPollInterval = null;

ipcMain.on('timer-update', (event, data) => {
  timerState = { ...timerState, ...data };
  relaySend({ type: 'timer', ...timerState });
});

ipcMain.on('timer-config', (event, data) => {
  timerState.theme = data.theme;
  relaySend({ type: 'timer-config', theme: data.theme });
});

ipcMain.on('timer-connect-external', (event, data) => {
  if (data.source === 'tikfinity') {
    connectTikFinityTimer(data.url);
  } else if (data.source === 'livepix') {
    connectLivePixTimer(data.url);
  }
});

function connectTikFinityTimer(url) {
  if (tikfinityWindow) {
    try { tikfinityWindow.close(); } catch(e) {}
    tikfinityWindow = null;
  }
  if (tikfinityPollInterval) { clearInterval(tikfinityPollInterval); tikfinityPollInterval = null; }

  tikfinityWindow = new BrowserWindow({
    width: 400, height: 200, show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });

  tikfinityWindow.loadURL(url);
  tikfinityLastSeconds = -1;

  tikfinityWindow.webContents.on('did-finish-load', () => {
    if (mainWindow) mainWindow.webContents.send('timer-external-status', { source: 'tikfinity', connected: true });

    tikfinityPollInterval = setInterval(async () => {
      try {
        const text = await tikfinityWindow.webContents.executeJavaScript(`
          (function() {
            const el = document.getElementById('countdown');
            return el ? el.textContent || el.innerText : null;
          })()
        `);
        if (text) {
          const parts = text.split(':').map(Number);
          let totalSecs = 0;
          if (parts.length === 3) totalSecs = parts[0] * 3600 + parts[1] * 60 + parts[2];
          else if (parts.length === 2) totalSecs = parts[0] * 60 + parts[1];

          if (tikfinityLastSeconds >= 0) {
            const diff = totalSecs - tikfinityLastSeconds;
            if (diff > 1) {
              if (mainWindow) mainWindow.webContents.send('timer-external-add', { source: 'TikFinity', seconds: diff });
            }
          }
          tikfinityLastSeconds = totalSecs;
        }
      } catch (e) {}
    }, 1000);
  });

  tikfinityWindow.webContents.on('did-fail-load', () => {
    if (mainWindow) mainWindow.webContents.send('timer-external-status', { source: 'tikfinity', connected: false, error: 'Falha ao carregar' });
  });
}

function connectLivePixTimer(url) {
  if (livepixWindow) {
    try { livepixWindow.close(); } catch(e) {}
    livepixWindow = null;
  }
  if (livepixPollInterval) { clearInterval(livepixPollInterval); livepixPollInterval = null; }

  livepixWindow = new BrowserWindow({
    width: 400, height: 200, show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });

  livepixWindow.loadURL(url);
  livepixLastSeconds = -1;

  livepixWindow.webContents.on('did-finish-load', () => {
    if (mainWindow) mainWindow.webContents.send('timer-external-status', { source: 'livepix', connected: true });

    setTimeout(() => {
      livepixPollInterval = setInterval(async () => {
        try {
          const jsCode = '(function(){var all=document.querySelectorAll("*");for(var j=0;j<all.length;j++){var t=all[j].textContent.trim();if(all[j].children.length===0&&t.match(/^[0-9]{1,2}:[0-9]{2}(:[0-9]{2})?$/)){return t;}}return null;})()';
          const text = await livepixWindow.webContents.executeJavaScript(jsCode);
          if (text) {
            const clean = text.replace(/[^0-9:]/g, '');
            const parts = clean.split(':').map(Number);
            let totalSecs = 0;
            if (parts.length === 3) totalSecs = parts[0] * 3600 + parts[1] * 60 + parts[2];
            else if (parts.length === 2) totalSecs = parts[0] * 60 + parts[1];

            if (livepixLastSeconds >= 0) {
              const diff = totalSecs - livepixLastSeconds;
              if (diff > 1) {
                if (mainWindow) mainWindow.webContents.send('timer-external-add', { source: 'LivePix', seconds: diff });
              }
            }
            livepixLastSeconds = totalSecs;
          }
        } catch (e) {}
      }, 1000);
    }, 3000);
  });

  livepixWindow.webContents.on('did-fail-load', () => {
    if (mainWindow) mainWindow.webContents.send('timer-external-status', { source: 'livepix', connected: false, error: 'Falha ao carregar' });
  });
}

// ============================================
// UNIFIED CHAT IPC HANDLERS
// ============================================

// Open / focus chat window
ipcMain.on('open-chat-window', () => {
  if (chatWindow && !chatWindow.isDestroyed()) { chatWindow.focus(); return; }
  chatWindow = new BrowserWindow({
    width: 380, height: 640,
    minWidth: 240, minHeight: 200,
    show: false,
    transparent: true,
    frame: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  chatWindow.loadFile(path.join(__dirname, 'renderer/chat-window.html'));
  chatWindow.setMenu(null);
  chatWindow.once('ready-to-show', () => {
    chatWindow.show();
    // Send history and current platform statuses
    chatWindow.webContents.send('chat-history', chatHistory);
    Object.entries(chatPlatformStatus).forEach(([p, c]) => {
      chatWindow.webContents.send('chat-platform-status', { platform: p, connected: c });
    });
  });
  chatWindow.on('closed', () => { chatWindow = null; });
});

// Click-through (lock mode) for chat window
ipcMain.on('chat-win-ignore-mouse', (event, ignore) => {
  if (chatWindow && !chatWindow.isDestroyed()) {
    chatWindow.setIgnoreMouseEvents(ignore, { forward: true });
  }
});

ipcMain.on('chat-win-opacity', (event, value) => {
  if (chatWindow && !chatWindow.isDestroyed()) {
    chatWindow.setOpacity(Math.max(0.05, Math.min(1, value)));
  }
});

ipcMain.on('chat-win-close', () => {
  if (chatWindow && !chatWindow.isDestroyed()) chatWindow.close();
});

ipcMain.on('chat-win-minimize', () => {
  if (chatWindow && !chatWindow.isDestroyed()) chatWindow.minimize();
});

ipcMain.on('chat-clear-all', () => {
  chatHistory = [];
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('chat-clear');
  if (chatWindow && !chatWindow.isDestroyed()) chatWindow.webContents.send('chat-clear');
});

// Chat event config from renderer
ipcMain.on('set-chat-event-config', (event, config) => {
  chatEventConfig = config;
});

// --- TWITCH ---
let twitchChatWs = null;

ipcMain.on('connect-twitch-chat', (event, { channel }) => {
  if (twitchChatWs) { try { twitchChatWs.close(); } catch(e){} twitchChatWs = null; }
  const ch = channel.toLowerCase().replace(/^#/, '').trim();
  twitchChatWs = new WebSocket('wss://irc-ws.chat.twitch.tv:443');

  twitchChatWs.on('open', () => {
    twitchChatWs.send('CAP REQ :twitch.tv/tags');
    twitchChatWs.send('PASS oauth:anonymous');
    twitchChatWs.send('NICK justinfan' + Math.floor(Math.random() * 99999 + 10000));
    twitchChatWs.send('JOIN #' + ch);
    updateChatPlatformStatus('twitch', true);
    if (mainWindow) mainWindow.webContents.send('twitch-chat-status', { ok: true, channel: ch });
  });

  twitchChatWs.on('message', (raw) => {
    const lines = raw.toString().split('\r\n');
    for (const line of lines) {
      if (line.startsWith('PING')) { if (twitchChatWs) twitchChatWs.send('PONG :tmi.twitch.tv'); continue; }

      // USERNOTICE — subs, raids, etc.
      const noticeMatch = line.match(/^@([^ ]+) :tmi\.twitch\.tv USERNOTICE #\w+/);
      if (noticeMatch) {
        const tags = {};
        noticeMatch[1].split(';').forEach(t => { const [k, v] = t.split('='); tags[k] = v; });
        const msgId = tags['msg-id'] || '';
        const dn = tags['display-name'] || tags['login'] || 'anon';
        if ((msgId === 'sub' || msgId === 'resub') && isEventEnabled('twitch', 'sub')) {
          const months = tags['msg-param-cumulative-months'];
          sendChatEvent({ platform: 'twitch', eventType: 'sub', username: dn, color: '#9146FF', detail: months ? months + ' meses' : '' });
        } else if ((msgId === 'subgift' || msgId === 'anonsubgift') && isEventEnabled('twitch', 'giftsub')) {
          const recipient = tags['msg-param-recipient-display-name'] || tags['msg-param-recipient-user-name'] || '';
          sendChatEvent({ platform: 'twitch', eventType: 'giftsub', username: dn, color: '#9146FF', detail: recipient ? '→ ' + recipient : '' });
        } else if (msgId === 'raid' && isEventEnabled('twitch', 'raid')) {
          const viewers = tags['msg-param-viewerCount'] || '?';
          sendChatEvent({ platform: 'twitch', eventType: 'raid', username: dn, color: '#9146FF', detail: viewers + ' viewers' });
        }
        continue;
      }

      // PRIVMSG with tags (chat + bits detection)
      const tagMatch = line.match(/^@([^ ]+) :(\w+)!\w+@\w+\.tmi\.twitch\.tv PRIVMSG #\w+ :(.+)/);
      if (tagMatch) {
        const tags = {};
        tagMatch[1].split(';').forEach(t => { const [k, v] = t.split('='); tags[k] = v; });
        const displayName = tags['display-name'] || tagMatch[2];
        const color = tags['color'] || '#9146FF';
        // Bits/Cheers event
        if (tags['bits'] && isEventEnabled('twitch', 'bits')) {
          sendChatEvent({ platform: 'twitch', eventType: 'bits', username: displayName, color, detail: tags['bits'] + ' bits' });
        }
        sendChatMessage({ platform: 'twitch', username: displayName, message: tagMatch[3].trim(), color });
        continue;
      }
      // Fallback without tags
      const simpleMatch = line.match(/:(\w+)!\w+@\w+\.tmi\.twitch\.tv PRIVMSG #\w+ :(.+)/);
      if (simpleMatch) {
        sendChatMessage({ platform: 'twitch', username: simpleMatch[1], message: simpleMatch[2].trim(), color: '#9146FF' });
      }
    }
  });

  twitchChatWs.on('close', () => {
    updateChatPlatformStatus('twitch', false);
    if (mainWindow) mainWindow.webContents.send('twitch-chat-status', { ok: false });
  });

  twitchChatWs.on('error', (err) => {
    updateChatPlatformStatus('twitch', false);
    if (mainWindow) mainWindow.webContents.send('twitch-chat-status', { ok: false, error: err.message });
  });
});

ipcMain.on('disconnect-twitch-chat', () => {
  if (twitchChatWs) { try { twitchChatWs.close(); } catch(e){} twitchChatWs = null; }
  updateChatPlatformStatus('twitch', false);
  if (mainWindow) mainWindow.webContents.send('twitch-chat-status', { ok: false });
});

// --- KICK ---
let kickChatWs = null;

ipcMain.on('connect-kick-chat', async (event, { channel }) => {
  if (kickChatWs) { try { kickChatWs.close(); } catch(e){} kickChatWs = null; }
  const https = require('https');

  function httpsGetKick(url) {
    return new Promise((resolve, reject) => {
      const req = https.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
      }, (res) => {
        let body = ''; res.on('data', d => body += d); res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', reject);
      req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
    });
  }

  try {
    const r = await httpsGetKick(`https://kick.com/api/v1/channels/${channel.trim()}`);
    if (r.status !== 200) throw new Error('Canal não encontrado no Kick');
    const data = JSON.parse(r.body);
    const chatRoomId = data.chatroom && data.chatroom.id;
    if (!chatRoomId) throw new Error('Chat room ID não encontrado');

    const pusherKey = 'eb1d5f283081a78b932c';
    kickChatWs = new WebSocket(`wss://ws-us2.pusher.com/app/${pusherKey}?protocol=7&client=js&version=7.4.0&flash=false`);

    kickChatWs.on('open', () => {
      kickChatWs.send(JSON.stringify({ event: 'pusher:subscribe', data: { auth: '', channel: `chatrooms.${chatRoomId}.v2` } }));
      updateChatPlatformStatus('kick', true);
      if (mainWindow) mainWindow.webContents.send('kick-chat-status', { ok: true, channel: channel.trim() });
    });

    kickChatWs.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.event === 'App\\Events\\ChatMessageEvent') {
          const d = JSON.parse(msg.data);
          sendChatMessage({ platform: 'kick', username: d.sender && d.sender.username || 'anon', message: d.content || '', color: '#53FC18' });
        } else if (msg.event === 'App\\Events\\SubscriptionEvent') {
          if (isEventEnabled('kick', 'subscribe')) {
            const d = JSON.parse(msg.data);
            const uname = d.username || (d.user && d.user.username) || 'anon';
            sendChatEvent({ platform: 'kick', eventType: 'subscribe', username: uname, color: '#53FC18' });
          }
        } else if (msg.event === 'App\\Events\\GiftedSubscriptionsEvent') {
          if (isEventEnabled('kick', 'giftsub')) {
            const d = JSON.parse(msg.data);
            const gifter = d.gifter_username || (d.gifter && d.gifter.username) || 'anon';
            const count = (d.gifted_usernames && d.gifted_usernames.length) || d.giftees_count || 1;
            sendChatEvent({ platform: 'kick', eventType: 'giftsub', username: gifter, color: '#53FC18', detail: 'x' + count });
          }
        } else if (msg.event === 'App\\Events\\FollowersUpdated' || msg.event === 'App\\Events\\UserBannedEvent') {
          // follow event (FollowersUpdated sometimes includes username in newer API versions)
          try {
            if (msg.event === 'App\\Events\\FollowersUpdated' && isEventEnabled('kick', 'follow')) {
              const d = JSON.parse(msg.data);
              const uname = d.username || (d.follower && d.follower.username);
              if (uname) sendChatEvent({ platform: 'kick', eventType: 'follow', username: uname, color: '#53FC18' });
            }
          } catch(e2) {}
        }
      } catch(e) {}
    });

    kickChatWs.on('close', () => {
      updateChatPlatformStatus('kick', false);
      if (mainWindow) mainWindow.webContents.send('kick-chat-status', { ok: false });
    });

    kickChatWs.on('error', (err) => {
      updateChatPlatformStatus('kick', false);
      if (mainWindow) mainWindow.webContents.send('kick-chat-status', { ok: false, error: err.message });
    });
  } catch(e) {
    updateChatPlatformStatus('kick', false);
    if (mainWindow) mainWindow.webContents.send('kick-chat-status', { ok: false, error: e.message });
  }
});

ipcMain.on('disconnect-kick-chat', () => {
  if (kickChatWs) { try { kickChatWs.close(); } catch(e){} kickChatWs = null; }
  updateChatPlatformStatus('kick', false);
  if (mainWindow) mainWindow.webContents.send('kick-chat-status', { ok: false });
});

// --- YOUTUBE (sem API Key — usa BrowserWindow oculto) ---
let youtubeChatBW = null;       // hidden BrowserWindow
let youtubeChatPollInterval = null;
const youtubeChatSeenIds = new Set();

function closeYoutubeChatBW() {
  if (youtubeChatPollInterval) { clearInterval(youtubeChatPollInterval); youtubeChatPollInterval = null; }
  if (youtubeChatBW) { try { youtubeChatBW.close(); } catch(e){} youtubeChatBW = null; }
  youtubeChatSeenIds.clear();
}

ipcMain.on('connect-youtube-chat', async (event, { username }) => {
  closeYoutubeChatBW();

  const cleanUser = username.trim().replace(/^@/, '');

  youtubeChatBW = new BrowserWindow({
    width: 500, height: 600,
    show: false, focusable: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });

  // Step 1: load the /live page to find the video ID
  youtubeChatBW.loadURL(`https://www.youtube.com/@${cleanUser}/live`, {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  });

  let step = 'finding_live';

  youtubeChatBW.webContents.on('did-finish-load', async () => {
    if (!youtubeChatBW) return;

    if (step === 'finding_live') {
      try {
        // Extract video ID from the page URL or canonical meta tag
        const videoId = await youtubeChatBW.webContents.executeJavaScript(`
          (function() {
            // Check current URL for ?v=
            const m1 = location.href.match(/[?&]v=([A-Za-z0-9_-]{11})/);
            if (m1) return m1[1];
            // Check canonical link
            const canon = document.querySelector('link[rel="canonical"]');
            if (canon) { const m2 = canon.href.match(/[?&]v=([A-Za-z0-9_-]{11})/); if (m2) return m2[1]; }
            // Check og:video or og:url meta
            const og = document.querySelector('meta[property="og:url"]');
            if (og) { const m3 = og.content.match(/[?&]v=([A-Za-z0-9_-]{11})/); if (m3) return m3[1]; }
            // Check ytInitialData embedded JSON
            const scripts = document.querySelectorAll('script');
            for (const s of scripts) {
              const m4 = s.textContent.match(/"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"/);
              if (m4) return m4[1];
            }
            return null;
          })()
        `);

        if (!videoId) {
          updateChatPlatformStatus('youtube', false);
          if (mainWindow) mainWindow.webContents.send('youtube-chat-status', { ok: false, error: 'Nenhuma live encontrada para @' + cleanUser });
          closeYoutubeChatBW();
          return;
        }

        // Step 2: Load the live chat embed
        step = 'loading_chat';
        youtubeChatBW.loadURL(`https://www.youtube.com/live_chat?v=${videoId}`, {
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
        });
      } catch(e) {
        updateChatPlatformStatus('youtube', false);
        if (mainWindow) mainWindow.webContents.send('youtube-chat-status', { ok: false, error: e.message });
        closeYoutubeChatBW();
      }

    } else if (step === 'loading_chat') {
      step = 'polling';
      updateChatPlatformStatus('youtube', true);
      if (mainWindow) mainWindow.webContents.send('youtube-chat-status', { ok: true, username: cleanUser });

      // Poll every 2s for new chat messages, super chats and memberships
      youtubeChatPollInterval = setInterval(async () => {
        if (!youtubeChatBW) return;
        try {
          const data = await youtubeChatBW.webContents.executeJavaScript(`
            (function() {
              var msgs = [], events = [];
              // Regular chat
              document.querySelectorAll('yt-live-chat-text-message-renderer').forEach(function(item) {
                var authorEl = item.querySelector('#author-name');
                var msgEl = item.querySelector('#message');
                if (authorEl && msgEl) msgs.push({ id: item.id || '', username: authorEl.textContent.trim(), message: msgEl.textContent.trim() });
              });
              // Super Chats
              document.querySelectorAll('yt-live-chat-paid-message-renderer').forEach(function(item) {
                var authorEl = item.querySelector('#author-name');
                var amountEl = item.querySelector('#purchase-amount');
                if (authorEl) events.push({ type: 'superchat', id: 'sc_' + (item.id || ''), username: authorEl.textContent.trim(), detail: amountEl ? amountEl.textContent.trim() : '' });
              });
              // Memberships (paid)
              document.querySelectorAll('yt-live-chat-membership-item-renderer').forEach(function(item) {
                var authorEl = item.querySelector('#author-name');
                var subEl = item.querySelector('#header-subtext');
                if (authorEl) events.push({ type: 'membership', id: 'mb_' + (item.id || ''), username: authorEl.textContent.trim(), detail: subEl ? subEl.textContent.trim() : 'Novo membro' });
              });
              // Viewer engagement messages (free subscriptions, likes, etc.)
              document.querySelectorAll('yt-live-chat-viewer-engagement-message-renderer').forEach(function(item) {
                var authorEl = item.querySelector('#author-name') || item.querySelector('yt-live-chat-author-chip #author-name');
                var bodyEl = item.querySelector('#message') || item.querySelector('#body');
                var bodyText = bodyEl ? bodyEl.textContent.toLowerCase() : '';
                var username = authorEl ? authorEl.textContent.trim() : '';
                if (!username) return;
                var itemId = item.id || (username + ':' + bodyText.slice(0, 20));
                // Detect subscription (free)
                if (bodyText.includes('subscri') || bodyText.includes('inscrev') || bodyText.includes('se inscre')) {
                  events.push({ type: 'subscribe', id: 'ysub_' + itemId, username: username, detail: '' });
                }
                // Detect like
                else if (bodyText.includes('like') || bodyText.includes('curtiu') || bodyText.includes('gostou')) {
                  events.push({ type: 'like', id: 'ylk_' + itemId, username: username, detail: '' });
                }
              });
              // Ticker items (new subscribers shown in ticker bar)
              document.querySelectorAll('yt-live-chat-ticker-paid-item-renderer, yt-live-chat-ticker-sponsor-item-renderer').forEach(function(item) {
                var authorEl = item.querySelector('#author-name') || item.querySelector('a#name');
                if (!authorEl) return;
                var username = authorEl.textContent.trim();
                var itemId = item.id || ('tick_' + username);
                if (item.tagName.toLowerCase().includes('sponsor')) {
                  events.push({ type: 'membership', id: 'tick_' + itemId, username: username, detail: 'Novo membro' });
                }
              });
              return { msgs: msgs, events: events };
            })()
          `);

          if (data && Array.isArray(data.msgs)) {
            data.msgs.forEach(m => {
              const key = m.id || (m.username + ':' + m.message);
              if (!youtubeChatSeenIds.has(key) && m.message) {
                youtubeChatSeenIds.add(key);
                if (youtubeChatSeenIds.size > 2000) youtubeChatSeenIds.delete(youtubeChatSeenIds.values().next().value);
                sendChatMessage({ platform: 'youtube', username: m.username || 'anon', message: m.message, color: '#FF4444' });
              }
            });
          }
          if (data && Array.isArray(data.events)) {
            data.events.forEach(e => {
              const key = e.id || (e.type + ':' + e.username);
              if (!youtubeChatSeenIds.has(key)) {
                youtubeChatSeenIds.add(key);
                if (youtubeChatSeenIds.size > 2000) youtubeChatSeenIds.delete(youtubeChatSeenIds.values().next().value);
                if (isEventEnabled('youtube', e.type)) {
                  sendChatEvent({ platform: 'youtube', eventType: e.type, username: e.username || 'anon', color: '#FF4444', detail: e.detail || '' });
                }
              }
            });
          }
        } catch(e) {}
      }, 2000);
    }
  });

  youtubeChatBW.webContents.on('did-fail-load', () => {
    if (step !== 'polling') {
      updateChatPlatformStatus('youtube', false);
      if (mainWindow) mainWindow.webContents.send('youtube-chat-status', { ok: false, error: 'Falha ao carregar YouTube' });
      closeYoutubeChatBW();
    }
  });

  youtubeChatBW.on('closed', () => { youtubeChatBW = null; });
});

ipcMain.on('disconnect-youtube-chat', () => {
  closeYoutubeChatBW();
  updateChatPlatformStatus('youtube', false);
  if (mainWindow) mainWindow.webContents.send('youtube-chat-status', { ok: false });
});

// ============================================
// APP START
// ============================================
app.whenReady().then(async () => {
  roomId = getRoomId();

  // Validate access key before opening main window
  const savedKey = getSavedKey();
  if (savedKey) {
    const result = await validateKeyOnline(savedKey);
    if (result.valid || result.offline) {
      // Valid or offline grace — open normally
      const config = getRelayConfig();
      connectToRelay(config.relayUrl || DEFAULT_RELAY_URL);
      createWindow();
    } else {
      // Key was revoked — show lock screen
      createLockWindow();
    }
  } else {
    // No key saved — show lock screen
    createLockWindow();
  }

  // HTTP keep-alive every 4 minutes (backup to prevent Render free tier sleep)
  setInterval(() => {
    const https = require('https');
    const url = (relayUrl || DEFAULT_RELAY_URL) + '/health';
    https.get(url, (res) => {
      res.resume(); // consume response
      console.log('HTTP keep-alive OK');
    }).on('error', () => {});
  }, 4 * 60 * 1000);
});

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll();
  if (relayWs) try { relayWs.close(); } catch (e) {}
  if (tikfinityWindow && !tikfinityWindow.isDestroyed()) try { tikfinityWindow.destroy(); } catch(e) {}
  if (livepixWindow && !livepixWindow.isDestroyed()) try { livepixWindow.destroy(); } catch(e) {}
  if (chatWindow && !chatWindow.isDestroyed()) try { chatWindow.destroy(); } catch(e) {}
  if (twitchChatWs) try { twitchChatWs.close(); } catch(e) {}
  if (kickChatWs) try { kickChatWs.close(); } catch(e) {}
  if (tikfinityPollInterval) clearInterval(tikfinityPollInterval);
  if (livepixPollInterval) clearInterval(livepixPollInterval);
  if (youtubeChatPollInterval) clearInterval(youtubeChatPollInterval);
  if (youtubeChatBW && !youtubeChatBW.isDestroyed()) try { youtubeChatBW.destroy(); } catch(e) {}
  if (livepixBrowserWin && !livepixBrowserWin.isDestroyed()) {
    try { livepixBrowserWin.webContents.debugger.detach(); } catch(e) {}
    livepixBrowserWin.destroy();
    livepixBrowserWin = null;
  }
  if (process.platform !== 'darwin') app.quit();
});
