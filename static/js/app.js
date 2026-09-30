const socket = io();
const appState = {
  peerId: null,
  name: `Utilisateur-${Math.floor(Math.random() * 1000)}`,
  selectedMode: 'auto',
  peers: new Map(),
  rtcConnections: new Map(),
  dataChannels: new Map(),
  messageCount: 0,
  pendingSignals: new Map(),
};

const CONFIG = {
  iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }],
};

function updateModeUI() {
  const modeButtons = document.querySelectorAll('[data-mode]');
  modeButtons.forEach((button) => {
    const isActive = button.dataset.mode === appState.selectedMode;
    button.classList.toggle('active', isActive);
    button.setAttribute('aria-pressed', String(isActive));
  });

  const modeStatus = document.getElementById('mode-status');
  if (modeStatus) {
    modeStatus.textContent = appState.selectedMode.toUpperCase();
  }
}

function evaluateBestMode(peerId) {
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  const effectiveType = connection ? connection.effectiveType : '4g';
  const slowNetwork = ['slow-2g', '2g'].includes(effectiveType);
  const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

  if (appState.selectedMode === 'direct') return 'direct';
  if (appState.selectedMode === 'relay') return 'relay';

  const shouldPreferDirect = !slowNetwork || isLocal;
  if (peerId && shouldPreferDirect) {
    return 'direct';
  }

  return 'relay';
}

function setConnectionStatus(status, type = 'connecting') {
  const badge = document.getElementById('chat-status');
  const text = document.getElementById('connection-status');
  const dot = badge.querySelector('.status-dot');

  badge.className = `status-badge ${type === 'connected' ? 'connected' : 'connecting'}`;
  badge.innerHTML = `<span class="status-dot ${type === 'connected' ? 'active' : 'inactive'}"></span><span>${status}</span>`;
  if (text) text.textContent = status;
  if (dot) dot.className = `status-dot ${type === 'connected' ? 'active' : 'inactive'}`;
}

function displayMessage(text, type, sender = 'Pair') {
  const container = document.getElementById('messages-container');
  if (container.children.length === 1 && container.children[0].textContent.includes('Aucun message')) {
    container.innerHTML = '';
  }

  const messageEl = document.createElement('div');
  messageEl.className = `flex gap-3 ${type === 'own' ? 'flex-row-reverse' : ''}`;

  const avatarEl = document.createElement('div');
  avatarEl.className = 'avatar shrink-0';
  avatarEl.textContent = sender.slice(0, 1).toUpperCase();

  const contentEl = document.createElement('div');
  contentEl.className = type === 'own' ? 'items-end text-right' : '';

  const senderEl = document.createElement('div');
  senderEl.className = 'flex items-baseline gap-2 mb-1 text-xs';
  const nameSpan = document.createElement('span');
  nameSpan.className = 'font-semibold text-[var(--text-light)]';
  nameSpan.textContent = type === 'own' ? 'Vous' : sender.slice(0, 8) + '...';
  const timeSpan = document.createElement('span');
  timeSpan.className = 'text-[10px] text-[var(--text-muted)]';
  timeSpan.textContent = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  senderEl.append(nameSpan, timeSpan);

  const bubbleEl = document.createElement('div');
  bubbleEl.className = `message-bubble ${type === 'own' ? 'own' : 'peer'}`;
  bubbleEl.textContent = text;

  contentEl.append(senderEl, bubbleEl);
  messageEl.append(avatarEl, contentEl);
  container.appendChild(messageEl);
  container.scrollTop = container.scrollHeight;
}

function addSystemMessage(text) {
  const container = document.getElementById('messages-container');
  if (container.children.length === 1 && container.children[0].textContent.includes('Aucun message')) {
    container.innerHTML = '';
  }

  const messageEl = document.createElement('div');
  messageEl.className = 'text-center py-2';
  messageEl.innerHTML = `<p class="text-[10px] text-[var(--text-muted)]">${text}</p>`;
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

  list.innerHTML = peers.map((peer) => `
    <div class="flex items-center gap-2 p-2 rounded-lg bg-[var(--bg-lighter)] border border-[var(--border-color)]" id="peer-${peer.peerId}">
      <div class="avatar text-xs">${peer.peerId.slice(0, 1).toUpperCase()}</div>
      <div class="flex-1 min-w-0">
        <p class="text-xs font-medium text-[var(--text-light)] truncate">${peer.name || peer.peerId.slice(0, 12)}...</p>
        <p class="text-[10px] text-[var(--text-label)]">${peer.mode || 'Auto'}</p>
      </div>
      <span class="h-2 w-2 rounded-full bg-[var(--primary)]"></span>
    </div>
  `).join('');
}

function updateNetworkInfo() {
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  const mode = evaluateBestMode();
  const el = document.getElementById('connection-type');
  if (el) el.textContent = mode.toUpperCase();

  if (connection) {
    document.getElementById('network-quality').textContent = connection.effectiveType || '4g';
  } else {
    document.getElementById('network-quality').textContent = 'N/A';
  }
}

function createPeerConnection(peerId, isOfferer = true) {
  if (appState.rtcConnections.has(peerId)) return appState.rtcConnections.get(peerId);

  const pc = new RTCPeerConnection(CONFIG);
  appState.rtcConnections.set(peerId, pc);

  const dc = pc.createDataChannel('chat');
  appState.dataChannels.set(peerId, dc);

  dc.onopen = () => {
    setConnectionStatus('Connecté', 'connected');
    addSystemMessage(`Connexion directe établie avec ${peerId.slice(0, 8)}...`);
    const current = appState.peers.get(peerId) || { peerId };
    current.mode = 'direct';
    appState.peers.set(peerId, current);
    renderPeerList();
  };

  dc.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload.type === 'message') {
        displayMessage(payload.text, 'peer', payload.sender || peerId);
      }
    } catch (error) {
      console.error('Erreur parsing message direct', error);
    }
  };

  pc.ondatachannel = (event) => {
    const channel = event.channel;
    appState.dataChannels.set(peerId, channel);
    channel.onmessage = (evt) => {
      try {
        const payload = JSON.parse(evt.data);
        if (payload.type === 'message') {
          displayMessage(payload.text, 'peer', payload.sender || peerId);
        }
      } catch (error) {
        console.error('Erreur parsing datachannel', error);
      }
    };
    channel.onopen = () => {
      setConnectionStatus('Connecté', 'connected');
      addSystemMessage(`Connexion directe active avec ${peerId.slice(0, 8)}...`);
    };
  };

  pc.onicecandidate = (event) => {
    if (!event.candidate) return;
    socket.emit('signal', {
      from: appState.peerId,
      target: peerId,
      signal: { candidate: event.candidate },
    });
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      appState.selectedMode = 'relay';
      updateModeUI();
      addSystemMessage('Direct a échoué. Passage automatique en mode relais.');
    }
  };

  pc.onnegotiationneeded = async () => {
    if (!isOfferer) return;
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('signal', {
        from: appState.peerId,
        target: peerId,
        signal: { offer },
      });
    } catch (error) {
      console.error('Erreur creation offer', error);
    }
  };

  return pc;
}

async function handleIncomingSignal(payload) {
  const from = payload.from;
  const signal = payload.signal;

  if (!from || !signal) return;

  let pc = appState.rtcConnections.get(from);
  if (!pc) {
    pc = createPeerConnection(from, false);
  }

  if (signal.offer) {
    await pc.setRemoteDescription(new RTCSessionDescription(signal.offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('signal', {
      from: appState.peerId,
      target: from,
      signal: { answer },
    });
    return;
  }

  if (signal.answer) {
    await pc.setRemoteDescription(new RTCSessionDescription(signal.answer));
    return;
  }

  if (signal.candidate) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
    } catch (error) {
      console.error('Erreur ICE candidate', error);
    }
  }
}

function sendMessageViaRelay(targetPeerId, text) {
  socket.emit('relay_message', {
    from: appState.peerId,
    to: targetPeerId,
    message: text,
    timestamp: Date.now(),
  });
}

function sendMessageToPeer(peerId, text) {
  const mode = evaluateBestMode(peerId);
  const pc = appState.rtcConnections.get(peerId);
  const channel = appState.dataChannels.get(peerId);

  if (mode === 'direct' && pc && channel && channel.readyState === 'open') {
    channel.send(JSON.stringify({ type: 'message', text, sender: appState.name }));
    return true;
  }

  if (mode === 'direct' && !pc) {
    const newPc = createPeerConnection(peerId, true);
    const toSend = { type: 'message', text, sender: appState.name };
    setTimeout(() => {
      const ch = appState.dataChannels.get(peerId);
      if (ch && ch.readyState === 'open') {
        ch.send(JSON.stringify(toSend));
      } else {
        sendMessageViaRelay(peerId, text);
      }
    }, 600);
    return true;
  }

  sendMessageViaRelay(peerId, text);
  return false;
}

socket.on('connect', () => {
  appState.peerId = `user-${Math.random().toString(36).slice(2, 8)}`;
  appState.name = document.getElementById('my-name')?.textContent || appState.name;
  socket.emit('register', { peerId: appState.peerId, name: appState.name });
  document.getElementById('my-peer-id').textContent = appState.peerId;
  document.getElementById('my-name').textContent = appState.name;
  updateNetworkInfo();
});

socket.on('my-peer-id', ({ peerId, name }) => {
  appState.peerId = peerId;
  document.getElementById('my-peer-id').textContent = peerId;
  document.getElementById('my-name').textContent = name || appState.name;
  appState.name = name || appState.name;
  setConnectionStatus('Prêt', 'connected');
});

socket.on('online-peers', (peers) => {
  appState.peers.clear();
  peers.forEach((peer) => {
    appState.peers.set(peer.peerId, { ...peer, mode: evaluateBestMode(peer.peerId) });
  });
  renderPeerList();
});

socket.on('signal', (payload) => {
  handleIncomingSignal(payload);
});

socket.on('relay_message', ({ from, message, timestamp }) => {
  displayMessage(message, 'peer', from.slice(0, 8) || 'Relais');
  addSystemMessage(`Message reçu via relais serveur`);
});

function bindUI() {
  document.querySelectorAll('[data-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      appState.selectedMode = button.dataset.mode;
      updateModeUI();
      addSystemMessage(`Mode sélectionné : ${appState.selectedMode.toUpperCase()}`);
    });
  });

  document.getElementById('message-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const input = document.getElementById('message-input');
    const text = input.value.trim();
    if (!text) return;

    const recipient = document.getElementById('target-peer-id')?.value?.trim();
    if (!recipient) {
      addSystemMessage('Entrez un ID de pair avant d’envoyer un message.');
      return;
    }

    displayMessage(text, 'own', appState.name);
    const sentDirectly = sendMessageToPeer(recipient, text);
    appState.messageCount += 1;
    document.getElementById('message-count').textContent = String(appState.messageCount);

    if (!sentDirectly) {
      addSystemMessage(`Message relayé via serveur vers ${recipient.slice(0, 8)}...`);
    }

    input.value = '';
  });

  document.getElementById('btn-create-offer').addEventListener('click', () => {
    const target = document.getElementById('target-peer-id').value.trim();
    if (!target) {
      addSystemMessage('Indiquez un peer cible pour lancer un appel direct.');
      return;
    }
    const pc = createPeerConnection(target, true);
    appState.peers.set(target, { peerId: target, name: target, mode: 'direct' });
    renderPeerList();
    setConnectionStatus('Connexion directe...', 'connecting');
  });

  document.getElementById('btn-answer-offer').addEventListener('click', () => {
    const target = document.getElementById('target-peer-id').value.trim();
    if (!target) {
      addSystemMessage('Indiquez un peer cible pour répondre à une offre.');
      return;
    }
    const pc = createPeerConnection(target, false);
    appState.peers.set(target, { peerId: target, name: target, mode: 'direct' });
    renderPeerList();
  });

  document.getElementById('target-peer-id').addEventListener('input', (event) => {
    const target = event.target.value.trim();
    if (!target) return;
    const recommended = evaluateBestMode(target);
    const label = document.getElementById('recommended-mode');
    label.textContent = recommended === 'direct' ? 'Direct WebRTC recommandé' : 'Relais serveur recommandé';
  });
}

window.addEventListener('load', () => {
  updateModeUI();
  bindUI();
  setConnectionStatus('Prêt', 'connected');
  updateNetworkInfo();
  document.getElementById('my-name').textContent = appState.name;
  document.getElementById('my-peer-id').textContent = '...' ;
});
