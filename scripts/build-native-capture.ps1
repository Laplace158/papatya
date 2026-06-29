$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$source = Join-Path $root "native\PapatyaNativeCapture"
$build = Join-Path $source "build"
$assetDir = Join-Path $root "assets\native-capture"
$sourceResolved = (Resolve-Path $source).Path

$generators = @("Visual Studio 18 2026", "Visual Studio 17 2022")
$configured = $false

foreach ($generator in $generators) {
  try {
    cmake -S $source -B $build -G $generator -A x64
    $configured = $true
    break
  } catch {
    if (Test-Path $build) {
      $buildResolved = (Resolve-Path $build).Path
      if (-not $buildResolved.StartsWith($sourceResolved, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Native build temizleme yolu proje klasoru disinda: $buildResolved"
      }
      Remove-Item -LiteralPath $buildResolved -Recurse -Force
    }
  }
}

if (-not $configured) {
  throw "Visual Studio C++ generator bulunamadi. Visual Studio Build Tools ve Windows SDK gerekli."
}

cmake --build $build --config Release

New-Item -ItemType Directory -Force -Path $assetDir | Out-Null
Copy-Item (Join-Path $build "Release\PapatyaNativeCapture.exe") (Join-Path $assetDir "PapatyaNativeCapture.exe") -Force
