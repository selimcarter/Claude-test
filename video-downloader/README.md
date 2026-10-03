# Video Downloader (yt-dlp)

Extension Chrome (Manifest V3) qui télécharge la vidéo de l'onglet actif — YouTube, Instagram, TikTok, X/Twitter, Vimeo, Facebook, Reddit, Dailymotion et [plus de 1 000 sites](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md) — en s'appuyant sur [yt-dlp](https://github.com/yt-dlp/yt-dlp) installé sur votre ordinateur.

## Fonctionnement

```
Popup / menu clic droit ──► Service worker ──(Native Messaging)──► host.py ──► yt-dlp (+ ffmpeg)
                                                                              │
                                                       ~/Downloads/VideoDownloader/
```

Une extension seule ne peut pas extraire de façon fiable les flux YouTube (signatures, flux audio/vidéo séparés…). L'extension délègue donc le travail à yt-dlp via un petit programme local (« hôte natif »).

## Installation

### 1. Prérequis

| Outil | Rôle | Installation |
|---|---|---|
| **Python 3.9+** | exécute l'hôte natif | [python.org](https://www.python.org/downloads/) (Windows : cocher « Add to PATH ») |
| **yt-dlp** | téléchargement | `python -m pip install -U "yt-dlp[default]"` (Windows : `py -3 -m pip …`) |
| **ffmpeg** (recommandé) | fusion audio + vidéo HD, MP3 | Windows : `winget install Gyan.FFmpeg` · macOS : `brew install ffmpeg` · Linux : `sudo apt install ffmpeg` |
| **Deno** (pour YouTube) | requis par yt-dlp pour YouTube | Windows : `winget install DenoLand.Deno` · macOS : `brew install deno` · Linux : voir [deno.com](https://deno.com) |

### 2. Charger l'extension

1. Ouvrir `chrome://extensions`, activer le **Mode développeur**.
2. **Charger l'extension non empaquetée** → sélectionner le dossier `video-downloader/extension`.
3. L'ID affiché doit être `ofpdpiefgkoalikmambabdamaodblcif` (fixé par la clé du manifest).

### 3. Installer l'hôte natif

- **Windows** : double-cliquer sur `host/install_windows.bat`.
- **macOS / Linux** : `./host/install.sh`

Les scripts enregistrent l'hôte pour Chrome, Edge et Brave (et Chromium sous macOS/Linux), pour l'utilisateur courant et sans droits administrateur. **Ne déplacez plus le dossier ensuite** (sinon relancez le script).

Ouvrez le popup : il doit afficher « Prêt · yt-dlp … ».

## Utilisation

- **Bouton sur la page** (YouTube, TikTok, Instagram) : un bouton **⬇ Vidéo | ♪ MP3 | ✂ Extrait** apparaît en bas à droite. Sur YouTube il s'affiche sur les pages vidéo ; dans les fils TikTok/Instagram il télécharge la vidéo la plus visible à l'écran (si elle n'est pas trouvée, ouvrez la vidéo puis réessayez).
- **Télécharger un passage** : cliquez **✂ Extrait** sur la page, lancez la vidéo et cliquez **⏱ maintenant** au début puis à la fin du passage voulu (ou tapez les temps, ex. `1:20` et `2:45`), puis **⬇ Vidéo** ou **♪ MP3**. Le même choix existe dans le popup (champs « Extrait », boutons ⏱). Fin vide = jusqu'à la fin ; nécessite ffmpeg.
- **Popup** : sur n'importe quelle page vidéo, choisir Vidéo (MP4) ou Audio (MP3) et la qualité max, puis **Télécharger**. Option :
  - **Toute la playlist / chaîne** : télécharge une playlist YouTube ou les vidéos d'une chaîne dans un sous-dossier (cochée automatiquement sur une page de playlist) ;
- **Raccourci clavier** : `Alt+Maj+D` télécharge la vidéo de l'onglet actif avec les derniers choix du popup (modifiable dans `chrome://extensions/shortcuts`).
- **Clic droit** sur un lien ou une page → « Télécharger la vidéo ».
- Le popup peut être fermé : le téléchargement continue et une notification s'affiche à la fin. Les fichiers arrivent dans `~/Downloads/VideoDownloader/` par défaut (bouton « Afficher »).

## Réglages

Bouton **⚙ Réglages** du popup (ou clic droit sur l'icône → Options) :

- **État** des outils et bouton **Mettre à jour yt-dlp** (à faire quand un site cesse de fonctionner) ;
- **Dossier de téléchargement** (bouton Parcourir… ou chemin complet) ;
- **Miniature et informations** intégrées au fichier, **sous-titres** intégrés (langues au choix, ex. `fr,en`) ;
- **Nombre maximum de vidéos** par playlist (1 à 500) ;
- **Connexion** : réutiliser la session d'un navigateur pour Instagram ou les vidéos réservées. Firefox est recommandé : sous Windows, les cookies de Chrome/Edge sont chiffrés et souvent illisibles par yt-dlp ;
- **Bouton sur les pages** : l'afficher ou non.

Les réglages de la page ont priorité ; `host/config.json` (voir `config.example.json`) reste lu en secours pour le dossier par défaut.

## Dépannage

| Symptôme | Solution |
|---|---|
| « Hôte natif introuvable » | Relancer le script d'installation ; vérifier que l'ID de l'extension est bien `ofpdpiefgkoalikmambabdamaodblcif`. |
| « yt-dlp n'est pas installé » | `python -m pip install -U "yt-dlp[default]"` |
| Échec sur YouTube/TikTok/Instagram alors que ça marchait | Les sites changent souvent : Réglages → **Mettre à jour yt-dlp**. |
| Instagram demande une connexion | Renseigner `cookies_from_browser` (voir ci-dessus). |
| Qualité basse, pas de MP3, pas d'extrait | Installer ffmpeg. |
| Le bouton n'apparaît pas sur la page | Recharger la page (F5) après avoir installé ou rechargé l'extension ; vérifier l'option « Bouton sur les pages ». |

## Permissions de l'extension

| Permission | Pourquoi |
|---|---|
| `nativeMessaging` | dialoguer avec l'hôte local (yt-dlp) |
| `activeTab` | lire l'URL de l'onglet uniquement quand vous ouvrez le popup |
| `storage` | préférences (type/qualité) et état des téléchargements |
| `contextMenus` | entrées « Télécharger » du clic droit |
| accès à youtube.com, tiktok.com, instagram.com | afficher le bouton « Télécharger » sur ces sites (content script, lit uniquement l'URL de la vidéo au clic) |
| `notifications` | prévenir quand un téléchargement se termine ou échoue |

Aucune donnée n'est envoyée à un serveur tiers : seule l'URL de la page est transmise à yt-dlp sur votre machine.

## Limites et usage responsable

- **Usage personnel uniquement** : le Chrome Web Store interdit les extensions qui téléchargent depuis YouTube, cette extension ne peut donc pas y être publiée.
- Téléchargez uniquement des contenus dont vous avez le droit (vos propres vidéos, licences libres, autorisation de l'auteur). Les conditions d'utilisation de YouTube, Instagram et TikTok restreignent le téléchargement.
- Les contenus protégés par DRM (Netflix, Prime Video, Disney+, Spotify…) ne sont pas pris en charge.
