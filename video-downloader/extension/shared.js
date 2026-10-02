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
