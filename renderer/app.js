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
let coinsRanking = {};
let likesRanking = {};
let coinsBg = loadFromStorage('coinsBg', 'transparent');
let coinsSide = loadFromStorage('coinsSide', 'left');
let likesBg = loadFromStorage('likesBg', 'transparent');
let likesSide = loadFromStorage('likesSide', 'left');

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
  const diamondCount = (data.diamondCount || 0) * repeatCount;
  const userId = data.uniqueId || data.userId;
  const nickname = data.nickname || userId;
  const profilePic = data.profilePictureUrl || '';

  // Update coins ranking
  if (!coinsRanking[userId]) {
    coinsRanking[userId] = { nickname, profilePictureUrl: profilePic, coins: 0 };
  }
  coinsRanking[userId].coins += diamondCount;
  coinsRanking[userId].nickname = nickname;
  if (profilePic) coinsRanking[userId].profilePictureUrl = profilePic;
  renderCoinsRanking();
  ipcRenderer.send('update-coins-ranking', coinsRanking);

  showToast(`🎁 ${nickname} enviou ${giftName} x${repeatCount}`, 'gift');

  // Check connected model's key mappings only
  if (connectedModelId) {
    const model = keyModels.find(m => m.id === connectedModelId);
    if (model) {
      model.mappings.forEach(mapping => {
        if (giftName.toLowerCase() === mapping.giftName.toLowerCase() && repeatCount >= mapping.minCount) {
          ipcRenderer.send('simulate-key', { key: mapping.key, modifiers: mapping.modifiers || [] });
        }
      });
    }
  }

  // Check edit mappings
  editMappings.forEach((edit, idx) => {
    if (giftName.toLowerCase() === edit.giftName.toLowerCase() && repeatCount >= edit.minCount) {
      ipcRenderer.send('trigger-edit-overlay', edit);
      flashCard('edit', idx);
    }
  });
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
  renderLikesRanking();
  ipcRenderer.send('update-likes-ranking', likesRanking);
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
  modalEdit.style.display = 'flex';
  renderGiftGrid('edit-gift-grid', 'edit-gift-search', 'edit-gift-name');
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

  editMappings.push({ giftName, filePath, duration, minCount, isGif, scene });
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
          <span>Cena ${e.scene || 1} | Duração: ${e.duration}s | Min: ${e.minCount}x</span>
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

// Reset rankings
document.getElementById('btn-reset-ranking').addEventListener('click', () => {
  coinsRanking = {};
  likesRanking = {};
  renderCoinsRanking();
  renderLikesRanking();
  ipcRenderer.send('update-coins-ranking', coinsRanking);
  ipcRenderer.send('update-likes-ranking', likesRanking);
  showToast('Classificações resetadas!', 'success');
});

// Coins config
const coinsBgSelect = document.getElementById('coins-bg-select');
const coinsSideSelect = document.getElementById('coins-side-select');
coinsBgSelect.value = coinsBg;
coinsSideSelect.value = coinsSide;

coinsBgSelect.addEventListener('change', () => {
  coinsBg = coinsBgSelect.value;
  saveToStorage('coinsBg', coinsBg);
  ipcRenderer.send('update-ranking-config', { ranking: 'coins', bg: coinsBg, side: coinsSide });
  showToast('Fundo de moedas atualizado!', 'success');
});
coinsSideSelect.addEventListener('change', () => {
  coinsSide = coinsSideSelect.value;
  saveToStorage('coinsSide', coinsSide);
  ipcRenderer.send('update-ranking-config', { ranking: 'coins', bg: coinsBg, side: coinsSide });
  showToast('Lado de moedas atualizado!', 'success');
});

// Likes config
const likesBgSelect = document.getElementById('likes-bg-select');
const likesSideSelect = document.getElementById('likes-side-select');
likesBgSelect.value = likesBg;
likesSideSelect.value = likesSide;

likesBgSelect.addEventListener('change', () => {
  likesBg = likesBgSelect.value;
  saveToStorage('likesBg', likesBg);
  ipcRenderer.send('update-ranking-config', { ranking: 'likes', bg: likesBg, side: likesSide });
  showToast('Fundo de likes atualizado!', 'success');
});
likesSideSelect.addEventListener('change', () => {
  likesSide = likesSideSelect.value;
  saveToStorage('likesSide', likesSide);
  ipcRenderer.send('update-ranking-config', { ranking: 'likes', bg: likesBg, side: likesSide });
  showToast('Lado de likes atualizado!', 'success');
});

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

ipcRenderer.on('relay-status', (event, data) => {
  if (data.connected) {
    relayStatusDot.classList.add('connected');
    relayStatusText.textContent = 'Servidor conectado';
    loadOverlayLinks();
    // Send current ranking configs to relay
    ipcRenderer.send('update-ranking-config', { ranking: 'coins', bg: coinsBg, side: coinsSide });
    ipcRenderer.send('update-ranking-config', { ranking: 'likes', bg: likesBg, side: likesSide });
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
// INIT
// ============================================
renderModels();
renderEditMappings();
renderCoinsRanking();
renderLikesRanking();
loadOverlayLinks();
