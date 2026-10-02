#!/usr/bin/env bash
# Enregistre l'hote natif pour Chrome / Chromium / Edge / Brave (macOS et Linux).
set -euo pipefail

HOST_NAME="com.videodownloader.host"
EXTENSION_ID="ofpdpiefgkoalikmambabdamaodblcif"
HOST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_PATH="$HOST_DIR/host.py"

chmod +x "$HOST_PATH"

if [[ "$(uname)" == "Darwin" ]]; then
  BASE="$HOME/Library/Application Support"
  TARGETS=("$BASE/Google/Chrome" "$BASE/Chromium" "$BASE/Microsoft Edge" "$BASE/BraveSoftware/Brave-Browser")
else
  BASE="$HOME/.config"
  TARGETS=("$BASE/google-chrome" "$BASE/chromium" "$BASE/microsoft-edge" "$BASE/BraveSoftware/Brave-Browser")
fi

for target in "${TARGETS[@]}"; do
  [[ -d "$target" ]] || continue
  mkdir -p "$target/NativeMessagingHosts"
  cat > "$target/NativeMessagingHosts/$HOST_NAME.json" <<JSON
{
  "name": "$HOST_NAME",
  "description": "Video Downloader (yt-dlp) native host",
  "path": "$HOST_PATH",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXTENSION_ID/"]
}
JSON
  echo "Installe pour : $target"
done

command -v python3 >/dev/null || echo "ATTENTION : python3 introuvable."
python3 -c "import yt_dlp" 2>/dev/null || command -v yt-dlp >/dev/null ||   echo "ATTENTION : yt-dlp introuvable. Installez-le : python3 -m pip install -U 'yt-dlp[default]'"
command -v ffmpeg >/dev/null || echo "ATTENTION : ffmpeg introuvable (meilleure qualite et MP3 indisponibles)."
