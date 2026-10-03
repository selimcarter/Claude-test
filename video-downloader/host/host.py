#!/usr/bin/env python3
"""Hote Native Messaging de l'extension Video Downloader.

Chrome lance ce script et dialogue avec lui sur stdin/stdout (messages JSON
prefixes par leur longueur sur 4 octets). Le script pilote yt-dlp pour
telecharger les videos dans le dossier de telechargement configure.

Uniquement la bibliotheque standard : seul yt-dlp (et idealement ffmpeg)
doivent etre installes a part.
"""

import importlib
import json
import math
import os
import re
import shutil
import signal
import struct
import subprocess
import sys
import threading
import time
from importlib.util import find_spec
from pathlib import Path

IS_WINDOWS = os.name == "nt"
# Version Windows sans Python : host.exe (PyInstaller) dans host/runtime/.
IS_FROZEN = getattr(sys, "frozen", False)
APP_DIR = Path(sys.executable).resolve().parent.parent if IS_FROZEN else Path(__file__).resolve().parent
CONFIG_PATH = APP_DIR / "config.json"
# Outils embarques par l'installateur (yt-dlp.exe, ffmpeg, deno), prioritaires sur le PATH.
BIN_DIR = APP_DIR / "bin"
MAX_URL_LENGTH = 2048
PROGRESS_INTERVAL_SECONDS = 0.5
UPDATE_TIMEOUT_SECONDS = 300
FOLDER_PICKER_TIMEOUT_SECONDS = 600
QUALITIES = {"best", "1080", "720", "480", "360"}
MODES = {"video", "audio"}
COOKIE_BROWSERS = {"firefox", "chrome", "edge", "brave", "opera", "vivaldi", "chromium", "safari"}
SUBTITLE_LANGS_PATTERN = re.compile(r"^[A-Za-z0-9*.\-_]+(,[A-Za-z0-9*.\-_]+)*$")
MAX_PLAYLIST_ITEMS = 500

write_lock = threading.Lock()
jobs_lock = threading.Lock()
jobs = {}  # id -> {"process": Popen, "files": [str], "cancelled": bool}

# Selecteur de dossier natif, lance dans un processus a part : Tk doit tourner
# dans le thread principal (obligatoire sur macOS) et ne doit pas bloquer
# la lecture des messages de Chrome.
# Windows : boite de dialogue native via PowerShell (aucun Python requis).
FOLDER_PICKER_POWERSHELL = (
    "Add-Type -AssemblyName System.Windows.Forms;"
    "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog;"
    "$dialog.Description = 'Dossier de telechargement';"
    "$dialog.SelectedPath = $env:VD_INITIAL_DIR;"
    "$owner = New-Object System.Windows.Forms.Form -Property @{TopMost = $true};"
    "if ($dialog.ShowDialog($owner) -eq 'OK') { [Console]::Out.Write($dialog.SelectedPath) }"
)

FOLDER_PICKER_SCRIPT = """
import sys, tkinter
from tkinter import filedialog
root = tkinter.Tk()
root.withdraw()
root.attributes("-topmost", True)
path = filedialog.askdirectory(title="Dossier de telechargement", initialdir=sys.argv[1], mustexist=False)
sys.stdout.write(path or "")
"""


# --- Protocole Native Messaging ------------------------------------------

def setup_binary_stdio():
    if IS_WINDOWS:
        import msvcrt
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)


def read_message():
    raw_length = sys.stdin.buffer.read(4)
    if len(raw_length) < 4:
        return None  # Chrome a ferme la connexion
    length = struct.unpack("<I", raw_length)[0]
    return json.loads(sys.stdin.buffer.read(length).decode("utf-8"))


def send_message(message):
    data = json.dumps(message).encode("utf-8")
    with write_lock:
        sys.stdout.buffer.write(struct.pack("<I", len(data)))
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()


def log(text):
    # stderr est affiche dans les logs de Chrome, jamais dans le protocole.
    print(f"[video-downloader-host] {text}", file=sys.stderr, flush=True)


# --- Configuration et outils -----------------------------------------------

def load_config():
    if not CONFIG_PATH.exists():
        return {}
    try:
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        log(f"config.json illisible, ignore : {error}")
        return {}


def default_download_dir(config):
    configured = config.get("download_dir")
    return Path(configured).expanduser() if configured else Path.home() / "Downloads" / "VideoDownloader"


def resolve_download_dir(requested, config):
    """Dossier choisi dans les reglages de l'extension, sinon config.json / defaut."""
    if isinstance(requested, str) and requested.strip():
        directory = Path(requested.strip()).expanduser()
        if not directory.is_absolute():
            raise ValueError("Le dossier de téléchargement doit être un chemin complet.")
    else:
        directory = default_download_dir(config)
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def tools_search_path():
    return os.pathsep.join([str(BIN_DIR), os.environ.get("PATH", "")])


def tools_env():
    # BIN_DIR en tete du PATH : yt-dlp y trouve ffmpeg et deno embarques.
    return dict(os.environ, PATH=tools_search_path(), PYTHONUTF8="1", PYTHONIOENCODING="utf-8")


def find_tool(name):
    return shutil.which(name, path=tools_search_path())


def bundled_yt_dlp():
    executable = shutil.which("yt-dlp", path=str(BIN_DIR))
    return [executable] if executable else None


def find_yt_dlp_command():
    bundled = bundled_yt_dlp()
    if bundled:
        return bundled
    importlib.invalidate_caches()  # yt-dlp a pu etre installe depuis le lancement
    if not IS_FROZEN and find_spec("yt_dlp") is not None:
        return [sys.executable, "-m", "yt_dlp"]
    executable = find_tool("yt-dlp")
    return [executable] if executable else None


def has_ffmpeg():
    return find_tool("ffmpeg") is not None


def has_deno():
    return find_tool("deno") is not None


def subprocess_options():
    if IS_WINDOWS:
        flags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
        return {"creationflags": flags}
    return {"start_new_session": True}


def get_yt_dlp_version(command):
    try:
        result = subprocess.run(command + ["--version"], capture_output=True, text=True, timeout=30,
                                env=tools_env(), **subprocess_options())
        return result.stdout.strip() or None
    except (OSError, subprocess.SubprocessError) as error:
        log(f"Impossible d'executer yt-dlp : {error}")
        return None


# --- Validation des requetes -------------------------------------------------

def is_valid_url(url):
    return (isinstance(url, str) and len(url) <= MAX_URL_LENGTH
            and url.startswith(("http://", "https://")) and not any(c.isspace() for c in url))


def parse_clip(clip):
    """Retourne (debut, fin) en secondes, fin=None pour "jusqu'a la fin", ou None."""
    if clip is None:
        return None
    if not isinstance(clip, dict):
        raise ValueError("Extrait invalide.")
    start, end = clip.get("start"), clip.get("end")
    for value in (start, end):
        if value is not None and (not isinstance(value, (int, float)) or isinstance(value, bool)
                                  or not math.isfinite(value) or value < 0):
            raise ValueError("Extrait invalide.")
    start = start or 0
    if end is not None and end <= start:
        raise ValueError("La fin de l'extrait doit être après le début.")
    if start == 0 and end is None:
        return None
    return start, end


def format_seconds(value):
    return f"{value:g}"


def build_download_options(message):
    """Valide le message DOWNLOAD et retourne les options normalisees."""
    url, mode, quality = message.get("url"), message.get("mode"), message.get("quality")
    if not is_valid_url(url) or mode not in MODES or quality not in QUALITIES:
        raise ValueError("Requête invalide.")

    playlist_limit = message.get("playlistLimit", 50)
    if not isinstance(playlist_limit, int) or not 1 <= playlist_limit <= MAX_PLAYLIST_ITEMS:
        raise ValueError("Limite de playlist invalide.")

    cookies = message.get("cookiesFromBrowser") or None
    if cookies is not None and cookies not in COOKIE_BROWSERS:
        raise ValueError("Navigateur de connexion invalide.")

    subtitle_langs = message.get("subtitleLangs") or ""
    if message.get("subtitles") and not SUBTITLE_LANGS_PATTERN.match(subtitle_langs):
        raise ValueError("Langues de sous-titres invalides (exemple : fr,en).")

    return {
        "url": url,
        "mode": mode,
        "quality": quality,
        "playlist": bool(message.get("playlist")),
        "playlist_limit": playlist_limit,
        "clip": parse_clip(message.get("clip")),
        "cookies": cookies,
        "subtitles": bool(message.get("subtitles")) and mode == "video",
        "subtitle_langs": subtitle_langs,
        "thumbnail": bool(message.get("thumbnail")),
    }


# --- Construction de la commande yt-dlp -------------------------------------

def build_format_args(mode, quality, ffmpeg_available):
    if mode == "audio":
        if ffmpeg_available:
            return ["-f", "ba/b", "-x", "--audio-format", "mp3", "--audio-quality", "0"]
        return ["-f", "ba[ext=m4a]/ba/b"]

    resolution = "res" if quality == "best" else f"res:{quality}"
    sort_args = ["-S", f"{resolution},ext:mp4:m4a"]
    if ffmpeg_available:
        return ["-f", "bv*+ba/b", "--merge-output-format", "mp4"] + sort_args
    # Sans ffmpeg, impossible de fusionner video + audio : fichier unique.
    return ["-f", "b"] + sort_args


def build_output_template(options):
    name = "%(title).150B [%(id)s]"
    if options["clip"]:
        start, end = options["clip"]
        name += f" (extrait {format_seconds(start)}-{format_seconds(end) if end is not None else 'fin'}s)"
    # Suffixe distinct pour l'audio : sinon la conversion MP3 supprimerait
    # la video du meme nom deja telechargee.
    if options["mode"] == "audio":
        name += " (audio)"
    if options["playlist"]:
        return "%(playlist_title|Playlist).100B/%(playlist_index|0)03d - " + name + ".%(ext)s"
    return name + ".%(ext)s"


def build_command(base_command, options, download_dir, ffmpeg_available):
    command = base_command + [
        "--newline",
        "--progress",
        "--no-mtime",
        "--windows-filenames",
        "--encoding", "utf-8",
        "-P", str(download_dir),
        "-o", build_output_template(options),
        "--progress-template",
        "download:PROGRESS %(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s"
        "|%(info.playlist_index)s|%(info.n_entries)s",
        "--print", "before_dl:TITLE %(title)s",
        "--print", "after_move:FILE %(filepath)s",
    ]

    if options["playlist"]:
        command += ["--yes-playlist", "-I", f"1:{options['playlist_limit']}", "--ignore-errors",
                    "--print", "before_dl:PLAYLIST %(playlist_title)s"]
    else:
        command += ["--no-playlist"]

    command += build_format_args(options["mode"], options["quality"], ffmpeg_available)

    if options["clip"]:
        start, end = options["clip"]
        end_text = format_seconds(end) if end is not None else "inf"
        command += ["--download-sections", f"*{format_seconds(start)}-{end_text}", "--force-keyframes-at-cuts"]

    if options["subtitles"] and ffmpeg_available:
        command += ["--write-subs", "--write-auto-subs", "--sub-langs", options["subtitle_langs"], "--embed-subs"]

    if options["thumbnail"] and ffmpeg_available:
        command += ["--embed-thumbnail", "--embed-metadata"]

    if options["cookies"]:
        command += ["--cookies-from-browser", options["cookies"]]

    # "--" empeche une URL commencant par "-" d'etre interpretee comme option.
    return command + ["--", options["url"]]


# --- Telechargements -------------------------------------------------------

def parse_percent(text):
    try:
        return max(0.0, min(100.0, float(text.strip().rstrip("%"))))
    except ValueError:
        return None


def parse_int(text):
    try:
        return int(text.strip())
    except ValueError:
        return None


def watch_stderr(process, error_lines):
    for line in process.stderr:
        line = line.strip()
        if line:
            error_lines.append(line)
            del error_lines[:-50]


def run_download(job_id, command, is_playlist):
    try:
        process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True, encoding="utf-8",
                                   errors="replace", env=tools_env(), **subprocess_options())
    except OSError as error:
        send_message({"type": "ERROR", "id": job_id, "message": f"Impossible de lancer yt-dlp : {error}"})
        return

    with jobs_lock:
        jobs[job_id] = {"process": process, "files": [], "cancelled": False}

    error_lines = []
    stderr_thread = threading.Thread(target=watch_stderr, args=(process, error_lines), daemon=True)
    stderr_thread.start()

    last_progress_sent = 0.0
    playlist_title_sent = False
    for line in process.stdout:
        line = line.strip()
        if line.startswith("PROGRESS "):
            now = time.monotonic()
            if now - last_progress_sent < PROGRESS_INTERVAL_SECONDS:
                continue
            last_progress_sent = now
            percent, speed, eta, index, total = (line[len("PROGRESS "):].split("|") + [""] * 5)[:5]
            send_message({"type": "PROGRESS", "id": job_id, "percent": parse_percent(percent),
                          "speed": speed.strip(), "eta": eta.strip(),
                          "item": parse_int(index) if is_playlist else None,
                          "itemCount": parse_int(total) if is_playlist else None})
        elif line.startswith("PLAYLIST ") and not playlist_title_sent:
            playlist_title_sent = True
            send_message({"type": "TITLE", "id": job_id, "title": line[len("PLAYLIST "):]})
        elif line.startswith("TITLE ") and not is_playlist:
            send_message({"type": "TITLE", "id": job_id, "title": line[len("TITLE "):]})
        elif line.startswith("FILE "):
            with jobs_lock:
                jobs[job_id]["files"].append(line[len("FILE "):])
            if not is_playlist:
                send_message({"type": "PROCESSING", "id": job_id})

    return_code = process.wait()
    stderr_thread.join(timeout=5)

    with jobs_lock:
        job = jobs.get(job_id, {})
        cancelled = job.get("cancelled", False)
        files = list(job.get("files", []))

    errors = [l for l in error_lines if l.startswith("ERROR")]
    if cancelled:
        send_message({"type": "CANCELLED", "id": job_id})
    elif files and (return_code == 0 or is_playlist):
        # En playlist, --ignore-errors continue apres un echec : succes partiel.
        send_message({"type": "DONE", "id": job_id, "filepath": files[-1],
                      "fileCount": len(files), "failedCount": len(errors)})
    else:
        message = (errors or error_lines or ["Erreur inconnue"])[-1]
        send_message({"type": "ERROR", "id": job_id, "message": message[:500]})


def kill_process_tree(process):
    if process.poll() is not None:
        return
    try:
        if IS_WINDOWS:
            # Tue aussi ffmpeg lance par yt-dlp.
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(process.pid)], capture_output=True,
                           creationflags=subprocess.CREATE_NO_WINDOW)
        else:
            os.killpg(process.pid, signal.SIGTERM)
    except (OSError, subprocess.SubprocessError) as error:
        log(f"Echec de l'arret du processus {process.pid} : {error}")
        process.kill()


def open_in_file_manager(path, select_file):
    if IS_WINDOWS:
        if select_file:
            subprocess.Popen(["explorer", "/select,", str(path)])
        else:
            os.startfile(str(path))
    elif sys.platform == "darwin":
        subprocess.Popen(["open", "-R", str(path)] if select_file else ["open", str(path)])
    else:
        subprocess.Popen(["xdg-open", str(path.parent if select_file else path)])


# --- Maintenance -------------------------------------------------------------

def build_update_command():
    # yt-dlp.exe (embarque ou dans le PATH) se met a jour lui-meme avec -U ;
    # une installation pip se met a jour avec pip.
    bundled = bundled_yt_dlp()
    if bundled:
        return bundled + ["-U"]
    if not IS_FROZEN and find_spec("yt_dlp") is not None:
        return [sys.executable, "-m", "pip", "install", "-U", "yt-dlp[default]"]
    executable = find_tool("yt-dlp")
    return [executable, "-U"] if executable else None


def update_yt_dlp(request_id):
    with jobs_lock:
        busy = any(job["process"].poll() is None for job in jobs.values())
    if busy:
        # Sous Windows, yt-dlp.exe ne peut pas etre remplace pendant qu'il tourne.
        send_message({"type": "UPDATE_RESULT", "requestId": request_id, "ok": False, "busy": True,
                      "output": "Des téléchargements sont en cours : réessayez une fois terminés."})
        return
    command = build_update_command()

    if not command:
        send_message({"type": "UPDATE_RESULT", "requestId": request_id, "ok": False,
                      "output": "yt-dlp est introuvable."})
        return
    try:
        result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace",
                                timeout=UPDATE_TIMEOUT_SECONDS, env=tools_env(), **subprocess_options())
        output = (result.stdout + result.stderr).strip()
        ok = result.returncode == 0
    except (OSError, subprocess.SubprocessError) as error:
        output, ok = str(error), False

    base_command = find_yt_dlp_command()
    send_message({"type": "UPDATE_RESULT", "requestId": request_id, "ok": ok,
                  "version": get_yt_dlp_version(base_command) if base_command else None,
                  "output": output[-1500:]})


def build_folder_picker_command(initial_dir):
    if IS_WINDOWS:
        return ["powershell", "-NoProfile", "-STA", "-Command", FOLDER_PICKER_POWERSHELL]
    return [sys.executable, "-c", FOLDER_PICKER_SCRIPT, str(initial_dir)]


def pick_folder(request_id, initial_dir):
    try:
        # Le dossier initial passe par l'environnement : jamais interprete comme code.
        env = dict(os.environ, VD_INITIAL_DIR=str(initial_dir))
        options = {"creationflags": subprocess.CREATE_NO_WINDOW} if IS_WINDOWS else {}
        result = subprocess.run(build_folder_picker_command(initial_dir), capture_output=True, text=True,
                                encoding="utf-8", errors="replace", timeout=FOLDER_PICKER_TIMEOUT_SECONDS,
                                env=env, **options)
        if result.returncode != 0:
            raise OSError(result.stderr.strip().splitlines()[-1] if result.stderr.strip() else "échec")
        path = result.stdout.strip()
        send_message({"type": "FOLDER_PICKED", "requestId": request_id, "ok": True,
                      "path": str(Path(path)) if path else None})
    except (OSError, subprocess.SubprocessError) as error:
        send_message({"type": "FOLDER_PICKED", "requestId": request_id, "ok": False,
                      "error": f"Sélecteur de dossier indisponible : {error}"})


# --- Traitement des messages -----------------------------------------------

def handle_message(message, config):
    message_type = message.get("type")
    request_id = message.get("requestId")

    if message_type == "PING":
        base_command = find_yt_dlp_command()
        send_message({
            "type": "PONG",
            "requestId": request_id,
            "ytDlpVersion": get_yt_dlp_version(base_command) if base_command else None,
            "ffmpeg": has_ffmpeg(),
            "deno": has_deno(),
            "bundled": bundled_yt_dlp() is not None,
            "defaultDownloadDir": str(default_download_dir(config)),
        })

    elif message_type == "DOWNLOAD":
        job_id = message.get("id")
        if not isinstance(job_id, str) or not job_id:
            return
        base_command = find_yt_dlp_command()
        if not base_command:
            send_message({"type": "ERROR", "id": job_id, "message": "yt-dlp n'est pas installé."})
            return
        try:
            options = build_download_options(message)
            ffmpeg_available = has_ffmpeg()
            if options["clip"] and not ffmpeg_available:
                raise ValueError("ffmpeg est nécessaire pour télécharger un extrait.")
            download_dir = resolve_download_dir(message.get("downloadDir"), config)
        except (ValueError, OSError) as error:
            send_message({"type": "ERROR", "id": job_id, "message": str(error)})
            return
        command = build_command(base_command, options, download_dir, ffmpeg_available)
        threading.Thread(target=run_download, args=(job_id, command, options["playlist"]), daemon=True).start()

    elif message_type == "CANCEL":
        with jobs_lock:
            job = jobs.get(message.get("id"))
            if job:
                job["cancelled"] = True
        if job:
            kill_process_tree(job["process"])

    elif message_type == "OPEN_FOLDER":
        # Le chemin du fichier vient de la memoire de l'hote, jamais de l'extension.
        with jobs_lock:
            files = jobs.get(message.get("id"), {}).get("files") or []
        try:
            if files and Path(files[-1]).exists():
                open_in_file_manager(Path(files[-1]), select_file=True)
            else:
                open_in_file_manager(resolve_download_dir(message.get("downloadDir"), config), select_file=False)
        except (OSError, ValueError) as error:
            log(f"Impossible d'ouvrir le dossier : {error}")

    elif message_type == "UPDATE_YTDLP":
        threading.Thread(target=update_yt_dlp, args=(request_id,), daemon=True).start()

    elif message_type == "PICK_FOLDER":
        initial = message.get("initialDir")
        initial_dir = Path(initial) if isinstance(initial, str) and Path(initial).is_dir() else Path.home()
        threading.Thread(target=pick_folder, args=(request_id, initial_dir), daemon=True).start()


def main():
    setup_binary_stdio()
    config = load_config()

    while True:
        try:
            message = read_message()
        except (ValueError, UnicodeDecodeError) as error:
            log(f"Message illisible : {error}")
            continue
        if message is None:
            break
        if isinstance(message, dict):
            handle_message(message, config)

    # Chrome a ferme la connexion : on n'abandonne pas de processus orphelins.
    with jobs_lock:
        processes = [job["process"] for job in jobs.values()]
    for process in processes:
        kill_process_tree(process)


if __name__ == "__main__":
    main()
