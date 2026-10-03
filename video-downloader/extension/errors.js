// Traduction des erreurs techniques (yt-dlp, ffmpeg, Native Messaging) en
// messages clairs en francais. Le message d'origine reste disponible en
// "details" pour le depannage.

const ERROR_RULES = [
  // Hote natif / installation
  { test: /native messaging host not found/i, message: "L'outil de téléchargement n'est pas installé.", hint: 'Lancez host\\install_windows.bat puis redémarrez Chrome.' },
  { test: /access to the specified native messaging host is forbidden/i, message: "L'outil de téléchargement est mal enregistré.", hint: "Relancez install_windows.bat (l'ID de l'extension doit être ofpdpiefgkoalikmambabdamaodblcif)." },
  { test: /native host has exited|error when communicating with the native messaging host/i, message: "L'outil de téléchargement s'est arrêté.", hint: 'Relancez install_windows.bat ; en version source, vérifiez Python et yt-dlp.' },
  { test: /yt-dlp n'est pas installé/i, message: "yt-dlp n'est pas installé.", hint: 'Relancez install_windows.bat.' },

  // Contenu inaccessible
  { test: /is DRM protected|\bDRM\b/i, message: 'Vidéo protégée (DRM) : impossible de la télécharger.' },
  { test: /private video|set to private|this video is private/i, message: 'Cette vidéo est privée.' },
  { test: /members[- ]only|join this channel/i, message: 'Vidéo réservée aux membres de la chaîne.' },
  { test: /confirm you.?re not a bot/i, message: 'YouTube demande une vérification anti-robot.', hint: 'Réessayez plus tard, ou activez la connexion dans les Réglages (Firefox).' },
  { test: /confirm your age|age[- ]restricted|inappropriate for some users/i, message: 'Vidéo soumise à une limite d\'âge.', hint: 'Activez la connexion dans les Réglages (navigateur où vous êtes connecté).' },
  { test: /geo.?restrict|not available (in|from) your (country|location)|geoblock/i, message: 'Vidéo bloquée dans votre pays.' },
  { test: /live event will begin|premieres in|not available yet/i, message: "Cette vidéo n'est pas encore disponible (direct ou première à venir)." },
  { test: /video unavailable|this video is not available|has been removed|no longer available|does not exist/i, message: 'Vidéo indisponible ou supprimée.' },
  { test: /login required|log in to access|you need to log in|requires? (authentication|login)|rate-limit reached/i, message: 'Ce contenu demande d\'être connecté.', hint: 'Réglages → Connexion : choisissez le navigateur où vous êtes connecté (Firefox recommandé).' },

  // Cookies de navigateur
  { test: /could not copy chrome cookie database|failed to decrypt|cookies database|could not find .* cookies/i, message: 'Impossible de lire la connexion du navigateur choisi.', hint: 'Fermez ce navigateur et réessayez, ou choisissez Firefox dans les Réglages.' },

  // Outils manquants
  { test: /no supported javascript runtime|js.?runtime/i, message: 'Deno est nécessaire pour YouTube.', hint: 'Relancez install_windows.bat, ou : winget install DenoLand.Deno' },
  { test: /ffmpeg (is not installed|not found)|ffmpeg est nécessaire/i, message: 'ffmpeg est nécessaire pour cette option (HD, MP3 ou extrait).', hint: 'Relancez install_windows.bat, ou : winget install Gyan.FFmpeg' },

  // Site, format, reseau
  { test: /unsupported url/i, message: "Ce site ou cette page n'est pas pris en charge." },
  { test: /requested format is not available|no video formats found/i, message: "Ce format n'est pas disponible pour cette vidéo.", hint: 'Essayez une autre qualité ou le mode MP3.' },
  { test: /http error 429|too many requests/i, message: 'Le site limite les téléchargements pour le moment.', hint: 'Réessayez dans quelques minutes.' },
  { test: /http error 404/i, message: 'Vidéo introuvable (erreur 404).' },
  { test: /http error 403|forbidden/i, message: 'Accès refusé par le site.', hint: 'Mettez yt-dlp à jour (Réglages), puis réessayez.' },
  { test: /unable to extract|signature extraction failed|nsig extraction failed|unable to download api page/i, message: 'Le site a changé et yt-dlp doit être mis à jour.', hint: 'Réglages → Mettre à jour yt-dlp.' },
  { test: /no space left|disk full|errno 28/i, message: 'Disque plein : libérez de la place puis réessayez.' },
  { test: /permission denied|access is denied|errno 13/i, message: "Impossible d'écrire dans le dossier de téléchargement.", hint: 'Choisissez un autre dossier dans les Réglages.' },
  { test: /getaddrinfo|name or service not known|timed out|connection (refused|reset|aborted)|network is unreachable|unable to download webpage/i, message: 'Problème de connexion Internet.', hint: 'Vérifiez votre connexion puis réessayez.' },
  { test: /interrompu|host.*déconnecté/i, message: 'Téléchargement interrompu.', hint: 'Relancez-le.' },
];

// Retourne { message, hint, details } ; message toujours en francais.
function explainError(rawMessage) {
  const details = String(rawMessage || '').trim();
  const rule = ERROR_RULES.find(({ test }) => test.test(details));
  if (rule) return { message: rule.message, hint: rule.hint || '', details };
  // Messages deja en francais (validation de l'hote ou de l'extension).
  if (!/^error:/i.test(details) && /[éèàùç]|\b(le|la|les|une?|du|est)\b/i.test(details)) {
    return { message: details, hint: '', details };
  }
  return { message: 'Le téléchargement a échoué.', hint: 'Voir le détail technique ci-dessous.', details };
}
