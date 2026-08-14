@echo off
cd /d "%~dp0"
echo SHAZ kuruluyor...
call npm.cmd install
if errorlevel 1 (
 echo.
 echo Kurulum hatasi oldu. Bu pencereyi kapatmayin ve ekran goruntusunu gonderin.
 pause
 exit /b 1
)
start "" http://localhost:3000
call npm.cmd start
pause
