#!/usr/bin/env python3
"""Hote Native Messaging de l'extension Video Downloader.

Chrome lance ce script et dialogue avec lui sur stdin/stdout (messages JSON
prefixes par leur longueur sur 4 octets). Le script pilote yt-dlp pour
telecharger les videos dans le dossier de telechargement configure.

Uniquement la bibliotheque standard : seul yt-dlp (et idealement ffmpeg)
doivent etre installes a part.
"""

import json
import os
import shutil
import signal
import struct
import subprocess
import sys
import threading
import time
from importlib.util import find_spec
from pathlib import Path

HOST_DIR = Path(__file__).resolve().parent
CONFIG_PATH = HOST_DIR / "config.json"
IS_WINDOWS = os.name == "nt"
MAX_URL_LENGTH = 2048
PROGRESS_INTERVAL_SECONDS = 0.5
QUALITIES = {"best", "1080", "720", "480", "360"}
MODES = {"video", "audio"}

write_lock = threading.Lock()
jobs_lock = threading.Lock()
jobs = {}  # id -> {"process": Popen, "filepath": str | None, "cancelled": bool}


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


def get_download_dir(config):
    configured = config.get("download_dir")
    directory = Path(configured).expanduser() if configured else Path.home() / "Downloads" / "VideoDownloader"
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def find_yt_dlp_command():
    if find_spec("yt_dlp") is not None:
        return [sys.executable, "-m", "yt_dlp"]
    executable = shutil.which("yt-dlp")
    return [executable] if executable else None


def has_ffmpeg():
    return shutil.which("ffmpeg") is not None


def subprocess_options():
    if IS_WINDOWS:
        flags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
        return {"creationflags": flags}
    return {"start_new_session": True}


def get_yt_dlp_version(command):
    try:
        result = subprocess.run(command + ["--version"], capture_output=True, text=True, timeout=30,
                                **subprocess_options())
        return result.stdout.strip() or None
    except (OSError, subprocess.SubprocessError) as error:
        log(f"Impossible d'executer yt-dlp : {error}")
        return None


# --- Telechargements -------------------------------------------------------

def is_valid_url(url):
    return (isinstance(url, str) and len(url) <= MAX_URL_LENGTH
            and url.startswith(("http://", "https://")) and not any(c.isspace() for c in url))


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


def build_command(base_command, url, mode, quality, config, download_dir):
    command = base_command + [
        "--no-playlist",
        "--newline",
        "--progress",
        "--no-mtime",
        "--windows-filenames",
        "--encoding", "utf-8",
        "-P", str(download_dir),
        # Suffixe distinct pour l'audio : sinon la conversion MP3 supprimerait
        # la video du meme nom deja telechargee.
        "-o", "%(title).150B [%(id)s]" + (" (audio)" if mode == "audio" else "") + ".%(ext)s",
        "--progress-template", "download:PROGRESS %(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s",
        "--print", "before_dl:TITLE %(title)s",
        "--print", "after_move:FILE %(filepath)s",
    ]
    command += build_format_args(mode, quality, has_ffmpeg())
    if config.get("cookies_from_browser"):
        command += ["--cookies-from-browser", str(config["cookies_from_browser"])]
    # "--" empeche une URL commencant par "-" d'etre interpretee comme option.
    return command + ["--", url]


def parse_percent(text):
    try:
        return max(0.0, min(100.0, float(text.strip().rstrip("%"))))
    except ValueError:
        return None


def watch_stderr(process, error_lines):
    for line in process.stderr:
        line = line.strip()
        if line:
            error_lines.append(line)
            del error_lines[:-20]


def run_download(job_id, command):
    try:
        env = dict(os.environ, PYTHONUTF8="1", PYTHONIOENCODING="utf-8")
        process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, text=True, encoding="utf-8",
                                   errors="replace", env=env, **subprocess_options())
    except OSError as error:
        send_message({"type": "ERROR", "id": job_id, "message": f"Impossible de lancer yt-dlp : {error}"})
        return

    with jobs_lock:
        jobs[job_id] = {"process": process, "filepath": None, "cancelled": False}

    error_lines = []
    stderr_thread = threading.Thread(target=watch_stderr, args=(process, error_lines), daemon=True)
    stderr_thread.start()

    last_progress_sent = 0.0
    for line in process.stdout:
        line = line.strip()
        if line.startswith("PROGRESS "):
            now = time.monotonic()
            if now - last_progress_sent < PROGRESS_INTERVAL_SECONDS:
                continue
            last_progress_sent = now
            percent, speed, eta = (line[len("PROGRESS "):].split("|") + ["", "", ""])[:3]
            send_message({"type": "PROGRESS", "id": job_id, "percent": parse_percent(percent),
                          "speed": speed.strip(), "eta": eta.strip()})
        elif line.startswith("TITLE "):
            send_message({"type": "TITLE", "id": job_id, "title": line[len("TITLE "):]})
        elif line.startswith("FILE "):
            with jobs_lock:
                jobs[job_id]["filepath"] = line[len("FILE "):]
            send_message({"type": "PROCESSING", "id": job_id})

    return_code = process.wait()
    stderr_thread.join(timeout=5)

    with jobs_lock:
        job = jobs.get(job_id, {})
        cancelled = job.get("cancelled", False)
        filepath = job.get("filepath")

    if cancelled:
        send_message({"type": "CANCELLED", "id": job_id})
    elif return_code == 0 and filepath:
        send_message({"type": "DONE", "id": job_id, "filepath": filepath})
    else:
        errors = [l for l in error_lines if l.startswith("ERROR")] or error_lines or ["Erreur inconnue"]
        send_message({"type": "ERROR", "id": job_id, "message": errors[-1][:500]})


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


# --- Traitement des messages -----------------------------------------------

def handle_message(message, base_command, config):
    message_type = message.get("type")

    if message_type == "PING":
        send_message({
            "type": "PONG",
            "requestId": message.get("requestId"),
            "ytDlpVersion": get_yt_dlp_version(base_command) if base_command else None,
            "ffmpeg": has_ffmpeg(),
            "downloadDir": str(get_download_dir(config)),
        })

    elif message_type == "DOWNLOAD":
        job_id = message.get("id")
        url = message.get("url")
        mode = message.get("mode")
        quality = message.get("quality")
        if not isinstance(job_id, str) or not job_id:
            return
        if not base_command:
            send_message({"type": "ERROR", "id": job_id, "message": "yt-dlp n'est pas installe."})
            return
        if not is_valid_url(url) or mode not in MODES or quality not in QUALITIES:
            send_message({"type": "ERROR", "id": job_id, "message": "Requete invalide."})
            return
        command = build_command(base_command, url, mode, quality, config, get_download_dir(config))
        threading.Thread(target=run_download, args=(job_id, command), daemon=True).start()

    elif message_type == "CANCEL":
        with jobs_lock:
            job = jobs.get(message.get("id"))
            if job:
                job["cancelled"] = True
        if job:
            kill_process_tree(job["process"])

    elif message_type == "OPEN_FOLDER":
        # Le chemin vient de la memoire de l'hote, jamais de l'extension.
        with jobs_lock:
            filepath = jobs.get(message.get("id"), {}).get("filepath")
        try:
            if filepath and Path(filepath).exists():
                open_in_file_manager(Path(filepath), select_file=True)
            else:
                open_in_file_manager(get_download_dir(config), select_file=False)
        except OSError as error:
            log(f"Impossible d'ouvrir le dossier : {error}")


def main():
    setup_binary_stdio()
    config = load_config()
    base_command = find_yt_dlp_command()
    if not base_command:
        log("yt-dlp introuvable (ni module Python, ni executable dans le PATH).")

    while True:
        try:
            message = read_message()
        except (ValueError, UnicodeDecodeError) as error:
            log(f"Message illisible : {error}")
            continue
        if message is None:
            break
        if isinstance(message, dict):
            handle_message(message, base_command, config)

    # Chrome a ferme la connexion : on n'abandonne pas de processus orphelins.
    with jobs_lock:
        processes = [job["process"] for job in jobs.values()]
    for process in processes:
        kill_process_tree(process)


if __name__ == "__main__":
    main()
