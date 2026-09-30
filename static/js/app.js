const socket = io();
const appState = {
  peerId: null,
  name: `User-${Math.floor(Math.random() * 10000)}`,
  selectedMode: 'auto',
  peers: new Map(),
  rtcConnections: new Map(),
  dataChannels: new Map(),
  messageCount: 0,
};

const CONFIG = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }
  ]
};

function updateModeUI() {
  document.querySelectorAll('[data-mode]').forEach(btn => {
    const isActive = btn.dataset.mode === appState.selectedMode;
    btn.classList.toggle('active', isActive);
  });
  const modeStatus = document.getElementById('mode-status');
  if (modeStatus) modeStatus.textContent = appState.selectedMode.toUpperCase();
}

function getNetworkQuality() {
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  return conn ? conn.effectiveType : '4g';
}

function evaluateBestMode(peerId) {
  const quality = getNetworkQuality();
  const slowNetwork = ['slow-2g', '2g'].includes(quality);
  
  if (appState.selectedMode === 'direct') return 'direct';
  if (appState.selectedMode === 'relay') return 'relay';
  
  return slowNetwork ? 'relay' : 'direct';
}

function setConnectionStatus(status, type = 'connecting') {
  const badge = document.getElementById('chat-status');
  if (!badge) return;
  badge.className = `status-badge ${type === 'connected' ? 'connected' : 'connecting'}`;
  badge.innerHTML = `<span class="status-dot ${type === 'connected' ? 'active' : 'inactive'}"></span><span>${status}</span>`;
}

function displayMessage(text, type, sender = 'User') {
  const container = document.getElementById('messages-container');
  if (container.children.length === 1 && container.children[0].textContent.includes('Aucun')) {
    container.innerHTML = '';
  }
  
  const messageEl = document.createElement('div');
  messageEl.className = `flex gap-3 ${type === 'own' ? 'flex-row-reverse' : ''}`;
  
  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = sender[0].toUpperCase();
  
  const content = document.createElement('div');
  const senderSpan = document.createElement('div');
  senderSpan.className = 'text-xs font-semibold text-[var(--text-light)] mb-1';
  senderSpan.textContent = type === 'own' ? 'Vous' : sender.slice(0, 8) + '...';
  
  const bubble = document.createElement('div');
  bubble.className = `message-bubble ${type === 'own' ? 'own' : 'peer'}`;
  bubble.textContent = text;
  
  content.appendChild(senderSpan);
  content.appendChild(bubble);
  messageEl.appendChild(avatar);
  messageEl.appendChild(content);
  container.appendChild(messageEl);
  container.scrollTop = container.scrollHeight;
}

function renderPeerList() {
  const list = document.getElementById('peers-list');
  if (!list) return;
  
  const peers = Array.from(appState.peers.values());
  if (!peers.length) {
    list.innerHTML = '<p class="text-xs text-[var(--text-muted)]">Aucune connexion</p>';
    return;
  }
  
  list.innerHTML = peers.map(p => `
    <div class="flex items-center gap-2 p-2 rounded-lg bg-[var(--bg-lighter)] border border-[var(--border-color)]">
      <div class="avatar text-xs">${p.peerId[0].toUpperCase()}</div>
      <div class="flex-1 min-w-0">
        <p class="text-xs font-medium text-[var(--text-light)] truncate">${p.name}</p>
        <p class="text-[10px] text-[var(--text-label)]">${p.mode || 'Auto'}</p>
      </div>
      <span class="h-2 w-2 rounded-full bg-[var(--primary)]"></span>
    </div>
  `).join('');
}

function updateNetworkInfo() {
  const quality = getNetworkQuality();
  const typeEl = document.getElementById('connection-type');
  const qualEl = document.getElementById('network-quality');
  if (typeEl) typeEl.textContent = evaluateBestMode() === 'direct' ? 'Direct' : 'Relay';
  if (qualEl) qualEl.textContent = quality;
}

socket.on('connect', () => {
  appState.peerId = `user-${Math.random().toString(36).slice(2, 8)}`;
  socket.emit('register', { peerId: appState.peerId, name: appState.name });
  document.getElementById('my-peer-id').textContent = appState.peerId;
  document.getElementById('my-name').textContent = appState.name;
  updateNetworkInfo();
  setConnectionStatus('Prêt', 'connected');
});

socket.on('online-peers', (peers) => {
  appState.peers.clear();
  peers.forEach(p => {
    appState.peers.set(p.peerId, { ...p, mode: evaluateBestMode(p.peerId) });
  });
  renderPeerList();
});

socket.on('relay-message', ({ from, message }) => {
  displayMessage(message, 'peer', from.slice(0, 8));
});

socket.on('message-history', ({ messages }) => {
  messages.forEach(msg => {
    const type = msg.from === appState.peerId ? 'own' : 'peer';
    displayMessage(msg.message, type, msg.from.slice(0, 8));
  });
});

function sendMessage() {
  const targetEl = document.getElementById('target-peer-id');
  const messageEl = document.getElementById('message-input');
  const target = targetEl.value.trim();
  const text = messageEl.value.trim();
  
  if (!target || !text) return;
  
  displayMessage(text, 'own', appState.name);
  socket.emit('relay-message', {
    from: appState.peerId,
    to: target,
    message: text,
    timestamp: Date.now()
  });
  
  appState.messageCount += 1;
  document.getElementById('message-count').textContent = String(appState.messageCount);
  messageEl.value = '';
}

document.getElementById('message-form').addEventListener('submit', (e) => {
  e.preventDefault();
  sendMessage();
});

document.querySelectorAll('[data-mode]').forEach(btn => {
  btn.addEventListener('click', () => {
    appState.selectedMode = btn.dataset.mode;
    updateModeUI();
    displayMessage(`Mode changé : ${appState.selectedMode.toUpperCase()}`, 'peer', 'Système');
  });
});

window.addEventListener('load', () => {
  updateModeUI();
  setConnectionStatus('Prêt', 'connected');
  updateNetworkInfo();
});
