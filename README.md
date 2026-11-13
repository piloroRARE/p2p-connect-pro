# P2P Connect Pro

Application web **pair-à-pair (P2P)** de chat et d'envoi de documents, **sans serveur applicatif**.
Les deux personnes doivent simplement être connectées à Internet : les messages et les fichiers
circulent **directement entre les deux navigateurs** via WebRTC, avec un **double chiffrement** :

- **DTLS** : chiffrement obligatoire du transport WebRTC (intégré aux navigateurs) ;
- **AES-256-GCM de bout en bout** : chaque message et chaque morceau de fichier est chiffré
  avec une clé dérivée localement (PBKDF2-SHA256, 250 000 itérations) d'une **phrase secrète
  partagée** saisie par les deux personnes. La phrase secrète ne quitte jamais les appareils :
  même le signaling PeerJS ne peut pas lire le contenu des échanges.

## Fonctionnement

1. Chaque personne ouvre la page : un **identifiant P2P unique** est généré automatiquement.
2. Elle partage son ID (ou son **lien d'invitation** copiable) par mail, SMS ou messagerie.
3. Le contact colle l'ID : la connexion WebRTC s'établit (signaling gratuit PeerJS, utilisé
   **uniquement** pour la mise en relation initiale).
4. Les deux personnes saisissent la **même phrase secrète** : le chiffrement de bout en bout
   s'active et est vérifié automatiquement.
5. Ensuite, tout est direct : chat en temps réel et transfert de documents chiffrés par morceaux
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
- **Appels audio et vidéo en direct** (P2P, sans serveur) avec micro/caméra, mute, coupure caméra
- **Gestion de réseau intelligente** :
  - mesure de la latence sur le canal de données **avant** chaque appel (estimation affichée) ;
  - adaptation automatique du débit vidéo (2,5 Mbit/s → 150 kbit/s), du débit audio et de la
    résolution (720p → 240p) selon la latence et la perte de paquets mesurées en continu ;
  - coupure vidéo automatique et passage en audio seul si le réseau s'effondre, réactivation
    automatique au rétablissement ;
  - détection des déconnexions ICE et relance automatique de la connexion ;
  - indicateur de qualité en direct (latence, débit, perte) pendant l'appel.
- **Chiffrement de bout en bout AES-256-GCM** de tous les messages et fichiers (clé dérivée de la
  phrase secrète partagée, jamais transmise ; vérification automatique entre les deux contacts).
  Les appels sont protégés par le chiffrement DTLS du transport WebRTC.
- Envoi de documents de toute taille (découpage automatique, reprise du flux si le réseau ralentit)
- Barre de progression d'envoi et bouton de téléchargement côté destinataire
- Lien d'invitation copiable (`?peer=<id>` pour connexion automatique)
- Statut de connexion en temps réel
- Interface responsive, en français

## Structure

- `index.html` : interface utilisateur
- `static/js/app.js` : client WebRTC/PeerJS (chat + transfert de fichiers)
- `static/css/style.css` : styles

## Sécurité

- **Chiffrement** : DTLS (transport WebRTC) + AES-256-GCM de bout en bout pour les messages et
  fichiers ; clé dérivée par PBKDF2-SHA256 (250 000 itérations), non extractible
  (`extractable = false`), jamais transmise ; IV aléatoire unique pour chaque message et chaque
  morceau de fichier.
- **XSS** : aucun contenu distant n'est inséré en HTML — tous les textes (messages, noms de
  fichiers, erreurs) sont affichés via `textContent`.
- **Content Security Policy** stricte : scripts limités au domaine et au CDN PeerJS, pas de
  `object-src`, pas de formulaires ; le script PeerJS est chargé avec un hash **SRI** (toute
  altération du CDN empêche le chargement).
- **Limitation des ressources** (protection contre la saturation mémoire) : file d'attente des
  messages chiffrés non déchiffrables bornée à 300, maximum 5 fichiers reçus simultanément,
  taille maximale de 1 Go par fichier reçu.
- **Appels** : jamais acceptés automatiquement — acceptation explicite obligatoire ; refus
  automatique si un appel est déjà en cours.
- **Bonne pratique** : partagez votre ID uniquement avec les personnes concernées et convenez de
  la phrase secrète par un autre canal (appel, SMS). Une personne qui connaît l'ID seul peut
  tenter de se connecter, mais ne peut rien lire ni envoyer d'utile sans la phrase secrète.
- **Limites** : le signaling PeerJS public connaît votre identifiant et vos adresses IP publiques
  (nécessaire à la mise en relation, mais ne voit jamais le contenu) ; le sel PBKDF2 est fixe
  (un sel par conversation serait préférable) ; les fichiers reçus sont assemblés en mémoire.

## Limites connues

- Le signaling PeerJS public sert uniquement à la mise en relation ; si les deux réseaux
  bloquent totalement le P2P (NAT très restrictif sans TURN), la connexion peut échouer.
- Une seule conversation à la fois par page.
- Si la phrase secrète est perdue ou mal recopiée, les messages reçus restent illisibles :
  il suffit de la ressaisir à l'identique pour déchiffrer les échanges en attente.
