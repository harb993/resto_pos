# Installs the verified build over the working copy in dist\win-unpacked.
#
# electron-builder wipes its output folder, and the live database lives inside it,
# so the data folders are copied out first and put back afterwards. The app must be
# closed: Windows keeps its files locked while it runs.

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$running = Get-Process -Name "Resto POS" -ErrorAction SilentlyContinue |
           Where-Object { $_.Path -notlike "*dist-test*" }
if ($running) {
    Write-Host "Resto POS is still open. Close it first, then run this again." -ForegroundColor Yellow
    exit 1
}

$stamp = Get-Date -Format "yyyy-MM-dd_HH-mm"
$hold  = Join-Path $env:TEMP "resto_deploy_$stamp"
New-Item -ItemType Directory -Force -Path $hold | Out-Null

foreach ($f in @("data", "data-demo")) {
    $src = "dist\win-unpacked\$f"
    if (Test-Path $src) {
        Copy-Item $src (Join-Path $hold $f) -Recurse -Force
        Write-Host "  saved $f"
    }
}
# A second copy of the real database, kept outside the temp folder.
if (Test-Path "dist\win-unpacked\data\restaurant.db") {
    Copy-Item "dist\win-unpacked\data" "..\resto_pos_DATA_BACKUP_$stamp" -Recurse -Force
    Write-Host "  backup: ..\resto_pos_DATA_BACKUP_$stamp"
}

Write-Host "`nbuilding..."
npm run build
if ($LASTEXITCODE -ne 0) { Write-Host "build failed - nothing was replaced" -ForegroundColor Red; exit 1 }

Write-Host "packaging..."
npx electron-builder --dir
if ($LASTEXITCODE -ne 0) { Write-Host "packaging failed" -ForegroundColor Red }

foreach ($f in @("data", "data-demo")) {
    $keep = Join-Path $hold $f
    if (Test-Path $keep) {
        $dest = "dist\win-unpacked\$f"
        if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
        Copy-Item $keep $dest -Recurse -Force
        Write-Host "  restored $f"
    }
}

if (Test-Path "dist\win-unpacked\data\restaurant.db") {
    Write-Host "`ndone - database in place." -ForegroundColor Green
} else {
    Write-Host "`nWARNING: database missing. Copy it back from ..\resto_pos_DATA_BACKUP_$stamp" -ForegroundColor Red
}
