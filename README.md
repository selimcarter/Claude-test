# CinéDuo

Site pour regarder films et séries à deux, à distance : partage d'écran (Netflix, Prime Video…), YouTube synchronisé, caméra en bulle déplaçable, chat et réactions. En ligne sur **https://cineduo.fr**.

## Fonctionnalités

- **Salons à 2 personnes** : créez un salon et partagez le lien. Le dernier salon est mémorisé : en rouvrant l'appli, « Rejoindre en tant que… » suffit (un code choisi à la main, ex. `NOUS2`, sert de salon permanent).
- **Partage d'écran** (Netflix, Prime Video, ou n'importe quel site) : une seule personne partage son onglet, l'autre regarde en direct sans rien installer ni avoir de compte. Image 720p dès le départ, son du film en stéréo, réglage du décalage son/image côté spectateur (bouton 🔊, aussi en plein écran).
- **YouTube** : lecture, pause et position synchronisées automatiquement ; une personne qui arrive reprend la vidéo au même endroit.
- **Caméra** : bulle déplaçable et redimensionnable, visible aussi en plein écran.
- **Chat** : messages en temps réel, historique conservé sur l'appareil (100 derniers messages par salon).
- **Réactions** : bouton 😀 dans la bulle caméra, l'emoji s'affiche par-dessus la vidéo chez les deux.
- **Connexion robuste** : en cas de coupure, la place est gardée 45 s et tout se reconnecte sans recharger ; bandeau « Reconnexion en cours… ».
- **Appli installable** (PWA) : Android Chrome → menu ⋮ → *Installer l'application* ; iPhone Safari → Partager → *Sur l'écran d'accueil*. Bouton ⟳ pour recharger dans l'appli, et bandeau « Nouvelle version disponible » après chaque mise en ligne.
- **Extension navigateur** (quand chacun a son compte Netflix/Prime) : voir [`extension/README.md`](extension/README.md).

## Lancer le site en local

```bash
npm install
npm start
```

Puis ouvrez `http://localhost:3000` dans deux navigateurs (ou deux profils) pour tester avec deux personnes.

## Tests

```bash
npm test
```

Ils tournent aussi automatiquement sur GitHub à chaque envoi (onglet **Actions**).

## Mise en ligne (Render)

Le site a besoin d'un serveur qui tourne en continu (connexions temps réel) : il est hébergé sur [Render](https://render.com), offre gratuite.

1. **New +** → **Web Service** → dépôt `selimcarter/Claude-test`, branche `claude/sync-streaming-platform-4typuw`.
2. **Region** : *Frankfurt* (au plus près de l'Europe et de l'Asie du Sud). **Build** : `npm install` · **Start** : `npm start` · **Instance** : *Free*.
3. **Environment** : voir les variables ci-dessous.
4. Chaque envoi sur la branche est mis en ligne automatiquement. Option conseillée : **Settings → Auto-Deploy → After CI Checks Pass**, pour attendre que les tests passent.
5. **Nom de domaine** (`cineduo.fr`, acheté chez OVH) : Render → **Settings → Custom Domains**, puis dans la zone DNS OVH : un enregistrement **A** (sous-domaine vide) vers l'IP indiquée par Render, et un **CNAME** `www` vers l'adresse `….onrender.com` du service. Supprimer les anciens A / AAAA d'OVH.

Sur l'offre gratuite, le serveur s'endort après 15 min sans personne connectée : la première ouverture prend alors quelques secondes à une minute. Il ne s'endort pas pendant une séance.

### Variables d'environnement

| Variable | Rôle |
|---|---|
| `METERED_DOMAIN` | Nom de l'application Metered, sans `.metered.live` (ex. `tethparty`). |
| `METERED_API_KEY` | Clé d'un identifiant TURN Metered : page **TURN Server → TURN Credentials → Add Credential → Show API Key**, valeur après `apiKey=` (ce n'est **pas** la Secret Key du compte). |
| `METERED_SECRET_KEY` | *Optionnel.* Secret Key du compte Metered (page **Developers**). Le serveur crée alors des identifiants TURN temporaires (12 h, renouvelés toutes les 3 h) au lieu d'utiliser la clé fixe. |
| `ADMIN_TOKEN` | Mot de passe de la page `/admin/logs`. |

Sans les variables Metered, le site utilise un relais TURN public gratuit (moins fiable). Le relais n'est utilisé que si la connexion directe entre les deux appareils échoue ; ses identifiants ne sont donnés qu'aux personnes qui entrent dans un salon.

## Journal des coupures

Chaque coupure (côté serveur et navigateur : heure, appareil, page visible ou non, réseau, raison, état de la vidéo) est enregistrée. Consultation : `https://cineduo.fr/admin/logs` (identifiant au choix + `ADMIN_TOKEN`). Ce journal repart à zéro à chaque redémarrage du serveur ; l'historique plus ancien reste dans **Render → Logs** (rechercher `[diag]`).

## Stack technique

- Backend : Node.js, Express, Socket.IO (salons, chat, signalisation WebRTC, synchro YouTube) + WebSocket brut (`ws`) pour l'extension (`/ext-ws`).
- Frontend : HTML/CSS/JS sans étape de build, API YouTube IFrame, WebRTC natif.
- Extension : Manifest V3 (content script + service worker).

## Limites connues

- 2 personnes maximum par salon (connexion WebRTC directe, sans serveur vidéo).
- Partage d'écran impossible depuis un téléphone (limite des navigateurs mobiles) ; le son du partage ne passe que depuis Chrome / Edge sur ordinateur.
- Les salons du site et de l'extension sont séparés.
