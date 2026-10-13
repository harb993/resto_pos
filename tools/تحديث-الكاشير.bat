@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

rem ============================================================
rem   تحديث برنامج كريسبو  —  يحافظ على بيانات المحل
rem ------------------------------------------------------------
rem   ضع هذا الملف بجوار مجلد البرنامج (المجلد الذي به Crispo.exe)
rem   ثم شغّله. سيقوم بـ:
rem     1. إغلاق البرنامج إن كان مفتوحاً
rem     2. أخذ نسخة احتياطية من data و data-demo
rem     3. استبدال ملفات البرنامج فقط بالنسخة الجديدة
rem     4. إعادة data و data-demo و printer كما هي
rem ============================================================

echo.
echo ============================================
echo    تحديث برنامج كريسبو
echo ============================================
echo.

set "NEW=%~dp0app"
set "TARGET=%~1"

if "%TARGET%"=="" (
  echo اسحب مجلد البرنامج القديم والقه على هذا الملف،
  echo او اكتب مساره الان ثم اضغط Enter:
  echo.
  set /p TARGET=المسار:
)

if not exist "%TARGET%\Crispo.exe" (
  echo.
  echo [خطأ] لم اجد Crispo.exe في:
  echo        %TARGET%
  echo تأكد انك اخترت مجلد البرنامج الصحيح.
  echo.
  pause
  exit /b 1
)

if not exist "%NEW%\Crispo.exe" (
  echo.
  echo [خطأ] مجلد app غير موجود بجوار هذا الملف.
  echo فك ضغط الملف بالكامل اولا ثم شغّل التحديث.
  echo.
  pause
  exit /b 1
)

echo    المجلد المستهدف: %TARGET%
echo.

rem ---- 1. اغلاق البرنامج ----
echo [1/4] اغلاق البرنامج ...
taskkill /IM Crispo.exe /F >nul 2>&1
timeout /t 3 /nobreak >nul

rem ---- 2. نسخة احتياطية ----
for /f "tokens=2 delims==" %%I in ('wmic os get localdatetime /value') do set DT=%%I
set "STAMP=%DT:~0,4%-%DT:~4,2%-%DT:~6,2%_%DT:~8,2%-%DT:~10,2%"
set "BACKUP=%TARGET%\..\crispo_DATA_BACKUP_%STAMP%"

echo [2/4] نسخة احتياطية من البيانات ...
mkdir "%BACKUP%" >nul 2>&1
if exist "%TARGET%\data"      xcopy "%TARGET%\data"      "%BACKUP%\data\"      /E /I /Q /Y >nul
if exist "%TARGET%\data-demo" xcopy "%TARGET%\data-demo" "%BACKUP%\data-demo\" /E /I /Q /Y >nul
echo        %BACKUP%

rem ---- 3. استبدال ملفات البرنامج فقط ----
rem    data و data-demo و printer لا تُمس اطلاقا.
echo [3/4] استبدال ملفات البرنامج ...
for /d %%D in ("%TARGET%\*") do (
  set "NAME=%%~nxD"
  if /i not "!NAME!"=="data" if /i not "!NAME!"=="data-demo" if /i not "!NAME!"=="printer" (
    rd /s /q "%%D" 2>nul
  )
)
del /q "%TARGET%\*.*" 2>nul

xcopy "%NEW%\*" "%TARGET%\" /E /I /Q /Y >nul
if errorlevel 1 (
  echo.
  echo [خطأ] فشل النسخ. بياناتك سليمة في:
  echo        %BACKUP%
  echo.
  pause
  exit /b 1
)

rem ---- 4. تعريفات الطابعة ----
echo [4/4] ملفات الطابعة ...
if not exist "%TARGET%\printer" (
  if exist "%~dp0printer" xcopy "%~dp0printer" "%TARGET%\printer\" /E /I /Q /Y >nul
)

echo.
echo ============================================
if exist "%TARGET%\data\restaurant.db" (
  echo    تم التحديث بنجاح — والبيانات في مكانها
) else (
  echo    تم التحديث — لا توجد قاعدة بيانات سابقة
  echo    سيبدأ البرنامج بقاعدة جديدة عند اول تشغيل
)
echo ============================================
echo    نسخة احتياطية: %BACKUP%
echo.
pause
