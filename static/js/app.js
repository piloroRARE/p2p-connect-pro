"use strict";

const CHUNK_SIZE = 64 * 1024;
const MAX_BUFFERED = 4 * 1024 * 1024;
const BUFFER_LOW = 512 * 1024;

const els = {
  status: document.getElementById("status"),
  statusText: document.getElementById("status-text"),
  myId: document.getElementById("my-id"),
  copyId: document.getElementById("copy-id"),
  copyLink: document.getElementById("copy-link"),
  peerId: document.getElementById("peer-id"),
  connectBtn: document.getElementById("connect-btn"),
  connectError: document.getElementById("connect-error"),
  connectPanel: document.getElementById("connect-panel"),
  chatPanel: document.getElementById("chat-panel"),
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

let peer = null;
let conn = null;
let sendingFile = false;

const incomingFiles = new Map();

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
  return { node: div, fill };
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
  resetProgress();
  showConnect();
  setStatus("waiting", statusText);
}

function bindConnection(c) {
  conn = c;

  conn.on("open", () => {
    showChat(conn.peer);
    setStatus("online", "Connecté (P2P direct)");
    addSystem("Connexion établie — vos échanges sont désormais directs et chiffrés.");
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

function handleData(data) {
  if (!data || typeof data !== "object") return;

  switch (data.type) {
    case "chat":
      addChatMessage(String(data.text), false);
      break;

    case "file-meta": {
      incomingFiles.set(data.id, { name: data.name, size: data.size, mime: data.mime, chunks: [], received: 0 });
      addFileMessage(data.id, data.name, data.size, false);
      break;
    }

    case "file-chunk": {
      const entry = incomingFiles.get(data.id);
      if (!entry) break;
      const buf = data.data instanceof ArrayBuffer ? data.data : new Uint8Array(data.data).buffer;
      entry.chunks.push(buf);
      entry.received += buf.byteLength;
      setFileProgress(data.id, entry.size ? entry.received / entry.size : 0);
      break;
    }

    case "file-end": {
      const entry = incomingFiles.get(data.id);
      if (!entry) break;
      const blob = new Blob(entry.chunks, { type: entry.mime || "application/octet-stream" });
      finishFileMessage(data.id, blob, entry.name, false);
      incomingFiles.delete(data.id);
      break;
    }

    case "file-abort": {
      const entry = incomingFiles.get(data.id);
      if (entry) {
        const node = els.messages.querySelector('[data-file-id="' + data.id + '"]');
        if (node) node.remove();
        incomingFiles.delete(data.id);
      }
      break;
    }
  }
}

async function sendFile(file) {
  if (!conn || !conn.open || sendingFile) return;
  sendingFile = true;
  els.sendBtn.disabled = true;
  els.fileBtn.disabled = true;
  els.sendProgress.hidden = false;

  const fileId = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + "-" + Math.random().toString(36).slice(2);
  addFileMessage(fileId, file.name, file.size, true);

  try {
    conn.send({ type: "file-meta", id: fileId, name: file.name, size: file.size, mime: file.type });

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
      const buf = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
      conn.send({ type: "file-chunk", id: fileId, data: buf });
      const sent = Math.min(offset + CHUNK_SIZE, file.size);
      els.sendProgressBar.style.width = Math.round((sent / file.size) * 100) + "%";
      els.sendProgressLabel.textContent = "Envoi de " + file.name + " — " + Math.round((sent / file.size) * 100) + "%";
    }

    conn.send({ type: "file-end", id: fileId });
    finishFileMessage(fileId, file.slice(0), file.name, true);
    els.sendProgressLabel.textContent = "Fichier envoyé ✓";
    setTimeout(() => { els.sendProgress.hidden = true; }, 1500);
  } catch (err) {
    conn.send({ type: "file-abort", id: fileId });
    const node = els.messages.querySelector('[data-file-id="' + fileId + '"]');
    if (node) node.remove();
    addSystem("Échec de l'envoi du fichier : " + err.message);
  } finally {
    resetProgress();
  }
}

function sendChat() {
  const text = els.textInput.value.trim();
  if (!text || !conn || !conn.open) return;
  conn.send({ type: "chat", text: text });
  addChatMessage(text, true);
  els.textInput.value = "";
  els.textInput.focus();
}

function connectTo(destId) {
  const dest = (destId || "").trim();
  if (!dest) {
    els.connectError.textContent = "Veuillez entrer l'identifiant de votre contact.";
    els.connectError.className = "hint error";
    return;
  }
  if (!peer || peer.destroyed || !peer.open) {
    els.connectError.textContent = "Votre identifiant n'est pas encore prêt, patientez une seconde.";
    els.connectError.className = "hint error";
    return;
  }
  els.connectError.textContent = "";
  setStatus("waiting", "Connexion en cours…");
  const c = peer.connect(dest, { reliable: true });
  bindConnection(c);
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
      connectTo(invited);
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

els.sendBtn.addEventListener("click", sendChat);
els.textInput.addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });

els.fileBtn.addEventListener("click", () => els.fileInput.click());
els.fileInput.addEventListener("change", () => {
  const file = els.fileInput.files[0];
  els.fileInput.value = "";
  if (file) sendFile(file);
});

els.disconnectBtn.addEventListener("click", () => teardown("Hors ligne"));

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
