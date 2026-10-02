@echo off
rem Install the logon auto-start task for the Cherysis web server.
rem Keep this file ASCII-only: cmd mis-parses multi-byte characters in batch files
rem (Chinese text inside a .cmd corrupted the command line - measured).
rem All Chinese messages come from scripts\autostart.ps1 instead.
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\autostart.ps1" install
echo.
pause
