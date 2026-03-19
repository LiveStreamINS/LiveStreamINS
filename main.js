const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const WebSocket = require('ws');
const crypto = require('crypto');

let mainWindow;

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

function connectToRelay(serverUrl) {
  if (relayWs) {
    try { relayWs.close(); } catch (e) {}
  }

  relayUrl = serverUrl.replace(/\/$/, '');
  const wsUrl = relayUrl.replace(/^http/, 'ws');

  relayWs = new WebSocket(wsUrl);

  relayWs.on('open', () => {
    relayWs.send(JSON.stringify({ type: 'join', roomId }));
    if (mainWindow) {
      mainWindow.webContents.send('relay-status', { connected: true, serverUrl: relayUrl, roomId });
    }
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
    if (mainWindow) {
      mainWindow.webContents.send('relay-status', { connected: false });
    }
    // Auto-reconnect after 5s
    setTimeout(() => {
      if (relayUrl) connectToRelay(relayUrl);
    }, 5000);
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
}

// Window controls
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
    likesRanking: `${relayUrl}/overlay/${roomId}/ranking/likes`,
    configured: true
  };
});

// ============================================
// TIKTOK CONNECTION
// ============================================
let tiktokConnection = null;

ipcMain.on('connect-tiktok', async (event, username) => {
  try {
    const { WebcastPushConnection } = require('tiktok-live-connector');

    if (tiktokConnection) {
      tiktokConnection.disconnect();
      tiktokConnection = null;
    }

    tiktokConnection = new WebcastPushConnection(username);

    const state = await tiktokConnection.connect();
    event.reply('tiktok-status', { connected: true, roomId: state.roomId });

    tiktokConnection.on('chat', (data) => event.reply('tiktok-event', { type: 'chat', data }));
    tiktokConnection.on('gift', (data) => event.reply('tiktok-event', { type: 'gift', data }));
    tiktokConnection.on('like', (data) => event.reply('tiktok-event', { type: 'like', data }));
    tiktokConnection.on('member', (data) => event.reply('tiktok-event', { type: 'member', data }));
    tiktokConnection.on('follow', (data) => event.reply('tiktok-event', { type: 'follow', data }));
    tiktokConnection.on('share', (data) => event.reply('tiktok-event', { type: 'share', data }));
    tiktokConnection.on('roomUser', (data) => event.reply('tiktok-event', { type: 'roomUser', data }));

    tiktokConnection.on('streamEnd', () => {
      event.reply('tiktok-status', { connected: false, reason: 'stream_ended' });
      tiktokConnection = null;
    });

    tiktokConnection.on('disconnected', () => {
      event.reply('tiktok-status', { connected: false, reason: 'disconnected' });
      tiktokConnection = null;
    });

    tiktokConnection.on('error', (err) => {
      event.reply('tiktok-status', { connected: false, error: err.message });
    });

  } catch (err) {
    let errorMsg = err.message;
    if (errorMsg.includes('Failed to retrieve')) {
      errorMsg = 'Usuário não encontrado ou não está em live.';
    } else if (errorMsg.includes('LIVE has ended')) {
      errorMsg = 'A live já foi encerrada.';
    } else if (errorMsg.includes('429')) {
      errorMsg = 'Muitas tentativas. Aguarde alguns minutos.';
    }
    event.reply('tiktok-status', { connected: false, error: errorMsg });
  }
});

ipcMain.on('disconnect-tiktok', (event) => {
  if (tiktokConnection) {
    tiktokConnection.disconnect();
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
        scene: edit.scene || 1
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

ipcMain.on('update-ranking-config', (event, config) => {
  relaySend({ type: 'ranking-config', ranking: config.ranking, bg: config.bg, side: config.side });
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

// File dialog
ipcMain.handle('open-file-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Mídia', extensions: ['mp4', 'webm', 'gif', 'avi', 'mov', 'mkv'] }]
  });
  if (!result.canceled && result.filePaths.length > 0) return result.filePaths[0];
  return null;
});

// ============================================
// APP START
// ============================================
app.whenReady().then(() => {
  roomId = getRoomId();
  const config = getRelayConfig();
  const urlToConnect = config.relayUrl || DEFAULT_RELAY_URL;
  connectToRelay(urlToConnect);
  createWindow();
});

app.on('window-all-closed', () => {
  if (relayWs) try { relayWs.close(); } catch (e) {}
  if (process.platform !== 'darwin') app.quit();
});
