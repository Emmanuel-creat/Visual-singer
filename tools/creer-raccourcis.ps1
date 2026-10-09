# Visual Singer : raccourcis du Bureau et du menu Démarrer (une application = une fenêtre, sans console).
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$pyw = (Get-Command pythonw.exe -ErrorAction SilentlyContinue).Source
if (-not $pyw) { Write-Host 'pythonw.exe introuvable : installez Python 3 (python.org ou Microsoft Store).'; exit 1 }

& ($pyw -replace 'pythonw\.exe$', 'python.exe') -c 'import webview' 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Host 'Installation de pywebview (fenêtres natives)...'
  & ($pyw -replace 'pythonw\.exe$', 'python.exe') -m pip install --user pywebview
}

$apps = @(
  @{ id = 'accueil';   name = 'Visual Singer';             desc = 'Accueil : les trois outils et l''état des services locaux' },
  @{ id = 'detecteur'; name = 'Visual Singer - Détecteur'; desc = 'Spectre audio 3D en temps réel et identification des sons' },
  @{ id = 'sommeil';   name = 'Visual Singer - Sommeil';   desc = 'Surveillance acoustique du sommeil' },
  @{ id = 'cours';     name = 'Visual Singer - Cours';     desc = 'Transcription et analyse locale de cours' }
)
$shell = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')
$startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Visual Singer'
New-Item -ItemType Directory -Force $startMenu | Out-Null

foreach ($a in $apps) {
  foreach ($dir in @($desktop, $startMenu)) {
    # Le Bureau contient déjà le dossier de données « Visual Singer » : le raccourci d'accueil prend un autre nom.
    $file = if ($dir -eq $desktop -and $a.id -eq 'accueil') { 'Visual Singer - Accueil' } else { $a.name }
    $lnk = $shell.CreateShortcut((Join-Path $dir "$file.lnk"))
    $lnk.TargetPath = $pyw
    $lnk.Arguments = "`"$root\app.py`" --app $($a.id)"
    $lnk.WorkingDirectory = $root
    $lnk.IconLocation = "$root\assets\icons\$($a.id).ico,0"
    $lnk.Description = $a.desc
    $lnk.Save()
  }
  Write-Host "  $($a.name)"
}
Write-Host "Raccourcis créés sur le Bureau et dans le menu Démarrer (dossier Visual Singer)."
