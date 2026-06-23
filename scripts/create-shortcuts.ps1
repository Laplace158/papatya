$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$launcher = Join-Path $projectRoot "Papatya.vbs"
$icon = Join-Path $projectRoot "assets\papatya.ico"
$wscript = Join-Path $env:SystemRoot "System32\wscript.exe"

$shell = New-Object -ComObject WScript.Shell

$desktopShortcut = Join-Path ([Environment]::GetFolderPath("Desktop")) "Papatya.lnk"
$startupShortcut = Join-Path ([Environment]::GetFolderPath("Startup")) "Papatya.lnk"
$oldDesktopShortcut = Join-Path ([Environment]::GetFolderPath("Desktop")) "ClipForge.lnk"
$oldStartupShortcut = Join-Path ([Environment]::GetFolderPath("Startup")) "ClipForge.lnk"

function New-PapatyaShortcut($shortcutPath) {
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $wscript
  $shortcut.Arguments = "//nologo `"$launcher`""
  $shortcut.WorkingDirectory = $projectRoot
  if (Test-Path $icon) {
    $shortcut.IconLocation = $icon
  }
  $shortcut.Description = "Papatya background clip recorder"
  $shortcut.Save()
}

New-PapatyaShortcut $desktopShortcut
New-PapatyaShortcut $startupShortcut

Remove-Item -LiteralPath $oldDesktopShortcut,$oldStartupShortcut -Force -ErrorAction SilentlyContinue

Write-Host "Desktop shortcut: $desktopShortcut"
Write-Host "Startup shortcut: $startupShortcut"
