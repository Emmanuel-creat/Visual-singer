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
# Icônes copiées hors de OneDrive : l'Explorateur n'affiche pas toujours une icône de raccourci
# située dans un dossier synchronisé (Bureau OneDrive), alors que la barre des tâches y arrive.
$iconDir = Join-Path $env:LOCALAPPDATA 'Programs\Visual Singer\icons'
New-Item -ItemType Directory -Force $iconDir | Out-Null
Copy-Item "$root\assets\icons\*.ico" $iconDir -Force

$shell = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath('Desktop')
$startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Visual Singer'
New-Item -ItemType Directory -Force $startMenu | Out-Null

foreach ($a in $apps) {
  foreach ($dir in @($desktop, $startMenu)) {
    # Le Bureau contient déjà le dossier de données « Visual Singer » : le raccourci d'accueil prend un autre nom.
    $file = if ($dir -eq $desktop -and $a.id -eq 'accueil') { 'Visual Singer - Accueil' } else { $a.name }
    $path = Join-Path $dir "$file.lnk"
    Remove-Item $path -Force -ErrorAction SilentlyContinue   # recréé : l'Explorateur relit l'icône
    $lnk = $shell.CreateShortcut($path)
    $lnk.TargetPath = $pyw
    $lnk.Arguments = "`"$root\app.py`" --app $($a.id)"
    $lnk.WorkingDirectory = $root
    $lnk.IconLocation = "$iconDir\$($a.id).ico,0"
    $lnk.Description = $a.desc
    $lnk.Save()
  }
  Write-Host "  $($a.name)"
}
# Rafraîchit les icônes du Bureau (SHChangeNotify SHCNE_ASSOCCHANGED)
Add-Type -Namespace VS -Name Shell -MemberDefinition '[DllImport("shell32.dll")] public static extern void SHChangeNotify(int e, int f, IntPtr a, IntPtr b);'
[VS.Shell]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)
Write-Host "Raccourcis créés sur le Bureau et dans le menu Démarrer (dossier Visual Singer)."
