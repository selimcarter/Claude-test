// ===================== Internationalisation (FR / Ourdou phonetique) =====================
// Le francais reste la langue par defaut et n'est jamais supprime : ce module
// ajoute l'ourdou phonetique (roman urdu, alphabet latin - ex: "shukriya" et
// non "شکریہ") comme option basculable via un bouton, pas un remplacement.
//
// Approche volontairement simple (pas de framework i18n) puisque le site est
// du HTML/JS statique sans etape de build : un dictionnaire de cles ->
// chaines par langue, un helper t(key, vars) pour les chaines generees en JS,
// et des attributs data-i18n-* sur le HTML pour le texte statique.

const TRANSLATIONS = {
  fr: {
    'landing.subtitle': "Regardez YouTube (synchronise automatiquement) ou une plateforme de streaming comme Netflix / Prime Video (synchro manuelle via partage d'ecran) a distance, avec camera et chat.",
    'landing.nameLabel': 'Votre prenom',
    'landing.namePlaceholder': 'Ex: Selim',
    'landing.createRoom': 'Creer un salon',
    'landing.roomCodePlaceholder': 'Code du salon',
    'landing.join': 'Rejoindre',
    'landing.joinAs': 'Rejoindre en tant que {name}',
    'landing.hint': 'Envoyez le lien du salon a la personne avec qui vous voulez regarder.',

    'topbar.roomLabel': 'Salon',
    'topbar.shareLinkTitle': "Partager le lien d'invitation",
    'topbar.shareLink': 'Partager le lien',

    'yt.urlPlaceholder': 'Collez une URL ou un ID YouTube...',
    'yt.load': 'Charger',
    'yt.placeholderHtml': "Collez un lien YouTube ci-dessus pour commencer.<br>La lecture, la pause et le deplacement dans la video seront synchronises automatiquement.",
    'yt.invalidUrl': 'URL ou ID YouTube invalide.',

    'tabs.streaming': 'Streaming',

    'fullscreen.enter': 'Plein ecran',
    'fullscreen.exit': 'Quitter le plein ecran',

    'share.requestPause': '⏸ Demander une pause',
    'share.requestForward': "⏩ Demander d'avancer",
    'share.shareScreen': 'Partager mon ecran',
    'share.stopShare': 'Arreter le partage',
    'share.hintStreaming': "Une seule personne clique ici (Netflix, Prime Video, ou n'importe quel autre site) : son ecran est diffuse en direct a l'autre personne, qui n'a rien a installer ni son propre compte.",
    'share.cantSwitchTab': "Impossible de changer d'onglet pendant un partage d'ecran. Arretez d'abord le partage.",
    'share.unavailable': "Partage d'ecran indisponible : ce navigateur ne le supporte pas (courant sur mobile), ou le site n'est pas en HTTPS.",
    'share.cancelled': "Partage d'ecran annule.",
    'share.failed': "Partage d'ecran impossible ({msg}).",
    'share.peerSharing': "L'autre personne partage son ecran.",
    'share.stopped': "Le partage d'ecran s'est arrete.",
    'share.pauseSent': 'Demande de pause envoyee.',
    'share.forwardSent': "Demande d'avancer envoyee.",
    'share.pauseFromPeer': '⏸ {from} demande une pause !',
    'share.forwardFromPeer': "⏩ {from} demande d'avancer la lecture !",
    'share.text': 'Rejoins-moi sur Watch Together :',

    'chat.title': 'Chat',
    'chat.closeTitle': 'Replier le chat',
    'chat.inputPlaceholder': 'Ecrire un message...',
    'chat.send': 'Envoyer',
    'chat.openTitle': 'Ouvrir le chat',

    'camera.toggleCamTitleGeneric': 'Activer/couper la camera',
    'camera.toggleMicTitleGeneric': 'Activer/couper le micro',
    'camera.turnOffCam': 'Couper la camera',
    'camera.turnOnCam': 'Activer la camera',
    'camera.turnOffMic': 'Couper le micro',
    'camera.turnOnMic': 'Activer le micro',
    'camera.shrinkTitle': 'Reduire la bulle',
    'camera.growTitle': 'Agrandir la bulle',

    'presence.you': '(vous)',

    'status.reconnected': 'Connexion retablie, on se reconnecte au salon...',
    'status.disconnected': 'Connexion au serveur perdue, reconnexion en cours...',
    'status.roomFull': 'Ce salon est deja complet (2 personnes max).',
    'status.peerJoined': '{name} a rejoint le salon.',
    'status.linkCopied': 'Lien copie !',

    'errors.enterNameFirst': "Entrez votre prenom d'abord.",
    'errors.enterRoomCode': 'Entrez un code de salon.',
    'errors.unknown': 'erreur inconnue',

    'media.unavailableHttps': "Camera/micro indisponibles : ce site doit etre ouvert en HTTPS (ou localhost) pour y acceder.",
    'media.whatCameraMic': 'camera/micro',
    'media.errorDenied': "Acces {what} refuse. Autorisez-le dans les parametres du navigateur (icone cadenas/camera dans la barre d'adresse) puis rechargez la page.",
    'media.errorNotFound': 'Aucun peripherique {what} detecte sur cet appareil.',
    'media.errorInUse': '{what} deja utilise par une autre application, un autre onglet ou un autre navigateur. Fermez-le puis reessayez.',
    'media.errorGeneric': "Impossible d'acceder a {what} ({msg}).",

    'video.playOverlay': '▶ Cliquer pour activer la video',
  },
  ur: {
    'landing.subtitle': 'YouTube dekhein (khud-kar sync) ya kisi streaming platform jaise Netflix / Prime Video (screen share ke zariye manual sync) door se, camera aur chat ke saath.',
    'landing.nameLabel': 'Aap ka naam',
    'landing.namePlaceholder': 'Misaal: Selim',
    'landing.createRoom': 'Room banayein',
    'landing.roomCodePlaceholder': 'Room ka code',
    'landing.join': 'Shamil hon',
    'landing.joinAs': '{name} ban kar shamil hon',
    'landing.hint': 'Room ka link us insaan ko bhejein jis ke saath aap dekhna chahte hain.',

    'topbar.roomLabel': 'Room',
    'topbar.shareLinkTitle': 'Dawat ka link share karein',
    'topbar.shareLink': 'Link share karein',

    'yt.urlPlaceholder': 'YouTube URL ya ID paste karein...',
    'yt.load': 'Load karein',
    'yt.placeholderHtml': 'Shuru karne ke liye upar YouTube link paste karein.<br>Play, pause aur video mein aage-peeche karna khud-kar sync ho jayega.',
    'yt.invalidUrl': 'YouTube URL ya ID sahi nahi hai.',

    'tabs.streaming': 'Streaming',

    'fullscreen.enter': 'Full screen',
    'fullscreen.exit': 'Full screen se nikalein',

    'share.requestPause': '⏸ Pause maango',
    'share.requestForward': '⏩ Aage barhne ko kahein',
    'share.shareScreen': 'Apni screen share karein',
    'share.stopShare': 'Sharing band karein',
    'share.hintStreaming': 'Sirf ek insaan yahan click kare (Netflix, Prime Video, ya koi bhi doosri site): uski screen doosre insaan ko live dikhegi, jise kuch install karne ya apna account rakhne ki zaroorat nahi.',
    'share.cantSwitchTab': 'Screen share ke dauran tab nahi badal sakte. Pehle sharing band karein.',
    'share.unavailable': 'Screen sharing available nahi hai: ya to yeh browser ise support nahi karta (mobile par aam baat hai), ya site HTTPS par nahi hai.',
    'share.cancelled': 'Screen sharing cancel kar di gayi.',
    'share.failed': 'Screen sharing nahi ho saki ({msg}).',
    'share.peerSharing': 'Doosra insaan apni screen share kar raha hai.',
    'share.stopped': 'Screen sharing band ho gayi.',
    'share.pauseSent': 'Pause ki maang bhej di gayi.',
    'share.forwardSent': 'Aage barhne ki maang bhej di gayi.',
    'share.pauseFromPeer': '⏸ {from} ne pause mangi hai!',
    'share.forwardFromPeer': '⏩ {from} ne aage barhne ko kaha hai!',
    'share.text': 'Watch Together par mere saath shamil hon:',

    'chat.title': 'Chat',
    'chat.closeTitle': 'Chat band karein',
    'chat.inputPlaceholder': 'Message likhein...',
    'chat.send': 'Bhejein',
    'chat.openTitle': 'Chat kholein',

    'camera.toggleCamTitleGeneric': 'Camera on/off karein',
    'camera.toggleMicTitleGeneric': 'Mic on/off karein',
    'camera.turnOffCam': 'Camera band karein',
    'camera.turnOnCam': 'Camera on karein',
    'camera.turnOffMic': 'Mic band karein',
    'camera.turnOnMic': 'Mic on karein',
    'camera.shrinkTitle': 'Bubble chhoti karein',
    'camera.growTitle': 'Bubble bari karein',

    'presence.you': '(aap)',

    'status.reconnected': 'Connection wapas aa gayi, room se dobara jud rahe hain...',
    'status.disconnected': 'Server se connection toot gayi, dobara jud rahe hain...',
    'status.roomFull': 'Yeh room pehle se bhara hua hai (zyada se zyada 2 log).',
    'status.peerJoined': '{name} room mein shamil ho gaye.',
    'status.linkCopied': 'Link copy ho gaya!',

    'errors.enterNameFirst': 'Pehle apna naam likhein.',
    'errors.enterRoomCode': 'Room ka code likhein.',
    'errors.unknown': 'namaloom masla',

    'media.unavailableHttps': 'Camera/mic available nahi: is site ko HTTPS (ya localhost) par khulna zaroori hai in tak pohanchne ke liye.',
    'media.whatCameraMic': 'camera/mic',
    'media.errorDenied': '{what} ki ijazat nahi mili. Browser settings mein ijazat dein (address bar mein lock/camera icon) phir page reload karein.',
    'media.errorNotFound': 'Is device par koi {what} nahi mila.',
    'media.errorInUse': '{what} pehle se kisi doosri app, tab ya browser mein istemal ho raha hai. Use band karke dobara koshish karein.',
    'media.errorGeneric': '{what} tak pohanch nahi ho saki ({msg}).',

    'video.playOverlay': '▶ Video shuru karne ke liye click karein',
  },
};

const STORAGE_KEY = 'watchTogetherLang';
let currentLang = 'fr';
try {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === 'fr' || saved === 'ur') currentLang = saved;
} catch (e) { /* ignore */ }

function getLang() {
  return currentLang;
}

// Substitution simple de {placeholder} - pas besoin de plus pour ce site.
function t(key, vars) {
  const str = (TRANSLATIONS[currentLang] && TRANSLATIONS[currentLang][key]) || TRANSLATIONS.fr[key] || key;
  if (!vars) return str;
  return Object.keys(vars).reduce((acc, k) => acc.replaceAll(`{${k}}`, vars[k]), str);
}

// Applique les traductions au HTML statique via des attributs data-i18n-* :
// data-i18n (textContent), data-i18n-html (innerHTML, pour le seul texte avec
// un <br> statique ecrit par nous - jamais utilise pour du contenu utilisateur),
// data-i18n-placeholder et data-i18n-title (attributs).
function applyStaticTranslations() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.getAttribute('data-i18n'));
  });
  document.querySelectorAll('[data-i18n-html]').forEach((el) => {
    el.innerHTML = t(el.getAttribute('data-i18n-html'));
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.placeholder = t(el.getAttribute('data-i18n-placeholder'));
  });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = t(el.getAttribute('data-i18n-title'));
  });
  document.querySelectorAll('.lang-toggle-btn').forEach((btn) => {
    btn.textContent = currentLang === 'fr' ? 'اردو' : 'FR';
    btn.title = currentLang === 'fr' ? 'Passer en ourdou phonetique' : 'Français mein badlein';
  });
  document.documentElement.lang = currentLang === 'ur' ? 'ur-Latn' : 'fr';
}

// Certains textes sont fixes dynamiquement par app.js selon l'etat courant
// (titre camera/micro selon on/off, bouton plein ecran selon l'etat) : on
// previent app.js via un evenement plutot que de dupliquer cette logique ici.
function setLang(lang) {
  if (lang !== 'fr' && lang !== 'ur') return;
  currentLang = lang;
  try { localStorage.setItem(STORAGE_KEY, lang); } catch (e) { /* ignore */ }
  applyStaticTranslations();
  // Prefixe pour ne pas se confondre avec l'evenement natif "languagechange"
  // du navigateur (qui se declenche sur window quand l'utilisateur change la
  // langue de son systeme/navigateur - un sujet different de notre selecteur).
  document.dispatchEvent(new CustomEvent('watchtogether-languagechange'));
}

function initI18n() {
  applyStaticTranslations();
  document.querySelectorAll('.lang-toggle-btn').forEach((btn) => {
    btn.addEventListener('click', () => setLang(currentLang === 'fr' ? 'ur' : 'fr'));
  });
}

export { t, getLang, setLang, initI18n };
