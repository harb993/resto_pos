# Installs this build over a Crispo till, keeping its data.
#
# Copy the whole folder this script sits in onto the till (USB stick is fine), then
# right-click this file > Run with PowerShell. It works on the master and on a node —
# the app works out which it is from its own settings, which are in `data`, which this
# script never touches.
#
# What it does, in order:
#   1. closes the app properly, so SQLite checkpoints its WAL and the shift is closed
#   2. copies `data` and `data-demo` aside, on their own
#   3. copies the WHOLE current install aside, as a one-move rollback
#   4. copies the new files over the top — `data` is never in the way
#   5. names the exe whatever the till already called it, so shortcuts keep working
#
# Nothing is deleted. If anything looks wrong afterwards, rename the folders back.

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$payload = Join-Path $PSScriptRoot 'app'
if (-not (Test-Path (Join-Path $payload 'resources\app.asar'))) {
    Write-Host "Cannot find the new build. Expected it in: $payload" -ForegroundColor Red
    Read-Host "Press Enter to close"; exit 1
}

# ---- Where is the till installed? ----
# The desktop folder is where these are always put; fall back to asking.
$target = Join-Path ([Environment]::GetFolderPath('Desktop')) 'crispo'
if (-not (Test-Path $target)) {
    Write-Host "Could not find $target" -ForegroundColor Yellow
    $target = Read-Host "Full path of the till folder (the one containing Crispo.exe)"
}
if (-not (Test-Path $target)) {
    Write-Host "That folder does not exist. Nothing was changed." -ForegroundColor Red
    Read-Host "Press Enter to close"; exit 1
}

# Whatever this till calls its executable — Crispo.exe on these machines, but the
# shortcuts on the desktop point at it by name, so it must not change.
$exe = Get-ChildItem $target -Filter *.exe |
       Where-Object { $_.Name -notlike 'Update*' } |
       Sort-Object Length -Descending | Select-Object -First 1
$exeName = if ($exe) { $exe.Name } else { 'Crispo.exe' }

Write-Host "Till folder : $target"
Write-Host "Executable  : $exeName"
Write-Host ""

# ---- 1. Close it ----
$running = Get-Process -ErrorAction SilentlyContinue |
           Where-Object { $_.Path -and $_.Path.StartsWith($target, 'OrdinalIgnoreCase') }
if ($running) {
    Write-Host "Closing the app ($($running.Count) process)..." -ForegroundColor Yellow
    foreach ($p in $running) { if ($p.MainWindowHandle -ne 0) { $null = $p.CloseMainWindow() } }
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Seconds 1
        $still = Get-Process -ErrorAction SilentlyContinue |
                 Where-Object { $_.Path -and $_.Path.StartsWith($target, 'OrdinalIgnoreCase') }
        if (-not $still) { break }
    }
    Get-Process -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and $_.Path.StartsWith($target, 'OrdinalIgnoreCase') } |
        Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 4
    Write-Host "  closed" -ForegroundColor Green
}

# ---- 2 & 3. Copies to fall back on ----
$stamp  = Get-Date -Format 'yyyy-MM-dd_HH-mm'
$parent = Split-Path $target -Parent
$name   = Split-Path $target -Leaf

$dataBk = Join-Path $parent "${name}_DATA_BACKUP_$stamp"
New-Item -ItemType Directory -Force -Path $dataBk | Out-Null
foreach ($f in @('data', 'data-demo')) {
    $src = Join-Path $target $f
    if (Test-Path $src) { Copy-Item $src (Join-Path $dataBk $f) -Recurse -Force; Write-Host "  saved $f" }
}
Write-Host "Database copy: $dataBk" -ForegroundColor Green

$oldBk = Join-Path $parent "${name}_OLD_$stamp"
Copy-Item $target $oldBk -Recurse -Force
Write-Host "Rollback copy: $oldBk" -ForegroundColor Green

# ---- 4 & 5. The new build ----
# Copied over the top rather than emptying the folder first: the app is one asar plus
# runtime files with fixed names, so an overwrite replaces it completely, and `data`
# is never at risk of being caught in a delete.
Write-Host ""
Write-Host "Installing..." -ForegroundColor Cyan
Copy-Item (Join-Path $payload '*') $target -Recurse -Force
Copy-Item (Join-Path $target 'Resto POS.exe') (Join-Path $target $exeName) -Force
if ($exeName -ne 'Resto POS.exe') {
    Remove-Item (Join-Path $target 'Resto POS.exe') -Force -ErrorAction SilentlyContinue
}

# ---- Prove the data survived ----
$db = Join-Path $target 'data\restaurant.db'
Write-Host ""
if (Test-Path $db) {
    $kb = [math]::Round((Get-Item $db).Length / 1KB)
    Write-Host "Done. Database in place ($kb KB)." -ForegroundColor Green
} else {
    Write-Host "Done, but data\restaurant.db is MISSING." -ForegroundColor Red
    Write-Host "Copy it back from: $dataBk" -ForegroundColor Red
}
Write-Host ""
Write-Host "Now open the app from its usual shortcut." -ForegroundColor Cyan
Write-Host "On the MASTER: Settings > network > search for devices > Add, next to the other till."
Write-Host ""
Read-Host "Press Enter to close"
