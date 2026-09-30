from flask import Flask, render_template, request, jsonify
from flask_socketio import SocketIO, emit
from datetime import datetime
from pathlib import Path
import json
import os
import uuid

app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "p2p-connect-secret-key-2026")
socketio = SocketIO(app, cors_allowed_origins="*", ping_interval=25, ping_timeout=60)

clients = {}
peer_to_sid = {}
peer_metadata = {}
MESSAGES_FILE = Path(__file__).with_name("messages_history.json")


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


def calculate_network_score(client_data):
    if not isinstance(client_data, dict):
        return 50

    score = 100
    connection_type = client_data.get("connectionType", "unknown")

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

    latency = float(client_data.get("latency", 50) or 50)
    if latency > 80:
        score -= min(18, (latency - 80) / 5)

    packet_loss = float(client_data.get("packetLoss", 0) or 0)
    if packet_loss > 0:
        score -= min(25, packet_loss * 4)

    return max(0, min(100, round(score)))


def get_best_mode(peer1_data, peer2_data):
    score1 = calculate_network_score(peer1_data)
    score2 = calculate_network_score(peer2_data)
    average = (score1 + score2) / 2
    minimum = min(score1, score2)

    if average >= 70:
        return "direct", minimum
    if average >= 50:
        return "direct", minimum
    return "relay", minimum


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/messages")
def api_messages():
    return jsonify({"messages": load_messages()[-50:], "count": len(load_messages())})


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
    if not payload:
        return emit("error", {"message": "Payload invalide"})

    peer_id = payload.get("peerId")
    name = payload.get("name") or "Utilisateur"
    network_info = payload.get("networkInfo") or {}

    if not peer_id:
        return emit("error", {"message": "peerId requis"})

    clients[peer_id] = {
        "name": name,
        "sid": request.sid,
        "connected_at": datetime.now().isoformat(),
        "network_info": network_info,
    }

    peer_to_sid[peer_id] = request.sid
    peer_metadata[peer_id] = {
        "connectionType": network_info.get("type", "unknown"),
        "latency": network_info.get("latency", 60),
        "packetLoss": network_info.get("packetLoss", 0),
        "lastUpdate": datetime.now().isoformat(),
    }

    online_peers = [
        {
            "peerId": pid,
            "name": info["name"],
            "networkScore": calculate_network_score(peer_metadata.get(pid, {})),
            "connectionType": info.get("network_info", {}).get("type", "unknown"),
        }
        for pid, info in clients.items()
        if pid != peer_id
    ]

    emit(
        "peer-registered",
        {
            "peerId": peer_id,
            "name": name,
            "networkScore": calculate_network_score(peer_metadata.get(peer_id, {})),
        },
    )
    emit("online-peers", online_peers, broadcast=True)
    emit("message-history", {"messages": load_messages()[-50:]})


@socketio.on("update-network-info")
def handle_network_update(payload):
    if not payload:
        return

    peer_id = payload.get("peerId")
    network_info = payload.get("networkInfo") or {}

    if not peer_id:
        return

    peer_metadata[peer_id] = {
        "connectionType": network_info.get("type", "unknown"),
        "latency": network_info.get("latency", 60),
        "packetLoss": network_info.get("packetLoss", 0),
        "lastUpdate": datetime.now().isoformat(),
    }

    if peer_id in clients:
        clients[peer_id]["network_info"] = network_info

    online_peers = [
        {
            "peerId": pid,
            "name": info["name"],
            "networkScore": calculate_network_score(peer_metadata.get(pid, {})),
            "connectionType": info.get("network_info", {}).get("type", "unknown"),
        }
        for pid, info in clients.items()
    ]
    emit("online-peers", online_peers, broadcast=True)


@socketio.on("signal")
def handle_signal(payload):
    if not payload:
        return

    target_peer = payload.get("target")
    source_peer = payload.get("from")
    signal_data = payload.get("signal")

    if not target_peer or not signal_data:
        return emit("error", {"message": "Signal invalide"})

    target_sid = peer_to_sid.get(target_peer)
    if not target_sid:
        return emit("error", {"message": f"Le pair {target_peer} n'est pas connecté"})

    source_data = peer_metadata.get(source_peer, {})
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
    if not payload:
        return

    target_peer = payload.get("to")
    from_peer = payload.get("from")
    message_text = payload.get("message")

    if not target_peer or not message_text:
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
    if not payload:
        return

    from_peer = payload.get("from")
    to_peer = payload.get("to")
    message_text = payload.get("message")

    if not from_peer or not to_peer:
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


@socketio.on("disconnect")
def handle_disconnect():
    for peer_id, data in list(clients.items()):
        if data.get("sid") == request.sid:
            del clients[peer_id]
            peer_to_sid.pop(peer_id, None)
            peer_metadata.pop(peer_id, None)
            break

    online_peers = [
        {
            "peerId": pid,
            "name": info["name"],
            "networkScore": calculate_network_score(peer_metadata.get(pid, {})),
            "connectionType": info.get("network_info", {}).get("type", "unknown"),
        }
        for pid, info in clients.items()
    ]
    emit("online-peers", online_peers, broadcast=True)


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
