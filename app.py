from flask import Flask, render_template
from flask_socketio import SocketIO, emit
import os

app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "p2p-connect-secret")
socketio = SocketIO(app, cors_allowed_origins="*")

clients = {}
peer_to_sid = {}


@app.route("/")
def index():
    return render_template("index.html")


@socketio.on("connect")
def handle_connect():
    emit("server-status", {"status": "connected", "message": "Connected to signaling server"})


@socketio.on("register")
def handle_register(payload):
    data = payload or {}
    peer_id = data.get("peerId")
    name = data.get("name") or "Utilisateur"
    if not peer_id:
        return

    clients[peer_id] = {"name": name, "sid": request.sid}
    peer_to_sid[peer_id] = request.sid

    online = [
        {"peerId": pid, "name": info["name"]}
        for pid, info in clients.items()
        if pid != peer_id
    ]
    emit("online-peers", online, broadcast=True)
    emit("my-peer-id", {"peerId": peer_id, "name": name})


@socketio.on("signal")
def handle_signal(payload):
    if not payload:
        return

    target_peer = payload.get("target")
    source_peer = payload.get("from")
    signal = payload.get("signal")

    if not target_peer or not signal:
        return

    target_sid = peer_to_sid.get(target_peer)
    if target_sid:
        emit(
            "signal",
            {"from": source_peer, "signal": signal, "target": target_peer},
            room=target_sid,
        )


@socketio.on("relay_message")
def handle_relay_message(payload):
    if not payload:
        return

    target_peer = payload.get("to")
    from_peer = payload.get("from")
    message = payload.get("message")

    if not target_peer or not message:
        return

    target_sid = peer_to_sid.get(target_peer)
    if target_sid:
        emit(
            "relay_message",
            {"from": from_peer, "message": message, "timestamp": payload.get("timestamp")},
            room=target_sid,
        )


@socketio.on("disconnect")
def handle_disconnect():
    for peer_id, data in list(clients.items()):
        if data.get("sid") == request.sid:
            del clients[peer_id]
            peer_to_sid.pop(peer_id, None)
            break

    online = [
        {"peerId": pid, "name": info["name"]}
        for pid, info in clients.items()
    ]
    emit("online-peers", online, broadcast=True)


if __name__ == "__main__":
    socketio.run(app, host="0.0.0.0", port=5000, debug=True)
