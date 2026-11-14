from flask import Flask, render_template, request, jsonify
from flask_socketio import SocketIO, emit
from datetime import datetime
from pathlib import Path
import json
import math
import os
import re
import uuid

app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "p2p-connect-secret-key-2026")
socketio = SocketIO(app, cors_allowed_origins="*", ping_interval=25, ping_timeout=60)

clients = {}
peer_to_sid = {}
peer_metadata = {}
MESSAGES_FILE = Path(__file__).with_name("messages_history.json")
MAX_MESSAGE_LENGTH = 500
MAX_NAME_LENGTH = 50
PEER_ID_RE = re.compile(r"^[A-Za-z0-9_-]{3,64}$")


def sanitize_peer_id(value):
    if not isinstance(value, str):
        return None
    peer_id = value.strip()
    if not peer_id or not PEER_ID_RE.fullmatch(peer_id):
        return None
    return peer_id


def sanitize_name(value):
    if value is None:
        return "Utilisateur"
    name = str(value).strip()
    if not name:
        return "Utilisateur"
    name = re.sub(r"\s+", " ", name)
    return name[:MAX_NAME_LENGTH]


def sanitize_message(value):
    if value is None:
        return None
    message = str(value).strip()
    if not message:
        return None
    return message[:MAX_MESSAGE_LENGTH]


def build_online_peers(exclude_peer_id=None):
    peers = []
    for pid, info in clients.items():
        if exclude_peer_id and pid == exclude_peer_id:
            continue
        peers.append(
            {
                "peerId": pid,
                "name": info.get("name", "Utilisateur"),
                "networkScore": calculate_network_score(peer_metadata.get(pid, {})),
                "connectionType": info.get("network_info", {}).get("type", "unknown"),
            }
        )
    return peers


def load_messages():
    if MESSAGES_FILE.exists():
        try:
            with open(MESSAGES_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            return data if isinstance(data, list) else []
        except (OSError, json.JSONDecodeError):
            return []
    return []


def save_message(message_data):
    messages = load_messages()
    messages.append(message_data)
    try:
        with open(MESSAGES_FILE, "w", encoding="utf-8") as f:
            json.dump(messages[-200:], f, ensure_ascii=False, indent=2)
    except OSError as exc:
        print(f"Erreur sauvegarde messages: {exc}")


def to_float(value, default=0.0):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return float(default)
    if not math.isfinite(number):
        return float(default)
    return number


def calculate_network_score(client_data):
    if not isinstance(client_data, dict):
        return 50

    score = 100
    connection_type = str(client_data.get("connectionType", "unknown")).lower()

    if connection_type == "4g":
        score -= 0
    elif connection_type == "3g":
        score -= 12
    elif connection_type == "2g":
        score -= 25
    elif connection_type == "slow-2g":
        score -= 40
    else:
        score -= 6

    latency = max(0.0, to_float(client_data.get("latency", 50), 50.0))
    if latency > 80:
        score -= min(18, (latency - 80) / 5)

    packet_loss = max(0.0, to_float(client_data.get("packetLoss", 0), 0.0))
    if packet_loss > 0:
        score -= min(25, packet_loss * 4)

    return max(0, min(100, round(score)))


def get_best_mode(peer1_data, peer2_data):
    score1 = calculate_network_score(peer1_data)
    score2 = calculate_network_score(peer2_data)
    average = (score1 + score2) / 2
    minimum = min(score1, score2)

    if average >= 50:
        return "direct", minimum
    return "relay", minimum


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/messages")
def api_messages():
    messages = load_messages()
    return jsonify({"messages": messages[-50:], "count": len(messages)})


@socketio.on("connect")
def handle_connect():
    emit(
        "server-status",
        {
            "status": "connected",
            "message": "Connexion au serveur de signalisation établie",
            "timestamp": datetime.now().isoformat(),
        },
    )


@socketio.on("register")
def handle_register(payload):
    if not isinstance(payload, dict):
        return emit("error", {"message": "Payload invalide"})

    peer_id = sanitize_peer_id(payload.get("peerId"))
    name = sanitize_name(payload.get("name"))
    network_info = payload.get("networkInfo") if isinstance(payload.get("networkInfo"), dict) else {}

    if not peer_id:
        return emit("error", {"message": "peerId requis"})

    if peer_id in clients and clients[peer_id].get("sid") != request.sid:
        previous_sid = clients[peer_id].get("sid")
        if previous_sid:
            emit("peer-disconnected", {"peerId": peer_id}, room=previous_sid)

    clients[peer_id] = {
        "name": name,
        "sid": request.sid,
        "connected_at": datetime.now().isoformat(),
        "network_info": network_info,
    }

    peer_to_sid[peer_id] = request.sid
    peer_metadata[peer_id] = {
        "connectionType": str(network_info.get("type", "unknown")).lower(),
        "latency": to_float(network_info.get("latency", 60), 60.0),
        "packetLoss": to_float(network_info.get("packetLoss", 0), 0.0),
        "lastUpdate": datetime.now().isoformat(),
    }

    emit(
        "peer-registered",
        {
            "peerId": peer_id,
            "name": name,
            "networkScore": calculate_network_score(peer_metadata.get(peer_id, {})),
        },
    )
    emit("online-peers", build_online_peers(), broadcast=True)
    emit("message-history", {"messages": load_messages()[-50:]})


@socketio.on("update-network-info")
def handle_network_update(payload):
    if not isinstance(payload, dict):
        return

    peer_id = sanitize_peer_id(payload.get("peerId"))
    network_info = payload.get("networkInfo") if isinstance(payload.get("networkInfo"), dict) else {}

    if not peer_id:
        return

    peer_metadata[peer_id] = {
        "connectionType": str(network_info.get("type", "unknown")).lower(),
        "latency": to_float(network_info.get("latency", 60), 60.0),
        "packetLoss": to_float(network_info.get("packetLoss", 0), 0.0),
        "lastUpdate": datetime.now().isoformat(),
    }

    if peer_id in clients:
        clients[peer_id]["network_info"] = network_info

    emit("online-peers", build_online_peers(), broadcast=True)


@socketio.on("signal")
def handle_signal(payload):
    if not isinstance(payload, dict):
        return

    target_peer = sanitize_peer_id(payload.get("target"))
    source_peer = sanitize_peer_id(payload.get("from"))
    signal_data = payload.get("signal")

    if not target_peer or not signal_data:
        return emit("error", {"message": "Signal invalide"})

    target_sid = peer_to_sid.get(target_peer)
    if not target_sid:
        return emit("error", {"message": f"Le pair {target_peer} n'est pas connecté"})

    source_data = peer_metadata.get(source_peer, {}) if source_peer else {}
    target_data = peer_metadata.get(target_peer, {})
    recommended_mode, confidence = get_best_mode(source_data, target_data)

    emit(
        "signal",
        {
            "from": source_peer,
            "signal": signal_data,
            "target": target_peer,
            "recommendedMode": recommended_mode,
            "modeConfidence": confidence,
            "timestamp": datetime.now().isoformat(),
        },
        room=target_sid,
    )


@socketio.on("relay-message")
def handle_relay_message(payload):
    if not isinstance(payload, dict):
        return

    target_peer = sanitize_peer_id(payload.get("to"))
    from_peer = sanitize_peer_id(payload.get("from"))
    message_text = sanitize_message(payload.get("message"))

    if not target_peer or not from_peer or not message_text:
        return emit("error", {"message": "Message relais invalide"})

    target_sid = peer_to_sid.get(target_peer)
    if not target_sid:
        return emit("error", {"message": f"Le pair {target_peer} n'est pas connecté"})

    message_record = {
        "id": str(uuid.uuid4()),
        "from": from_peer,
        "to": target_peer,
        "message": message_text,
        "timestamp": datetime.now().isoformat(),
        "deliveryMode": "relay",
    }
    save_message(message_record)

    emit(
        "relay-message",
        {
            "from": from_peer,
            "message": message_text,
            "timestamp": message_record["timestamp"],
            "deliveryMode": "relay",
        },
        room=target_sid,
    )


@socketio.on("direct-message-sent")
def handle_direct_message(payload):
    if not isinstance(payload, dict):
        return

    from_peer = sanitize_peer_id(payload.get("from"))
    to_peer = sanitize_peer_id(payload.get("to"))
    message_text = sanitize_message(payload.get("message"))

    if not from_peer or not to_peer or not message_text:
        return

    message_record = {
        "id": str(uuid.uuid4()),
        "from": from_peer,
        "to": to_peer,
        "message": message_text,
        "timestamp": datetime.now().isoformat(),
        "deliveryMode": "direct",
    }
    save_message(message_record)


@socketio.on("request-online-peers")
def handle_request_online_peers():
    emit("online-peers", build_online_peers())


@socketio.on("disconnect")
def handle_disconnect():
    peer_id = None
    for pid, data in list(clients.items()):
        if data.get("sid") == request.sid:
            peer_id = pid
            del clients[pid]
            peer_to_sid.pop(pid, None)
            peer_metadata.pop(pid, None)
            break

    if peer_id:
        emit("peer-disconnected", {"peerId": peer_id}, broadcast=True)
        emit("online-peers", build_online_peers(), broadcast=True)


if __name__ == "__main__":
    if not MESSAGES_FILE.exists():
        with open(MESSAGES_FILE, "w", encoding="utf-8") as f:
            json.dump([], f)

    print("\n" + "=" * 64)
    print("  P2P Connect Pro - Serveur de signalisation")
    print("=" * 64)
    print("  URL: http://localhost:5000")
    print(f"  Historique: {MESSAGES_FILE.resolve()}")
    print("=" * 64 + "\n")
    socketio.run(app, host="0.0.0.0", port=5000, debug=True)
