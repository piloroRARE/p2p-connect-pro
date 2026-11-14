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
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ],
};

function sanitizeText(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  return String(value).trim().slice(0, 200) || fallback;
}

function safeId(value) {
  if (!value) return '';
  return String(value).trim();
}

function getNetworkQuality() {
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  return conn && conn.effectiveType ? conn.effectiveType : '4g';
}

function evaluateBestMode() {
  const quality = getNetworkQuality();
  const slowNetwork = ['slow-2g', '2g'].includes(quality);

  if (appState.selectedMode === 'direct') return 'direct';
  if (appState.selectedMode === 'relay') return 'relay';

  return slowNetwork ? 'relay' : 'direct';
}

function updateModeUI() {
  document.querySelectorAll('[data-mode]').forEach((btn) => {
    const isActive = btn.dataset.mode === appState.selectedMode;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
  });

  const modeStatus = document.getElementById('mode-status');
  if (modeStatus) modeStatus.textContent = appState.selectedMode.toUpperCase();
}

function setConnectionStatus(status, type = 'connecting') {
  const badge = document.getElementById('chat-status');
  if (!badge) return;

  badge.className = `status-badge ${type === 'connected' ? 'connected' : 'connecting'}`;
  badge.innerHTML = `<span class="status-dot ${type === 'connected' ? 'active' : 'inactive'}"></span><span>${status}</span>`;

  const connectionStatus = document.getElementById('connection-status');
  if (connectionStatus) connectionStatus.textContent = status;
}

function updateMessageCount() {
  const counter = document.getElementById('message-count');
  if (counter) counter.textContent = String(appState.messageCount);
}

function displayMessage(text, type, sender = 'User') {
  const container = document.getElementById('messages-container');
  if (!container) return;

  if (container.children.length === 1 && container.children[0].textContent.includes('Aucun')) {
    container.innerHTML = '';
  }

  const safeMessage = sanitizeText(text, '');
  if (!safeMessage) return;

  const messageEl = document.createElement('div');
  messageEl.className = `flex gap-3 ${type === 'own' ? 'flex-row-reverse' : ''}`;

  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = (sender || 'U').toString().trim()[0]?.toUpperCase() || 'U';

  const content = document.createElement('div');
  const senderSpan = document.createElement('div');
  senderSpan.className = 'text-xs font-semibold text-[var(--text-light)] mb-1';
  senderSpan.textContent = type === 'own' ? 'Vous' : (sender || 'Peer').toString().slice(0, 8) || 'Peer';

  const bubble = document.createElement('div');
  bubble.className = `message-bubble ${type === 'own' ? 'own' : 'peer'}`;
  bubble.textContent = safeMessage;

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

  list.innerHTML = peers
    .map((p) => {
      const peerName = sanitizeText(p.name, 'Utilisateur');
      const peerId = safeId(p.peerId);
      const modeLabel = sanitizeText(p.mode || 'Auto', 'Auto');

      return `
        <div class="flex items-center gap-2 p-2 rounded-lg bg-[var(--bg-lighter)] border border-[var(--border-color)]">
          <div class="avatar text-xs">${peerName[0]?.toUpperCase() || 'P'}</div>
          <div class="flex-1 min-w-0">
            <p class="text-xs font-medium text-[var(--text-light)] truncate">${peerName}</p>
            <p class="text-[10px] text-[var(--text-label)]">${modeLabel} · ${peerId.slice(0, 8)}</p>
          </div>
          <span class="h-2 w-2 rounded-full bg-[var(--primary)]"></span>
        </div>
      `;
    })
    .join('');
}

function updateNetworkInfo() {
  const quality = getNetworkQuality();
  const typeEl = document.getElementById('connection-type');
  const qualEl = document.getElementById('network-quality');

  if (typeEl) typeEl.textContent = evaluateBestMode() === 'direct' ? 'Direct' : 'Relay';
  if (qualEl) qualEl.textContent = quality;
}

function generatePeerId() {
  const timestamp = Date.now().toString(36);
  const randomPart = Math.random().toString(36).slice(2, 10);
  return `user-${timestamp}-${randomPart}`;
}

function setIdentity() {
  if (!appState.peerId) return;

  const myPeerIdEl = document.getElementById('my-peer-id');
  const myNameEl = document.getElementById('my-name');

  if (myPeerIdEl) myPeerIdEl.textContent = appState.peerId;
  if (myNameEl) myNameEl.textContent = sanitizeText(appState.name, 'Utilisateur');
}

function showSystemMessage(message) {
  displayMessage(message, 'peer', 'Système');
}

socket.on('connect', () => {
  appState.peerId = generatePeerId();
  appState.name = sanitizeText(appState.name, 'Utilisateur');

  socket.emit('register', {
    peerId: appState.peerId,
    name: appState.name,
  });

  setIdentity();
  updateNetworkInfo();
  setConnectionStatus('Prêt', 'connected');
});

socket.on('server-status', ({ message }) => {
  if (message) showSystemMessage(message);
});

socket.on('peer-registered', ({ peerId, name }) => {
  if (!peerId) return;
  const peer = appState.peers.get(peerId);
  if (peer) {
    peer.name = sanitizeText(name, 'Utilisateur');
  }
});

socket.on('online-peers', (peers) => {
  if (!Array.isArray(peers)) return;

  appState.peers.clear();
  peers.forEach((p) => {
    const peerId = safeId(p.peerId);
    if (!peerId) return;

    appState.peers.set(peerId, {
      ...p,
      peerId,
      name: sanitizeText(p.name, 'Utilisateur'),
      mode: evaluateBestMode(),
    });
  });

  renderPeerList();
  updateNetworkInfo();
});

socket.on('peer-disconnected', ({ peerId }) => {
  if (!peerId) return;
  appState.peers.delete(peerId);
  renderPeerList();
});

socket.on('relay-message', ({ from, message }) => {
  if (!from || !message) return;
  displayMessage(message, 'peer', from.slice(0, 8));
});

socket.on('message-history', ({ messages }) => {
  if (!Array.isArray(messages)) return;
  messages.forEach((msg) => {
    if (!msg || !msg.message) return;
    const type = msg.from === appState.peerId ? 'own' : 'peer';
    displayMessage(msg.message, type, (msg.from || 'Peer').slice(0, 8));
  });
});

socket.on('error', ({ message }) => {
  if (message) showSystemMessage(message);
});

function sendMessage() {
  const targetEl = document.getElementById('target-peer-id');
  const messageEl = document.getElementById('message-input');

  if (!targetEl || !messageEl) return;

  const target = safeId(targetEl.value);
  const text = sanitizeText(messageEl.value, '');

  if (!target || !text) return;

  displayMessage(text, 'own', appState.name || 'Vous');

  socket.emit('relay-message', {
    from: appState.peerId,
    to: target,
    message: text,
    timestamp: Date.now(),
  });

  appState.messageCount += 1;
  updateMessageCount();
  messageEl.value = '';
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('message-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    sendMessage();
  });

  document.querySelectorAll('[data-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      appState.selectedMode = btn.dataset.mode;
      updateModeUI();
      updateNetworkInfo();
      showSystemMessage(`Mode changé : ${appState.selectedMode.toUpperCase()}`);
    });
  });

  updateModeUI();
  setConnectionStatus('Prêt', 'connected');
  updateNetworkInfo();
  updateMessageCount();
});

window.addEventListener('load', () => {
  updateModeUI();
  setConnectionStatus('Prêt', 'connected');
  updateNetworkInfo();
  updateMessageCount();
});
