# Extension Watch Together (Netflix / Prime Video)

Cette extension complete le site web : elle s'injecte directement dans la page Netflix ou Prime Video (pas dans une iframe) pour piloter la vraie balise `<video>` du lecteur. C'est ce qui permet une **synchronisation automatique reelle** (lecture, pause, position) sur ces deux plateformes, exactement comme des services tels que Teleparty.

Elle ajoute aussi une bulle camera (deplacable) et un chat directement sur la page video, pour ne pas avoir a garder l'onglet du site ouvert a cote.

## Installation (Chrome / Edge / Brave)

1. Ouvrez `chrome://extensions` (ou `edge://extensions`).
2. Activez le **Mode developpeur** (en haut a droite).
3. Cliquez **Charger l'extension non empaquetee** et selectionnez le dossier `extension/` de ce depot.
4. L'icone de l'extension apparait dans la barre d'outils.

## Utilisation

1. Deployez et lancez le serveur Watch Together (voir le README principal) ; notez son URL (ex: `https://votre-app.onrender.com`).
2. Chaque personne ouvre Netflix ou Prime Video dans un onglet et lance la meme video.
3. Chaque personne clique sur l'icone de l'extension, renseigne :
   - l'URL du serveur,
   - le meme **code de salon** (par exemple celui affiche sur le site, ou n'importe quel code choisi en commun),
   - son prenom,
4. Cliquez **Connecter**. Des que les deux personnes sont connectees au meme salon, la camera et le chat apparaissent sur la page, et la lecture/pause/position se synchronisent automatiquement entre les deux navigateurs.

## Pourquoi une extension et pas juste le site ?

Netflix et Prime Video bloquent toute integration dans une iframe (headers anti-iframe + DRM) et n'exposent aucune API publique de lecture : un site web classique ne peut donc pas piloter leur lecteur a distance. Une extension de navigateur, elle, s'execute directement dans le contexte de la page (via un "content script") et peut lire/ecrire les evenements standards du lecteur HTML5 (`play`, `pause`, `currentTime`) exposes par le site lui-meme pour ses propres controles - le flux video chiffre (DRM) n'est jamais touche.

## Notes techniques

- L'extension communique avec le meme serveur que le site, mais via un canal WebSocket brut dedie (`/ext-ws`), plus simple a utiliser depuis un service worker d'extension que le protocole Socket.IO.
- Les salons cote extension sont independants de ceux du site web (meme s'ils utilisent le meme code) : ce sont deux canaux separes sur le meme serveur.
- Chaque salon extension est limite a 2 personnes (connexion camera WebRTC directe entre les deux).
