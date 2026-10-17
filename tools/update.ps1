#requires -version 3
<#
    تحديث سريع لبرنامج أبو الدهب

    يستبدل ملف البرنامج (resources\app.asar) فقط. محرك البرنامج وملفات ويندوز
    لا تتغير بين النسختين، وكل التعديلات موجودة داخل هذا الملف الواحد — لذلك
    التحديث 11 ميجا بدل 195.

    مجلد data لا يُمس إطلاقاً.
#>

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Line { param($t) Write-Host $t }
function Fail { param($t) Write-Host ''; Write-Host "[خطأ] $t" -ForegroundColor Red; Write-Host ''; Read-Host 'اضغط Enter للإغلاق' | Out-Null; exit 1 }

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$source = Join-Path $here 'resources\app.asar'

Line ''
Line '============================================'
Line '   تحديث سريع — أبو الدهب'
Line '============================================'
Line ''

if (-not (Test-Path $source)) {
    Fail "ملف التحديث غير موجود بجوار هذا السكربت. فُك ضغط الملف بالكامل أولاً."
}

$target = if ($args.Count -gt 0 -and $args[0]) { $args[0] } else { $null }

# Find the program by itself, so a double-click is enough: first where the desktop
# shortcut «أبو الدهب» points (the program makes it on its first run), then the usual
# folder on the desktop, then any folder on the desktop holding AboElDahab.exe.
if (-not $target) {
    $found = @()
    $desktops = @([Environment]::GetFolderPath('Desktop'), (Join-Path $env:USERPROFILE 'Desktop')) |
        Where-Object { $_ -and (Test-Path $_) } | Sort-Object -Unique
    try {
        $shell = New-Object -ComObject WScript.Shell
        foreach ($d in $desktops) {
            foreach ($l in Get-ChildItem -LiteralPath $d -Filter *.lnk -ErrorAction SilentlyContinue) {
                # WScript cannot open a shortcut with an Arabic name — read a copy.
                $probe = Join-Path $env:TEMP 'aboeldahab-probe.lnk'
                Copy-Item -LiteralPath $l.FullName $probe -Force
                $t = $shell.CreateShortcut($probe).TargetPath
                if ($t -and (Split-Path -Leaf $t) -ieq 'AboElDahab.exe' -and (Test-Path $t)) { $found += (Split-Path -Parent $t) }
            }
        }
    } catch { }
    foreach ($d in $desktops) {
        foreach ($exe in Get-ChildItem -LiteralPath $d -Filter AboElDahab.exe -Recurse -Depth 1 -ErrorAction SilentlyContinue) {
            $found += $exe.DirectoryName
        }
    }
    # Never the update's own folder, and each folder once.
    $found = @($found | ForEach-Object { (Resolve-Path $_).Path } |
        Where-Object { $_ -ne $here } | Sort-Object -Unique)
    if ($found.Count -eq 1) {
        $target = $found[0]
        Line "   وجدت البرنامج في: $target"
        Line ''
    } elseif ($found.Count -gt 1) {
        Line 'وجدت البرنامج في أكثر من مكان:'
        $found | ForEach-Object { Line "   $_" }
        Line ''
    }
}

if (-not $target) {
    Line 'اسحب مجلد البرنامج وألقِه على UPDATE.bat،'
    Line 'أو اكتب مساره الآن ثم اضغط Enter:'
    Line '   مثال: C:\Users\Admin\Desktop\aboeldahab'
    Line ''
    $target = Read-Host 'المسار'
}

$target = $target.Trim('"').Trim()
if (-not (Test-Path (Join-Path $target 'AboElDahab.exe'))) {
    Fail "لم أجد AboElDahab.exe في:`n        $target`n       تأكد أنك اخترت مجلد البرنامج الصحيح."
}
$targetAsar = Join-Path $target 'resources\app.asar'
if (-not (Test-Path $targetAsar)) {
    Fail "لم أجد resources\app.asar في المجلد المستهدف — هذا لا يبدو مجلد برنامج سليم."
}

Line "   المجلد: $target"
Line ''

# ---- 1. إغلاق البرنامج ----
Line '[1/3] إغلاق البرنامج ...'
Get-Process -Name 'AboElDahab' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
if (Get-Process -Name 'AboElDahab' -ErrorAction SilentlyContinue) {
    Fail 'البرنامج ما زال مفتوحاً — أغلقه يدوياً ثم أعد المحاولة.'
}

# ---- 2. نسخة احتياطية من الملف القديم ----
# تؤخذ قبل أي تغيير: إذا فشلت، لا نلمس شيئاً أصلاً.
$stamp = Get-Date -Format 'yyyy-MM-dd_HH-mm'
$backup = "$targetAsar.backup-$stamp"
Line '[2/3] حفظ النسخة القديمة ...'
try {
    Copy-Item $targetAsar $backup -Force
} catch {
    Fail "تعذّر حفظ نسخة احتياطية — تم الإيقاف قبل تغيير أي شيء.`n       $($_.Exception.Message)"
}
Line "        $(Split-Path -Leaf $backup)"

# ---- 3. تركيب النسخة الجديدة ----
Line '[3/3] تركيب النسخة الجديدة ...'
try {
    Copy-Item $source $targetAsar -Force
} catch {
    Write-Host ''
    Write-Host '[خطأ] فشل النسخ — جارٍ إرجاع النسخة القديمة ...' -ForegroundColor Red
    Copy-Item $backup $targetAsar -Force
    Fail "تم إرجاع النسخة القديمة. البرنامج كما كان."
}

$sizeMb = [math]::Round((Get-Item $targetAsar).Length / 1MB, 1)
if ($sizeMb -lt 10) {
    Copy-Item $backup $targetAsar -Force
    Fail "الملف الجديد يبدو ناقصاً ($sizeMb ميجا) — تم إرجاع القديم. أعد تنزيل ملف التحديث."
}

Line ''
Line '============================================'
Line '   تم التحديث — شغّل AboElDahab.exe'
Line '============================================'
Line ''
Line "   البيانات لم تُمس. النسخة القديمة محفوظة باسم:"
Line "   $(Split-Path -Leaf $backup)"
Line ''
Line '   للرجوع للنسخة القديمة إذا لزم:'
Line "   Copy-Item `"$backup`" `"$targetAsar`" -Force"
Line ''
Read-Host 'اضغط Enter للإغلاق' | Out-Null
