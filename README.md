# Watch Together

Site pour regarder du contenu a distance avec une autre personne : chat texte, camera deplacable (webcam en incrustation), et synchronisation video.

## Fonctionnalites

- **Salons** : creez un salon (code a 6 caracteres) et partagez le lien pour que l'autre personne rejoigne (2 personnes par salon).
- **YouTube** : synchronisation automatique et reelle de la lecture/pause/position via l'API officielle YouTube IFrame.
- **Netflix / Amazon Prime** : ces plateformes bloquent toute integration externe (DRM, headers anti-iframe, aucune API de lecture publique). Un site web ne peut donc pas piloter leur lecteur a distance. A la place :
  - un bouton ouvre la plateforme dans un nouvel onglet pour chaque personne,
  - un compte a rebours partage permet de lancer la lecture en meme temps,
  - un bouton "Pause maintenant !" envoie une notification a l'autre personne pour qu'elle mette en pause manuellement.
- **Camera** : chaque personne partage sa webcam (WebRTC pair-a-pair). La bulle video est deplacable a la souris/au doigt n'importe ou sur l'ecran (position sauvegardee localement).
- **Chat** : messages texte en temps reel dans le salon.

## Lancer le site en local

```bash
npm install
npm start
```

Puis ouvrez `http://localhost:3000` dans deux navigateurs (ou deux profils) pour tester avec deux personnes.

## Mettre le site en ligne (pour y acceder depuis un telephone)

Ce site a besoin d'un serveur qui tourne en continu (Socket.IO garde une connexion ouverte), donc un hebergeur d'archives statiques (type Vercel/Netlify gratuit) ne convient pas. **Render** offre un service gratuit qui fonctionne bien pour ca :

1. Allez sur [render.com](https://render.com) et connectez-vous avec votre compte GitHub.
2. Cliquez **New +** puis **Web Service**.
3. Choisissez le depot `selimcarter/claude-test` et la branche `claude/sync-streaming-platform-4typuw`.
4. Renseignez :
   - **Build Command** : `npm install`
   - **Start Command** : `npm start`
   - **Instance Type** : `Free`
5. Cliquez **Create Web Service**. Au bout de 1-2 minutes, Render fournit une URL publique (`https://xxxx.onrender.com`) que vous pourrez ouvrir depuis votre telephone et partager avec l'autre personne.

(Alternative equivalente : [Railway](https://railway.app), meme principe : connecter le depot, `npm install` / `npm start`.)

Note : sur le plan gratuit de Render, le serveur s'endort apres une periode d'inactivite et met quelques secondes a se reveiller au premier chargement.

## Stack technique

- Backend : Node.js, Express, Socket.IO (salons, chat, signalisation WebRTC, synchronisation YouTube)
- Frontend : HTML/CSS/JS vanilla (aucune etape de build), API YouTube IFrame, WebRTC natif du navigateur

## Limites connues

- Les salons sont limites a 2 personnes (connexion WebRTC directe, sans serveur media).
- Aucune donnee n'est persistee en base : tout est en memoire et disparait au redemarrage du serveur.
- Netflix/Prime necessitent une synchronisation manuelle (voir ci-dessus) : c'est une contrainte technique des plateformes, pas une limite de ce projet.
