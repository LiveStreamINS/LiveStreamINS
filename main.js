const { app, BrowserWindow, ipcMain, dialog, globalShortcut, session } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { exec } = require('child_process');
const WebSocket = require('ws');
const crypto = require('crypto');

// ── AUTO UPDATER ──
let autoUpdater = null;
try {
  autoUpdater = require('electron-updater').autoUpdater;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('update-available', (info) => {
    console.log(`[Updater] Update available: v${info.version}`);
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('update-available', { version: info.version });
  });
  autoUpdater.on('update-downloaded', (info) => {
    console.log(`[Updater] Update downloaded: v${info.version}`);
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('update-downloaded', { version: info.version });
  });
  autoUpdater.on('error', (e) => console.log('[Updater] Error:', e.message));
} catch(e) {
  console.log('[Updater] electron-updater not available:', e.message);
}

let mainWindow;
let lockWindow = null;
let loginWindow = null;
let subscribeWindow = null;

// ============================================
// ACCOUNT SYSTEM
// ============================================
const ACCOUNT_FILE = () => path.join(app.getPath('userData'), 'account.json');

function getAccountData() {
  try { return JSON.parse(fs.readFileSync(ACCOUNT_FILE(), 'utf-8')); } catch(e) { return null; }
}

function saveAccountData(data) {
  try { fs.writeFileSync(ACCOUNT_FILE(), JSON.stringify(data)); } catch(e) {}
}

function clearAccountData() {
  try { fs.unlinkSync(ACCOUNT_FILE()); } catch(e) {}
}

// HTTP POST helper (uses https module, no fetch needed)
function postToServer(urlPath, body) {
  return new Promise((resolve) => {
    const baseUrl = DEFAULT_RELAY_URL;
    const isHttps = baseUrl.startsWith('https');
    const mod = isHttps ? https : http;
    const fullUrl = baseUrl + urlPath;
    const data = JSON.stringify(body);

    // Parse host/path from URL
    const urlObj = new URL(fullUrl);
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: urlObj.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    };

    const req = mod.request(options, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch(e) { resolve({ ok: false, error: 'Resposta inválida do servidor' }); }
      });
    });
    req.on('error', () => resolve({ ok: false, error: 'Sem conexão com o servidor' }));
    req.write(data);
    req.end();
  });
}

function createLoginWindow() {
  loginWindow = new BrowserWindow({
    width: 420,
    height: 640,
    resizable: false,
    frame: false,
    center: true,
    backgroundColor: '#0e1120',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  loginWindow.loadFile('renderer/login.html');
  loginWindow.on('closed', () => { loginWindow = null; });
}

function createSubscribeWindow(subscriptionInfo) {
  subscribeWindow = new BrowserWindow({
    width: 520,
    height: 620,
    resizable: false,
    frame: false,
    center: true,
    backgroundColor: '#0e1120',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  subscribeWindow.loadFile('renderer/subscribe.html');
  subscribeWindow.on('closed', () => { subscribeWindow = null; });
  subscribeWindow.webContents.once('did-finish-load', () => {
    if (subscriptionInfo) {
      subscribeWindow.webContents.send('set-status', subscriptionInfo);
    }
  });
}

function openSubscribeWindow(info) {
  if (loginWindow && !loginWindow.isDestroyed()) { loginWindow.close(); loginWindow = null; }
  if (lockWindow  && !lockWindow.isDestroyed())  { lockWindow.close();  lockWindow  = null; }
  createSubscribeWindow(info);
}

function openMainApp() {
  if (loginWindow && !loginWindow.isDestroyed()) { loginWindow.close(); loginWindow = null; }
  if (lockWindow  && !lockWindow.isDestroyed())  { lockWindow.close();  lockWindow  = null; }
  const config = getRelayConfig();
  connectToRelay(config.relayUrl || DEFAULT_RELAY_URL);
  createWindow();
}

ipcMain.on('login-close', () => { app.quit(); });

function handleSubscriptionResult(result, win, sendFn) {
  if (!result.ok) {
    sendFn({ ok: false, error: result.error });
    return;
  }
  // Save account data
  saveAccountData({ username: result.username, token: result.token });
  // Check subscription
  if (result.subscription === 'active' || result.subscription === 'trial') {
    openMainApp();
  } else {
    // Expired or pending payment — open subscribe window
    openSubscribeWindow({
      subscription: result.subscription,
      trialEnds: result.trialEnds,
      needsPaymentSetup: result.needsPaymentSetup || result.subscription === 'pending_payment'
    });
  }
}

// Check saved session (auto-login)
ipcMain.on('account-check-session', async (event) => {
  const saved = getAccountData();
  if (saved && saved.username && saved.token) {
    const result = await postToServer('/api/validate-token', { username: saved.username, token: saved.token });
    if (result.ok) {
      if (result.subscription === 'active' || result.subscription === 'trial') {
        openMainApp();
      } else {
        openSubscribeWindow({ subscription: result.subscription, trialEnds: result.trialEnds });
      }
      return;
    }
  }
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.webContents.send('session-invalid');
  }
});

// Register new account
ipcMain.on('account-register', async (event, { username, password, email }) => {
  const result = await postToServer('/api/register', { username, password, email });
  handleSubscriptionResult(result, loginWindow, (r) => {
    if (loginWindow && !loginWindow.isDestroyed())
      loginWindow.webContents.send('account-result', r);
  });
});

// Login to existing account
ipcMain.on('account-login', async (event, { username, password }) => {
  const result = await postToServer('/api/login', { username, password });
  handleSubscriptionResult(result, loginWindow, (r) => {
    if (loginWindow && !loginWindow.isDestroyed())
      loginWindow.webContents.send('account-result', r);
  });
});

// Forgot password
ipcMain.on('forgot-password', async (event, { email }) => {
  const result = await postToServer('/api/forgot-password', { email });
  if (loginWindow && !loginWindow.isDestroyed())
    loginWindow.webContents.send('forgot-result', result);
});

// Reset password with code
ipcMain.on('reset-password', async (event, { email, code, newPassword }) => {
  const result = await postToServer('/api/reset-password', { email, code, newPassword });
  if (loginWindow && !loginWindow.isDestroyed())
    loginWindow.webContents.send('reset-result', result);
});

// Subscribe request (from subscribe window)
ipcMain.on('subscribe-request', async (event, { plan }) => {
  const saved = getAccountData();
  if (!saved) return;
  // If pending_payment, always use 'trial' plan (sets up card with 3-day free trial)
  const result = await postToServer('/api/subscribe', { username: saved.username, token: saved.token, plan });
  if (result.ok) {
    if (subscribeWindow && !subscribeWindow.isDestroyed())
      subscribeWindow.webContents.send('subscribe-url', { url: result.url });
  } else {
    if (subscribeWindow && !subscribeWindow.isDestroyed())
      subscribeWindow.webContents.send('subscribe-error', { error: result.error });
  }
});

// Verify subscription after payment
ipcMain.on('subscribe-verify', async (event) => {
  const saved = getAccountData();
  if (!saved) return;
  const result = await postToServer('/api/check-subscription', { username: saved.username, token: saved.token });
  if (result.ok) {
    if (result.subscription === 'active' || result.subscription === 'trial') {
      if (subscribeWindow && !subscribeWindow.isDestroyed()) { subscribeWindow.close(); subscribeWindow = null; }
      openMainApp();
    } else {
      if (subscribeWindow && !subscribeWindow.isDestroyed())
        subscribeWindow.webContents.send('subscribe-status', result);
    }
  }
});

// Close subscribe window (user cancelled)
ipcMain.on('subscribe-close', () => {
  app.quit();
});

ipcMain.on('logout', () => {
  clearAccountData();
  // Disconnect relay WebSocket so it doesn't fire events after window closes
  if (relayWs) { try { relayWs.terminate(); } catch(e) {} relayWs = null; }
  if (reconnectTimeout) { clearTimeout(reconnectTimeout); reconnectTimeout = null; }
  if (keepAliveInterval) { clearInterval(keepAliveInterval); keepAliveInterval = null; }
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  if (subscribeWindow && !subscribeWindow.isDestroyed()) subscribeWindow.close();
  createLoginWindow();
});

// Legacy access key (kept for backward compat / admin bypass)
const KEY_FILE = () => path.join(app.getPath('userData'), 'access.json');
function getSavedKey() {
  try { return JSON.parse(fs.readFileSync(KEY_FILE(), 'utf-8')).key || ''; } catch(e) { return ''; }
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
    if (mainWindow && !mainWindow.isDestroyed()) {
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
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('relay-status', { connected: false });
    }
    // Auto-reconnect after 3s
    reconnectTimeout = setTimeout(() => {
      if (relayUrl) connectToRelay(relayUrl);
    }, 3000);
  });

  relayWs.on('error', (err) => {
    console.error('Relay connection error:', err.message);
    if (mainWindow && !mainWindow.isDestroyed()) {
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

  // Check for updates after window loads
  mainWindow.webContents.once('did-finish-load', () => {
    if (autoUpdater) {
      setTimeout(() => {
        try { autoUpdater.checkForUpdates(); } catch(e) {}
      }, 3000);
    }
  });

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

// Install update and restart
ipcMain.on('install-update', () => {
  if (autoUpdater) autoUpdater.quitAndInstall();
});

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
    alert: `${relayUrl}/overlay/${roomId}/alert/scene1`,
    alertScene1: `${relayUrl}/overlay/${roomId}/alert/scene1`,
    alertScene2: `${relayUrl}/overlay/${roomId}/alert/scene2`,
    alertScene3: `${relayUrl}/overlay/${roomId}/alert/scene3`,
    desejo: `${relayUrl}/overlay/${roomId}/desejo`,
    galeria: `${relayUrl}/overlay/${roomId}/galeria`,
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

// Alert trigger — broadcasts to local overlay server (OBS on same machine)
ipcMain.on('alert-trigger', (event, data) => {
  relaySend({
    type: 'alert-trigger',
    alertType: data.alertType || '',
    nickname:  data.nickname  || '',
    profilePic: data.profilePic || '',
    message:   data.message   || '',
    giftImage: data.giftImage || '',
    giftCount: data.giftCount || 0,
    scene:     data.scene     || 1
  });
});

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
  relaySend({ type: 'top-score-update', title: data.title, desc: data.desc, subtitle: data.subtitle, name: data.name, avatar: data.avatar, valor: data.valor, theme: data.theme, customColor: data.customColor });
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
// LOCAL ALERT OVERLAY SERVER (localhost — OBS on same machine)
// ============================================
const ALERT_OVERLAY_PORT = 3006;
let alertSseClients1 = [], alertSseClients2 = [], alertSseClients3 = [];
let alertCurrentTheme = 'roxo';

// ── Galeria de Presentes state ──
let galeriaSseClients = [];
let galeriaState = {
  league: 'D',
  title: 'Galeria de Presentes',
  progress: {},
  theme: 'neon',
  titleColor: '#ffffff',
  nameColor: '#00d4ff',
  counterColor: '#ffd700',
  customColor: '',
  completeColor: '#ffd700'
};

// ── Desejo do Streamer state ──
let desejoSseClients = [];
let desejoState = {
  name: 'Desejo do Streamer',
  giftName: '',
  giftImage: '',
  target: 1,
  current: 0,
  theme: 'neon',
  customColor: '',
  nameColor: '#ffffff',
  countColor: '#ffd700'
};

function getGaleriaHTML() {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@700;900&family=Cinzel:wght@700;900&family=Press+Start+2P&family=Russo+One&family=Rajdhani:wght@700&family=Poppins:wght@700;900&display=swap" rel="stylesheet">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:transparent; overflow:hidden; width:100vw; height:100vh; display:flex; align-items:center; justify-content:center; }

  #gw {
    display:flex; flex-direction:column; align-items:center; justify-content:center;
    padding:22px 30px; gap:8px; border-radius:20px; min-width:210px;
  }

  #gw-title {
    font-size:12px; font-weight:700;
    text-align:center; letter-spacing:1.5px; color:#fff;
    text-transform:uppercase;
  }

  #gw-content {
    display:flex; flex-direction:column; align-items:center; gap:6px;
    transition: opacity 0.35s ease-in-out;
  }
  #gw-content.fading { opacity:0; }

  #gw-img-wrap {
    position:relative; width:110px; height:110px;
    display:flex; align-items:center; justify-content:center;
  }
  #gw-img {
    width:88px; height:88px; object-fit:contain;
    animation: galeriaFloat 3s ease-in-out infinite;
  }
  @keyframes galeriaFloat {
    0%,100% { transform: translateY(0px) rotate(-3deg); }
    50%      { transform: translateY(-10px) rotate(3deg); }
  }

  .gw-sparkle { position:absolute; font-size:13px; pointer-events:none; animation: gSparkle 2.2s ease-in-out infinite; }
  .gw-sp1 { top:4px; left:4px; animation-delay:0s; }
  .gw-sp2 { top:4px; right:4px; animation-delay:0.75s; }
  .gw-sp3 { bottom:4px; left:8px; animation-delay:1.5s; }
  .gw-sp4 { bottom:4px; right:8px; animation-delay:0.4s; }
  @keyframes gSparkle {
    0%   { opacity:0; transform:scale(0) rotate(0deg); }
    50%  { opacity:1; transform:scale(1.2) rotate(180deg); }
    100% { opacity:0; transform:scale(0) rotate(360deg); }
  }

  #gw-gift-name {
    font-size:13px; font-weight:700;
    color:#00d4ff; text-align:center; letter-spacing:0.5px;
  }
  #gw-counter {
    font-size:32px; font-weight:900;
    color:#ffd700; letter-spacing:2px; text-align:center;
  }
  #gw-counter.bump { animation: gBump 0.5s ease-out; }
  @keyframes gBump {
    0%   { transform:scale(1); }
    30%  { transform:scale(1.35); }
    60%  { transform:scale(0.95); }
    100% { transform:scale(1); }
  }

  #gw-dots { display:flex; gap:5px; margin-top:4px; }
  .gw-dot {
    width:7px; height:7px; border-radius:50%;
    background:rgba(255,255,255,0.2);
    transition: background 0.3s;
  }

  /* ── THEMES ── */
  .t-neon { background:linear-gradient(160deg,rgba(0,10,35,0.93),rgba(0,28,60,0.93)); border:2px solid #00d4ff; box-shadow:0 0 32px rgba(0,212,255,0.45),inset 0 0 20px rgba(0,212,255,0.08); }
  .t-neon #gw-title     { font-family:'Orbitron',sans-serif; }
  .t-neon #gw-gift-name { font-family:'Orbitron',sans-serif; font-size:11px; }
  .t-neon #gw-counter   { font-family:'Orbitron',sans-serif; }
  .t-neon #gw-img       { filter: drop-shadow(0 0 12px rgba(0,212,255,0.55)); }
  .t-neon .gw-dot.active { background:#00d4ff; box-shadow:0 0 6px rgba(0,212,255,0.8); }

  .t-roxo { background:linear-gradient(160deg,rgba(15,10,35,0.93),rgba(35,10,65,0.93)); border:2px solid rgba(190,100,255,0.65); box-shadow:0 0 30px rgba(160,60,255,0.4),inset 0 0 20px rgba(160,60,255,0.08); }
  .t-roxo #gw-title     { font-family:'Segoe UI',sans-serif; }
  .t-roxo #gw-gift-name { font-family:'Segoe UI',sans-serif; }
  .t-roxo #gw-counter   { font-family:'Segoe UI',sans-serif; }
  .t-roxo #gw-img       { filter: drop-shadow(0 0 10px rgba(180,80,255,0.5)); }
  .t-roxo .gw-dot.active { background:#d8b4ff; box-shadow:0 0 6px rgba(180,80,255,0.8); }

  .t-medieval { background:linear-gradient(160deg,rgba(20,14,4,0.96),rgba(45,32,8,0.96)); border:3px solid #8b7355; box-shadow:0 4px 22px rgba(0,0,0,0.65),inset 0 1px 0 rgba(255,215,0,0.15); border-radius:12px; }
  .t-medieval #gw-title     { font-family:'Cinzel',serif; }
  .t-medieval #gw-gift-name { font-family:'Cinzel',serif; }
  .t-medieval #gw-counter   { font-family:'Cinzel',serif; }
  .t-medieval #gw-img       { filter: drop-shadow(0 0 8px rgba(255,200,0,0.4)); }
  .t-medieval .gw-dot.active { background:#ffd700; box-shadow:0 0 6px rgba(255,215,0,0.8); }

  .t-retro { background:#0a0a0a; border:3px solid #00ff41; box-shadow:0 0 12px rgba(0,255,65,0.5),inset 0 0 14px rgba(0,255,65,0.05); border-radius:4px; }
  .t-retro #gw-title     { font-family:'Press Start 2P',monospace; font-size:7px; }
  .t-retro #gw-gift-name { font-family:'Press Start 2P',monospace; font-size:8px; }
  .t-retro #gw-counter   { font-family:'Press Start 2P',monospace; font-size:22px; }
  .t-retro #gw-img       { image-rendering:pixelated; filter: drop-shadow(0 0 6px rgba(0,255,65,0.4)); }
  .t-retro .gw-dot.active { background:#00ff41; box-shadow:0 0 6px rgba(0,255,65,0.8); }

  .t-fire { background:linear-gradient(160deg,rgba(50,12,0,0.95),rgba(85,28,0,0.95)); border:2px solid #ff6600; box-shadow:0 0 32px rgba(255,100,0,0.45),inset 0 -8px 28px rgba(255,50,0,0.15); }
  .t-fire #gw-title     { font-family:'Russo One',sans-serif; }
  .t-fire #gw-gift-name { font-family:'Russo One',sans-serif; }
  .t-fire #gw-counter   { font-family:'Russo One',sans-serif; }
  .t-fire #gw-img       { filter: drop-shadow(0 0 12px rgba(255,120,0,0.6)); }
  .t-fire .gw-dot.active { background:#ff6600; box-shadow:0 0 6px rgba(255,100,0,0.8); }

  .t-ice { background:linear-gradient(160deg,rgba(5,18,38,0.93),rgba(10,38,78,0.93)); border:2px solid rgba(150,220,255,0.65); box-shadow:0 0 26px rgba(100,200,255,0.35),inset 0 0 20px rgba(200,240,255,0.06); }
  .t-ice #gw-title     { font-family:'Rajdhani',sans-serif; font-size:16px; }
  .t-ice #gw-gift-name { font-family:'Rajdhani',sans-serif; font-size:16px; }
  .t-ice #gw-counter   { font-family:'Rajdhani',sans-serif; font-size:40px; }
  .t-ice #gw-img       { filter: drop-shadow(0 0 10px rgba(150,220,255,0.5)); }
  .t-ice .gw-dot.active { background:#b0e0ff; box-shadow:0 0 6px rgba(150,220,255,0.8); }

  .t-clean { background:transparent; border:none; box-shadow:none; }
  .t-clean #gw-title     { font-family:'Segoe UI',sans-serif; text-shadow:0 2px 8px rgba(0,0,0,0.95); }
  .t-clean #gw-gift-name { font-family:'Segoe UI',sans-serif; text-shadow:0 2px 8px rgba(0,0,0,0.95); }
  .t-clean #gw-counter   { font-family:'Segoe UI',sans-serif; text-shadow:0 2px 10px rgba(0,0,0,0.95); }
  .t-clean #gw-img       { filter: drop-shadow(0 4px 12px rgba(0,0,0,0.8)); }
  .t-clean .gw-dot.active { background:rgba(255,255,255,0.8); }

  .t-custom { border:2px solid rgba(255,255,255,0.3); }
  .t-custom #gw-title     { font-family:'Segoe UI',sans-serif; }
  .t-custom #gw-gift-name { font-family:'Segoe UI',sans-serif; }
  .t-custom #gw-counter   { font-family:'Segoe UI',sans-serif; }
  .t-custom .gw-dot.active { background:rgba(255,255,255,0.8); }

  /* ── META BATIDA: efeito colorido sobre qualquer tema ── */
  #gw { --gw-done-color: #ffd700; }
  #gw.gw-complete {
    border-color: var(--gw-done-color) !important;
    animation: gwDonePulse 1.8s ease-in-out infinite !important;
  }
  @keyframes gwDonePulse {
    0%,100% { box-shadow: 0 0 30px color-mix(in srgb, var(--gw-done-color) 50%, transparent), inset 0 0 16px color-mix(in srgb, var(--gw-done-color) 12%, transparent); border-color: color-mix(in srgb, var(--gw-done-color) 80%, transparent); }
    50%      { box-shadow: 0 0 65px color-mix(in srgb, var(--gw-done-color) 85%, transparent), 0 0 110px color-mix(in srgb, var(--gw-done-color) 30%, transparent), inset 0 0 30px color-mix(in srgb, var(--gw-done-color) 22%, transparent); border-color: var(--gw-done-color); }
  }
  #gw.gw-complete #gw-img {
    filter: drop-shadow(0 0 20px color-mix(in srgb, var(--gw-done-color) 90%, transparent)) drop-shadow(0 0 8px color-mix(in srgb, var(--gw-done-color) 70%, transparent)) !important;
  }
  #gw.gw-complete #gw-counter {
    color: var(--gw-done-color) !important;
    text-shadow: 0 0 14px color-mix(in srgb, var(--gw-done-color) 80%, transparent) !important;
  }
  #gw.gw-complete .gw-dot.active {
    background: var(--gw-done-color) !important;
    box-shadow: 0 0 8px var(--gw-done-color) !important;
  }

  /* Badge de meta batida */
  #gw-badge {
    font-size:11px; font-weight:800; letter-spacing:2.5px; text-transform:uppercase;
    color: var(--gw-done-color); text-shadow: 0 0 12px color-mix(in srgb, var(--gw-done-color) 95%, transparent);
    height:16px; opacity:0; transition:opacity 0.4s;
  }
  #gw.gw-complete #gw-badge {
    opacity:1;
    animation: gwBadgePulse 1.4s ease-in-out infinite;
  }
  @keyframes gwBadgePulse {
    0%,100% { opacity:0.75; transform:scale(1); }
    50%      { opacity:1;    transform:scale(1.07); }
  }
</style>
</head>
<body>
<div id="gw" class="t-neon">
  <div id="gw-title">Galeria de Presentes</div>
  <div id="gw-content">
    <div id="gw-img-wrap">
      <img id="gw-img" src="" alt="">
      <span class="gw-sparkle gw-sp1">✨</span>
      <span class="gw-sparkle gw-sp2">⭐</span>
      <span class="gw-sparkle gw-sp3">✨</span>
      <span class="gw-sparkle gw-sp4">⭐</span>
    </div>
    <div id="gw-gift-name"></div>
    <div id="gw-counter">0 / 10</div>
  </div>
  <div id="gw-dots"></div>
  <div id="gw-badge">⭐ META BATIDA! ⭐</div>
</div>
<script>
  var LIGA_D = [
    { name:'TikTok',              target:10, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/802a21ae29f9fae5abe3693de9f874bd~tplv-obj.webp' },
    { name:'Rose',                target:10, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/eba3a9bb85c33e017f3648eaf88d7189~tplv-obj.webp' },
    { name:'Finger Heart',        target:6,  image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/a4c4dc437fd3a6632aba149769491f49.png~tplv-obj.webp' },
    { name:'Friendship Necklace', target:5,  image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/e033c3f28632e233bebac1668ff66a2f.png~tplv-obj.webp' },
    { name:'Perfume',             target:3,  image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/20b8f61246c7b6032777bb81bf4ee055~tplv-obj.webp' },
    { name:'Doughnut',            target:3,  image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/4e7ad6bdf0a1d860c538f38026d4e812~tplv-obj.webp' },
    { name:'Hat and Mustache',    target:3,  image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/2f1e4f3f5c728ffbfa35705b480fdc92~tplv-obj.webp' },
    { name:'Hand Hearts',         target:3,  image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/6cd022271dc4669d182cad856384870f~tplv-obj.webp' },
    { name:'Hearts',              target:2,  image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/934b5a10dee8376df5870a61d2ea5cb6.png~tplv-obj.webp' },
    { name:'Corgi',               target:2,  image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/148eef0884fdb12058d1c6897d1e02b9~tplv-obj.webp' }
  ];
  var LIGA_C = [
    { name:'Rose',             target:20, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/eba3a9bb85c33e017f3648eaf88d7189~tplv-obj.webp' },
    { name:'Finger Heart',     target:15, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/a4c4dc437fd3a6632aba149769491f49.png~tplv-obj.webp' },
    { name:'Rosa',             target:15, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/eb77ead5c3abb6da6034d3cf6cfeb438~tplv-obj.webp' },
    { name:'Doughnut',         target:10, image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/4e7ad6bdf0a1d860c538f38026d4e812~tplv-obj.webp' },
    { name:'Hat and Mustache', target:6,  image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/2f1e4f3f5c728ffbfa35705b480fdc92~tplv-obj.webp' },
    { name:'Hand Hearts',      target:6,  image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/6cd022271dc4669d182cad856384870f~tplv-obj.webp' },
    { name:'Hearts',           target:5,  image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/934b5a10dee8376df5870a61d2ea5cb6.png~tplv-obj.webp' },
    { name:'Corgi',            target:3,  image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/148eef0884fdb12058d1c6897d1e02b9~tplv-obj.webp' },
    { name:'Money Gun',        target:2,  image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/e0589e95a2b41970f0f30f6202f5fce6~tplv-obj.webp' },
    { name:'DJ Glasses',       target:2,  image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/d4aad726e2759e54a924fbcd628ea143.png~tplv-obj.webp' },
    { name:'Swan',             target:1,  image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/97a26919dbf6afe262c97e22a83f4bf1~tplv-obj.webp' },
    { name:'Galaxy',           target:1,  image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/resource/79a02148079526539f7599150da9fd28.png~tplv-obj.webp' },
    { name:'Fireworks',        target:1,  image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/9494c8a0bc5c03521ef65368e59cc2b8~tplv-obj.webp' },
    { name:'Whale Diving',     target:1,  image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/46fa70966d8e931497f5289060f9a794~tplv-obj.webp' },
    { name:'Meteor Shower',    target:1,  image:'https://p16-webcast.tiktokcdn.com/img/maliva/webcast-va/71883933511237f7eaa1bf8cd12ed575~tplv-obj.webp' }
  ];

  var THEMES = ['neon','roxo','medieval','retro','fire','ice','clean','custom'];
  var state = { league:'D', title:'Galeria de Presentes', progress:{}, theme:'neon', titleColor:'#ffffff', nameColor:'#00d4ff', counterColor:'#ffd700', customColor:'' };
  var currIdx = 0;
  var timer   = null;

  var gwEl      = document.getElementById('gw');
  var titleEl   = document.getElementById('gw-title');
  var contentEl = document.getElementById('gw-content');
  var imgEl     = document.getElementById('gw-img');
  var nameEl    = document.getElementById('gw-gift-name');
  var counterEl = document.getElementById('gw-counter');
  var dotsEl    = document.getElementById('gw-dots');

  function applyVisual(s) {
    THEMES.forEach(function(t){ gwEl.classList.remove('t-'+t); });
    gwEl.classList.add('t-' + (s.theme || 'neon'));
    if (s.theme === 'custom' && s.customColor) gwEl.style.background = s.customColor;
    else gwEl.style.background = '';
    titleEl.style.color   = s.titleColor   || '#ffffff';
    nameEl.style.color    = s.nameColor    || '#00d4ff';
    counterEl.style.color = s.counterColor || '#ffd700';
    gwEl.style.setProperty('--gw-done-color', s.completeColor || '#ffd700');
  }

  function getLeague() { return state.league === 'C' ? LIGA_C : LIGA_D; }

  function buildDots() {
    var gifts = getLeague();
    dotsEl.innerHTML = '';
    gifts.forEach(function(_, i) {
      var d = document.createElement('div');
      d.className = 'gw-dot' + (i === currIdx ? ' active' : '');
      dotsEl.appendChild(d);
    });
  }

  var badgeEl = document.getElementById('gw-badge');

  function showGift(idx) {
    var gifts = getLeague();
    var gift  = gifts[idx];
    if (!gift) return;
    var curr = (state.progress[gift.name] || 0);
    var done = curr >= gift.target;
    contentEl.classList.add('fading');
    setTimeout(function() {
      imgEl.src             = gift.image;
      nameEl.textContent    = gift.name;
      counterEl.textContent = curr + ' / ' + gift.target;
      contentEl.classList.remove('fading');
      gwEl.classList.toggle('gw-complete', done);
      var dots = dotsEl.querySelectorAll('.gw-dot');
      dots.forEach(function(d, i) { d.classList.toggle('active', i === idx); });
    }, 350);
  }

  function startCycle() {
    if (timer) clearInterval(timer);
    buildDots();
    showGift(currIdx);
    timer = setInterval(function() {
      currIdx = (currIdx + 1) % getLeague().length;
      showGift(currIdx);
    }, 2800);
  }

  function connect() {
    var es = new EventSource('http://localhost:${ALERT_OVERLAY_PORT}/sse-galeria');
    es.onmessage = function(e) {
      try {
        var d = JSON.parse(e.data);
        if (d.type === 'config') {
          state.league       = d.league       || 'D';
          state.title        = d.title        || 'Galeria de Presentes';
          state.progress     = d.progress     || {};
          state.theme         = d.theme         || 'neon';
          state.titleColor    = d.titleColor    || '#ffffff';
          state.nameColor     = d.nameColor     || '#00d4ff';
          state.counterColor  = d.counterColor  || '#ffd700';
          state.customColor   = d.customColor   || '';
          state.completeColor = d.completeColor || '#ffd700';
          titleEl.textContent = state.title;
          applyVisual(state);
          currIdx = 0;
          startCycle();
        } else if (d.type === 'progress') {
          state.progress = d.progress || {};
          var gifts = getLeague();
          var cur   = gifts[currIdx];
          if (cur && d.giftName === cur.name) {
            var v    = state.progress[cur.name] || 0;
            var done = v >= cur.target;
            counterEl.textContent = v + ' / ' + cur.target;
            gwEl.classList.toggle('gw-complete', done);
            counterEl.classList.remove('bump');
            void counterEl.offsetWidth;
            counterEl.classList.add('bump');
            counterEl.addEventListener('animationend', function() { counterEl.classList.remove('bump'); }, { once:true });
          }
        }
      } catch(err) {}
    };
    es.onerror = function() { es.close(); setTimeout(connect, 3000); };
  }
  connect();
</script>
</body>
</html>`;
}

function getDesejoHTML() {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@700;900&family=Cinzel:wght@700;900&family=Press+Start+2P&family=Russo+One&family=Rajdhani:wght@700&display=swap" rel="stylesheet">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:transparent; overflow:hidden; width:100vw; height:100vh; display:flex; align-items:center; justify-content:center; }

  #dw {
    display:flex; flex-direction:column; align-items:center; justify-content:center;
    padding:20px 28px; gap:10px; border-radius:20px; min-width:190px;
    animation-duration:0.4s; animation-fill-mode:both;
  }

  #dw-title { font-size:15px; font-weight:700; text-align:center; letter-spacing:1px; }
  #dw-img-wrap { position:relative; width:110px; height:110px; display:flex; align-items:center; justify-content:center; }
  #dw-img { width:88px; height:88px; object-fit:contain; animation: floatGift 3s ease-in-out infinite; }
  @keyframes floatGift {
    0%,100% { transform: translateY(0px) rotate(-3deg); }
    50%      { transform: translateY(-10px) rotate(3deg); }
  }
  .dw-sparkle {
    position:absolute; font-size:13px; pointer-events:none;
    animation: sparkleAnim 2.2s ease-in-out infinite;
  }
  .dw-sp1 { top:4px;    left:4px;   animation-delay:0s;    }
  .dw-sp2 { top:4px;    right:4px;  animation-delay:0.75s; }
  .dw-sp3 { bottom:4px; left:8px;   animation-delay:1.5s;  }
  .dw-sp4 { bottom:4px; right:8px;  animation-delay:0.4s;  }
  @keyframes sparkleAnim {
    0%   { opacity:0; transform:scale(0) rotate(0deg); }
    50%  { opacity:1; transform:scale(1.2) rotate(180deg); }
    100% { opacity:0; transform:scale(0) rotate(360deg); }
  }
  #dw-counter {
    font-size:38px; font-weight:900; letter-spacing:2px; text-align:center;
    transition: transform 0.1s;
  }
  #dw-counter.bump {
    animation: counterBump 0.5s ease-out;
  }
  @keyframes counterBump {
    0%   { transform: scale(1); }
    30%  { transform: scale(1.35); }
    60%  { transform: scale(0.95); }
    100% { transform: scale(1); }
  }
  #dw-complete {
    font-size:14px; font-weight:800; letter-spacing:2px; text-transform:uppercase;
    opacity:0; transition:opacity 0.4s;
    animation: none;
  }
  #dw-complete.show { opacity:1; animation: completePulse 1.2s ease-in-out infinite; }
  @keyframes completePulse { 0%,100% { opacity:0.7; } 50% { opacity:1; } }

  /* ── THEMES ── */
  .t-neon { background:linear-gradient(160deg,rgba(0,10,35,0.93),rgba(0,28,60,0.93)); border:2px solid #00d4ff; box-shadow:0 0 30px rgba(0,212,255,0.45),inset 0 0 20px rgba(0,212,255,0.08); }
  .t-neon #dw-title   { font-family:'Orbitron',sans-serif; font-size:13px; }
  .t-neon #dw-counter { font-family:'Orbitron',sans-serif; }
  .t-neon #dw-complete { font-family:'Orbitron',sans-serif; color:#00d4ff; }
  .t-neon #dw-img { filter: drop-shadow(0 0 10px rgba(0,212,255,0.5)); }

  .t-roxo { background:linear-gradient(160deg,rgba(15,10,35,0.93),rgba(35,10,65,0.93)); border:2px solid rgba(190,100,255,0.65); box-shadow:0 0 30px rgba(160,60,255,0.4),inset 0 0 20px rgba(160,60,255,0.08); }
  .t-roxo #dw-title   { font-family:'Segoe UI',sans-serif; }
  .t-roxo #dw-counter { font-family:'Segoe UI',sans-serif; }
  .t-roxo #dw-complete { font-family:'Segoe UI',sans-serif; color:#d8b4ff; }
  .t-roxo #dw-img { filter: drop-shadow(0 0 10px rgba(180,80,255,0.5)); }

  .t-medieval { background:linear-gradient(160deg,rgba(20,14,4,0.96),rgba(45,32,8,0.96)); border:3px solid #8b7355; box-shadow:0 4px 22px rgba(0,0,0,0.65),inset 0 1px 0 rgba(255,215,0,0.15); border-radius:12px; }
  .t-medieval #dw-title   { font-family:'Cinzel',serif; }
  .t-medieval #dw-counter { font-family:'Cinzel',serif; }
  .t-medieval #dw-complete { font-family:'Cinzel',serif; color:#ffd700; }
  .t-medieval #dw-img { filter: drop-shadow(0 0 8px rgba(255,200,0,0.4)); }

  .t-retro { background:#0a0a0a; border:3px solid #00ff41; box-shadow:0 0 12px rgba(0,255,65,0.5),inset 0 0 14px rgba(0,255,65,0.05); border-radius:4px; }
  .t-retro #dw-title   { font-family:'Press Start 2P',monospace; font-size:9px; color:#00ff41 !important; }
  .t-retro #dw-counter { font-family:'Press Start 2P',monospace; font-size:28px; }
  .t-retro #dw-complete { font-family:'Press Start 2P',monospace; font-size:9px; color:#ff00ff !important; }
  .t-retro #dw-img { image-rendering:pixelated; filter: drop-shadow(0 0 6px rgba(0,255,65,0.4)); }

  .t-fire { background:linear-gradient(160deg,rgba(50,12,0,0.95),rgba(85,28,0,0.95)); border:2px solid #ff6600; box-shadow:0 0 32px rgba(255,100,0,0.45),inset 0 -8px 28px rgba(255,50,0,0.15); }
  .t-fire #dw-title   { font-family:'Russo One',sans-serif; }
  .t-fire #dw-counter { font-family:'Russo One',sans-serif; }
  .t-fire #dw-complete { font-family:'Russo One',sans-serif; color:#ffd700; }
  .t-fire #dw-img { filter: drop-shadow(0 0 12px rgba(255,120,0,0.6)); }

  .t-ice { background:linear-gradient(160deg,rgba(5,18,38,0.93),rgba(10,38,78,0.93)); border:2px solid rgba(150,220,255,0.65); box-shadow:0 0 26px rgba(100,200,255,0.35),inset 0 0 20px rgba(200,240,255,0.06); }
  .t-ice #dw-title   { font-family:'Rajdhani',sans-serif; font-size:17px; }
  .t-ice #dw-counter { font-family:'Rajdhani',sans-serif; font-size:44px; }
  .t-ice #dw-complete { font-family:'Rajdhani',sans-serif; color:#b0e0ff; }
  .t-ice #dw-img { filter: drop-shadow(0 0 10px rgba(150,220,255,0.5)); }

  .t-clean { background:transparent; border:none; box-shadow:none; }
  .t-clean #dw-title   { font-family:'Segoe UI',sans-serif; text-shadow:0 2px 8px rgba(0,0,0,0.95); }
  .t-clean #dw-counter { font-family:'Segoe UI',sans-serif; text-shadow:0 2px 10px rgba(0,0,0,0.95); }
  .t-clean #dw-complete { font-family:'Segoe UI',sans-serif; }
  .t-clean #dw-img { filter: drop-shadow(0 4px 12px rgba(0,0,0,0.8)); }

  .t-custom { border:2px solid rgba(255,255,255,0.3); }
  .t-custom #dw-title { font-family:'Segoe UI',sans-serif; }
  .t-custom #dw-counter { font-family:'Segoe UI',sans-serif; }
  .t-custom #dw-complete { font-family:'Segoe UI',sans-serif; }
</style>
</head>
<body>
<div id="dw" class="t-neon">
  <div id="dw-title" style="color:#fff;">Desejo do Streamer</div>
  <div id="dw-img-wrap">
    <img id="dw-img" src="" alt="">
    <span class="dw-sparkle dw-sp1">✨</span>
    <span class="dw-sparkle dw-sp2">⭐</span>
    <span class="dw-sparkle dw-sp3">✨</span>
    <span class="dw-sparkle dw-sp4">⭐</span>
  </div>
  <div id="dw-counter" style="color:#ffd700;">0 / 1</div>
  <div id="dw-complete">✨ COMPLETO! ✨</div>
</div>
<script>
  var dw = document.getElementById('dw');
  var titleEl = document.getElementById('dw-title');
  var imgEl = document.getElementById('dw-img');
  var counterEl = document.getElementById('dw-counter');
  var completeEl = document.getElementById('dw-complete');
  var THEMES = ['neon','roxo','medieval','retro','fire','ice','clean','custom'];
  var state = { name:'Desejo do Streamer', giftImage:'', target:1, current:0, theme:'neon', customColor:'', nameColor:'#ffffff', countColor:'#ffd700' };

  function applyState(s) {
    state = s;
    THEMES.forEach(function(t){ dw.classList.remove('t-'+t); });
    dw.classList.add('t-' + (s.theme||'neon'));
    if (s.theme === 'custom' && s.customColor) dw.style.background = s.customColor;
    else dw.style.background = '';
    titleEl.textContent = s.name || 'Desejo do Streamer';
    titleEl.style.color = s.nameColor || '#ffffff';
    counterEl.style.color = s.countColor || '#ffd700';
    imgEl.src = s.giftImage || '';
    updateCounter(s.current, s.target, false);
  }

  function updateCounter(current, target, animate) {
    state.current = current;
    state.target  = target;
    counterEl.textContent = current + ' / ' + target;
    if (animate) {
      counterEl.classList.remove('bump');
      void counterEl.offsetWidth;
      counterEl.classList.add('bump');
    }
    if (current >= target && target > 0) {
      completeEl.classList.add('show');
    } else {
      completeEl.classList.remove('show');
    }
  }

  function connect() {
    var es = new EventSource('http://localhost:${ALERT_OVERLAY_PORT}/sse-desejo');
    es.onmessage = function(e) {
      try {
        var d = JSON.parse(e.data);
        if (d.type === 'config')     applyState(d.state);
        if (d.type === 'increment')  updateCounter(d.current, d.target, true);
        if (d.type === 'reset')      updateCounter(0, d.target, false);
      } catch(err) {}
    };
    es.onerror = function() { es.close(); setTimeout(connect, 3000); };
  }
  connect();
</script>
</body>
</html>`;
}

function getLocalAlertOverlayHTML(scene) {
  scene = scene || 1;
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@700;900&family=Cinzel:wght@700;900&family=Press+Start+2P&family=Russo+One&family=Rajdhani:wght@700&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: transparent; overflow: hidden; width: 100vw; height: 100vh; display: flex; align-items: flex-end; justify-content: flex-start; padding: 28px; }

  /* ── BASE BOX ── */
  #alert-box {
    display: none;
    align-items: center;
    gap: 16px;
    border-radius: 18px;
    padding: 16px 22px;
    min-width: 300px;
    max-width: 520px;
    animation-duration: 0.5s;
    animation-fill-mode: both;
  }
  #alert-box.show { display: flex !important; animation-name: slideIn; }
  #alert-box.hide { display: flex !important; animation-name: slideOut; }
  @keyframes slideIn { from { opacity: 0; transform: translateX(-90px); } to { opacity: 1; transform: translateX(0); } }
  @keyframes slideOut { from { opacity: 1; transform: translateX(0); } to { opacity: 0; transform: translateX(-90px); } }

  #alert-avatar {
    width: 68px; height: 68px; border-radius: 50%;
    object-fit: cover; flex-shrink: 0;
  }
  #alert-info { flex: 1; min-width: 0; }
  #alert-nickname {
    font-size: 19px; font-weight: 700;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  #alert-message {
    font-size: 14px; font-weight: 400;
    margin-top: 4px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  #alert-gift-wrap {
    display: none; flex-direction: column; align-items: center; flex-shrink: 0; gap: 2px;
  }
  #alert-gift-img {
    width: 58px; height: 58px; object-fit: contain;
  }
  #alert-gift-count {
    font-family: 'Segoe UI', sans-serif;
    font-size: 15px; font-weight: 800;
    color: #fff;
    text-shadow: 0 1px 6px rgba(0,0,0,0.8);
  }

  /* ── THEME: ROXO (padrão) ── */
  .t-roxo {
    background: linear-gradient(135deg, rgba(15,15,30,0.93) 0%, rgba(35,10,65,0.93) 100%);
    border: 2px solid rgba(190,100,255,0.65);
    box-shadow: 0 0 32px rgba(160,60,255,0.45), inset 0 0 20px rgba(160,60,255,0.1);
  }
  .t-roxo #alert-avatar { border: 3px solid rgba(210,130,255,0.9); background: rgba(80,50,120,0.5); }
  .t-roxo #alert-nickname { font-family: 'Segoe UI', sans-serif; color: #fff; text-shadow: 0 0 14px rgba(200,130,255,0.9); }
  .t-roxo #alert-message  { font-family: 'Segoe UI', sans-serif; color: #d8b4ff; }

  /* ── THEME: NEON ── */
  .t-neon {
    background: linear-gradient(135deg, rgba(0,10,35,0.93) 0%, rgba(0,25,55,0.93) 100%);
    border: 2px solid #00d4ff;
    box-shadow: 0 0 28px rgba(0,212,255,0.45), inset 0 0 20px rgba(0,212,255,0.08);
  }
  .t-neon #alert-avatar { border: 3px solid #00d4ff; background: rgba(0,50,80,0.5); }
  .t-neon #alert-nickname { font-family: 'Orbitron', sans-serif; font-size: 16px; color: #00d4ff; text-shadow: 0 0 14px rgba(0,212,255,0.9); }
  .t-neon #alert-message  { font-family: 'Orbitron', sans-serif; font-size: 11px; color: #ff3366; text-shadow: 0 0 8px rgba(255,51,102,0.7); }

  /* ── THEME: MEDIEVAL ── */
  .t-medieval {
    background: linear-gradient(135deg, rgba(20,14,4,0.96) 0%, rgba(45,32,8,0.96) 100%);
    border: 3px solid #8b7355;
    box-shadow: 0 4px 22px rgba(0,0,0,0.65), inset 0 1px 0 rgba(255,215,0,0.18);
    border-radius: 12px;
  }
  .t-medieval #alert-avatar { border: 3px solid #8b7355; background: rgba(50,35,10,0.6); }
  .t-medieval #alert-nickname { font-family: 'Cinzel', serif; color: #ffd700; text-shadow: 0 2px 6px rgba(0,0,0,0.8); }
  .t-medieval #alert-message  { font-family: 'Cinzel', serif; font-size: 13px; color: #e8d4a0; }

  /* ── THEME: RETRO ── */
  .t-retro {
    background: #0a0a0a;
    border: 3px solid #00ff41;
    box-shadow: 0 0 12px rgba(0,255,65,0.5), inset 0 0 14px rgba(0,255,65,0.06);
    border-radius: 4px;
  }
  .t-retro #alert-avatar { border: 3px solid #00ff41; background: #111; border-radius: 4px; }
  .t-retro #alert-nickname { font-family: 'Press Start 2P', monospace; font-size: 11px; color: #00ff41; }
  .t-retro #alert-message  { font-family: 'Press Start 2P', monospace; font-size: 9px; color: #ff00ff; margin-top: 7px; }

  /* ── THEME: FOGO ── */
  .t-fire {
    background: linear-gradient(160deg, rgba(50,12,0,0.95) 0%, rgba(85,28,0,0.95) 100%);
    border: 2px solid #ff6600;
    box-shadow: 0 0 32px rgba(255,100,0,0.45), inset 0 -8px 28px rgba(255,50,0,0.18);
  }
  .t-fire #alert-avatar { border: 3px solid #ff6600; background: rgba(80,20,0,0.5); }
  .t-fire #alert-nickname { font-family: 'Russo One', sans-serif; color: #ffd700; text-shadow: 0 0 12px rgba(255,120,0,0.85); }
  .t-fire #alert-message  { font-family: 'Russo One', sans-serif; font-size: 13px; color: #ffaa44; }

  /* ── THEME: GELO ── */
  .t-ice {
    background: linear-gradient(160deg, rgba(5,18,38,0.93) 0%, rgba(10,38,78,0.93) 100%);
    border: 2px solid rgba(150,220,255,0.65);
    box-shadow: 0 0 26px rgba(100,200,255,0.35), inset 0 0 20px rgba(200,240,255,0.07);
  }
  .t-ice #alert-avatar { border: 3px solid rgba(150,220,255,0.8); background: rgba(10,50,90,0.5); }
  .t-ice #alert-nickname { font-family: 'Rajdhani', sans-serif; font-size: 21px; color: #b0e0ff; text-shadow: 0 0 14px rgba(150,220,255,0.75); }
  .t-ice #alert-message  { font-family: 'Rajdhani', sans-serif; font-size: 15px; color: #e0f4ff; }

  /* ── THEME: TRANSPARENTE ── */
  .t-clean {
    background: transparent;
    border: none;
    box-shadow: none;
    padding: 8px 4px;
  }
  .t-clean #alert-avatar { border: 3px solid rgba(255,255,255,0.85); box-shadow: 0 2px 12px rgba(0,0,0,0.7); }
  .t-clean #alert-nickname { font-family: 'Segoe UI', sans-serif; font-size: 20px; color: #fff; text-shadow: 0 2px 8px rgba(0,0,0,0.95), 0 0 20px rgba(0,0,0,0.8); }
  .t-clean #alert-message  { font-family: 'Segoe UI', sans-serif; color: rgba(255,255,255,0.92); text-shadow: 0 2px 6px rgba(0,0,0,0.95); }
</style>
</head>
<body>
<div id="alert-box" class="t-roxo">
  <img id="alert-avatar" src="" alt="">
  <div id="alert-info">
    <div id="alert-nickname"></div>
    <div id="alert-message"></div>
  </div>
  <div id="alert-gift-wrap">
    <img id="alert-gift-img" src="" alt="">
    <span id="alert-gift-count"></span>
  </div>
</div>
<script>
  var box = document.getElementById('alert-box');
  var avatarEl = document.getElementById('alert-avatar');
  var nicknameEl = document.getElementById('alert-nickname');
  var messageEl = document.getElementById('alert-message');
  var giftWrapEl = document.getElementById('alert-gift-wrap');
  var giftImgEl = document.getElementById('alert-gift-img');
  var giftCountEl = document.getElementById('alert-gift-count');
  var currentTheme = 'roxo';
  var hideTimer = null;

  var THEMES = ['roxo','neon','medieval','retro','fire','ice','clean'];

  function applyTheme(t) {
    if (THEMES.indexOf(t) === -1) t = 'roxo';
    currentTheme = t;
    THEMES.forEach(function(th) { box.classList.remove('t-' + th); });
    box.classList.add('t-' + t);
  }

  function showAlert(data) {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    box.className = 't-' + currentTheme;
    void box.offsetWidth;
    avatarEl.src = data.profilePic || '';
    nicknameEl.textContent = data.nickname || '';
    messageEl.textContent = data.message || '';
    if (data.giftImage) {
      giftImgEl.src = data.giftImage;
      giftCountEl.textContent = (data.giftCount && data.giftCount > 1) ? 'x' + data.giftCount : '';
      giftWrapEl.style.display = 'flex';
    } else {
      giftWrapEl.style.display = 'none';
    }
    box.classList.add('show');
    hideTimer = setTimeout(function() {
      box.classList.remove('show');
      box.classList.add('hide');
      setTimeout(function() { box.className = 't-' + currentTheme; }, 550);
    }, 8000);
  }

  function connect() {
    var es = new EventSource('http://localhost:${ALERT_OVERLAY_PORT}/sse/scene${scene}');
    es.onmessage = function(e) {
      try {
        var d = JSON.parse(e.data);
        if (d.type === 'alert') showAlert(d);
        if (d.type === 'config') applyTheme(d.theme);
      } catch(err) {}
    };
    es.onerror = function() { es.close(); setTimeout(connect, 3000); };
  }
  connect();
</script>
</body>
</html>`;
}

const alertOverlayServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // Strip query strings so OBS cache-busting params don't break matching
  const urlPath = req.url.split('?')[0];

  if (urlPath === '/galeria') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getGaleriaHTML());
    return;
  }
  if (urlPath === '/sse-galeria') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    res.write('data: {"type":"connected"}\n\n');
    res.write('data: ' + JSON.stringify({ type: 'config', league: galeriaState.league, title: galeriaState.title, progress: galeriaState.progress, theme: galeriaState.theme, titleColor: galeriaState.titleColor, nameColor: galeriaState.nameColor, counterColor: galeriaState.counterColor, customColor: galeriaState.customColor, completeColor: galeriaState.completeColor }) + '\n\n');
    galeriaSseClients.push(res);
    req.on('close', () => { galeriaSseClients = galeriaSseClients.filter(c => c !== res); });
    return;
  }
  if (urlPath === '/desejo') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getDesejoHTML());
    return;
  }
  if (urlPath === '/sse-desejo') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    res.write('data: {"type":"connected"}\n\n');
    res.write('data: ' + JSON.stringify({ type: 'config', state: desejoState }) + '\n\n');
    desejoSseClients.push(res);
    req.on('close', () => { desejoSseClients = desejoSseClients.filter(c => c !== res); });
    return;
  }
  // SSE scene endpoints
  if (urlPath === '/sse/scene1' || urlPath === '/sse') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    res.write('data: {"type":"connected"}\n\n');
    res.write('data: ' + JSON.stringify({ type: 'config', theme: alertCurrentTheme }) + '\n\n');
    alertSseClients1.push(res);
    req.on('close', () => { alertSseClients1 = alertSseClients1.filter(c => c !== res); });
  } else if (urlPath === '/sse/scene2') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    res.write('data: {"type":"connected"}\n\n');
    res.write('data: ' + JSON.stringify({ type: 'config', theme: alertCurrentTheme }) + '\n\n');
    alertSseClients2.push(res);
    req.on('close', () => { alertSseClients2 = alertSseClients2.filter(c => c !== res); });
  } else if (urlPath === '/sse/scene3') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    res.write('data: {"type":"connected"}\n\n');
    res.write('data: ' + JSON.stringify({ type: 'config', theme: alertCurrentTheme }) + '\n\n');
    alertSseClients3.push(res);
    req.on('close', () => { alertSseClients3 = alertSseClients3.filter(c => c !== res); });
  } else {
    // HTML overlay — embed scene number directly so OBS gets the right SSE channel
    let scene = 1;
    if (urlPath === '/scene2') scene = 2;
    else if (urlPath === '/scene3') scene = 3;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getLocalAlertOverlayHTML(scene));
  }
});

alertOverlayServer.listen(ALERT_OVERLAY_PORT, '127.0.0.1', () => {
  console.log('[Alert] Local overlay server running on port ' + ALERT_OVERLAY_PORT);
});

function broadcastAlertEvent(data) {
  const ev = JSON.stringify({
    type: 'alert',
    alertType: data.alertType || '',
    nickname: data.nickname || '',
    profilePic: data.profilePic || '',
    message: data.message || '',
    giftImage: data.giftImage || '',
    giftCount: data.giftCount || 0
  });
  const scene = parseInt(data.scene) || 1;
  const clients = scene === 2 ? alertSseClients2 : scene === 3 ? alertSseClients3 : alertSseClients1;
  clients.forEach(c => { try { c.write('data: ' + ev + '\n\n'); } catch(e) {} });
}

function broadcastAlertConfig(theme) {
  alertCurrentTheme = theme;
  const ev = JSON.stringify({ type: 'config', theme });
  alertSseClients1.forEach(c => { try { c.write('data: ' + ev + '\n\n'); } catch(e) {} });
  alertSseClients2.forEach(c => { try { c.write('data: ' + ev + '\n\n'); } catch(e) {} });
  alertSseClients3.forEach(c => { try { c.write('data: ' + ev + '\n\n'); } catch(e) {} });
}

ipcMain.on('alert-config', (event, data) => {
  if (data && data.theme) {
    alertCurrentTheme = data.theme;
    relaySend({ type: 'alert-config', theme: data.theme });
  }
});

// ── Desejo do Streamer IPC ──
function broadcastDesejo(ev) {
  const msg = 'data: ' + JSON.stringify(ev) + '\n\n';
  desejoSseClients.forEach(c => { try { c.write(msg); } catch(e) {} });
}

ipcMain.on('desejo-config', (event, cfg) => {
  Object.assign(desejoState, cfg);
  if (typeof cfg.current === 'number') desejoState.current = cfg.current;
  relaySend({ type: 'desejo-config', ...desejoState });
});

ipcMain.on('desejo-increment', (event, { amount }) => {
  relaySend({ type: 'desejo-increment', amount: amount || 1 });
});

ipcMain.on('desejo-reset', () => {
  relaySend({ type: 'desejo-reset' });
});

// ── Galeria de Presentes IPC ──
function broadcastGaleria(ev) {
  const msg = 'data: ' + JSON.stringify(ev) + '\n\n';
  galeriaSseClients.forEach(c => { try { c.write(msg); } catch(e) {} });
}

ipcMain.on('galeria-config', (event, cfg) => {
  galeriaState.league       = cfg.league       || 'D';
  galeriaState.title        = cfg.title        || 'Galeria de Presentes';
  galeriaState.progress     = cfg.progress     || {};
  galeriaState.theme         = cfg.theme         || 'neon';
  galeriaState.titleColor    = cfg.titleColor    || '#ffffff';
  galeriaState.nameColor     = cfg.nameColor     || '#00d4ff';
  galeriaState.counterColor  = cfg.counterColor  || '#ffd700';
  galeriaState.customColor   = cfg.customColor   || '';
  galeriaState.completeColor = cfg.completeColor || '#ffd700';
  relaySend({ type: 'galeria-config', ...galeriaState });
});

ipcMain.on('galeria-progress', (event, data) => {
  galeriaState.progress = data.progress || {};
  relaySend({ type: 'galeria-progress', progress: galeriaState.progress, giftName: data.giftName });
});

ipcMain.on('galeria-reset', () => {
  galeriaState.progress = {};
  relaySend({ type: 'galeria-reset' });
});

// ============================================
// LIVEPIX GOAL — BrowserWindow persistente + MutationObserver em tempo real
// ============================================
let livepixBrowserWin = null;
let livepixCleanUrl = '';
let livepixCheckInterval = null;

const LIVEPIX_MONITOR_JS = `
(function() {
  if (window.__livepixMonitoring) return;
  window.__livepixMonitoring = true;
  function extractAmount() {
    var text = document.body ? (document.body.innerText || document.body.textContent || '') : '';
    var m = text.match(/R\\$[\\s\\u00a0]*([\\d.]+,[\\d]{2})/);
    if (!m) return null;
    var n = parseFloat(m[1].replace(/\\./g,'').replace(',','.'));
    return isNaN(n) ? null : n;
  }
  var lastAmount = null;
  function report() {
    var a = extractAmount();
    if (a !== null && a !== lastAmount) {
      lastAmount = a;
      document.title = '__LP__' + a;
    }
  }
  report();
  var obs = new MutationObserver(function() { report(); });
  obs.observe(document.documentElement, { childList:true, subtree:true, characterData:true });
  setInterval(report, 10000);
})();
`;

function livepixSendAmount(total) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('livepix-update', { total });
  }
}

function livepixInjectMonitor() {
  if (!livepixBrowserWin || livepixBrowserWin.isDestroyed()) return;
  setTimeout(async () => {
    try {
      if (!livepixBrowserWin || livepixBrowserWin.isDestroyed()) return;
      await livepixBrowserWin.webContents.executeJavaScript(LIVEPIX_MONITOR_JS);
      console.log('[livepix] monitor injected');
    } catch(e) { console.log('[livepix] inject error:', e.message); }
  }, 3500);
}

ipcMain.on('livepix-start-poll', (event, { url }) => {
  if (livepixCheckInterval) { clearInterval(livepixCheckInterval); livepixCheckInterval = null; }
  if (livepixBrowserWin && !livepixBrowserWin.isDestroyed()) { livepixBrowserWin.destroy(); livepixBrowserWin = null; }

  const clean = url.trim().replace(/\/$/, '');
  if (!/livepix\.gg/i.test(clean)) {
    if (mainWindow) mainWindow.webContents.send('livepix-status', { error: '❌ URL inválida. Use a URL do widget de meta do LivePix.' });
    return;
  }

  livepixCleanUrl = clean;
  livepixBrowserWin = new BrowserWindow({
    width: 800, height: 400, show: false, focusable: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false }
  });

  livepixBrowserWin.webContents.on('page-title-updated', (e, title) => {
    const m = title.match(/^__LP__([\d.]+)$/);
    if (m) { const total = parseFloat(m[1]); if (!isNaN(total)) livepixSendAmount(total); }
  });

  livepixBrowserWin.webContents.on('did-finish-load', livepixInjectMonitor);

  livepixCheckInterval = setInterval(async () => {
    if (!livepixBrowserWin || livepixBrowserWin.isDestroyed()) return;
    try {
      const t = await livepixBrowserWin.webContents.executeJavaScript('document.title');
      const m = t.match(/^__LP__([\d.]+)$/);
      if (m) livepixSendAmount(parseFloat(m[1]));
    } catch(e) {}
  }, 15000);

  livepixBrowserWin.loadURL(clean);
  if (mainWindow) mainWindow.webContents.send('livepix-status', { ok: true, username: clean });
});

ipcMain.on('livepix-stop-poll', () => {
  if (livepixCheckInterval) { clearInterval(livepixCheckInterval); livepixCheckInterval = null; }
  if (livepixBrowserWin && !livepixBrowserWin.isDestroyed()) { livepixBrowserWin.destroy(); livepixBrowserWin = null; }
  livepixCleanUrl = '';
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

  // Show login window — it will auto-validate saved session or show login form
  createLoginWindow();

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
  if (livepixCheckInterval) { clearInterval(livepixCheckInterval); livepixCheckInterval = null; }
  if (livepixBrowserWin && !livepixBrowserWin.isDestroyed()) { try { livepixBrowserWin.destroy(); } catch(e) {} }
  try { alertOverlayServer.close(); } catch(e) {}
  if (process.platform !== 'darwin') app.quit();
});
