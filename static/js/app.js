"use strict";

const CHUNK_SIZE = 64 * 1024;
const MAX_BUFFERED = 4 * 1024 * 1024;
const BUFFER_LOW = 512 * 1024;

const PBKDF2_ITERATIONS = 250000;
const KEY_SALT = "p2p-connect-pro-e2ee-v1";
const IV_LENGTH = 12;
const KIND_CONTROL = 1;
const KIND_CHUNK = 2;

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
  }
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
