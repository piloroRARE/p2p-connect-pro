# P2P Connect Pro

Application web Python pour un chat pair-à-pair avec sélection automatique du meilleur mode de transport.

## Fonctionnalités

- Chat direct WebRTC entre navigateurs
- Fallback automatique via le serveur en cas de contraintes réseau
- Mode automatique intelligent : direct si possible, relay si besoin
- Interface moderne inspirée du mock-up fourni
- Backend Python avec signalisation Socket.IO

## Prérequis

- Python 3.10+
- Un navigateur moderne (Chrome, Edge, Firefox)

## Installation

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Lancer l'application

```bash
python app.py
```

Ouvrez ensuite :

```text
http://localhost:5000
```

## Modes de connexion

- Auto : le système choisit le meilleur mode automatiquement
- Direct : privilégie WebRTC
- Relay : utilise le serveur comme fallback

La logique d'automatisation repose sur une évaluation des conditions du navigateur et de la qualité réseau pour choisir :

- WebRTC direct si le route est viable
- relay serveur si le réseau est limité, le trafic ne peut pas être établi ou la connexion directe échoue

## Structure

- `app.py` : backend Flask + Socket.IO
- `templates/index.html` : interface utilisateur
- `static/css/style.css` : styles
- `static/js/app.js` : client WebRTC + logique auto mode
