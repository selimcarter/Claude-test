# Installe Video Downloader pour l'utilisateur courant (sans droits admin).
# - Version autonome (dossier runtime\host.exe present) : aucun Python requis,
#   yt-dlp.exe est telecharge dans bin\, ainsi que ffmpeg et Deno s'ils manquent.
# - Version source (sans runtime\) : utilise Python + yt-dlp installes a part.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # Invoke-WebRequest est tres lent avec la barre
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$hostName = 'com.videodownloader.host'
$extensionId = 'ofpdpiefgkoalikmambabdamaodblcif'
$hostDir = $PSScriptRoot
$binDir = Join-Path $hostDir 'bin'
$standaloneHost = Join-Path $hostDir 'runtime\host.exe'
$manifestPath = Join-Path $hostDir "$hostName.json"

function Test-Command($name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

function Save-Download($url, $destination) {
  Write-Host "  - $url"
  Invoke-WebRequest -Uri $url -OutFile $destination -UseBasicParsing
}

# Copie depuis une archive .zip les executables voulus vers bin\.
function Install-FromZip($url, $fileNames) {
  $zip = Join-Path $env:TEMP "video-downloader-$([guid]::NewGuid()).zip"
  $extractDir = "$zip-extract"
  try {
    Save-Download $url $zip
    Expand-Archive -Path $zip -DestinationPath $extractDir -Force
    Get-ChildItem -Path $extractDir -Recurse -Include $fileNames | Copy-Item -Destination $binDir -Force
  } finally {
    Remove-Item -Path $zip, $extractDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# Fichiers issus d'un ZIP telecharge : retire la marque "provenant d'Internet".
Get-ChildItem -Path (Split-Path $hostDir -Parent) -Recurse -File | Unblock-File

if (Test-Path $standaloneHost) {
  Write-Host 'Version autonome : installation des outils dans bin\'
  New-Item -ItemType Directory -Force -Path $binDir | Out-Null

  Save-Download 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' (Join-Path $binDir 'yt-dlp.exe')

  if ((Test-Path (Join-Path $binDir 'ffmpeg.exe')) -or (Test-Command 'ffmpeg')) {
    Write-Host '  - ffmpeg deja present'
  } else {
    Install-FromZip 'https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip' @('ffmpeg.exe', 'ffprobe.exe')
  }

  if ((Test-Path (Join-Path $binDir 'deno.exe')) -or (Test-Command 'deno')) {
    Write-Host '  - Deno deja present'
  } else {
    Install-FromZip 'https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip' @('deno.exe')
  }
  $hostPath = $standaloneHost
} else {
  Write-Host 'Version source : Python et yt-dlp doivent etre installes.'
  if (-not (Test-Command 'py') -and -not (Test-Command 'python')) {
    Write-Warning 'Python 3 introuvable : installez-le depuis https://www.python.org/downloads/ (cochez "Add to PATH").'
  } else {
    Write-Host 'Pensez a installer/mettre a jour yt-dlp :  py -3 -m pip install -U "yt-dlp[default]"'
  }
  if (-not (Test-Command 'ffmpeg')) {
    Write-Warning 'ffmpeg introuvable : installez-le (winget install Gyan.FFmpeg) pour la meilleure qualite et le MP3.'
  }
  $hostPath = Join-Path $hostDir 'host_windows.bat'
}

$manifest = [ordered]@{
  name = $hostName
  description = 'Video Downloader (yt-dlp) native host'
  path = $hostPath
  type = 'stdio'
  allowed_origins = @("chrome-extension://$extensionId/")
}
$json = $manifest | ConvertTo-Json
[System.IO.File]::WriteAllText($manifestPath, $json, (New-Object System.Text.UTF8Encoding $false))

foreach ($browserKey in @('Google\Chrome', 'Microsoft\Edge', 'BraveSoftware\Brave-Browser')) {
  $regPath = "HKCU:\Software\$browserKey\NativeMessagingHosts\$hostName"
  New-Item -Path $regPath -Force | Out-Null
  Set-ItemProperty -Path $regPath -Name '(Default)' -Value $manifestPath
}

Write-Host ''
Write-Host "Hote natif installe : $hostPath"
Write-Host 'Redemarrez Chrome pour terminer.'
