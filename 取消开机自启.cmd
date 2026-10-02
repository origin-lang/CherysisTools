@echo off
rem Remove the logon auto-start task for the Cherysis web server.
rem Keep this file ASCII-only (see the install script for why).
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\autostart.ps1" remove
echo.
pause
