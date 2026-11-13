# P2P Connect Pro

Application web **pair-à-pair (P2P)** de chat et d'envoi de documents, **sans serveur applicatif**.
Les deux personnes doivent simplement être connectées à Internet : les messages et les fichiers
circulent **directement entre les deux navigateurs** via WebRTC, chiffrés de bout en bout (DTLS).

## Fonctionnement

1. Chaque personne ouvre la page : un **identifiant P2P unique** est généré automatiquement.
2. Elle partage son ID (ou son **lien d'invitation** copiable) par mail, SMS ou messagerie.
3. Le contact colle l'ID : la connexion WebRTC s'établit (signaling gratuit PeerJS, utilisé
   **uniquement** pour la mise en relation initiale).
4. Ensuite, tout est direct : chat en temps réel et transfert de documents par morceaux
   (découpage en tranches de 64 Ko avec contrôle de la mémoire tampon et barre de progression).

Aucune donnée (message ou fichier) ne transite par un serveur : seul l'échange des adresses
réseau initiales passe par le signaling PeerJS public.

## Utilisation

L'application est 100 % statique : aucun backend à installer.

### Option 1 — GitHub Pages (recommandé)

Activez GitHub Pages sur la branche principale (`Settings > Pages`), puis ouvrez l'URL du site.

### Option 2 — Serveur statique local

```bash
python -m http.server 8000
```

Ouvrez ensuite `http://localhost:8000`.

> ⚠️ Ouvrez la page dans **deux navigateurs/appareils différents** (deux onglets du même
> navigateur fonctionnent aussi pour tester).

## Fonctionnalités

- Chat en temps réel entre deux personnes
- Envoi de documents de toute taille (découpage automatique, reprise du flux si le réseau ralentit)
- Barre de progression d'envoi et bouton de téléchargement côté destinataire
- Lien d'invitation copiable (`?peer=<id>` pour connexion automatique)
- Statut de connexion en temps réel
- Interface responsive, en français

## Structure

- `index.html` : interface utilisateur
- `static/js/app.js` : client WebRTC/PeerJS (chat + transfert de fichiers)
- `static/css/style.css` : styles

## Limites connues

- Le signaling PeerJS public sert uniquement à la mise en relation ; si les deux réseaux
  bloquent totalement le P2P (NAT très restrictif sans TURN), la connexion peut échouer.
- Une seule conversation à la fois par page.
