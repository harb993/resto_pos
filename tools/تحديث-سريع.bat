@echo off
chcp 65001 >nul

rem ============================================================
rem   تحديث سريع لبرنامج كريسبو
rem ------------------------------------------------------------
rem   يستبدل ملف البرنامج (app.asar) فقط — 11 ميجا بدل 195.
rem   محرك البرنامج وملفات ويندوز لا تتغير بين النسختين،
rem   وكل التعديلات موجودة داخل هذا الملف الواحد.
rem
rem   البيانات (data) لا تُمس إطلاقاً.
rem ============================================================

echo.
echo ============================================
echo    تحديث سريع — كريسبو
echo ============================================
echo.

set "TARGET=%~1"

if "%TARGET%"=="" (
  echo اسحب مجلد البرنامج والقه على هذا الملف،
  echo او اكتب مساره الان ثم اضغط Enter:
  echo    مثال: C:\Users\Admin\Desktop\crispo
  echo.
  set /p TARGET=المسار:
)

if not exist "%TARGET%\Crispo.exe" (
  echo.
  echo [خطأ] لم اجد Crispo.exe في:
  echo        %TARGET%
  echo.
  pause
  exit /b 1
)

if not exist "%TARGET%\resources\app.asar" (
  echo.
  echo [خطأ] لم اجد resources\app.asar في المجلد المستهدف.
  echo هذا لا يبدو مجلد برنامج سليم.
  echo.
  pause
  exit /b 1
)

if not exist "%~dp0resources\app.asar" (
  echo.
  echo [خطأ] ملف التحديث غير موجود بجوار هذا السكربت.
  echo فك ضغط الملف بالكامل اولا.
  echo.
  pause
  exit /b 1
)

echo    المجلد: %TARGET%
echo.

echo [1/3] اغلاق البرنامج ...
taskkill /IM Crispo.exe /F >nul 2>&1
timeout /t 3 /nobreak >nul

for /f "tokens=2 delims==" %%I in ('wmic os get localdatetime /value') do set DT=%%I
set "STAMP=%DT:~0,4%-%DT:~4,2%-%DT:~6,2%_%DT:~8,2%-%DT:~10,2%"

echo [2/3] حفظ النسخة القديمة ...
copy /y "%TARGET%\resources\app.asar" "%TARGET%\resources\app.asar.backup-%STAMP%" >nul
if errorlevel 1 (
  echo [خطأ] تعذر حفظ نسخة احتياطية — تم الايقاف قبل تغيير اي شيء.
  pause
  exit /b 1
)
echo        app.asar.backup-%STAMP%

echo [3/3] تركيب النسخة الجديدة ...
copy /y "%~dp0resources\app.asar" "%TARGET%\resources\app.asar" >nul
if errorlevel 1 (
  echo.
  echo [خطأ] فشل النسخ. لاسترجاع النسخة القديمة:
  echo   copy /y "%TARGET%\resources\app.asar.backup-%STAMP%" "%TARGET%\resources\app.asar"
  echo.
  pause
  exit /b 1
)

echo.
echo ============================================
echo    تم التحديث — شغّل Crispo.exe
echo ============================================
echo.
echo  للرجوع للنسخة القديمة اذا لزم:
echo    copy /y "%TARGET%\resources\app.asar.backup-%STAMP%" "%TARGET%\resources\app.asar"
echo.
pause
