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

- **Popup** : sur une page vidéo, choisir Vidéo (MP4) ou Audio (MP3) et la qualité max, puis **Télécharger**. Le popup peut être fermé : le téléchargement continue et une notification s'affiche à la fin.
- **Clic droit** sur un lien (ex. une vidéo dans un fil TikTok/Instagram) → « Télécharger la vidéo de ce lien », ou sur la page → « Télécharger la vidéo de cette page ». Les options utilisées sont les dernières choisies dans le popup.
- Les fichiers arrivent dans `~/Downloads/VideoDownloader/` (bouton « Afficher » pour ouvrir le dossier).

## Configuration (optionnelle)

Copier `host/config.example.json` en `host/config.json` :

```json
{
  "download_dir": "D:/Videos",
  "cookies_from_browser": "firefox"
}
```

- `download_dir` : dossier de destination.
- `cookies_from_browser` : utilise la session d'un navigateur pour les contenus nécessitant une connexion (Instagram, vidéos avec restriction d'âge…). Firefox est recommandé : sous Windows, les cookies de Chrome sont chiffrés et souvent illisibles par yt-dlp.

## Dépannage

| Symptôme | Solution |
|---|---|
| « Hôte natif introuvable » | Relancer le script d'installation ; vérifier que l'ID de l'extension est bien `ofpdpiefgkoalikmambabdamaodblcif`. |
| « yt-dlp n'est pas installé » | `python -m pip install -U "yt-dlp[default]"` |
| Échec sur YouTube/TikTok/Instagram alors que ça marchait | Les sites changent souvent : mettre à jour yt-dlp avec la même commande. |
| Instagram demande une connexion | Renseigner `cookies_from_browser` (voir ci-dessus). |
| Qualité basse, pas de MP3 | Installer ffmpeg. |

## Permissions de l'extension

| Permission | Pourquoi |
|---|---|
| `nativeMessaging` | dialoguer avec l'hôte local (yt-dlp) |
| `activeTab` | lire l'URL de l'onglet uniquement quand vous ouvrez le popup |
| `storage` | préférences (type/qualité) et état des téléchargements |
| `contextMenus` | entrées « Télécharger » du clic droit |
| `notifications` | prévenir quand un téléchargement se termine ou échoue |

Aucune donnée n'est envoyée à un serveur tiers : seule l'URL de la page est transmise à yt-dlp sur votre machine.

## Limites et usage responsable

- **Usage personnel uniquement** : le Chrome Web Store interdit les extensions qui téléchargent depuis YouTube, cette extension ne peut donc pas y être publiée.
- Téléchargez uniquement des contenus dont vous avez le droit (vos propres vidéos, licences libres, autorisation de l'auteur). Les conditions d'utilisation de YouTube, Instagram et TikTok restreignent le téléchargement.
- Les contenus protégés par DRM (Netflix, Prime Video, Disney+, Spotify…) ne sont pas pris en charge.
