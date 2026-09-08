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

## Stack technique

- Backend : Node.js, Express, Socket.IO (salons, chat, signalisation WebRTC, synchronisation YouTube)
- Frontend : HTML/CSS/JS vanilla (aucune etape de build), API YouTube IFrame, WebRTC natif du navigateur

## Limites connues

- Les salons sont limites a 2 personnes (connexion WebRTC directe, sans serveur media).
- Aucune donnee n'est persistee en base : tout est en memoire et disparait au redemarrage du serveur.
- Netflix/Prime necessitent une synchronisation manuelle (voir ci-dessus) : c'est une contrainte technique des plateformes, pas une limite de ce projet.
