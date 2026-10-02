# Enregistre l'hote natif pour Chrome et Edge (utilisateur courant, sans droits admin).
$ErrorActionPreference = 'Stop'
$hostName = 'com.videodownloader.host'
$extensionId = 'ofpdpiefgkoalikmambabdamaodblcif'
$hostDir = $PSScriptRoot
$manifestPath = Join-Path $hostDir "$hostName.json"

$manifest = [ordered]@{
  name = $hostName
  description = 'Video Downloader (yt-dlp) native host'
  path = (Join-Path $hostDir 'host_windows.bat')
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
Write-Host "Hote natif installe : $manifestPath"

if (-not (Get-Command py -ErrorAction SilentlyContinue) -and -not (Get-Command python -ErrorAction SilentlyContinue)) {
  Write-Warning 'Python 3 introuvable : installez-le depuis https://www.python.org/downloads/ (cochez "Add to PATH").'
} else {
  Write-Host 'Pensez a installer/mettre a jour yt-dlp :  py -3 -m pip install -U "yt-dlp[default]"'
}
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
  Write-Warning 'ffmpeg introuvable : installez-le (winget install Gyan.FFmpeg) pour la meilleure qualite et le MP3.'
}
