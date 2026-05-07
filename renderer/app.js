const { ipcRenderer } = require('electron');
const path = require('path');
const fs = require('fs');
const TIKTOK_GIFTS = require('../gifts');

// ============================================
// STATE
// ============================================
let isConnected = false;
let keyModels = loadFromStorage('keyModels', []);
let activeModelId = null; // model being viewed
let connectedModelId = loadFromStorage('connectedModelId', null);
let editMappings = loadFromStorage('editMappings', []);
let coinsRanking = loadFromStorage('coinsRanking', {});
let likesRanking = loadFromStorage('likesRanking', {});
let pointsRanking = loadFromStorage('pointsRanking', {});
let pointsPerCoin = loadFromStorage('pointsPerCoin', 1);

// Membros Ação state
let membrosAcaoMembers = loadFromStorage('membrosAcaoMembers', []);
let membrosAcaoConfig  = loadFromStorage('membrosAcaoConfig', { title: 'Membros Ação', giftName: 'Heart Me', giftImage: '', subText: '', subTextSize: 9, subValueSize: 9, subTextColor: '#ffdc50', subValueColor: '#ffdc50' });
let pointsConfig = loadFromStorage('pointsConfig', { label: 'points', valueColor: '#f1c40f', labelColor: '#aaaaaa', nameColor: '#ffffff', theme: 'clean', side: 'left', customColor: '#1a1f2e' });
let coinsBg = loadFromStorage('coinsBg', 'transparent');
let coinsSide = loadFromStorage('coinsSide', 'left');
let likesBg = loadFromStorage('likesBg', 'transparent');
let likesSide = loadFromStorage('likesSide', 'left');

let jarTotalCount = 0;
let scoreboardEnabled = loadFromStorage('scoreboardEnabled', false);

// Goal state
let goalCoins = loadFromStorage('goalCoins', { text: '', target: 2000, current: 0, double: false, theme: 'neon', customColor: '#1a1f2e', style: 'default' });
let goalLikes = loadFromStorage('goalLikes', { text: '', target: 5000, current: 0, double: false, theme: 'neon', customColor: '#1a1f2e', style: 'default' });
let goalPix = loadFromStorage('goalPix', { text: '', target: 100, current: 0, double: false, theme: 'neon', customColor: '#1a1f2e', style: 'default' });
let livepixUrl = loadFromStorage('livepixUrl', '');

// Top Score state
let topScore = loadFromStorage('topScore', { title: '', desc: '', subtitle: '', name: '', avatar: '', valor: 0 });

// Membros state
let membrosTitle = loadFromStorage('membrosTitle', 'Membros');
let membrosMembers = loadFromStorage('membrosMembers', []); // [{userId, nickname, profilePictureUrl}]

// Top Presentes state
let topGift = loadFromStorage('topGift', null); // {giftName, giftPictureUrl, diamonds, nickname, profilePictureUrl}
let topCombo = loadFromStorage('topCombo', null); // {giftName, giftPictureUrl, comboCount, nickname, profilePictureUrl}
let topGiftConfig = loadFromStorage('topGiftConfig', { label: 'Maior Presente', labelColor: '#ffffff', nameColor: '#FFD700', valueColor: '#ffffff' });
let topComboConfig = loadFromStorage('topComboConfig', { label: 'Maior Combo', labelColor: '#ffffff', nameColor: '#FFD700', comboColor: '#ff6464' });
const editDebounce = {}; // { "userId_giftName": timestamp }

// Timer state
let timerSeconds = 0;
let timerRunning = false;
let timerInterval = null;
let timerCoinsRatio = 1; // 1 coin = X seconds
let timerTheme = 'neon';
let timerLivePixUrl = '';

// Load timer config
const savedTimerConfig = localStorage.getItem('timerConfig');
if (savedTimerConfig) {
  const tc = JSON.parse(savedTimerConfig);
  timerSeconds = tc.seconds || 0;
  timerCoinsRatio = tc.coinsRatio || 1;
  timerTheme = tc.theme || 'neon';
  timerLivePixUrl = tc.livePixUrl || '';
}

// Migrate old keyMappings to models
(function migrateOldData() {
  const old = loadFromStorage('keyMappings', null);
  if (old && old.length > 0 && keyModels.length === 0) {
    keyModels.push({ id: generateId(), name: 'Modelo Importado', mappings: old });
    saveToStorage('keyModels', keyModels);
    localStorage.removeItem('keyMappings');
  }
})();

// ============================================
// STORAGE
// ============================================
function loadFromStorage(key, fallback) {
  try {
    const data = localStorage.getItem(key);
    return data ? JSON.parse(data) : fallback;
  } catch { return fallback; }
}

function saveToStorage(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
}

// ============================================
// WINDOW CONTROLS
// ============================================
document.getElementById('btn-minimize').addEventListener('click', () => ipcRenderer.send('window-minimize'));
document.getElementById('btn-maximize').addEventListener('click', () => ipcRenderer.send('window-maximize'));
document.getElementById('btn-close').addEventListener('click', () => ipcRenderer.send('window-close'));

// ============================================
// TAB NAVIGATION
// ============================================
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
  });
});

// ============================================
// RANKING SUB-TABS
// ============================================
document.querySelectorAll('.ranking-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.ranking-tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.ranking-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`ranking-${btn.dataset.ranking}`).classList.add('active');
  });
});

// ============================================
// GIFT GRID SELECTOR
// ============================================
function renderGiftGrid(gridId, searchId, hiddenInputId) {
  const grid = document.getElementById(gridId);
  const searchInput = document.getElementById(searchId);
  const hiddenInput = document.getElementById(hiddenInputId);

  function render(filter = '') {
    const filtered = filter
      ? TIKTOK_GIFTS.filter(g => g.name.toLowerCase().includes(filter.toLowerCase()))
      : TIKTOK_GIFTS;

    grid.innerHTML = filtered.map(g => {
      const selected = hiddenInput.value === g.name ? 'selected' : '';
      return `<div class="gift-item ${selected}" data-name="${escapeHtml(g.name)}">
        <img src="${g.image}" alt="${escapeHtml(g.name)}" loading="lazy" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 36 36%22><text y=%2228%22 font-size=%2228%22>🎁</text></svg>'">
        <span title="${escapeHtml(g.name)}">${escapeHtml(g.name)}</span>
      </div>`;
    }).join('');

    grid.querySelectorAll('.gift-item').forEach(item => {
      item.addEventListener('click', () => {
        grid.querySelectorAll('.gift-item').forEach(i => i.classList.remove('selected'));
        item.classList.add('selected');
        hiddenInput.value = item.dataset.name;
      });
    });
  }

  render();
  searchInput.addEventListener('input', () => render(searchInput.value));
}

// ============================================
// TIKTOK CONNECTION
// ============================================
const btnConnect = document.getElementById('btn-connect');
const usernameInput = document.getElementById('username-input');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const viewerCount = document.getElementById('viewer-count');
const liveIndicator = document.getElementById('live-events-indicator');

btnConnect.addEventListener('click', () => {
  if (isConnected) {
    ipcRenderer.send('disconnect-tiktok');
    return;
  }
  const username = usernameInput.value.trim();
  if (!username) { showToast('Digite o username do TikTok', 'error'); return; }
  btnConnect.disabled = true;
  btnConnect.textContent = 'Conectando...';
  statusText.textContent = 'Conectando...';
  ipcRenderer.send('connect-tiktok', username);
});

usernameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') btnConnect.click();
});

ipcRenderer.on('tiktok-status', (event, data) => {
  // Update TikTok badge in unified chat
  const chatTkBadge = document.getElementById('chat-status-tiktok');
  if (chatTkBadge) {
    if (data.connected) {
      chatTkBadge.style.background = 'rgba(255,45,85,0.2)';
      chatTkBadge.style.color = '#ff2d55';
      chatTkBadge.textContent = '● Conectado';
    } else if (data.reason !== 'reconnecting') {
      chatTkBadge.style.background = 'rgba(255,255,255,0.07)';
      chatTkBadge.style.color = 'rgba(255,255,255,0.4)';
      chatTkBadge.textContent = 'Desconectado';
    }
  }

  if (data.connected) {
    isConnected = true;
    statusDot.classList.add('connected');
    statusText.textContent = 'Conectado';
    btnConnect.textContent = 'Desconectar';
    btnConnect.classList.add('connected');
    btnConnect.disabled = false;
    liveIndicator.style.display = 'flex';
    usernameInput.disabled = true;
    showToast('Conectado com sucesso!', 'success');
  } else if (data.reason === 'checking') {
    // Verificando se o usuário está em live (BrowserWindow carregando)
    isConnected = false;
    statusDot.classList.remove('connected');
    liveIndicator.style.display = 'none';
    statusText.textContent = 'Verificando live...';
    btnConnect.textContent = 'Desconectar';
    btnConnect.classList.add('connected');
    btnConnect.disabled = false;
    usernameInput.disabled = true;
  } else if (data.reason === 'reconnecting') {
    // Auto-reconnect in progress — keep UI showing "reconectando"
    isConnected = false;
    statusDot.classList.remove('connected');
    liveIndicator.style.display = 'none';
    const retryMsg = data.retryIn ? ` (${data.retryIn}s)` : '';
    statusText.textContent = 'Reconectando...' + retryMsg;
    btnConnect.textContent = 'Desconectar';
    btnConnect.classList.add('connected');
    btnConnect.disabled = false;
    usernameInput.disabled = true;
    if (!data._silent) showToast('Desconectado — reconectando automaticamente...', 'info');
  } else {
    isConnected = false;
    statusDot.classList.remove('connected');
    btnConnect.classList.remove('connected');
    btnConnect.disabled = false;
    usernameInput.disabled = false;
    liveIndicator.style.display = 'none';
    if (data.error) {
      statusText.textContent = 'Erro';
      btnConnect.textContent = 'Conectar';
      showToast(data.error, 'error');
    } else if (data.reason === 'stream_ended') {
      statusText.textContent = 'Live encerrada';
      btnConnect.textContent = 'Conectar';
      showToast('A live foi encerrada', 'info');
    } else {
      statusText.textContent = 'Desconectado';
      btnConnect.textContent = 'Conectar';
      if (data.reason === 'user_disconnected') showToast('Desconectado', 'info');
    }
  }
});

// ============================================
// TIKTOK EVENTS
// ============================================
ipcRenderer.on('tiktok-event', (event, { type, data }) => {
  switch (type) {
    case 'gift': handleGift(data); break;
    case 'like': handleLike(data); break;
    case 'roomUser': handleRoomUser(data); break;
    case 'member': handleMember(data); break;
  }
});

// ============================================
// GIFT HANDLER
// ============================================
function handleGift(data) {
  const giftName = data.giftName || '';
  const repeatCount = data.repeatCount || 1;
  const diamondCount = Number(data.diamondCount || 0);
  const userId = data.uniqueId || data.userId;
  const nickname = data.nickname || userId;
  const profilePic = data.profilePictureUrl || '';

  // Detect streakable gifts via giftType (1 = streakable, others = single-event)
  // The legacy data converter ALWAYS sets repeatEnd to a boolean, so we cannot
  // rely on `repeatEnd !== undefined` — non-streak expensive gifts (Lion, Universe,
  // Galaxy, etc.) fire ONE event with repeatEnd=false and would be skipped.
  const giftType = data.giftType ?? data.gift?.gift_type ?? 0;
  const isStreakable = giftType === 1;
  const isStreakEnded = data.repeatEnd === true;

  // Count when: non-streakable single-event gift, OR streakable that just ended
  if (!isStreakable || isStreakEnded) {
    const totalDiamonds = diamondCount * repeatCount;

    // Only count gifts that actually cost diamonds (filter out free interaction points)
    if (totalDiamonds > 0 && diamondCount > 0) {
      // Update coins ranking
      if (!coinsRanking[userId]) {
        coinsRanking[userId] = { nickname, profilePictureUrl: profilePic, coins: 0 };
      }
      coinsRanking[userId].coins += totalDiamonds;
      coinsRanking[userId].nickname = nickname;
      if (profilePic) coinsRanking[userId].profilePictureUrl = profilePic;
      saveToStorage('coinsRanking', coinsRanking);
      renderCoinsRanking();
      ipcRenderer.send('update-coins-ranking', coinsRanking);

      // Points ranking — acumula pontos baseado em moedas × ratio
      const pointsToAdd = totalDiamonds * pointsPerCoin;
      if (pointsToAdd > 0) {
        if (!pointsRanking[userId]) pointsRanking[userId] = { nickname, profilePictureUrl: profilePic, points: 0 };
        pointsRanking[userId].points += pointsToAdd;
        pointsRanking[userId].nickname = nickname;
        if (profilePic) pointsRanking[userId].profilePictureUrl = profilePic;
        saveToStorage('pointsRanking', pointsRanking);
        renderPointsRanking();
        ipcRenderer.send('update-points-ranking', pointsRanking);
      }

      // Add time to timer (works even when paused)
      if (timerCoinsRatio > 0) {
        const secondsToAdd = totalDiamonds * timerCoinsRatio;
        if (secondsToAdd > 0) {
          timerSeconds += secondsToAdd;
          updateTimerDisplay();
          saveTimerConfig();
        }
      }
    }

    showToast(`🎁 ${nickname} enviou ${giftName} x${repeatCount}`, 'gift');

    // Update coin goal
    if (totalDiamonds > 0) {
      updateGoalProgress('coins', totalDiamonds);
    }
  }

  // Send to jar overlay - always
  const giftImage = getGiftImage(giftName);
  if (giftImage) {
    ipcRenderer.send('jar-gift', { giftImage, giftName, count: repeatCount, coins: diamondCount * repeatCount });
    jarTotalCount += repeatCount;
    const jarCountEl = document.getElementById('jar-total-count');
    if (jarCountEl) jarCountEl.textContent = jarTotalCount;
  }

  // Track Top Gift (highest diamond value single gift)
  const giftPictureUrl = data.giftPictureUrl || data.gift?.image?.url_list?.[0] || '';
  if (diamondCount > 0) {
    if (!topGift || diamondCount > topGift.diamonds) {
      topGift = { giftName, giftPictureUrl, diamonds: diamondCount, nickname, profilePictureUrl: profilePic };
      saveToStorage('topGift', topGift);
      ipcRenderer.send('top-gift-update', topGift);
      const tgd = document.getElementById('tp-gift-display');
      const tgs = document.getElementById('tp-gift-sender');
      if (tgd) tgd.textContent = giftName + ' — 🪙' + diamondCount.toLocaleString('pt-BR');
      if (tgs) tgs.textContent = 'por ' + nickname;
    }
  }

  // Track Top Combo (highest repeatCount on a streakable gift)
  if (isStreakable && repeatCount > 0) {
    if (!topCombo || repeatCount > topCombo.comboCount) {
      topCombo = { giftName, giftPictureUrl, comboCount: repeatCount, nickname, profilePictureUrl: profilePic };
      saveToStorage('topCombo', topCombo);
      ipcRenderer.send('top-combo-update', topCombo);
      const tcd = document.getElementById('tp-combo-display');
      const tcs = document.getElementById('tp-combo-sender');
      if (tcd) tcd.textContent = giftName + ' x' + repeatCount.toLocaleString('pt-BR');
      if (tcs) tcs.textContent = 'por ' + nickname;
    }
  }

  // Membros Ação — detecta o presente configurado (conta só quando streak acabou)
  if (membrosAcaoConfig.giftName && giftName.toLowerCase() === membrosAcaoConfig.giftName.toLowerCase()) {
    if (!isStreakable || isStreakEnded) {
      const qty = repeatCount || 1;
      const existing = membrosAcaoMembers.find(m => m.userId === userId);
      if (existing) {
        existing.value = (existing.value || 0) + qty;
        existing.nickname = nickname;
        if (profilePic) existing.profilePictureUrl = profilePic;
      } else {
        membrosAcaoMembers.push({ userId, nickname, profilePictureUrl: profilePic, value: qty });
        const el = document.getElementById('membros-acao-count');
        if (el) el.textContent = membrosAcaoMembers.length;
      }
      saveToStorage('membrosAcaoMembers', membrosAcaoMembers);
      ipcRenderer.send('membros-acao-add', { userId, nickname, profilePictureUrl: profilePic, value: qty });
    }
  }

  // Detect Heart Me → add to Membros
  if (giftName.toLowerCase() === 'heart me') {
    const alreadyMember = membrosMembers.find(m => m.userId === userId);
    if (!alreadyMember) {
      membrosMembers.push({ userId, nickname, profilePictureUrl: profilePic });
      saveToStorage('membrosMembers', membrosMembers);
      ipcRenderer.send('membros-add', { userId, nickname, profilePictureUrl: profilePic });
      const countEl = document.getElementById('membros-count');
      if (countEl) countEl.textContent = membrosMembers.length;
    }
  }

  // Check connected model's key mappings - ALWAYS trigger (no streak filtering)
  if (connectedModelId) {
    const model = keyModels.find(m => m.id === connectedModelId);
    if (model) {
      model.mappings.forEach(mapping => {
        if (giftName.toLowerCase() === mapping.giftName.toLowerCase() && repeatCount >= (mapping.minCount || 1)) {
          console.log(`[KeyMatch] "${giftName}" matched "${mapping.giftName}" → sending key: ${mapping.key}`);
          ipcRenderer.send('simulate-key', { key: mapping.key, modifiers: mapping.modifiers || [] });
        }
      });
    }
  }

  // Check edit mappings - with debounce to prevent duplicate playback
  if (!isStreakable || isStreakEnded) {
    const now = Date.now();
    editMappings.forEach((edit, idx) => {
      if (giftName.toLowerCase() === edit.giftName.toLowerCase() && repeatCount >= (edit.minCount || 1)) {
        const debounceKey = `${userId}_${giftName.toLowerCase()}_${idx}`;
        if (editDebounce[debounceKey] && (now - editDebounce[debounceKey]) < 3000) {
          console.log(`[EditDebounce] Skipping duplicate "${giftName}" from ${userId}`);
          return;
        }
        editDebounce[debounceKey] = now;
        console.log(`[EditMatch] "${giftName}" matched "${edit.giftName}" → triggering edit`);
        ipcRenderer.send('trigger-edit-overlay', { ...edit, senderNickname: nickname, senderPhoto: profilePic });
        flashCard('edit', idx);
      }
    });
  }
}

function handleLike(data) {
  const userId = data.uniqueId || data.userId;
  const nickname = data.nickname || userId;
  const profilePic = data.profilePictureUrl || '';
  const likeCount = data.likeCount || data.totalLikeCount || 1;

  if (!likesRanking[userId]) {
    likesRanking[userId] = { nickname, profilePictureUrl: profilePic, likes: 0 };
  }
  likesRanking[userId].likes += likeCount;
  likesRanking[userId].nickname = nickname;
  if (profilePic) likesRanking[userId].profilePictureUrl = profilePic;
  saveToStorage('likesRanking', likesRanking);
  renderLikesRanking();
  ipcRenderer.send('update-likes-ranking', likesRanking);

  // Update like goal
  updateGoalProgress('likes', likeCount);
}

function handleRoomUser(data) {
  const count = data.viewerCount || 0;
  viewerCount.textContent = `👁 ${count.toLocaleString()}`;
}

function handleMember(data) {
  const nickname = data.nickname || data.uniqueId;
  showToast(`${nickname} entrou na live`, 'info');
}

// ============================================
// FLASH CARD ANIMATION
// ============================================
function flashCard(type, idx) {
  const cards = document.querySelectorAll(type === 'mapping' ? '.mapping-card' : '.edit-card');
  if (cards[idx]) {
    cards[idx].classList.add('triggered');
    setTimeout(() => cards[idx].classList.remove('triggered'), 1500);
  }
}

// ============================================
// MODELS SYSTEM
// ============================================
const modelsListView = document.getElementById('models-list-view');
const modelDetailView = document.getElementById('model-detail-view');
const modalModel = document.getElementById('modal-model');
let editingModelId = null; // for rename

document.getElementById('btn-add-model').addEventListener('click', () => {
  editingModelId = null;
  document.getElementById('modal-model-title').textContent = 'Novo Modelo';
  document.getElementById('model-name-input').value = '';
  modalModel.style.display = 'flex';
  setTimeout(() => document.getElementById('model-name-input').focus(), 100);
});

document.getElementById('btn-save-model').addEventListener('click', () => {
  const name = document.getElementById('model-name-input').value.trim();
  if (!name) { showToast('Digite um nome para o modelo', 'error'); return; }

  if (editingModelId) {
    // Rename
    const model = keyModels.find(m => m.id === editingModelId);
    if (model) model.name = name;
  } else {
    // Create new
    keyModels.push({ id: generateId(), name, mappings: [] });
  }
  saveToStorage('keyModels', keyModels);
  renderModels();
  modalModel.style.display = 'none';
  showToast(editingModelId ? 'Modelo renomeado!' : `Modelo "${name}" criado!`, 'success');
  editingModelId = null;
});

document.getElementById('btn-back-models').addEventListener('click', () => {
  activeModelId = null;
  modelDetailView.style.display = 'none';
  modelsListView.style.display = 'block';
});

function renderModels() {
  const container = document.getElementById('models-list');

  if (keyModels.length === 0) {
    container.innerHTML = '';
    container.appendChild(createEmptyState('🎮', 'Nenhum modelo criado', 'Clique em "+ Adicionar Modelo" para começar'));
    return;
  }

  container.innerHTML = keyModels.map(m => {
    const isConn = connectedModelId === m.id;
    return `
    <div class="model-card ${isConn ? 'model-connected' : ''}" data-id="${m.id}">
      <div class="model-card-info" onclick="openModel('${m.id}')">
        <span class="model-card-icon">🎮</span>
        <div>
          <h4>${escapeHtml(m.name)}</h4>
          <span>${m.mappings.length} mapeamento${m.mappings.length !== 1 ? 's' : ''}</span>
        </div>
      </div>
      <div class="mapping-actions">
        <button class="btn-model-connect ${isConn ? 'active' : ''}" onclick="toggleModelConnect('${m.id}')">${isConn ? 'Desconectar' : 'Conectar'}</button>
        <button class="btn-action" onclick="renameModel('${m.id}')" title="Renomear">✏️</button>
        <button class="btn-action delete" onclick="deleteModel('${m.id}')" title="Remover">🗑</button>
      </div>
    </div>`;
  }).join('');
}

function openModel(id) {
  const model = keyModels.find(m => m.id === id);
  if (!model) return;
  activeModelId = id;
  document.getElementById('model-detail-name').textContent = model.name;
  modelsListView.style.display = 'none';
  modelDetailView.style.display = 'block';
  renderKeyMappings();
}

function renameModel(id) {
  const model = keyModels.find(m => m.id === id);
  if (!model) return;
  editingModelId = id;
  document.getElementById('modal-model-title').textContent = 'Renomear Modelo';
  document.getElementById('model-name-input').value = model.name;
  modalModel.style.display = 'flex';
  setTimeout(() => document.getElementById('model-name-input').focus(), 100);
}

function toggleModelConnect(id) {
  if (connectedModelId === id) {
    connectedModelId = null;
    showToast('Modelo desconectado', 'info');
  } else {
    connectedModelId = id;
    const model = keyModels.find(m => m.id === id);
    showToast(`Modelo "${model.name}" conectado!`, 'success');
  }
  saveToStorage('connectedModelId', connectedModelId);
  renderModels();
}

function deleteModel(id) {
  if (connectedModelId === id) connectedModelId = null;
  keyModels = keyModels.filter(m => m.id !== id);
  saveToStorage('keyModels', keyModels);
  saveToStorage('connectedModelId', connectedModelId);
  renderModels();
  showToast('Modelo removido', 'info');
}

// ============================================
// KEY MAPPINGS (inside active model)
// ============================================
const btnAddKeyMap = document.getElementById('btn-add-key-map');
const modalKeyMap = document.getElementById('modal-key-map');
const keyCaptureBox = document.getElementById('key-capture-box');
const keyCaptureText = document.getElementById('key-capture-text');
let capturedKey = null;
let capturedModifiers = [];

btnAddKeyMap.addEventListener('click', () => {
  if (!activeModelId) return;
  document.getElementById('map-gift-name').value = '';
  document.getElementById('map-gift-search').value = '';
  document.getElementById('map-gift-count').value = '1';
  capturedKey = null;
  capturedModifiers = [];
  keyCaptureText.textContent = 'Clique aqui e pressione uma tecla';
  keyCaptureBox.classList.remove('captured');
  modalKeyMap.style.display = 'flex';
  renderGiftGrid('map-gift-grid', 'map-gift-search', 'map-gift-name');
});

keyCaptureBox.addEventListener('keydown', (e) => {
  e.preventDefault();
  e.stopPropagation();
  const key = e.key.toLowerCase();
  if (['control', 'shift', 'alt', 'meta'].includes(key)) return;

  capturedModifiers = [];
  if (e.ctrlKey) capturedModifiers.push('control');
  if (e.shiftKey) capturedModifiers.push('shift');
  if (e.altKey) capturedModifiers.push('alt');

  const keyMap = {
    ' ': 'space', 'arrowup': 'up', 'arrowdown': 'down',
    'arrowleft': 'left', 'arrowright': 'right', 'enter': 'enter',
    'escape': 'escape', 'tab': 'tab', 'backspace': 'backspace',
    'delete': 'delete'
  };

  capturedKey = keyMap[key] || key;
  let displayText = '';
  if (capturedModifiers.length > 0) {
    displayText = capturedModifiers.map(m => m.charAt(0).toUpperCase() + m.slice(1)).join(' + ') + ' + ';
  }
  displayText += capturedKey.toUpperCase();
  keyCaptureText.textContent = displayText;
  keyCaptureBox.classList.add('captured');
});

document.getElementById('btn-save-key-map').addEventListener('click', () => {
  const giftName = document.getElementById('map-gift-name').value.trim();
  const minCount = parseInt(document.getElementById('map-gift-count').value) || 1;

  if (!giftName) { showToast('Selecione um presente', 'error'); return; }
  if (!capturedKey) { showToast('Pressione uma tecla', 'error'); return; }
  if (!activeModelId) return;

  const model = keyModels.find(m => m.id === activeModelId);
  if (!model) return;

  model.mappings.push({ giftName, key: capturedKey, modifiers: capturedModifiers, minCount });
  saveToStorage('keyModels', keyModels);
  renderKeyMappings();
  modalKeyMap.style.display = 'none';
  showToast(`Mapeamento "${giftName}" → ${capturedKey.toUpperCase()} salvo!`, 'success');
});

function getGiftImage(name) {
  const gift = TIKTOK_GIFTS.find(g => g.name.toLowerCase() === name.toLowerCase());
  return gift ? gift.image : null;
}

function renderKeyMappings() {
  const container = document.getElementById('key-mappings-list');
  const model = keyModels.find(m => m.id === activeModelId);
  if (!model) return;

  if (model.mappings.length === 0) {
    container.innerHTML = '';
    container.appendChild(createEmptyState('⌨️', 'Nenhum mapeamento criado', 'Clique em "+ Adicionar Mapeamento" para começar'));
    return;
  }

  container.innerHTML = model.mappings.map((m, i) => {
    const modText = m.modifiers && m.modifiers.length > 0
      ? m.modifiers.map(mod => mod.charAt(0).toUpperCase() + mod.slice(1)).join('+') + '+' : '';
    const giftImg = getGiftImage(m.giftName);
    const iconHtml = giftImg
      ? `<img src="${giftImg}" class="mapping-gift-img" alt="${escapeHtml(m.giftName)}">`
      : `<div class="mapping-gift-icon">🎁</div>`;
    return `
    <div class="mapping-card" data-index="${i}">
      <div class="mapping-info">
        ${iconHtml}
        <div class="mapping-details">
          <h4>${escapeHtml(m.giftName)}</h4>
          <span>Min: ${m.minCount}x</span>
        </div>
      </div>
      <div class="mapping-key">${modText}${m.key.toUpperCase()}</div>
      <div class="mapping-actions">
        <button class="btn-action" onclick="testKeyMapping(${i})" title="Testar">▶</button>
        <button class="btn-action delete" onclick="deleteKeyMapping(${i})" title="Remover">🗑</button>
      </div>
    </div>`;
  }).join('');
}

function deleteKeyMapping(idx) {
  const model = keyModels.find(m => m.id === activeModelId);
  if (!model) return;
  model.mappings.splice(idx, 1);
  saveToStorage('keyModels', keyModels);
  renderKeyMappings();
  showToast('Mapeamento removido', 'info');
}

function testKeyMapping(idx) {
  const model = keyModels.find(m => m.id === activeModelId);
  if (!model) return;
  const mapping = model.mappings[idx];
  ipcRenderer.send('simulate-key', { key: mapping.key, modifiers: mapping.modifiers || [] });
  showToast(`Testando tecla: ${mapping.key.toUpperCase()}`, 'info');
  flashCard('mapping', idx);
}

// ============================================
// EDIT MAPPINGS
// ============================================
const btnAddEdit = document.getElementById('btn-add-edit');
const modalEdit = document.getElementById('modal-edit');

btnAddEdit.addEventListener('click', () => {
  document.getElementById('edit-gift-name').value = '';
  document.getElementById('edit-gift-search').value = '';
  document.getElementById('edit-file-path').value = '';
  document.getElementById('edit-duration').value = '5';
  document.getElementById('edit-gift-count').value = '1';
  document.getElementById('edit-scene').value = '1';
  document.getElementById('edit-volume').value = '100';
  document.getElementById('edit-volume-label').textContent = '100%';
  modalEdit.style.display = 'flex';
  renderGiftGrid('edit-gift-grid', 'edit-gift-search', 'edit-gift-name');
});

document.getElementById('edit-volume').addEventListener('input', (e) => {
  document.getElementById('edit-volume-label').textContent = e.target.value + '%';
});

document.getElementById('btn-browse-edit').addEventListener('click', async () => {
  const filePath = await ipcRenderer.invoke('open-file-dialog');
  if (filePath) document.getElementById('edit-file-path').value = filePath;
});

document.getElementById('btn-save-edit').addEventListener('click', () => {
  const giftName = document.getElementById('edit-gift-name').value.trim();
  const filePath = document.getElementById('edit-file-path').value.trim();
  const duration = parseInt(document.getElementById('edit-duration').value) || 5;
  const minCount = parseInt(document.getElementById('edit-gift-count').value) || 1;

  if (!giftName) { showToast('Selecione um presente', 'error'); return; }
  if (!filePath) { showToast('Selecione um arquivo', 'error'); return; }

  const ext = path.extname(filePath).toLowerCase();
  const isGif = ext === '.gif';
  const scene = parseInt(document.getElementById('edit-scene').value) || 1;
  const volume = parseInt(document.getElementById('edit-volume').value) || 100;

  editMappings.push({ giftName, filePath, duration, minCount, isGif, scene, volume });
  saveToStorage('editMappings', editMappings);
  renderEditMappings();
  modalEdit.style.display = 'none';
  showToast(`Edit "${giftName}" salvo!`, 'success');
});

function renderEditMappings() {
  const container = document.getElementById('edits-list');

  if (editMappings.length === 0) {
    container.innerHTML = '';
    container.appendChild(createEmptyState('🎬', 'Nenhum edit configurado', 'Clique em "+ Adicionar Edit" para começar'));
    return;
  }

  container.innerHTML = editMappings.map((e, i) => {
    const fileName = path.basename(e.filePath);
    const giftImg = getGiftImage(e.giftName);
    const thumbHtml = giftImg
      ? `<img src="${giftImg}" class="mapping-gift-img" alt="${escapeHtml(e.giftName)}">`
      : `<div class="edit-thumb">${e.isGif ? '🖼' : '🎬'}</div>`;
    return `
    <div class="edit-card" data-index="${i}">
      <div class="edit-info">
        ${thumbHtml}
        <div class="edit-details">
          <h4>${escapeHtml(e.giftName)}</h4>
          <span>Cena ${e.scene || 1} | Duração: ${e.duration}s | Min: ${e.minCount}x | Vol: ${e.volume !== undefined ? e.volume : 100}%</span>
        </div>
      </div>
      <span class="edit-file-name" title="${escapeHtml(e.filePath)}">${escapeHtml(fileName)}</span>
      <div class="mapping-actions">
        <button class="btn-action" onclick="testEdit(${i})" title="Testar">▶</button>
        <button class="btn-action delete" onclick="deleteEdit(${i})" title="Remover">🗑</button>
      </div>
    </div>`;
  }).join('');
}

function deleteEdit(idx) {
  editMappings.splice(idx, 1);
  saveToStorage('editMappings', editMappings);
  renderEditMappings();
  showToast('Edit removido', 'info');
}

function testEdit(idx) {
  const edit = editMappings[idx];
  ipcRenderer.send('trigger-edit-overlay', edit);
  showToast(`Testando edit "${edit.giftName}" na Cena ${edit.scene || 1}`, 'info');
}

// ============================================
// RANKINGS
// ============================================
function renderCoinsRanking() {
  const list = document.getElementById('coins-ranking-list');
  const sorted = Object.entries(coinsRanking)
    .map(([id, data]) => ({ id, ...data }))
    .sort((a, b) => b.coins - a.coins)
    .slice(0, 50);

  if (sorted.length === 0) {
    list.innerHTML = '';
    list.appendChild(createEmptyState('🪙', 'Nenhum dado ainda', 'Conecte-se a uma live para ver o ranking de moedas'));
    return;
  }
  list.innerHTML = sorted.map((user, i) => createRankingItem(user, i, 'coins')).join('');
}

function renderPointsRanking() {
  const list = document.getElementById('points-ranking-list');
  if (!list) return;
  const sorted = Object.entries(pointsRanking)
    .map(([id, data]) => ({ id, ...data }))
    .sort((a, b) => b.points - a.points)
    .slice(0, 20);
  if (sorted.length === 0) {
    list.innerHTML = '';
    list.appendChild(createEmptyState('⭐', 'Nenhum ponto ainda', 'Pontos são acumulados com base nas moedas enviadas'));
    return;
  }
  list.innerHTML = sorted.map((user, i) => {
    const pos = i + 1;
    const posClass = pos <= 3 ? `pos-${pos}` : 'pos-other';
    const avatarContent = user.profilePictureUrl
      ? `<img src="${user.profilePictureUrl}" alt="" onerror="this.parentElement.innerHTML='👤'">`
      : '👤';
    const frameClass = pos <= 3 ? `avatar-frame-${pos}` : '';
    return `<div class="ranking-item">
      <div class="ranking-position ${posClass}">${pos}</div>
      <div class="ranking-avatar ${frameClass}">${avatarContent}</div>
      <div class="ranking-user-info">
        <div class="ranking-user-name">${escapeHtml(user.nickname)}</div>
        <div class="ranking-user-value">⭐ ${(user.points||0).toLocaleString('pt-BR')} ${pointsConfig.label}</div>
      </div>
    </div>`;
  }).join('');
}

function renderLikesRanking() {
  const list = document.getElementById('likes-ranking-list');
  const sorted = Object.entries(likesRanking)
    .map(([id, data]) => ({ id, ...data }))
    .sort((a, b) => b.likes - a.likes)
    .slice(0, 50);

  if (sorted.length === 0) {
    list.innerHTML = '';
    list.appendChild(createEmptyState('❤️', 'Nenhum dado ainda', 'Conecte-se a uma live para ver o ranking de likes'));
    return;
  }
  list.innerHTML = sorted.map((user, i) => createRankingItem(user, i, 'likes')).join('');
}

function createRankingItem(user, index, type) {
  const pos = index + 1;
  const posClass = pos <= 3 ? `pos-${pos}` : 'pos-other';
  const value = type === 'coins' ? user.coins : user.likes;
  const valueLabel = type === 'coins' ? `🪙 ${value.toLocaleString()}` : `❤️ ${value.toLocaleString()}`;
  const avatarContent = user.profilePictureUrl
    ? `<img src="${user.profilePictureUrl}" alt="" onerror="this.parentElement.innerHTML='👤'">`
    : '👤';
  const frameClass = pos <= 3 ? `avatar-frame-${pos}` : '';

  return `
    <div class="ranking-item">
      <div class="ranking-position ${posClass}">${pos}</div>
      <div class="ranking-avatar ${frameClass}">${avatarContent}</div>
      <div class="ranking-user-info">
        <div class="ranking-user-name">${escapeHtml(user.nickname)}</div>
        <div class="ranking-user-value ${type}">${valueLabel}</div>
      </div>
    </div>`;
}

// Reset rankings (individual)
document.getElementById('btn-reset-coins').addEventListener('click', () => {
  coinsRanking = {};
  saveToStorage('coinsRanking', coinsRanking);
  renderCoinsRanking();
  ipcRenderer.send('update-coins-ranking', coinsRanking);
  showToast('Ranking de Moedas resetado!', 'success');
});

document.getElementById('btn-reset-likes').addEventListener('click', () => {
  likesRanking = {};
  saveToStorage('likesRanking', likesRanking);
  renderLikesRanking();
  ipcRenderer.send('update-likes-ranking', likesRanking);
  showToast('Ranking de Likes resetado!', 'success');
});

// Reset jar
document.getElementById('btn-reset-jar').addEventListener('click', () => {
  jarTotalCount = 0;
  const jarCountEl = document.getElementById('jar-total-count');
  if (jarCountEl) jarCountEl.textContent = '0';
  ipcRenderer.send('jar-reset');
  showToast('Cofrinho resetado!', 'success');
});

// Jar config (theme, custom color, capacity, visual)
function sendJarConfig() {
  const theme = document.getElementById('jar-theme-select')?.value || 'clean';
  const customColor = document.getElementById('jar-custom-color')?.value || '#1a1f2e';
  const capacity = parseInt(document.getElementById('jar-capacity-select')?.value || '1000', 10);
  const visual = document.getElementById('jar-visual-select')?.value || 'default';
  saveToStorage('jarTheme', theme);
  saveToStorage('jarCustomColor', customColor);
  saveToStorage('jarCapacity', capacity);
  saveToStorage('jarVisual', visual);
  ipcRenderer.send('jar-config', { theme, customColor, capacity, visual });
}

document.getElementById('jar-visual-select')?.addEventListener('change', () => {
  sendJarConfig();
  const v = document.getElementById('jar-visual-select').value;
  showToast(v === 'chest' ? 'Visual: Baú do Tesouro!' : 'Visual: Padrão!', 'success');
});
document.getElementById('jar-theme-select')?.addEventListener('change', () => {
  const theme = document.getElementById('jar-theme-select').value;
  const wrap = document.getElementById('jar-custom-color-wrap');
  if (wrap) wrap.style.display = theme === 'custom' ? '' : 'none';
  sendJarConfig();
  showToast('Tema do cofrinho atualizado!', 'success');
});
document.getElementById('jar-custom-color')?.addEventListener('input', () => {
  sendJarConfig();
});
document.getElementById('jar-capacity-select')?.addEventListener('change', () => {
  sendJarConfig();
  const cap = document.getElementById('jar-capacity-select').value;
  showToast('Capacidade do cofrinho: ' + Number(cap).toLocaleString('pt-BR') + ' presentes', 'success');
});

// Restore saved jar settings on startup
(function initJarSettings() {
  const savedTheme = loadFromStorage('jarTheme', 'clean');
  const savedColor = loadFromStorage('jarCustomColor', '#1a1f2e');
  const savedCapacity = loadFromStorage('jarCapacity', 1000);
  const savedVisual = loadFromStorage('jarVisual', 'default');
  const themeSel = document.getElementById('jar-theme-select');
  const colorEl = document.getElementById('jar-custom-color');
  const capSel = document.getElementById('jar-capacity-select');
  const visualSel = document.getElementById('jar-visual-select');
  if (themeSel) themeSel.value = savedTheme;
  if (colorEl) colorEl.value = savedColor;
  if (capSel) capSel.value = String(savedCapacity);
  if (visualSel) visualSel.value = savedVisual;
  const wrap = document.getElementById('jar-custom-color-wrap');
  if (wrap) wrap.style.display = savedTheme === 'custom' ? '' : 'none';
  // Push to relay so overlay receives current settings even before user changes anything
  ipcRenderer.send('jar-config', { theme: savedTheme, customColor: savedColor, capacity: savedCapacity, visual: savedVisual });
})();

// ============================================
// JAR TEST / PREVIEW
// ============================================
(function initJarTest() {
  const TEST_GIFTS = [
    { name: 'Rose', coins: 1 },
    { name: 'GG', coins: 1 },
    { name: 'Ice Cream Cone', coins: 1 },
    { name: 'TikTok', coins: 1 },
    { name: 'Finger Heart', coins: 5 },
    { name: 'Doughnut', coins: 30 },
    { name: 'Paper Crane', coins: 99 },
    { name: 'Little Crown', coins: 99 },
    { name: 'Cap', coins: 999 },
    { name: 'Garland', coins: 1000 },
    { name: 'Dragon Flame', coins: 10000 },
    { name: 'Lion', coins: 29999 },
    { name: 'TikTok Universe', coins: 44999 },
    { name: 'Rosa', coins: 1 },
    { name: 'Galaxy', coins: 1000 },
  ];

  const giftSel = document.getElementById('jar-test-gift');
  const coinsInput = document.getElementById('jar-test-coins');
  if (!giftSel) return;

  // Populate dropdown
  TEST_GIFTS.forEach(g => {
    const opt = document.createElement('option');
    opt.value = g.name;
    opt.dataset.coins = g.coins;
    opt.textContent = g.name + ' (' + g.coins + ' moedas)';
    giftSel.appendChild(opt);
  });

  // Auto-fill coins when gift changes
  giftSel.addEventListener('change', () => {
    const opt = giftSel.selectedOptions[0];
    if (opt && opt.dataset.coins) coinsInput.value = opt.dataset.coins;
  });

  // Send test gift
  document.getElementById('btn-jar-test')?.addEventListener('click', () => {
    const name = giftSel.value;
    const coins = parseInt(coinsInput.value, 10) || 1;
    const count = parseInt(document.getElementById('jar-test-count')?.value, 10) || 1;
    const image = getGiftImage(name);
    if (!image) return showToast('Presente não encontrado na lista', 'error');
    ipcRenderer.send('jar-gift', { giftImage: image, giftName: name, count, coins });
    jarTotalCount += count;
    const jarCountEl = document.getElementById('jar-total-count');
    if (jarCountEl) jarCountEl.textContent = jarTotalCount;
  });

  // Rain button - 20 random gifts
  document.getElementById('btn-jar-test-rain')?.addEventListener('click', () => {
    let sent = 0;
    const interval = setInterval(() => {
      if (sent >= 20) return clearInterval(interval);
      const g = TEST_GIFTS[Math.floor(Math.random() * TEST_GIFTS.length)];
      const image = getGiftImage(g.name);
      if (image) {
        ipcRenderer.send('jar-gift', { giftImage: image, giftName: g.name, count: 1, coins: g.coins });
        jarTotalCount++;
        const jarCountEl = document.getElementById('jar-total-count');
        if (jarCountEl) jarCountEl.textContent = jarTotalCount;
      }
      sent++;
    }, 200);
  });

  // Load jar overlay into preview iframe
  async function loadJarPreview() {
    try {
      const urls = await ipcRenderer.invoke('get-overlay-urls');
      const iframe = document.getElementById('jar-preview-iframe');
      if (urls.configured && urls.jar && iframe) {
        iframe.src = urls.jar;
      }
    } catch (e) {}
  }
  loadJarPreview();
})();

// ============================================
// GOALS SYSTEM (Metas)
// ============================================
function updateGoalProgress(type, amount) {
  if (type === 'pix') {
    // Pix is updated by livepix-update handler directly; just send to relay
    sendGoalToRelay('pix');
    return;
  }
  const goal = type === 'coins' ? goalCoins : goalLikes;
  goal.current += amount;

  // Check if goal reached + auto-double
  if (goal.current >= goal.target && goal.double) {
    goal.target *= 2;
  }

  saveToStorage(type === 'coins' ? 'goalCoins' : 'goalLikes', goal);
  renderGoalProgress(type);
  sendGoalToRelay(type);
}

function renderGoalProgress(type) {
  const goal = type === 'coins' ? goalCoins : goalLikes;
  const el = document.getElementById('goal-' + type + '-progress');
  if (el) el.textContent = goal.current.toLocaleString('pt-BR') + ' / ' + goal.target.toLocaleString('pt-BR');
}

function sendGoalToRelay(type) {
  const goal = type === 'coins' ? goalCoins : (type === 'pix' ? goalPix : goalLikes);
  ipcRenderer.send('goal-update', { type, text: goal.text, target: goal.target, current: goal.current, theme: goal.theme || 'neon', customColor: goal.customColor || '', style: goal.style || 'default' });
}

// Save coin goal
document.getElementById('btn-goal-coins-save')?.addEventListener('click', () => {
  goalCoins.text = document.getElementById('goal-coins-text').value.trim();
  goalCoins.target = parseInt(document.getElementById('goal-coins-target').value, 10) || 2000;
  goalCoins.double = document.getElementById('goal-coins-double').checked;
  goalCoins.style = document.getElementById('goal-coins-style')?.value || 'default';
  goalCoins.theme = document.getElementById('goal-coins-theme')?.value || 'neon';
  goalCoins.customColor = document.getElementById('goal-coins-custom-color')?.value || '#1a1f2e';
  saveToStorage('goalCoins', goalCoins);
  renderGoalProgress('coins');
  sendGoalToRelay('coins');
  showToast('Meta de moedas salva!', 'success');
});

// Save like goal
document.getElementById('btn-goal-likes-save')?.addEventListener('click', () => {
  goalLikes.text = document.getElementById('goal-likes-text').value.trim();
  goalLikes.target = parseInt(document.getElementById('goal-likes-target').value, 10) || 5000;
  goalLikes.double = document.getElementById('goal-likes-double').checked;
  goalLikes.style = document.getElementById('goal-likes-style')?.value || 'default';
  goalLikes.theme = document.getElementById('goal-likes-theme')?.value || 'neon';
  goalLikes.customColor = document.getElementById('goal-likes-custom-color')?.value || '#1a1f2e';
  saveToStorage('goalLikes', goalLikes);
  renderGoalProgress('likes');
  sendGoalToRelay('likes');
  showToast('Meta de likes salva!', 'success');
});

// Theme change → show/hide custom color
document.getElementById('goal-coins-theme')?.addEventListener('change', () => {
  const wrap = document.getElementById('goal-coins-custom-wrap');
  if (wrap) wrap.style.display = document.getElementById('goal-coins-theme').value === 'custom' ? '' : 'none';
});
document.getElementById('goal-likes-theme')?.addEventListener('change', () => {
  const wrap = document.getElementById('goal-likes-custom-wrap');
  if (wrap) wrap.style.display = document.getElementById('goal-likes-theme').value === 'custom' ? '' : 'none';
});

// Reset coin goal
document.getElementById('btn-goal-coins-reset')?.addEventListener('click', () => {
  goalCoins.current = 0;
  saveToStorage('goalCoins', goalCoins);
  renderGoalProgress('coins');
  sendGoalToRelay('coins');
  showToast('Meta de moedas resetada!', 'success');
});

// Reset like goal
document.getElementById('btn-goal-likes-reset')?.addEventListener('click', () => {
  goalLikes.current = 0;
  saveToStorage('goalLikes', goalLikes);
  renderGoalProgress('likes');
  sendGoalToRelay('likes');
  showToast('Meta de likes resetada!', 'success');
});

// Restore goal UI on startup
(function initGoals() {
  const ct = document.getElementById('goal-coins-text');
  const ctar = document.getElementById('goal-coins-target');
  const cd = document.getElementById('goal-coins-double');
  const csty = document.getElementById('goal-coins-style');
  const cth = document.getElementById('goal-coins-theme');
  const ccc = document.getElementById('goal-coins-custom-color');
  if (ct) ct.value = goalCoins.text;
  if (ctar) ctar.value = goalCoins.target;
  if (cd) cd.checked = goalCoins.double;
  if (csty) csty.value = goalCoins.style || 'default';
  if (cth) cth.value = goalCoins.theme || 'neon';
  if (ccc) ccc.value = goalCoins.customColor || '#1a1f2e';
  const ccw = document.getElementById('goal-coins-custom-wrap');
  if (ccw) ccw.style.display = (goalCoins.theme === 'custom') ? '' : 'none';
  renderGoalProgress('coins');

  const lt = document.getElementById('goal-likes-text');
  const ltar = document.getElementById('goal-likes-target');
  const ld = document.getElementById('goal-likes-double');
  const lsty = document.getElementById('goal-likes-style');
  const lth = document.getElementById('goal-likes-theme');
  const lcc = document.getElementById('goal-likes-custom-color');
  if (lt) lt.value = goalLikes.text;
  if (ltar) ltar.value = goalLikes.target;
  if (ld) ld.checked = goalLikes.double;
  if (lsty) lsty.value = goalLikes.style || 'default';
  if (lth) lth.value = goalLikes.theme || 'neon';
  if (lcc) lcc.value = goalLikes.customColor || '#1a1f2e';
  const lcw = document.getElementById('goal-likes-custom-wrap');
  if (lcw) lcw.style.display = (goalLikes.theme === 'custom') ? '' : 'none';
  renderGoalProgress('likes');

  // Push initial state to relay
  sendGoalToRelay('coins');
  sendGoalToRelay('likes');
})();

// ============================================
// TOP SCORE UI
// ============================================
(function initTopScore() {
  const el = (id) => document.getElementById(id);
  if (!el('ts-title')) return;

  // Restore saved values
  el('ts-title').value    = topScore.title    || '';
  el('ts-subtitle').value = topScore.subtitle || '';
  el('ts-desc').value     = topScore.desc     || '';
  el('ts-name').value     = topScore.name     || '';
  el('ts-avatar').value   = topScore.avatar   || '';
  el('ts-valor').value    = topScore.valor    || 0;

  // Send initial state to relay
  if (topScore.title || topScore.name) ipcRenderer.send('top-score-update', topScore);

  // Fetch TikTok user
  el('btn-ts-fetch').addEventListener('click', async () => {
    const username = el('ts-tiktok').value.trim();
    if (!username) return;
    const statusEl = el('ts-fetch-status');
    statusEl.textContent = '🔍 Buscando...';
    statusEl.style.color = 'var(--text-secondary)';
    try {
      const result = await ipcRenderer.invoke('fetch-tiktok-user', username);
      if (result.success) {
        el('ts-name').value   = result.nickname || '';
        el('ts-avatar').value = result.avatar   || '';
        statusEl.textContent = '✅ Encontrado: ' + (result.nickname || result.uniqueId);
        statusEl.style.color = '#4caf50';
      } else {
        statusEl.textContent = '❌ Usuário não encontrado ou offline. Preencha nome e foto manualmente.';
        statusEl.style.color = '#e74c3c';
      }
    } catch (e) {
      statusEl.textContent = '❌ Erro ao buscar. Preencha manualmente.';
      statusEl.style.color = '#e74c3c';
    }
  });

  // Save & send
  el('btn-ts-save').addEventListener('click', () => {
    topScore = {
      title:    el('ts-title').value.trim()    || 'TOP',
      subtitle: el('ts-subtitle').value.trim() || 'PONTUAÇÃO',
      desc:     el('ts-desc').value.trim(),
      name:     el('ts-name').value.trim(),
      avatar:   el('ts-avatar').value.trim(),
      valor:    parseInt(el('ts-valor').value) || 0,
    };
    saveToStorage('topScore', topScore);
    ipcRenderer.send('top-score-update', topScore);
    showToast('Top Pontuação salvo e enviado!', 'success');
  });
})();

(function initGoalPix() {
  const urlInput = document.getElementById('goal-pix-livepix-url');
  const textInput = document.getElementById('goal-pix-text');
  const targetInput = document.getElementById('goal-pix-target');
  const styleSelect = document.getElementById('goal-pix-style');
  const themeSelect = document.getElementById('goal-pix-theme');
  const customWrap = document.getElementById('goal-pix-custom-wrap');
  const customColor = document.getElementById('goal-pix-custom-color');
  const doubleCheck = document.getElementById('goal-pix-double');
  const progEl = document.getElementById('goal-pix-progress');

  // Restore saved state
  if (urlInput) urlInput.value = livepixUrl;
  if (textInput) textInput.value = goalPix.text;
  if (targetInput) targetInput.value = goalPix.target;
  if (styleSelect) styleSelect.value = goalPix.style || 'default';
  if (themeSelect) themeSelect.value = goalPix.theme || 'neon';
  if (customColor) customColor.value = goalPix.customColor || '#1a1f2e';
  if (doubleCheck) doubleCheck.checked = goalPix.double || false;
  if (progEl) progEl.textContent = 'R$ ' + (goalPix.current || 0).toLocaleString('pt-BR') + ' / R$ ' + goalPix.target.toLocaleString('pt-BR');

  if (themeSelect && customWrap) {
    themeSelect.addEventListener('change', () => {
      customWrap.style.display = themeSelect.value === 'custom' ? '' : 'none';
    });
    customWrap.style.display = (goalPix.theme === 'custom') ? '' : 'none';
  }

  // Connect button
  const btnConnect = document.getElementById('btn-goal-pix-connect');
  if (btnConnect) {
    btnConnect.addEventListener('click', () => {
      const url = urlInput ? urlInput.value.trim() : '';
      if (!url) { showToast('Cole o link do LivePix!', 'error'); return; }
      livepixUrl = url;
      saveToStorage('livepixUrl', livepixUrl);
      ipcRenderer.send('livepix-start-poll', { url });
    });
  }

  // Save button
  const btnSave = document.getElementById('btn-goal-pix-save');
  if (btnSave) {
    btnSave.addEventListener('click', () => {
      goalPix.text = textInput ? textInput.value.trim() : '';
      goalPix.target = Number(targetInput ? targetInput.value : 100) || 100;
      goalPix.style = styleSelect ? styleSelect.value : 'default';
      goalPix.theme = themeSelect ? themeSelect.value : 'neon';
      goalPix.customColor = customColor ? customColor.value : '#1a1f2e';
      goalPix.double = doubleCheck ? doubleCheck.checked : false;
      saveToStorage('goalPix', goalPix);
      if (progEl) progEl.textContent = 'R$ ' + (goalPix.current || 0).toLocaleString('pt-BR') + ' / R$ ' + goalPix.target.toLocaleString('pt-BR');
      ipcRenderer.send('goal-update', { type: 'pix', ...goalPix });
      showToast('Meta de PIX salva!', 'success');
    });
  }

  // Reset button
  const btnReset = document.getElementById('btn-goal-pix-reset');
  if (btnReset) {
    btnReset.addEventListener('click', () => {
      goalPix.current = 0;
      saveToStorage('goalPix', goalPix);
      if (progEl) progEl.textContent = 'R$ 0 / R$ ' + goalPix.target.toLocaleString('pt-BR');
      ipcRenderer.send('goal-update', { type: 'pix', ...goalPix });
      showToast('Meta de PIX resetada!', 'success');
    });
  }
})();

// ============================================
// MEMBROS UI
// ============================================
(function initTopPresentes() {
  // Restore display from saved state
  if (topGift) {
    const tgd = document.getElementById('tp-gift-display');
    const tgs = document.getElementById('tp-gift-sender');
    if (tgd) tgd.textContent = topGift.giftName + ' — 🪙' + topGift.diamonds.toLocaleString('pt-BR');
    if (tgs) tgs.textContent = 'por ' + topGift.nickname;
  }
  if (topCombo) {
    const tcd = document.getElementById('tp-combo-display');
    const tcs = document.getElementById('tp-combo-sender');
    if (tcd) tcd.textContent = topCombo.giftName + ' x' + topCombo.comboCount.toLocaleString('pt-BR');
    if (tcs) tcs.textContent = 'por ' + topCombo.nickname;
  }

  // Restore config inputs
  const tgLabel = document.getElementById('tg-label');
  const tgLabelColor = document.getElementById('tg-label-color');
  const tgNameColor = document.getElementById('tg-name-color');
  const tgValueColor = document.getElementById('tg-value-color');
  if (tgLabel) tgLabel.value = topGiftConfig.label;
  if (tgLabelColor) tgLabelColor.value = topGiftConfig.labelColor;
  if (tgNameColor) tgNameColor.value = topGiftConfig.nameColor;
  if (tgValueColor) tgValueColor.value = topGiftConfig.valueColor;

  const tcLabel = document.getElementById('tc-label');
  const tcLabelColor = document.getElementById('tc-label-color');
  const tcNameColor = document.getElementById('tc-name-color');
  const tcComboColor = document.getElementById('tc-combo-color');
  if (tcLabel) tcLabel.value = topComboConfig.label;
  if (tcLabelColor) tcLabelColor.value = topComboConfig.labelColor;
  if (tcNameColor) tcNameColor.value = topComboConfig.nameColor;
  if (tcComboColor) tcComboColor.value = topComboConfig.comboColor;

  // Save buttons
  const btnTgSave = document.getElementById('btn-tg-save');
  if (btnTgSave) {
    btnTgSave.addEventListener('click', () => {
      topGiftConfig = {
        label: (tgLabel ? tgLabel.value.trim() : '') || 'Maior Presente',
        labelColor: tgLabelColor ? tgLabelColor.value : '#ffffff',
        nameColor: tgNameColor ? tgNameColor.value : '#FFD700',
        valueColor: tgValueColor ? tgValueColor.value : '#ffffff'
      };
      saveToStorage('topGiftConfig', topGiftConfig);
      ipcRenderer.send('top-gift-config', topGiftConfig);
      showToast('Configuração do Maior Presente aplicada!', 'success');
    });
  }

  const btnTcSave = document.getElementById('btn-tc-save');
  if (btnTcSave) {
    btnTcSave.addEventListener('click', () => {
      topComboConfig = {
        label: (tcLabel ? tcLabel.value.trim() : '') || 'Maior Combo',
        labelColor: tcLabelColor ? tcLabelColor.value : '#ffffff',
        nameColor: tcNameColor ? tcNameColor.value : '#FFD700',
        comboColor: tcComboColor ? tcComboColor.value : '#ff6464'
      };
      saveToStorage('topComboConfig', topComboConfig);
      ipcRenderer.send('top-combo-config', topComboConfig);
      showToast('Configuração do Maior Combo aplicada!', 'success');
    });
  }

  const btnTgReset = document.getElementById('btn-tg-reset');
  if (btnTgReset) {
    btnTgReset.addEventListener('click', () => {
      topGift = null;
      saveToStorage('topGift', null);
      ipcRenderer.send('top-gift-reset');
      const tgd = document.getElementById('tp-gift-display');
      const tgs = document.getElementById('tp-gift-sender');
      if (tgd) tgd.textContent = '—';
      if (tgs) tgs.textContent = 'Aguardando...';
      showToast('Maior Presente resetado!', 'success');
    });
  }

  const btnTcReset = document.getElementById('btn-tc-reset');
  if (btnTcReset) {
    btnTcReset.addEventListener('click', () => {
      topCombo = null;
      saveToStorage('topCombo', null);
      ipcRenderer.send('top-combo-reset');
      const tcd = document.getElementById('tp-combo-display');
      const tcs = document.getElementById('tp-combo-sender');
      if (tcd) tcd.textContent = '—';
      if (tcs) tcs.textContent = 'Aguardando...';
      showToast('Maior Combo resetado!', 'success');
    });
  }
})();

(function initMembros() {
  const titleInput = document.getElementById('membros-title-input');
  const countEl = document.getElementById('membros-count');
  if (titleInput) titleInput.value = membrosTitle;
  if (countEl) countEl.textContent = membrosMembers.length;

  // Members are re-sent when relay connects (see relay-status handler below)

  const btnSave = document.getElementById('btn-membros-save');
  if (btnSave) {
    btnSave.addEventListener('click', () => {
      const title = (titleInput ? titleInput.value.trim() : '') || 'Membros';
      membrosTitle = title;
      saveToStorage('membrosTitle', membrosTitle);
      ipcRenderer.send('membros-title', { title });
      showToast('Título de membros salvo!', 'success');
    });
  }

  const btnReset = document.getElementById('btn-membros-reset');
  if (btnReset) {
    btnReset.addEventListener('click', () => {
      membrosMembers = [];
      saveToStorage('membrosMembers', membrosMembers);
      ipcRenderer.send('membros-reset');
      if (countEl) countEl.textContent = '0';
      showToast('Lista de membros limpa!', 'success');
    });
  }

  // Adicionar membro manualmente
  const manualInput = document.getElementById('membros-manual-input');
  const btnAddManual = document.getElementById('btn-membros-add-manual');
  const manualStatus = document.getElementById('membros-manual-status');

  async function addMemberManual() {
    const raw = (manualInput ? manualInput.value : '').trim();
    if (!raw) return;
    const username = raw.replace(/^@/, '');

    if (manualStatus) { manualStatus.style.color = '#aaa'; manualStatus.textContent = '🔍 Buscando perfil...'; }
    if (btnAddManual) btnAddManual.disabled = true;

    try {
      const result = await ipcRenderer.invoke('fetch-tiktok-profile', username);

      // Usa userId como username (unique por conta do TikTok)
      const userId = result.ok ? result.userId : username;
      const nickname = result.ok ? result.nickname : username;
      const profilePictureUrl = result.ok ? result.profilePictureUrl : '';

      const alreadyMember = membrosMembers.find(m => m.userId === userId);
      if (alreadyMember) {
        if (manualStatus) { manualStatus.style.color = '#f59e0b'; manualStatus.textContent = '⚠️ Este usuário já está na lista!'; }
        if (btnAddManual) btnAddManual.disabled = false;
        return;
      }

      membrosMembers.push({ userId, nickname, profilePictureUrl });
      saveToStorage('membrosMembers', membrosMembers);
      ipcRenderer.send('membros-add', { userId, nickname, profilePictureUrl });
      if (countEl) countEl.textContent = membrosMembers.length;
      if (manualInput) manualInput.value = '';

      if (!result.ok) {
        if (manualStatus) { manualStatus.style.color = '#f59e0b'; manualStatus.textContent = `✅ @${username} adicionado (sem foto — TikTok bloqueou a busca).`; }
      } else {
        if (manualStatus) { manualStatus.style.color = '#22c55e'; manualStatus.textContent = `✅ ${nickname} adicionado com sucesso!`; }
      }
      showToast(`✅ ${nickname} adicionado aos membros!`, 'success');
    } catch (e) {
      if (manualStatus) { manualStatus.style.color = '#ef4444'; manualStatus.textContent = '❌ Erro ao buscar perfil. Verifique o nome de usuário.'; }
    }

    if (btnAddManual) btnAddManual.disabled = false;
  }

  if (btnAddManual) btnAddManual.addEventListener('click', addMemberManual);
  if (manualInput) manualInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addMemberManual(); });
})();

// ============================================
// MEMBROS AÇÃO
// ============================================
(function initMembrosAcao() {
  const giftSelect       = document.getElementById('membros-acao-gift-select');
  const titleInput       = document.getElementById('membros-acao-title-input');
  const subTextInput     = document.getElementById('membros-acao-subtext');
  const subTextSizeInput  = document.getElementById('membros-acao-subtext-size');
  const subValSizeInput   = document.getElementById('membros-acao-subvalue-size');
  const subTextColorInput = document.getElementById('membros-acao-subtext-color');
  const subValColorInput  = document.getElementById('membros-acao-subvalue-color');
  const acaoManualValInput = document.getElementById('membros-acao-manual-value');
  const countEl          = document.getElementById('membros-acao-count');
  const btnSave          = document.getElementById('btn-membros-acao-save');
  const btnReset         = document.getElementById('btn-membros-acao-reset');

  if (titleInput)       titleInput.value       = membrosAcaoConfig.title        || 'Membros Ação';
  if (subTextInput)     subTextInput.value     = membrosAcaoConfig.subText       || '';
  if (subTextSizeInput)  subTextSizeInput.value  = membrosAcaoConfig.subTextSize   || 9;
  if (subValSizeInput)   subValSizeInput.value   = membrosAcaoConfig.subValueSize  || 9;
  if (subTextColorInput) subTextColorInput.value = membrosAcaoConfig.subTextColor  || '#ffdc50';
  if (subValColorInput)  subValColorInput.value  = membrosAcaoConfig.subValueColor || '#ffdc50';
  if (countEl)          countEl.textContent    = membrosAcaoMembers.length;

  // Populate gift list from TIKTOK_GIFTS
  if (giftSelect) {
    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = '🚫 Nenhum presente (somente manual)';
    if (!membrosAcaoConfig.giftName) noneOpt.selected = true;
    giftSelect.appendChild(noneOpt);

    TIKTOK_GIFTS.forEach(g => {
      const opt = document.createElement('option');
      opt.value = g.name;
      opt.textContent = g.name;
      if (g.name === membrosAcaoConfig.giftName) opt.selected = true;
      giftSelect.appendChild(opt);
    });
  }

  function sendConfig() {
    const giftName  = giftSelect  ? giftSelect.value        : membrosAcaoConfig.giftName;
    const giftObj   = TIKTOK_GIFTS.find(g => g.name === giftName);
    const giftImage = giftObj ? giftObj.image : '';
    membrosAcaoConfig = {
      title:        titleInput       ? titleInput.value.trim()          || 'Membros Ação' : membrosAcaoConfig.title,
      giftName,
      giftImage,
      subText:      subTextInput     ? subTextInput.value.trim()        : membrosAcaoConfig.subText,
      subTextSize:  subTextSizeInput ? Number(subTextSizeInput.value)  || 9          : membrosAcaoConfig.subTextSize,
      subValueSize: subValSizeInput  ? Number(subValSizeInput.value)   || 9          : membrosAcaoConfig.subValueSize,
      subTextColor: subTextColorInput ? subTextColorInput.value || '#ffdc50'         : membrosAcaoConfig.subTextColor,
      subValueColor:subValColorInput  ? subValColorInput.value  || '#ffdc50'         : membrosAcaoConfig.subValueColor
    };
    saveToStorage('membrosAcaoConfig', membrosAcaoConfig);
    ipcRenderer.send('membros-acao-config', membrosAcaoConfig);
  }

  if (btnSave) btnSave.addEventListener('click', () => { sendConfig(); showToast('Membros Ação salvo!', 'success'); });

  if (btnReset) btnReset.addEventListener('click', () => {
    if (!confirm('Limpar todos os membros ação?')) return;
    membrosAcaoMembers = [];
    saveToStorage('membrosAcaoMembers', membrosAcaoMembers);
    ipcRenderer.send('membros-acao-reset');
    if (countEl) countEl.textContent = '0';
    showToast('Membros Ação limpos!', 'success');
  });

  // Adicionar membro ação manualmente
  const acaoManualInput  = document.getElementById('membros-acao-manual-input');
  const btnAcaoManual    = document.getElementById('btn-membros-acao-add-manual');
  const acaoManualStatus = document.getElementById('membros-acao-manual-status');

  async function addMembrosAcaoManual() {
    const raw = (acaoManualInput ? acaoManualInput.value : '').trim();
    if (!raw) return;
    const username = raw.replace(/^@/, '');
    const valueToAdd = acaoManualValInput ? (parseFloat(acaoManualValInput.value) || 0) : 0;

    if (acaoManualStatus) { acaoManualStatus.style.color = '#aaa'; acaoManualStatus.textContent = '🔍 Buscando perfil...'; }
    if (btnAcaoManual) btnAcaoManual.disabled = true;

    try {
      const result = await ipcRenderer.invoke('fetch-tiktok-profile', username);

      const userId            = result.ok ? result.userId            : username;
      const nickname          = result.ok ? result.nickname          : username;
      const profilePictureUrl = result.ok ? result.profilePictureUrl : '';

      const existing = membrosAcaoMembers.find(m => m.userId === userId);

      if (existing) {
        // Soma o valor ao existente
        existing.value = (existing.value || 0) + valueToAdd;
        existing.nickname = nickname || existing.nickname;
        existing.profilePictureUrl = profilePictureUrl || existing.profilePictureUrl;
        saveToStorage('membrosAcaoMembers', membrosAcaoMembers);
        ipcRenderer.send('membros-acao-add', { userId, nickname, profilePictureUrl, value: valueToAdd });
        if (acaoManualInput) acaoManualInput.value = '';
        if (acaoManualValInput) acaoManualValInput.value = '';
        if (acaoManualStatus) { acaoManualStatus.style.color = '#22c55e'; acaoManualStatus.textContent = `✅ ${nickname} atualizado! Total: ${existing.value}`; }
        showToast(`✅ ${nickname} atualizado! Total: ${existing.value}`, 'success');
      } else {
        // Novo membro
        membrosAcaoMembers.push({ userId, nickname, profilePictureUrl, value: valueToAdd });
        saveToStorage('membrosAcaoMembers', membrosAcaoMembers);
        ipcRenderer.send('membros-acao-add', { userId, nickname, profilePictureUrl, value: valueToAdd });
        if (countEl) countEl.textContent = membrosAcaoMembers.length;
        if (acaoManualInput) acaoManualInput.value = '';
        if (acaoManualValInput) acaoManualValInput.value = '';

        if (!result.ok) {
          if (acaoManualStatus) { acaoManualStatus.style.color = '#f59e0b'; acaoManualStatus.textContent = `✅ @${username} adicionado (sem foto — TikTok bloqueou a busca).`; }
        } else {
          if (acaoManualStatus) { acaoManualStatus.style.color = '#22c55e'; acaoManualStatus.textContent = `✅ ${nickname} adicionado com sucesso!`; }
        }
        showToast(`✅ ${nickname} adicionado aos Membros Ação!`, 'success');
      }
    } catch (e) {
      // First attempt failed — retry once automatically before giving up
      if (acaoManualStatus) { acaoManualStatus.style.color = '#aaa'; acaoManualStatus.textContent = '🔄 Tentando novamente...'; }
      try {
        await new Promise(r => setTimeout(r, 1200));
        const result2 = await ipcRenderer.invoke('fetch-tiktok-profile', username);
        const userId            = result2.ok ? result2.userId            : null;
        const nickname          = result2.ok ? result2.nickname          : null;
        const profilePictureUrl = result2.ok ? result2.profilePictureUrl : '';
        if (!result2.ok || !userId) throw new Error('no profile');
        const existing = membrosAcaoMembers.find(m => m.userId === userId);
        if (existing) {
          existing.value = (existing.value || 0) + valueToAdd;
          existing.nickname = nickname || existing.nickname;
          existing.profilePictureUrl = profilePictureUrl || existing.profilePictureUrl;
          saveToStorage('membrosAcaoMembers', membrosAcaoMembers);
          ipcRenderer.send('membros-acao-add', { userId, nickname, profilePictureUrl, value: valueToAdd });
          if (acaoManualInput) acaoManualInput.value = '';
          if (acaoManualValInput) acaoManualValInput.value = '';
          if (acaoManualStatus) { acaoManualStatus.style.color = '#22c55e'; acaoManualStatus.textContent = `✅ ${nickname} atualizado! Total: ${existing.value}`; }
          showToast(`✅ ${nickname} atualizado!`, 'success');
        } else {
          membrosAcaoMembers.push({ userId, nickname, profilePictureUrl, value: valueToAdd });
          saveToStorage('membrosAcaoMembers', membrosAcaoMembers);
          ipcRenderer.send('membros-acao-add', { userId, nickname, profilePictureUrl, value: valueToAdd });
          if (countEl) countEl.textContent = membrosAcaoMembers.length;
          if (acaoManualInput) acaoManualInput.value = '';
          if (acaoManualValInput) acaoManualValInput.value = '';
          if (acaoManualStatus) { acaoManualStatus.style.color = '#22c55e'; acaoManualStatus.textContent = `✅ ${nickname} adicionado com sucesso!`; }
          showToast(`✅ ${nickname} adicionado aos Membros Ação!`, 'success');
        }
      } catch (e2) {
        if (acaoManualStatus) { acaoManualStatus.style.color = '#ef4444'; acaoManualStatus.textContent = '❌ Não foi possível buscar o perfil. Tente novamente.'; }
      }
    }

    if (btnAcaoManual) btnAcaoManual.disabled = false;
  }

  if (btnAcaoManual) btnAcaoManual.addEventListener('click', addMembrosAcaoManual);
  if (acaoManualInput) acaoManualInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addMembrosAcaoManual(); });
})();

// ============================================
// SCOREBOARD
// ============================================
const btnScoreboardToggle = document.getElementById('btn-scoreboard-toggle');

function updateScoreboardToggleBtn() {
  btnScoreboardToggle.textContent = scoreboardEnabled ? 'Desativar Atalhos' : 'Ativar Atalhos';
  btnScoreboardToggle.classList.toggle('active', scoreboardEnabled);
}
updateScoreboardToggleBtn();

// Send initial toggle state
ipcRenderer.send('scoreboard-toggle', scoreboardEnabled);

btnScoreboardToggle.addEventListener('click', () => {
  scoreboardEnabled = !scoreboardEnabled;
  saveToStorage('scoreboardEnabled', scoreboardEnabled);
  ipcRenderer.send('scoreboard-toggle', scoreboardEnabled);
  updateScoreboardToggleBtn();
  showToast(scoreboardEnabled ? 'Atalhos do placar ativados! (Alt+1/2/3/4)' : 'Atalhos do placar desativados', scoreboardEnabled ? 'success' : 'info');
});

// Scoreboard theme - show/hide custom color
document.getElementById('sb-theme-select')?.addEventListener('change', () => {
  const wrap = document.getElementById('sb-custom-color-wrap');
  if (wrap) wrap.style.display = document.getElementById('sb-theme-select').value === 'custom' ? '' : 'none';
});

document.getElementById('btn-scoreboard-save').addEventListener('click', () => {
  const leftName = document.getElementById('sb-left-name-input').value.trim() || 'Streamer';
  const rightName = document.getElementById('sb-right-name-input').value.trim() || 'Chat';
  const theme = document.getElementById('sb-theme-select').value;
  const customColor = document.getElementById('sb-custom-color')?.value || '#1a1f2e';
  const style = document.getElementById('sb-style-select')?.value || 'default';
  ipcRenderer.send('scoreboard-update', { leftName, rightName, theme, customColor, style });
  document.getElementById('sb-preview-left-name').textContent = leftName;
  document.getElementById('sb-preview-right-name').textContent = rightName;
  showToast('Configuração do placar salva!', 'success');
});

document.getElementById('btn-scoreboard-reset').addEventListener('click', () => {
  ipcRenderer.send('scoreboard-update', { left: 0, right: 0 });
  document.getElementById('sb-preview-left').textContent = '0';
  document.getElementById('sb-preview-right').textContent = '0';
  showToast('Placar resetado!', 'success');
});

// Listen for state updates from main (when shortcuts are used)
ipcRenderer.on('scoreboard-state', (event, state) => {
  document.getElementById('sb-preview-left').textContent = state.left;
  document.getElementById('sb-preview-right').textContent = state.right;
  if (state.leftName) document.getElementById('sb-preview-left-name').textContent = state.leftName;
  if (state.rightName) document.getElementById('sb-preview-right-name').textContent = state.rightName;
});

// ============================================
// TIMER SYSTEM
// ============================================
function updateTimerDisplay() {
  const h = Math.floor(timerSeconds / 3600);
  const m = Math.floor((timerSeconds % 3600) / 60);
  const s = timerSeconds % 60;
  const display = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  const timerEl = document.getElementById('timer-display');
  if (timerEl) timerEl.textContent = display;
  // Send to relay
  ipcRenderer.send('timer-update', { seconds: timerSeconds, running: timerRunning, theme: timerTheme });
}

function startTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerRunning = true;
  const btn = document.getElementById('btn-timer-toggle');
  if (btn) { btn.textContent = '⏸ Pausar'; btn.classList.add('active'); }
  timerInterval = setInterval(() => {
    if (timerSeconds > 0) {
      timerSeconds--;
      updateTimerDisplay();
    } else {
      stopTimer();
    }
  }, 1000);
  updateTimerDisplay();
}

function stopTimer() {
  timerRunning = false;
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  const btn = document.getElementById('btn-timer-toggle');
  if (btn) { btn.textContent = '▶ Iniciar'; btn.classList.remove('active'); }
  updateTimerDisplay();
}

function addTimerSeconds(secs) {
  timerSeconds += secs;
  if (timerSeconds < 0) timerSeconds = 0;
  updateTimerDisplay();
  showToast(`⏱️ +${secs}s adicionados ao cronômetro`, 'info');
}

function saveTimerConfig() {
  localStorage.setItem('timerConfig', JSON.stringify({
    seconds: timerSeconds,
    coinsRatio: timerCoinsRatio,
    theme: timerTheme,
    livePixUrl: timerLivePixUrl
  }));
}

// Timer controls
document.getElementById('btn-timer-toggle')?.addEventListener('click', () => {
  if (timerRunning) stopTimer(); else startTimer();
});

document.getElementById('btn-timer-reset')?.addEventListener('click', () => {
  timerSeconds = 0;
  stopTimer();
  updateTimerDisplay();
});

document.getElementById('btn-timer-set')?.addEventListener('click', () => {
  const h = parseInt(document.getElementById('timer-hours').value) || 0;
  const m = parseInt(document.getElementById('timer-minutes').value) || 0;
  const s = parseInt(document.getElementById('timer-seconds').value) || 0;
  timerSeconds = h * 3600 + m * 60 + s;
  updateTimerDisplay();
  showToast('⏱️ Tempo definido', 'info');
});

document.getElementById('btn-timer-add-time')?.addEventListener('click', () => {
  const h = parseInt(document.getElementById('timer-hours').value) || 0;
  const m = parseInt(document.getElementById('timer-minutes').value) || 0;
  const s = parseInt(document.getElementById('timer-seconds').value) || 0;
  const total = h * 3600 + m * 60 + s;
  if (total > 0) addTimerSeconds(total);
});

// Timer theme change - show/hide custom color
document.getElementById('timer-theme-select')?.addEventListener('change', () => {
  const wrap = document.getElementById('timer-custom-color-wrap');
  if (wrap) wrap.style.display = document.getElementById('timer-theme-select').value === 'custom' ? '' : 'none';
});

document.getElementById('btn-timer-save-config')?.addEventListener('click', () => {
  timerCoinsRatio = parseInt(document.getElementById('timer-coins-ratio').value) || 1;
  timerTheme = document.getElementById('timer-theme-select').value;
  timerLivePixUrl = document.getElementById('timer-livepix-url').value.trim();
  const timerCustomColor = document.getElementById('timer-custom-color')?.value || '#1a1f2e';
  saveTimerConfig();
  ipcRenderer.send('timer-config', { theme: timerTheme, customColor: timerCustomColor });
  showToast('💾 Configurações do cronômetro salvas', 'success');
});


document.getElementById('btn-timer-livepix-connect')?.addEventListener('click', () => {
  const url = document.getElementById('timer-livepix-url').value.trim();
  if (!url) return;
  timerLivePixUrl = url;
  ipcRenderer.send('timer-connect-external', { source: 'livepix', url });
  document.getElementById('livepix-status').textContent = 'Conectando...';
  document.getElementById('livepix-status').style.color = '#ffd700';
});

// Timer IPC listeners
ipcRenderer.on('timer-external-status', (event, data) => {
  if (data.source === 'livepix') {
    const el = document.getElementById('livepix-status');
    if (el) {
      el.textContent = data.connected ? 'Conectado ✓' : ('Erro: ' + (data.error || 'Desconectado'));
      el.style.color = data.connected ? '#2ecc71' : '#e74c3c';
    }
  }
});

ipcRenderer.on('timer-external-add', (event, data) => {
  if (data.seconds > 0) {
    timerSeconds += data.seconds;
    updateTimerDisplay();
    showToast(`⏱️ +${data.seconds}s (${data.source})`, 'info');
  }
});

// Coins config
let coinsTheme = loadFromStorage('coinsTheme', 'clean');
let coinsCustomColor = loadFromStorage('coinsCustomColor', '#1a1f2e');
const coinsThemeSelect = document.getElementById('coins-theme-select');
const coinsSideSelect = document.getElementById('coins-side-select');
const coinsCustomColorWrap = document.getElementById('coins-custom-color-wrap');
const coinsCustomColorInput = document.getElementById('coins-custom-color');
coinsThemeSelect.value = coinsTheme;
coinsSideSelect.value = coinsSide;
if (coinsCustomColorInput) coinsCustomColorInput.value = coinsCustomColor;
if (coinsTheme === 'custom' && coinsCustomColorWrap) coinsCustomColorWrap.style.display = '';

function sendCoinsConfig() {
  const bg = coinsTheme === 'custom' ? coinsCustomColor : 'transparent';
  ipcRenderer.send('update-ranking-config', { ranking: 'coins', bg, side: coinsSide, theme: coinsTheme, customColor: coinsCustomColor });
}
coinsThemeSelect.addEventListener('change', () => {
  coinsTheme = coinsThemeSelect.value;
  saveToStorage('coinsTheme', coinsTheme);
  if (coinsCustomColorWrap) coinsCustomColorWrap.style.display = coinsTheme === 'custom' ? '' : 'none';
  sendCoinsConfig();
  showToast('Tema de moedas atualizado!', 'success');
});
coinsSideSelect.addEventListener('change', () => {
  coinsSide = coinsSideSelect.value;
  saveToStorage('coinsSide', coinsSide);
  sendCoinsConfig();
  showToast('Lado de moedas atualizado!', 'success');
});
if (coinsCustomColorInput) coinsCustomColorInput.addEventListener('input', () => {
  coinsCustomColor = coinsCustomColorInput.value;
  saveToStorage('coinsCustomColor', coinsCustomColor);
  sendCoinsConfig();
});

// Likes config
let likesTheme = loadFromStorage('likesTheme', 'clean');
let likesCustomColor = loadFromStorage('likesCustomColor', '#1a1f2e');
const likesThemeSelect = document.getElementById('likes-theme-select');
const likesSideSelect = document.getElementById('likes-side-select');
const likesCustomColorWrap = document.getElementById('likes-custom-color-wrap');
const likesCustomColorInput = document.getElementById('likes-custom-color');
likesThemeSelect.value = likesTheme;
likesSideSelect.value = likesSide;
if (likesCustomColorInput) likesCustomColorInput.value = likesCustomColor;
if (likesTheme === 'custom' && likesCustomColorWrap) likesCustomColorWrap.style.display = '';

function sendLikesConfig() {
  const bg = likesTheme === 'custom' ? likesCustomColor : 'transparent';
  ipcRenderer.send('update-ranking-config', { ranking: 'likes', bg, side: likesSide, theme: likesTheme, customColor: likesCustomColor });
}
likesThemeSelect.addEventListener('change', () => {
  likesTheme = likesThemeSelect.value;
  saveToStorage('likesTheme', likesTheme);
  if (likesCustomColorWrap) likesCustomColorWrap.style.display = likesTheme === 'custom' ? '' : 'none';
  sendLikesConfig();
  showToast('Tema de likes atualizado!', 'success');
});
likesSideSelect.addEventListener('change', () => {
  likesSide = likesSideSelect.value;
  saveToStorage('likesSide', likesSide);
  sendLikesConfig();
  showToast('Lado de likes atualizado!', 'success');
});
if (likesCustomColorInput) likesCustomColorInput.addEventListener('input', () => {
  likesCustomColor = likesCustomColorInput.value;
  saveToStorage('likesCustomColor', likesCustomColor);
  sendLikesConfig();
});

// Points config
function sendPointsConfig() {
  ipcRenderer.send('update-points-config', pointsConfig);
}

const pointsThemeSelect = document.getElementById('points-theme-select');
const pointsSideSelect = document.getElementById('points-side-select');
const pointsCustomColorWrap = document.getElementById('points-custom-color-wrap');
const pointsCustomColorInput = document.getElementById('points-custom-color');
const pointsLabelInput = document.getElementById('points-label-input');
const pointsValueColorInput = document.getElementById('points-value-color');
const pointsLabelColorInput = document.getElementById('points-label-color');
const pointsNameColorInput = document.getElementById('points-name-color');
const pointsPerCoinInput = document.getElementById('points-per-coin');

if (pointsThemeSelect) {
  pointsThemeSelect.value = pointsConfig.theme || 'clean';
  pointsThemeSelect.addEventListener('change', () => {
    pointsConfig.theme = pointsThemeSelect.value;
    saveToStorage('pointsConfig', pointsConfig);
    if (pointsCustomColorWrap) pointsCustomColorWrap.style.display = pointsConfig.theme === 'custom' ? '' : 'none';
    sendPointsConfig();
    showToast('Tema de pontos atualizado!', 'success');
  });
}
if (pointsSideSelect) {
  pointsSideSelect.value = pointsConfig.side || 'left';
  pointsSideSelect.addEventListener('change', () => {
    pointsConfig.side = pointsSideSelect.value;
    saveToStorage('pointsConfig', pointsConfig);
    sendPointsConfig();
    showToast('Lado de pontos atualizado!', 'success');
  });
}
if (pointsCustomColorInput) {
  pointsCustomColorInput.value = pointsConfig.customColor || '#1a1f2e';
  pointsCustomColorInput.addEventListener('input', () => {
    pointsConfig.customColor = pointsCustomColorInput.value;
    saveToStorage('pointsConfig', pointsConfig);
    sendPointsConfig();
  });
}
if (pointsLabelInput) {
  pointsLabelInput.value = pointsConfig.label || 'points';
  pointsLabelInput.addEventListener('input', () => {
    pointsConfig.label = pointsLabelInput.value || 'points';
    saveToStorage('pointsConfig', pointsConfig);
    saveToStorage('pointsConfig', pointsConfig);
    sendPointsConfig();
    renderPointsRanking();
  });
}
if (pointsValueColorInput) {
  pointsValueColorInput.value = pointsConfig.valueColor || '#f1c40f';
  pointsValueColorInput.addEventListener('input', () => {
    pointsConfig.valueColor = pointsValueColorInput.value;
    saveToStorage('pointsConfig', pointsConfig);
    sendPointsConfig();
  });
}
if (pointsLabelColorInput) {
  pointsLabelColorInput.value = pointsConfig.labelColor || '#aaaaaa';
  pointsLabelColorInput.addEventListener('input', () => {
    pointsConfig.labelColor = pointsLabelColorInput.value;
    saveToStorage('pointsConfig', pointsConfig);
    sendPointsConfig();
  });
}
if (pointsNameColorInput) {
  pointsNameColorInput.value = pointsConfig.nameColor || '#ffffff';
  pointsNameColorInput.addEventListener('input', () => {
    pointsConfig.nameColor = pointsNameColorInput.value;
    saveToStorage('pointsConfig', pointsConfig);
    sendPointsConfig();
  });
}
if (pointsPerCoinInput) {
  pointsPerCoinInput.value = pointsPerCoin;
  pointsPerCoinInput.addEventListener('change', () => {
    pointsPerCoin = parseFloat(pointsPerCoinInput.value) || 1;
    saveToStorage('pointsPerCoin', pointsPerCoin);
    showToast('Pontos por moeda: ' + pointsPerCoin, 'success');
  });
}

const btnResetPoints = document.getElementById('btn-reset-points');
if (btnResetPoints) {
  btnResetPoints.addEventListener('click', () => {
    if (!confirm('Resetar o ranking de pontos? Esta ação não pode ser desfeita.')) return;
    pointsRanking = {};
    saveToStorage('pointsRanking', pointsRanking);
    renderPointsRanking();
    ipcRenderer.send('update-points-ranking', pointsRanking);
    showToast('Ranking de pontos resetado!', 'success');
  });
}

renderPointsRanking();

// ============================================
// MODALS CLOSE
// ============================================
document.querySelectorAll('[data-close]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.getElementById(btn.dataset.close).style.display = 'none';
  });
});

document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.style.display = 'none';
  });
});

// ============================================
// COPY LINK
// ============================================
function copyLink(inputId) {
  const input = document.getElementById(inputId);
  input.select();
  navigator.clipboard.writeText(input.value).then(() => {
    showToast('Link copiado!', 'success');
  });
}

// ============================================
// RELAY SERVER CONNECTION (auto-connect)
// ============================================
const relayStatusDot = document.getElementById('relay-status-dot');
const relayStatusText = document.getElementById('relay-status-text');

// LivePix update handler
ipcRenderer.on('livepix-update', (event, { total }) => {
  if (total !== goalPix.current) {
    goalPix.current = total;
    saveToStorage('goalPix', goalPix);
    updateGoalProgress('pix', 0); // trigger re-render with current value
    const progEl = document.getElementById('goal-pix-progress');
    if (progEl) progEl.textContent = 'R$ ' + total.toLocaleString('pt-BR') + ' / R$ ' + goalPix.target.toLocaleString('pt-BR');
    ipcRenderer.send('goal-update', { type: 'pix', ...goalPix });
  }
});

ipcRenderer.on('livepix-status', (event, data) => {
  const statusEl = document.getElementById('goal-pix-livepix-status');
  if (!statusEl) return;
  if (data.error) {
    statusEl.style.color = '#ef4444';
    statusEl.textContent = '❌ ' + data.error;
  } else if (data.warning) {
    statusEl.style.color = '#f59e0b';
    statusEl.textContent = '⚠️ ' + data.warning;
  } else if (data.ok) {
    statusEl.style.color = '#22c55e';
    statusEl.textContent = '✅ Conectado a @' + data.username + ' — atualizando a cada 30s';
  }
});

ipcRenderer.on('relay-status', (event, data) => {
  if (data.connected) {
    relayStatusDot.classList.add('connected');
    relayStatusText.textContent = 'Servidor conectado';
    loadOverlayLinks();
    // Send current ranking configs to relay
    sendCoinsConfig();
    sendLikesConfig();
    // Re-send persistent rankings to relay after reconnection
    if (Object.keys(coinsRanking).length > 0) {
      ipcRenderer.send('update-coins-ranking', coinsRanking);
    }
    if (Object.keys(likesRanking).length > 0) {
      ipcRenderer.send('update-likes-ranking', likesRanking);
    }
    if (Object.keys(pointsRanking).length > 0) {
      ipcRenderer.send('update-points-ranking', pointsRanking);
    }
    ipcRenderer.send('update-points-config', pointsConfig);
    // Re-send Membros Ação — reset first so accumulated totals don't get double-added on reconnect
    ipcRenderer.send('membros-acao-config', membrosAcaoConfig);
    ipcRenderer.send('membros-acao-reset');
    membrosAcaoMembers.forEach(m => ipcRenderer.send('membros-acao-add', m));
    // Re-send persistent membros state after relay reconnects
    if (membrosMembers.length > 0) {
      ipcRenderer.send('membros-title', { title: membrosTitle });
      membrosMembers.forEach(m => ipcRenderer.send('membros-add', m));
    }
    // Re-send top score state after relay reconnects
    if (topScore && (topScore.title || topScore.name)) {
      ipcRenderer.send('top-score-update', topScore);
    }
    // Re-send pix goal after relay reconnects
    ipcRenderer.send('goal-update', { type: 'pix', ...goalPix });
    if (livepixUrl) ipcRenderer.send('livepix-start-poll', { url: livepixUrl });
    // Re-send top presentes after relay reconnects
    ipcRenderer.send('top-gift-config', topGiftConfig);
    ipcRenderer.send('top-combo-config', topComboConfig);
    if (topGift) ipcRenderer.send('top-gift-update', topGift);
    if (topCombo) ipcRenderer.send('top-combo-update', topCombo);
  } else {
    relayStatusDot.classList.remove('connected');
    relayStatusText.textContent = data.error ? 'Erro: ' + data.error : 'Reconectando...';
  }
});

// ============================================
// OVERLAY LINKS
// ============================================
async function loadOverlayLinks() {
  try {
    const urls = await ipcRenderer.invoke('get-overlay-urls');
    if (urls.configured) {
      document.getElementById('link-edits1').value = urls.edits1;
      document.getElementById('link-edits2').value = urls.edits2;
      document.getElementById('link-edits3').value = urls.edits3;
      document.getElementById('link-coins').value = urls.coinsRanking;
      document.getElementById('link-likes').value = urls.likesRanking;
      const ptLink = document.getElementById('link-points');
      if (ptLink) ptLink.value = urls.pointsRanking || 'Não disponível';
      const maLink = document.getElementById('link-membros-acao');
      if (maLink) maLink.value = urls.membrosAcao || 'Não disponível';
      document.getElementById('link-jar').value = urls.jar;
      document.getElementById('link-scoreboard').value = urls.scoreboard;
      const timerLink = document.getElementById('link-timer');
      if (timerLink) timerLink.value = urls.timer || 'Não disponível';
      const gcLink = document.getElementById('link-goal-coins');
      if (gcLink) gcLink.value = urls.goalCoins || 'Não disponível';
      const glLink = document.getElementById('link-goal-likes');
      if (glLink) glLink.value = urls.goalLikes || 'Não disponível';
      const mbLink = document.getElementById('link-membros');
      if (mbLink) mbLink.value = urls.membros || 'Não disponível';
      const tsLink = document.getElementById('link-top-score');
      if (tsLink) tsLink.value = urls.topScore || 'Não disponível';
      const gpLink = document.getElementById('link-goal-pix');
      if (gpLink) gpLink.value = urls.goalPix || 'Não disponível';
      const tgLink = document.getElementById('link-top-gift');
      if (tgLink) tgLink.value = urls.topGift || 'Não disponível';
      const tcLink = document.getElementById('link-top-combo');
      if (tcLink) tcLink.value = urls.topCombo || 'Não disponível';
    }
  } catch (e) {}
}

// ============================================
// TOAST NOTIFICATIONS
// ============================================
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const icons = { success: '✅', error: '❌', info: 'ℹ️', gift: '🎁' };
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span class="toast-icon">${icons[type] || 'ℹ️'}</span><span class="toast-msg">${escapeHtml(message)}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('toast-out');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// ============================================
// HELPERS
// ============================================
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function createEmptyState(icon, text, sub) {
  const div = document.createElement('div');
  div.className = 'empty-state';
  div.innerHTML = `<span class="empty-icon">${icon}</span><p>${text}</p><p class="empty-sub">${sub}</p>`;
  return div;
}

// ============================================
// UNIFIED CHAT
// ============================================
(function initChat() {
  const inlineMsgs  = document.getElementById('chat-inline-msgs');
  const inlineEmpty = document.getElementById('chat-inline-empty');
  const inlineCount = document.getElementById('chat-inline-count');
  let inlineMsgCount = 0;
  const MAX_INLINE = 150;

  const PLAT_COLOR = { tiktok: '#ff2d55', twitch: '#9146ff', kick: '#53fc18', youtube: '#ff4444' };
  const PLAT_LABEL = { tiktok: 'TK', twitch: 'TW', kick: 'KI', youtube: 'YT' };

  function esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function addInlineMessage(msg) {
    inlineMsgCount++;
    if (inlineEmpty && inlineEmpty.parentNode === inlineMsgs) inlineMsgs.removeChild(inlineEmpty);

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:baseline;gap:5px;padding:3px 5px;border-radius:4px;font-size:12px;line-height:1.4;';
    const color = msg.color || PLAT_COLOR[msg.platform] || '#aaa';
    const label = PLAT_LABEL[msg.platform] || msg.platform;
    row.innerHTML =
      `<span style="font-size:9px;font-weight:800;padding:1px 5px;border-radius:3px;flex-shrink:0;background:${color}22;color:${color};">${esc(label)}</span>` +
      `<span style="font-weight:700;color:${esc(color)};flex-shrink:0;max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(msg.username)}">${esc(msg.username)}</span>` +
      `<span style="color:rgba(255,255,255,0.25);">:</span>` +
      `<span style="color:rgba(255,255,255,0.82);word-break:break-word;">${esc(msg.message)}</span>`;

    inlineMsgs.appendChild(row);
    if (inlineMsgCount > MAX_INLINE) {
      const first = inlineMsgs.querySelector('div:not(#chat-inline-empty)');
      if (first) inlineMsgs.removeChild(first);
    }
    inlineMsgs.scrollTop = inlineMsgs.scrollHeight;
    if (inlineCount) inlineCount.textContent = inlineMsgCount;
  }

  // Receive chat messages from main process
  ipcRenderer.on('chat-message', (event, msg) => {
    addInlineMessage(msg);
  });

  // Clear
  ipcRenderer.on('chat-clear', () => {
    inlineMsgCount = 0;
    if (inlineMsgs) { inlineMsgs.innerHTML = ''; if (inlineEmpty) inlineMsgs.appendChild(inlineEmpty); }
    if (inlineCount) inlineCount.textContent = '0';
  });

  // Platform status
  function updateStatusBadge(platform, connected, channel) {
    const el = document.getElementById('chat-status-' + platform);
    if (!el) return;
    if (connected) {
      el.style.background = PLAT_COLOR[platform] + '22';
      el.style.color = PLAT_COLOR[platform];
      el.textContent = '● ' + (channel ? channel : 'Conectado');
    } else {
      el.style.background = 'rgba(255,255,255,0.07)';
      el.style.color = 'rgba(255,255,255,0.4)';
      el.textContent = 'Desconectado';
    }
  }

  ipcRenderer.on('chat-platform-status', (event, { platform, connected }) => {
    updateStatusBadge(platform, connected);
  });

  // TikTok status mirrors main TikTok connection
  ipcRenderer.on('tiktok-status', (event, data) => {
    // already handled above, just update chat badge
    // (we re-listen here specifically for chat badge)
  });

  // Twitch
  const twitchInput = document.getElementById('chat-twitch-channel');
  const btnTwitchConnect = document.getElementById('btn-twitch-connect');
  let twitchConnected = false;

  if (btnTwitchConnect) {
    btnTwitchConnect.addEventListener('click', () => {
      if (twitchConnected) {
        ipcRenderer.send('disconnect-twitch-chat');
        return;
      }
      const ch = (twitchInput ? twitchInput.value.trim() : '');
      if (!ch) { showToast('Digite o canal da Twitch', 'error'); return; }
      btnTwitchConnect.disabled = true;
      btnTwitchConnect.textContent = 'Conectando...';
      ipcRenderer.send('connect-twitch-chat', { channel: ch });
    });
  }

  ipcRenderer.on('twitch-chat-status', (event, data) => {
    twitchConnected = !!data.ok;
    updateStatusBadge('twitch', data.ok, data.channel);
    if (btnTwitchConnect) {
      btnTwitchConnect.disabled = false;
      btnTwitchConnect.textContent = data.ok ? 'Desconectar' : 'Conectar';
      if (data.ok) btnTwitchConnect.classList.add('btn-danger');
      else btnTwitchConnect.classList.remove('btn-danger');
    }
    if (data.error) showToast('Twitch: ' + data.error, 'error');
    else if (data.ok) showToast('Twitch conectado: #' + (data.channel || ''), 'success');
  });

  // Kick
  const kickInput = document.getElementById('chat-kick-channel');
  const btnKickConnect = document.getElementById('btn-kick-connect');
  let kickConnected = false;

  if (btnKickConnect) {
    btnKickConnect.addEventListener('click', () => {
      if (kickConnected) {
        ipcRenderer.send('disconnect-kick-chat');
        return;
      }
      const ch = (kickInput ? kickInput.value.trim() : '');
      if (!ch) { showToast('Digite o canal do Kick', 'error'); return; }
      btnKickConnect.disabled = true;
      btnKickConnect.textContent = 'Conectando...';
      ipcRenderer.send('connect-kick-chat', { channel: ch });
    });
  }

  ipcRenderer.on('kick-chat-status', (event, data) => {
    kickConnected = !!data.ok;
    updateStatusBadge('kick', data.ok, data.channel);
    if (btnKickConnect) {
      btnKickConnect.disabled = false;
      btnKickConnect.textContent = data.ok ? 'Desconectar' : 'Conectar';
      if (data.ok) btnKickConnect.classList.add('btn-danger');
      else btnKickConnect.classList.remove('btn-danger');
    }
    if (data.error) showToast('Kick: ' + data.error, 'error');
    else if (data.ok) showToast('Kick conectado: ' + (data.channel || ''), 'success');
  });

  // YouTube
  const ytChannel = document.getElementById('chat-youtube-channel');
  const btnYtConnect = document.getElementById('btn-youtube-connect');
  let youtubeConnected = false;

  if (btnYtConnect) {
    btnYtConnect.addEventListener('click', () => {
      if (youtubeConnected) {
        ipcRenderer.send('disconnect-youtube-chat');
        return;
      }
      const username = (ytChannel ? ytChannel.value.trim() : '');
      if (!username) { showToast('Insira o nome ou @username do canal do YouTube', 'error'); return; }
      btnYtConnect.disabled = true;
      btnYtConnect.textContent = 'Conectando...';
      ipcRenderer.send('connect-youtube-chat', { username });
    });
  }

  ipcRenderer.on('youtube-chat-status', (event, data) => {
    youtubeConnected = !!data.ok;
    updateStatusBadge('youtube', data.ok, data.username ? '@' + data.username : null);
    if (btnYtConnect) {
      btnYtConnect.disabled = false;
      btnYtConnect.textContent = data.ok ? 'Desconectar' : 'Conectar';
      if (data.ok) btnYtConnect.classList.add('btn-danger');
      else btnYtConnect.classList.remove('btn-danger');
    }
    if (data.error) showToast('YouTube: ' + data.error, 'error');
    else if (data.ok) showToast('YouTube Live Chat conectado: @' + (data.username || ''), 'success');
  });

  // Open separate window
  const btnOpenWindow = document.getElementById('btn-open-chat-window');
  if (btnOpenWindow) {
    btnOpenWindow.addEventListener('click', () => {
      ipcRenderer.send('open-chat-window');
    });
  }

  // Clear chat button
  const btnClearChat = document.getElementById('btn-clear-chat');
  if (btnClearChat) {
    btnClearChat.addEventListener('click', () => {
      ipcRenderer.send('chat-clear-all');
    });
  }

  // ── Event config checkboxes ────────────────────────────────────────────────
  const defaultEventConfig = {
    tiktok:  { follow: true,  gift: true,  subscribe: true, share: false, member: false, like: false },
    twitch:  { sub: true,     giftsub: true, raid: true,    bits: false },
    kick:    { follow: true,  subscribe: true, giftsub: true },
    youtube: { superchat: true, membership: true, subscribe: true, like: true }
  };
  let eventConfig = loadFromStorage('chatEventConfig', defaultEventConfig);

  function applyEventCheckboxes() {
    document.querySelectorAll('[data-platform][data-event]').forEach(cb => {
      const p = cb.dataset.platform, e = cb.dataset.event;
      const cfg = eventConfig[p];
      // Use saved value if exists, else use default
      cb.checked = cfg && cfg[e] !== undefined ? cfg[e] : (defaultEventConfig[p] && defaultEventConfig[p][e] === true);
    });
  }

  function saveEventConfig() {
    document.querySelectorAll('[data-platform][data-event]').forEach(cb => {
      const p = cb.dataset.platform, e = cb.dataset.event;
      if (!eventConfig[p]) eventConfig[p] = {};
      eventConfig[p][e] = cb.checked;
    });
    saveToStorage('chatEventConfig', eventConfig);
    ipcRenderer.send('set-chat-event-config', eventConfig);
  }

  applyEventCheckboxes();
  document.querySelectorAll('[data-platform][data-event]').forEach(cb => {
    cb.addEventListener('change', saveEventConfig);
  });
  // Send initial config to main on startup
  ipcRenderer.send('set-chat-event-config', eventConfig);

  // ── Inline event display ───────────────────────────────────────────────────
  const EVENT_LABELS_SHORT = {
    follow: '→ Seguiu', gift: '🎁 Presente', subscribe: '⭐ Inscrito',
    share: '↗ Compart.', member: '👋 Entrou', like: '❤ Curtiu',
    sub: '⭐ Sub', giftsub: '🎁 Gift Sub', raid: '⚔ Raid', bits: '💎 Bits',
    superchat: '💛 Super Chat', membership: '🏅 Membro',
    like: '👍 Curtiu'
  };

  function addInlineEvent(evt) {
    inlineMsgCount++;
    if (inlineEmpty && inlineEmpty.parentNode === inlineMsgs) inlineMsgs.removeChild(inlineEmpty);

    const row = document.createElement('div');
    const color = evt.color || PLAT_COLOR[evt.platform] || '#aaa';
    const platLabel = PLAT_LABEL[evt.platform] || evt.platform;
    const evtLabel = EVENT_LABELS_SHORT[evt.eventType] || evt.eventType;
    row.style.cssText = 'display:flex;align-items:center;gap:5px;padding:3px 5px;border-radius:4px;font-size:11px;line-height:1.4;background:rgba(255,255,255,0.04);';
    row.innerHTML =
      `<span style="font-size:9px;font-weight:800;padding:1px 5px;border-radius:3px;flex-shrink:0;background:${color}22;color:${color};">${esc(platLabel)}</span>` +
      `<span style="font-size:9px;color:rgba(255,255,255,0.4);flex-shrink:0;">${esc(evtLabel)}</span>` +
      `<span style="font-weight:700;color:${esc(color)};flex-shrink:0;max-width:110px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(evt.username)}">${esc(evt.username)}</span>` +
      (evt.detail ? `<span style="color:rgba(255,255,255,0.35);font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(evt.detail)}</span>` : '');

    inlineMsgs.appendChild(row);
    if (inlineMsgCount > MAX_INLINE) {
      const first = inlineMsgs.querySelector('div:not(#chat-inline-empty)');
      if (first) inlineMsgs.removeChild(first);
    }
    inlineMsgs.scrollTop = inlineMsgs.scrollHeight;
    if (inlineCount) inlineCount.textContent = inlineMsgCount;
  }

  ipcRenderer.on('chat-event', (event, evt) => addInlineEvent(evt));
})();

// ============================================
// INIT
// ============================================
renderModels();
renderEditMappings();
renderCoinsRanking();
renderLikesRanking();
loadOverlayLinks();
