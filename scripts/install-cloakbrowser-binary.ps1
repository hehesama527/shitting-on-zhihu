# Install CloakBrowser Chromium from GitHub via Clash proxy
# Usage: powershell -ExecutionPolicy Bypass -File scripts/install-cloakbrowser-binary.ps1

$ErrorActionPreference = "Stop"

$Proxy = if ($env:CLASH_PROXY) { $env:CLASH_PROXY } else { "http://127.0.0.1:7890" }
$Version = "146.0.7680.177.4"
$CacheDir = if ($env:CLOAKBROWSER_CACHE_DIR) { $env:CLOAKBROWSER_CACHE_DIR } else { Join-Path $env:USERPROFILE ".cloakbrowser" }
$BinaryDir = Join-Path $CacheDir "chromium-$Version"
$ChromeExe = Join-Path $BinaryDir "chrome.exe"
$ZipPath = Join-Path $CacheDir "_download_cloakbrowser-windows-x64.zip"
$Url = "https://github.com/CloakHQ/CloakBrowser/releases/download/chromium-v$Version/cloakbrowser-windows-x64.zip"

Write-Host "CloakBrowser install (GitHub, proxy $Proxy)"
Write-Host "Target: $ChromeExe"

if (Test-Path $ChromeExe) {
    Write-Host "Already installed."
    exit 0
}

New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null

Write-Host "Downloading (~536MB, resumable)..."
curl.exe -x $Proxy -L --retry 5 --retry-delay 5 -C - -o $ZipPath $Url
if ($LASTEXITCODE -ne 0) {
    throw "curl failed with exit code $LASTEXITCODE"
}

$sizeMb = [math]::Round((Get-Item $ZipPath).Length / 1MB, 1)
Write-Host "Downloaded ${sizeMb} MB"

if (Test-Path $BinaryDir) {
    Remove-Item -Recurse -Force $BinaryDir
}
New-Item -ItemType Directory -Force -Path $BinaryDir | Out-Null

Write-Host "Extracting..."
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory($ZipPath, $BinaryDir)

$entries = Get-ChildItem $BinaryDir
if ($entries.Count -eq 1 -and $entries[0].PSIsContainer) {
    $sub = $entries[0].FullName
    Get-ChildItem $sub | ForEach-Object {
        Move-Item $_.FullName (Join-Path $BinaryDir $_.Name) -Force
    }
    Remove-Item -Recurse -Force $sub
}

Remove-Item -Force $ZipPath -ErrorAction SilentlyContinue

if (-not (Test-Path $ChromeExe)) {
    throw "chrome.exe not found after extract: $ChromeExe"
}

Write-Host "Install OK: $ChromeExe" -ForegroundColor Green
