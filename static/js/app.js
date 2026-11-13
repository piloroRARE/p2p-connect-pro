"use strict";

const CHUNK_SIZE = 64 * 1024;
const MAX_BUFFERED = 4 * 1024 * 1024;
const BUFFER_LOW = 512 * 1024;

const PBKDF2_ITERATIONS = 250000;
const KEY_SALT = "p2p-connect-pro-e2ee-v1";
const IV_LENGTH = 12;
const KIND_CONTROL = 1;
const KIND_CHUNK = 2;

const CALL_PROFILES = {
  excellent: { videoBitrate: 2500000, audioBitrate: 64000, width: 1280, height: 720, videoEnabled: true, label: "excellent" },
  good: { videoBitrate: 1200000, audioBitrate: 56000, width: 960, height: 540, videoEnabled: true, label: "bon" },
  poor: { videoBitrate: 500000, audioBitrate: 40000, width: 640, height: 360, videoEnabled: true, label: "faible" },
  critical: { videoBitrate: 150000, audioBitrate: 24000, width: 320, height: 240, videoEnabled: false, label: "très faible — audio seul" },
};
const QUALITY_ORDER = ["excellent", "good", "poor", "critical"];

const els = {
  status: document.getElementById("status"),
  statusText: document.getElementById("status-text"),
  myId: document.getElementById("my-id"),
  copyId: document.getElementById("copy-id"),
  copyLink: document.getElementById("copy-link"),
  peerId: document.getElementById("peer-id"),
  passphrase: document.getElementById("passphrase"),
  connectBtn: document.getElementById("connect-btn"),
  connectError: document.getElementById("connect-error"),
  connectPanel: document.getElementById("connect-panel"),
  chatPanel: document.getElementById("chat-panel"),
  keyBanner: document.getElementById("key-banner"),
  bannerPassphrase: document.getElementById("banner-passphrase"),
  bannerApply: document.getElementById("banner-apply"),
  peerLabel: document.getElementById("peer-label"),
  disconnectBtn: document.getElementById("disconnect-btn"),
  callAudioBtn: document.getElementById("call-audio-btn"),
  callVideoBtn: document.getElementById("call-video-btn"),
  callOverlay: document.getElementById("call-overlay"),
  remoteVideo: document.getElementById("remote-video"),
  localVideo: document.getElementById("local-video"),
  callTimer: document.getElementById("call-timer"),
  callQuality: document.getElementById("call-quality"),
  callStats: document.getElementById("call-stats"),
  muteBtn: document.getElementById("mute-btn"),
  camBtn: document.getElementById("cam-btn"),
  hangupBtn: document.getElementById("hangup-btn"),
  incomingCall: document.getElementById("incoming-call"),
  incomingText: document.getElementById("incoming-text"),
  acceptCall: document.getElementById("accept-call"),
  declineCall: document.getElementById("decline-call"),
  messages: document.getElementById("messages"),
  fileBtn: document.getElementById("file-btn"),
  fileInput: document.getElementById("file-input"),
  textInput: document.getElementById("text-input"),
  sendBtn: document.getElementById("send-btn"),
  sendProgress: document.getElementById("send-progress"),
  sendProgressLabel: document.getElementById("send-progress-label"),
  sendProgressBar: document.getElementById("send-progress-bar"),
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let peer = null;
let conn = null;
let sendingFile = false;
let cryptoKey = null;
let keyVerified = false;
let decryptWarned = false;

let mediaCall = null;
let incomingMediaCall = null;
let localStream = null;
let remoteStream = null;
let callIsVideo = false;
let callStartTime = 0;
let callStatsTimer = null;
let callTimerInterval = null;
let currentLevel = null;
let pendingLevel = null;
let pendingLevelCount = 0;
let lastBytesSent = 0;
let lastStatsTime = 0;
let micMuted = false;
let camOff = false;
let autoVideoOff = false;
let netPongWaiters = [];

const incomingFiles = new Map();
const pendingCipher = [];

function setStatus(kind, text) {
  els.status.className = "status " + kind;
  els.statusText.textContent = text;
}

function timeNow() {
  return new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

function addSystem(text) {
  const div = document.createElement("div");
  div.className = "system";
  div.textContent = text;
  els.messages.appendChild(div);
  els.messages.scrollTop = els.messages.scrollHeight;
}

function addChatMessage(text, mine) {
  const div = document.createElement("div");
  div.className = "msg " + (mine ? "me" : "them");
  div.textContent = text;
  const meta = document.createElement("span");
  meta.className = "meta";
  meta.textContent = timeNow();
  div.appendChild(meta);
  els.messages.appendChild(div);
  els.messages.scrollTop = els.messages.scrollHeight;
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + " o";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " Ko";
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " Mo";
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " Go";
}

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
}

function concatBytes(...parts) {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function toArrayBuffer(data) {
  if (data instanceof ArrayBuffer) return data;
  if (data instanceof Uint8Array) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  return null;
}

async function deriveKey(passphrase) {
  const baseKey = await crypto.subtle.importKey("raw", encoder.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: encoder.encode(KEY_SALT), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptControl(obj) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, encoder.encode(JSON.stringify(obj)))
  );
  return concatBytes(new Uint8Array([KIND_CONTROL]), iv, cipher);
}

async function encryptChunk(fileId, plainBytes) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const plain = concatBytes(encoder.encode(fileId), plainBytes);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, plain));
  return concatBytes(new Uint8Array([KIND_CHUNK]), iv, cipher);
}

async function decryptMessage(data) {
  const bytes = new Uint8Array(data);
  const kind = bytes[0];
  const iv = bytes.slice(1, 1 + IV_LENGTH);
  const cipher = bytes.slice(1 + IV_LENGTH);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, cipher));
  if (kind === KIND_CHUNK) {
    return { kind, fileId: decoder.decode(plain.slice(0, 36)), data: plain.slice(36) };
  }
  return { kind, msg: JSON.parse(decoder.decode(plain)) };
}

async function sendEncrypted(obj) {
  if (!conn || !conn.open || !cryptoKey) return false;
  conn.send(await encryptControl(obj));
  return true;
}

function showKeyBanner() {
  els.keyBanner.hidden = false;
  els.bannerPassphrase.focus();
}

async function applyPassphrase(passphrase) {
  const pass = (passphrase || "").trim();
  if (!pass) return false;
  cryptoKey = await deriveKey(pass);
  decryptWarned = false;
  keyVerified = false;
  els.keyBanner.hidden = true;
  if (conn && conn.open) {
    setStatus("online", "Connecté · chiffré 🔒");
    await sendEncrypted({ type: "e2ee-hello" });
  }
  await processPendingCipher();
  addSystem("🔒 Chiffrement de bout en bout activé (AES-256-GCM). La phrase secrète ne quitte jamais votre appareil.");
  return true;
}

async function processPendingCipher() {
  if (!cryptoKey || pendingCipher.length === 0) return;
  const remaining = [];
  for (const buf of pendingCipher) {
    try {
      const parsed = await decryptMessage(buf);
      routeParsed(parsed);
    } catch (_) {
      remaining.push(buf);
    }
  }
  pendingCipher.length = 0;
  pendingCipher.push(...remaining);
  if (remaining.length > 0 && !decryptWarned) {
    decryptWarned = true;
    addSystem("⚠️ Des messages reçus restent illisibles : la phrase secrète ne correspond probablement pas à celle de votre contact.");
  }
}

function addFileMessage(fileId, name, size, mine) {
  const div = document.createElement("div");
  div.className = "msg file " + (mine ? "me" : "them");
  div.dataset.fileId = fileId;

  const label = document.createElement("span");
  label.className = "file-name";
  label.textContent = "📄 " + name;
  div.appendChild(label);

  const sizeSpan = document.createElement("span");
  sizeSpan.className = "file-size";
  sizeSpan.textContent = formatSize(size);
  div.appendChild(sizeSpan);

  const bar = document.createElement("div");
  bar.className = "bar";
  const fill = document.createElement("div");
  bar.appendChild(fill);
  div.appendChild(bar);

  els.messages.appendChild(div);
  els.messages.scrollTop = els.messages.scrollHeight;
}

function setFileProgress(fileId, ratio) {
  const node = els.messages.querySelector('[data-file-id="' + fileId + '"]');
  if (node) node.querySelector(".bar > div").style.width = Math.round(ratio * 100) + "%";
}

function finishFileMessage(fileId, blob, name, mine) {
  const node = els.messages.querySelector('[data-file-id="' + fileId + '"]');
  if (!node) return;
  const bar = node.querySelector(".bar");
  if (bar) bar.remove();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.className = "dl";
  link.href = url;
  link.download = name;
  link.textContent = mine ? "Télécharger une copie" : "⬇ Télécharger";
  node.appendChild(link);
  els.messages.scrollTop = els.messages.scrollHeight;
}

function showChat(peerId) {
  els.connectPanel.hidden = true;
  els.chatPanel.hidden = false;
  els.peerLabel.textContent = "Connecté à : " + peerId;
  if (!cryptoKey) showKeyBanner();
}

function showConnect() {
  els.chatPanel.hidden = true;
  els.connectPanel.hidden = false;
  els.peerId.value = "";
  setStatus("offline", "Hors ligne");
}

function resetProgress() {
  sendingFile = false;
  els.sendProgress.hidden = true;
  els.sendProgressBar.style.width = "0";
  els.sendBtn.disabled = false;
  els.fileBtn.disabled = false;
}

function teardown(statusText) {
  if (conn) {
    try { conn.close(); } catch (_) {}
    conn = null;
  }
  endCall(false);
  incomingFiles.clear();
  pendingCipher.length = 0;
  keyVerified = false;
  resetProgress();
  showConnect();
  setStatus("waiting", statusText);
}

function bindConnection(c) {
  conn = c;

  conn.on("open", async () => {
    showChat(conn.peer);
    if (cryptoKey) {
      setStatus("online", "Connecté · chiffré 🔒");
      await sendEncrypted({ type: "e2ee-hello" });
    } else {
      setStatus("online", "Connecté — chiffrement à activer");
      showKeyBanner();
    }
    addSystem("Connexion établie — vos échanges sont désormais directs.");
    resetProgress();
  });

  conn.on("data", handleData);

  conn.on("close", () => {
    addSystem("Votre contact s'est déconnecté.");
    teardown("Contact déconnecté");
  });

  conn.on("error", (err) => {
    addSystem("Erreur de connexion : " + err.message);
    teardown("Erreur de connexion");
  });
}

async function handleData(data) {
  const buf = toArrayBuffer(data);
  if (buf === null) return;

  if (!cryptoKey) {
    pendingCipher.push(buf);
    showKeyBanner();
    return;
  }

  let parsed;
  try {
    parsed = await decryptMessage(buf);
  } catch (_) {
    pendingCipher.push(buf);
    if (!decryptWarned) {
      decryptWarned = true;
      addSystem("⚠️ Message illisible : la phrase secrète ne correspond probablement pas à celle de votre contact.");
    }
    return;
  }
  routeParsed(parsed);
}

function routeParsed(parsed) {
  if (parsed.kind === KIND_CHUNK) {
    handleChunk(parsed.fileId, parsed.data);
    return;
  }

  const msg = parsed.msg;
  if (!msg || typeof msg !== "object") return;

  switch (msg.type) {
    case "chat":
      addChatMessage(String(msg.text), false);
      break;

    case "file-meta": {
      incomingFiles.set(msg.id, { name: msg.name, size: msg.size, mime: msg.mime, chunks: [], received: 0 });
      addFileMessage(msg.id, msg.name, msg.size, false);
      break;
    }

    case "file-end": {
      const entry = incomingFiles.get(msg.id);
      if (!entry) break;
      const blob = new Blob(entry.chunks, { type: entry.mime || "application/octet-stream" });
      finishFileMessage(msg.id, blob, entry.name, false);
      incomingFiles.delete(msg.id);
      break;
    }

    case "file-abort": {
      const node = els.messages.querySelector('[data-file-id="' + msg.id + '"]');
      if (node) node.remove();
      incomingFiles.delete(msg.id);
      break;
    }

    case "e2ee-hello": {
      keyVerified = true;
      sendEncrypted({ type: "e2ee-ack" });
      addSystem("🔒 Chiffrement vérifié avec votre contact ✓");
      break;
    }

    case "e2ee-ack": {
      if (!keyVerified) {
        keyVerified = true;
        addSystem("🔒 Chiffrement vérifié avec votre contact ✓");
      }
      break;
    }

    case "net-ping": {
      sendEncrypted({ type: "net-pong", t: msg.t });
      break;
    }

    case "net-pong": {
      const waiter = netPongWaiters.find((w) => w.t === msg.t);
      if (waiter) {
        netPongWaiters = netPongWaiters.filter((w) => w !== waiter);
        waiter.resolve(performance.now() - msg.t);
      }
      break;
    }
  }
}

async function measureDataChannelRtt() {
  if (!conn || !conn.open || !cryptoKey) return null;
  const samples = [];
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    const sent = await sendEncrypted({ type: "net-ping", t });
    if (!sent) return null;
    const rtt = await new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(null), 2000);
      netPongWaiters.push({ t, resolve: (v) => { clearTimeout(timeout); resolve(v); } });
    });
    if (rtt == null) return null;
    samples.push(rtt);
    await new Promise((r) => setTimeout(r, 120));
  }
  return samples.reduce((a, b) => a + b, 0) / samples.length;
}

function handleChunk(fileId, bytes) {
  const entry = incomingFiles.get(fileId);
  if (!entry) return;
  entry.chunks.push(bytes);
  entry.received += bytes.byteLength;
  setFileProgress(fileId, entry.size ? entry.received / entry.size : 0);
}

async function sendFile(file) {
  if (!conn || !conn.open || sendingFile) return;
  if (!cryptoKey) {
    addSystem("⚠️ Activez le chiffrement (phrase secrète) avant d'envoyer un fichier.");
    showKeyBanner();
    return;
  }
  sendingFile = true;
  els.sendBtn.disabled = true;
  els.fileBtn.disabled = true;
  els.sendProgress.hidden = false;

  const fileId = uuid();
  addFileMessage(fileId, file.name, file.size, true);

  try {
    await sendEncrypted({ type: "file-meta", id: fileId, name: file.name, size: file.size, mime: file.type });

    const channel = conn.dataChannel;
    if (channel) {
      channel.bufferedAmountLowThreshold = BUFFER_LOW;
    }

    for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
      if (channel && channel.bufferedAmount > MAX_BUFFERED) {
        await new Promise((resolve) => {
          const onLow = () => {
            channel.removeEventListener("bufferedamountlow", onLow);
            resolve();
          };
          channel.addEventListener("bufferedamountlow", onLow);
          setTimeout(onLow, 3000);
        });
      }
      const plain = new Uint8Array(await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer());
      conn.send(await encryptChunk(fileId, plain));
      const sent = Math.min(offset + CHUNK_SIZE, file.size);
      const ratio = sent / file.size;
      els.sendProgressBar.style.width = Math.round(ratio * 100) + "%";
      els.sendProgressLabel.textContent = "Envoi chiffré de " + file.name + " — " + Math.round(ratio * 100) + "%";
    }

    await sendEncrypted({ type: "file-end", id: fileId });
    finishFileMessage(fileId, file.slice(0), file.name, true);
    els.sendProgressLabel.textContent = "Fichier envoyé ✓";
    setTimeout(() => { els.sendProgress.hidden = true; }, 1500);
  } catch (err) {
    await sendEncrypted({ type: "file-abort", id: fileId });
    const node = els.messages.querySelector('[data-file-id="' + fileId + '"]');
    if (node) node.remove();
    addSystem("Échec de l'envoi du fichier : " + err.message);
  } finally {
    resetProgress();
  }
}

async function sendChat() {
  const text = els.textInput.value.trim();
  if (!text || !conn || !conn.open) return;
  if (!cryptoKey) {
    addSystem("⚠️ Activez le chiffrement (phrase secrète) avant d'envoyer un message.");
    showKeyBanner();
    return;
  }
  await sendEncrypted({ type: "chat", text: text });
  addChatMessage(text, true);
  els.textInput.value = "";
  els.textInput.focus();
}

async function connectTo(destId) {
  const dest = (destId || "").trim();
  if (!dest) {
    els.connectError.textContent = "Veuillez entrer l'identifiant de votre contact.";
    els.connectError.className = "hint error";
    return;
  }
  const pass = els.passphrase.value.trim();
  if (!pass) {
    els.connectError.textContent = "Saisissez la phrase secrète partagée : elle doit être identique chez votre contact.";
    els.connectError.className = "hint error";
    return;
  }
  if (!peer || peer.destroyed || !peer.open) {
    els.connectError.textContent = "Votre identifiant n'est pas encore prêt, patientez une seconde.";
    els.connectError.className = "hint error";
    return;
  }
  try {
    await applyPassphrase(pass);
  } catch (_) {
    els.connectError.textContent = "Impossible de préparer le chiffrement, réessayez.";
    els.connectError.className = "hint error";
    return;
  }
  els.connectError.textContent = "";
  setStatus("waiting", "Connexion chiffrée en cours…");
  bindConnection(peer.connect(dest, { reliable: true }));
}

function initPeer() {
  if (typeof Peer === "undefined") {
    setStatus("offline", "Bibliothèque PeerJS non chargée");
    els.myId.value = "";
    els.myId.placeholder = "Erreur de chargement — vérifiez votre connexion internet";
    return;
  }

  peer = new Peer(null, { debug: 1 });

  peer.on("open", (id) => {
    els.myId.value = id;
    els.copyId.disabled = false;
    els.copyLink.disabled = false;
    setStatus("waiting", "En attente d'un contact");

    const invited = new URLSearchParams(window.location.search).get("peer");
    if (invited) {
      els.peerId.value = invited;
      els.passphrase.focus();
    }
  });

  peer.on("connection", (c) => {
    if (conn && conn.open) {
      c.on("open", () => c.close());
      return;
    }
    bindConnection(c);
  });

  peer.on("call", (call) => {
    if (mediaCall || !conn || !conn.open || call.peer !== conn.peer) {
      try { call.close(); } catch (_) {}
      return;
    }
    incomingMediaCall = call;
    const video = !!(call.metadata && call.metadata.video);
    els.incomingText.textContent = video ? "📞 Appel vidéo entrant…" : "📞 Appel audio entrant…";
    els.incomingCall.hidden = false;
  });

  peer.on("error", (err) => {
    const map = {
      "peer-unavailable": "Contact introuvable : vérifiez l'identifiant saisi.",
      "unavailable-id": "Cet identifiant est déjà utilisé, rechargez la page.",
      "network": "Problème de réseau : reconnectez-vous à internet puis rechargez.",
      "browser-incompatible": "Votre navigateur ne prend pas en charge WebRTC.",
    };
    const msg = map[err.type] || "Erreur : " + (err.message || err.type);
    if (err.type === "peer-unavailable") {
      els.connectError.textContent = msg;
      els.connectError.className = "hint error";
      setStatus("waiting", "En attente d'un contact");
    } else {
      addSystem(msg);
      setStatus("offline", "Erreur réseau");
    }
  });

  peer.on("disconnected", () => {
    setStatus("waiting", "Reconnexion au réseau…");
    try { peer.reconnect(); } catch (_) {}
  });
}

els.connectBtn.addEventListener("click", () => connectTo(els.peerId.value));
els.peerId.addEventListener("keydown", (e) => { if (e.key === "Enter") connectTo(els.peerId.value); });
els.passphrase.addEventListener("keydown", (e) => { if (e.key === "Enter") connectTo(els.peerId.value); });

els.sendBtn.addEventListener("click", sendChat);
els.textInput.addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });

els.fileBtn.addEventListener("click", () => els.fileInput.click());
els.fileInput.addEventListener("change", () => {
  const file = els.fileInput.files[0];
  els.fileInput.value = "";
  if (file) sendFile(file);
});

els.disconnectBtn.addEventListener("click", () => teardown("Hors ligne"));

async function getCallMedia(withVideo) {
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: withVideo ? { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } : false,
  });
}

function openCallOverlay() {
  els.callOverlay.classList.toggle("audio-only", !callIsVideo);
  els.callOverlay.hidden = false;
}

function attachLocalVideo() {
  els.localVideo.srcObject = localStream;
}

function startCallTimer() {
  callStartTime = Date.now();
  els.callTimer.textContent = "00:00";
  callTimerInterval = setInterval(() => {
    const s = Math.floor((Date.now() - callStartTime) / 1000);
    els.callTimer.textContent = String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
  }, 1000);
}

function stopCallTimer() {
  if (callTimerInterval) {
    clearInterval(callTimerInterval);
    callTimerInterval = null;
  }
}

function computeLevel(rtt, lossPct) {
  if (rtt == null) return "good";
  if (rtt < 100 && (lossPct == null || lossPct < 1)) return "excellent";
  if (rtt < 200 && (lossPct == null || lossPct < 3)) return "good";
  if (rtt < 400 && (lossPct == null || lossPct < 7)) return "poor";
  return "critical";
}

function confirmAndApply(level) {
  if (level === currentLevel) {
    pendingLevel = null;
    pendingLevelCount = 0;
    return;
  }
  if (level === pendingLevel) {
    pendingLevelCount++;
  } else {
    pendingLevel = level;
    pendingLevelCount = 1;
  }
  const isDowngrade = QUALITY_ORDER.indexOf(level) > QUALITY_ORDER.indexOf(currentLevel);
  if (pendingLevelCount >= (isDowngrade ? 2 : 3)) {
    setQualityLevel(level);
    pendingLevel = null;
    pendingLevelCount = 0;
  }
}

async function setQualityLevel(level) {
  if (level === currentLevel) return;
  currentLevel = level;
  const profile = CALL_PROFILES[level];
  els.callQuality.textContent = "Réseau : " + profile.label;
  els.callQuality.className = "quality " + level;

  const pc = mediaCall && mediaCall.peerConnection;
  if (!pc) return;

  for (const sender of pc.getSenders()) {
    if (!sender.track) continue;
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
      if (sender.track.kind === "video") {
        params.encodings[0].maxBitrate = profile.videoBitrate;
        params.degradationPreference = "balanced";
        await sender.setParameters(params);
        if (!profile.videoEnabled && !camOff) {
          if (!autoVideoOff) {
            autoVideoOff = true;
            sender.track.enabled = false;
            addSystem("⚠️ Réseau très dégradé — vidéo coupée automatiquement, audio prioritaire.");
          }
        } else if (profile.videoEnabled && autoVideoOff && !camOff) {
          autoVideoOff = false;
          sender.track.enabled = true;
          addSystem("✓ Réseau rétabli — vidéo réactivée automatiquement.");
        }
        if (profile.videoEnabled) {
          await sender.track.applyConstraints({ width: { ideal: profile.width }, height: { ideal: profile.height } });
        }
      } else if (sender.track.kind === "audio") {
        params.encodings[0].maxBitrate = profile.audioBitrate;
        await sender.setParameters(params);
      }
    } catch (_) {}
  }
}

function updateCallStatsUI(rtt, bitrate, lossPct) {
  const parts = [];
  if (rtt != null) parts.push("latence " + Math.round(rtt) + " ms");
  if (bitrate > 0) parts.push((bitrate / 1000).toFixed(0) + " kbit/s");
  if (lossPct != null) parts.push("perte " + lossPct.toFixed(1) + " %");
  els.callStats.textContent = parts.join(" · ");
}

function startNetworkMonitoring(call) {
  stopNetworkMonitoring();
  lastBytesSent = 0;
  lastStatsTime = 0;
  pendingLevel = null;
  pendingLevelCount = 0;
  setQualityLevel("good");

  callStatsTimer = setInterval(async () => {
    const pc = call.peerConnection;
    if (!pc) return;
    try {
      const stats = await pc.getStats();
      let rtt = null;
      let lossPct = null;
      let bytes = 0;
      stats.forEach((r) => {
        if (r.type === "candidate-pair" && r.state === "succeeded" && r.currentRoundTripTime != null) {
          rtt = r.currentRoundTripTime * 1000;
        }
        if (r.type === "remote-inbound-rtp" && r.fractionLoss != null) {
          lossPct = r.fractionLoss * 100;
        }
        if (r.type === "outbound-rtp" && !r.isRemote) {
          bytes += r.bytesSent || 0;
        }
      });
      const now = Date.now();
      let bitrate = 0;
      if (lastStatsTime && bytes >= lastBytesSent) {
        bitrate = ((bytes - lastBytesSent) * 8) / ((now - lastStatsTime) / 1000);
      }
      lastBytesSent = bytes;
      lastStatsTime = now;
      confirmAndApply(computeLevel(rtt, lossPct));
      updateCallStatsUI(rtt, bitrate, lossPct);
    } catch (_) {}
  }, 2000);
}

function stopNetworkMonitoring() {
  if (callStatsTimer) {
    clearInterval(callStatsTimer);
    callStatsTimer = null;
  }
}

function watchIce(pc) {
  if (!pc) return;
  pc.addEventListener("iceconnectionstatechange", () => {
    if (pc.iceConnectionState === "disconnected") {
      addSystem("⚠️ Réseau instable — tentative de reconnexion…");
    } else if (pc.iceConnectionState === "failed" && pc.restartIce) {
      addSystem("⚠️ Connexion perdue — rétablissement en cours…");
      pc.restartIce();
    }
  });
  pc.addEventListener("connectionstatechange", () => {
    if (pc.connectionState === "failed" && pc.restartIce) pc.restartIce();
  });
}

function setupMediaCall(call) {
  startCallTimer();
  setQualityLevel("good");

  call.on("stream", (remote) => {
    remoteStream = remote;
    els.remoteVideo.srcObject = remote;
    watchIce(call.peerConnection);
    startNetworkMonitoring(call);
  });

  call.on("close", () => endCall(false));
  call.on("error", (err) => {
    addSystem("Erreur d'appel : " + err.message);
    endCall(false);
  });

  watchIce(call.peerConnection);
}

async function startCall(withVideo) {
  if (!conn || !conn.open) return;
  if (mediaCall || incomingMediaCall) {
    addSystem("⚠️ Un appel est déjà en cours.");
    return;
  }
  const rtt = await measureDataChannelRtt();
  if (rtt != null) {
    const lvl = computeLevel(rtt, null);
    addSystem("Réseau estimé avant appel : " + CALL_PROFILES[lvl].label + " (latence ~" + Math.round(rtt) + " ms)");
  }
  try {
    localStream = await getCallMedia(withVideo);
  } catch (err) {
    addSystem("Impossible d'accéder au micro/caméra : " + err.message);
    return;
  }
  callIsVideo = withVideo;
  openCallOverlay();
  attachLocalVideo();
  mediaCall = peer.call(conn.peer, localStream, { metadata: { video: withVideo } });
  setupMediaCall(mediaCall);
  addSystem(withVideo ? "📞 Appel vidéo en cours…" : "📞 Appel audio en cours…");
}

async function acceptIncomingCall() {
  const call = incomingMediaCall;
  els.incomingCall.hidden = true;
  incomingMediaCall = null;
  if (!call) return;
  try {
    const wantVideo = !!(call.metadata && call.metadata.video);
    localStream = await getCallMedia(wantVideo);
    callIsVideo = wantVideo;
    call.answer(localStream);
    mediaCall = call;
    openCallOverlay();
    attachLocalVideo();
    setupMediaCall(call);
  } catch (err) {
    addSystem("Impossible d'accepter l'appel : " + err.message);
    try { call.close(); } catch (_) {}
  }
}

function endCall(showMessage) {
  stopNetworkMonitoring();
  stopCallTimer();
  if (mediaCall) {
    try { mediaCall.close(); } catch (_) {}
    mediaCall = null;
  }
  if (incomingMediaCall) {
    try { incomingMediaCall.close(); } catch (_) {}
    incomingMediaCall = null;
  }
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
  remoteStream = null;
  els.remoteVideo.srcObject = null;
  els.localVideo.srcObject = null;
  els.callOverlay.hidden = true;
  els.incomingCall.hidden = true;
  micMuted = false;
  camOff = false;
  autoVideoOff = false;
  currentLevel = null;
  pendingLevel = null;
  pendingLevelCount = 0;
  els.muteBtn.textContent = "🎤";
  els.camBtn.textContent = "📷";
  if (showMessage) addSystem("Appel terminé.");
}

els.callAudioBtn.addEventListener("click", () => startCall(false));
els.callVideoBtn.addEventListener("click", () => startCall(true));
els.hangupBtn.addEventListener("click", () => endCall(true));
els.acceptCall.addEventListener("click", acceptIncomingCall);
els.declineCall.addEventListener("click", () => {
  if (incomingMediaCall) {
    try { incomingMediaCall.close(); } catch (_) {}
    incomingMediaCall = null;
  }
  els.incomingCall.hidden = true;
  addSystem("Appel refusé.");
});

els.muteBtn.addEventListener("click", () => {
  if (!localStream) return;
  micMuted = !micMuted;
  localStream.getAudioTracks().forEach((t) => { t.enabled = !micMuted; });
  els.muteBtn.textContent = micMuted ? "🔇" : "🎤";
});

els.camBtn.addEventListener("click", () => {
  if (!localStream || !callIsVideo) return;
  camOff = !camOff;
  if (camOff) autoVideoOff = false;
  localStream.getVideoTracks().forEach((t) => { t.enabled = !camOff; });
  els.camBtn.textContent = camOff ? "🚫" : "📷";
});

els.bannerApply.addEventListener("click", async () => {
  try {
    await applyPassphrase(els.bannerPassphrase.value);
    els.bannerPassphrase.value = "";
  } catch (_) {
    addSystem("⚠️ Impossible d'activer le chiffrement, réessayez.");
  }
});
els.bannerPassphrase.addEventListener("keydown", async (e) => {
  if (e.key !== "Enter") return;
  try {
    await applyPassphrase(els.bannerPassphrase.value);
    els.bannerPassphrase.value = "";
  } catch (_) {
    addSystem("⚠️ Impossible d'activer le chiffrement, réessayez.");
  }
});

async function copyText(text, button, doneLabel) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  const original = button.textContent;
  button.textContent = doneLabel;
  setTimeout(() => { button.textContent = original; }, 1500);
}

els.copyId.disabled = true;
els.copyLink.disabled = true;

els.copyId.addEventListener("click", () => copyText(els.myId.value, els.copyId, "Copié ✓"));

els.copyLink.addEventListener("click", () => {
  const link = window.location.origin + window.location.pathname + "?peer=" + encodeURIComponent(els.myId.value);
  copyText(link, els.copyLink, "Lien copié ✓");
});

setStatus("waiting", "Connexion au réseau…");
initPeer();
