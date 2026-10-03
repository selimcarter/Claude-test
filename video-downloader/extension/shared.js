// Valeurs par defaut partagees entre le service worker, le popup, la page de
// reglages et le content script (charge via importScripts / <script>).

const DEFAULT_PREFS = { mode: 'video', quality: 'best' };

const DEFAULT_SETTINGS = {
  downloadDir: '', // vide = dossier par defaut de l'hote (Telechargements/VideoDownloader)
  cookiesFromBrowser: '', // vide = pas de connexion
  subtitles: false,
  subtitleLangs: 'fr,en',
  thumbnail: true,
  playlistLimit: 50,
  showPageButton: true,
};

const COOKIE_BROWSERS = ['firefox', 'chrome', 'edge', 'brave', 'opera', 'vivaldi', 'chromium', 'safari'];

async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...settings };
}

async function loadPrefs() {
  const { prefs } = await chrome.storage.local.get('prefs');
  return { ...DEFAULT_PREFS, ...prefs };
}

// --- Temps d'extrait --------------------------------------------------------

const TIME_PATTERN = /^\d{1,3}(:\d{1,2}){0,2}(\.\d+)?$/;

// "1:20" -> 80, "1:02:03" -> 3723, "" -> null. Retourne NaN si invalide.
function parseTime(text) {
  const value = String(text).trim();
  if (!value) return null;
  if (!TIME_PATTERN.test(value)) return NaN;
  return value.split(':').reduce((total, part) => total * 60 + Number(part), 0);
}

// 80.4 -> "1:20", 3723 -> "1:02:03"
function formatTime(seconds) {
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${secs}` : `${minutes}:${secs}`;
}

// Retourne { start, end } en secondes, null si aucun extrait, ou leve une erreur.
function buildClip(startText, endText) {
  const start = parseTime(startText);
  const end = parseTime(endText);
  if (Number.isNaN(start) || Number.isNaN(end)) throw new Error('Format de temps invalide (exemple : 1:20).');
  if (end !== null && end <= (start || 0)) throw new Error("La fin de l'extrait doit être après le début.");
  return start || end !== null ? { start, end } : null;
}
