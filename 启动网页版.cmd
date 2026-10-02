@echo off
rem Cherysis web server launcher - double-click this file.
rem All logic and Chinese messages live in scripts\serve-web.cjs: batch files mis-parse
rem multi-byte characters, so keep this file ASCII-only.
rem Closing this window stops the server (phones cannot connect anymore).
chcp 65001 >nul
cd /d "%~dp0"
node "scripts\serve-web.cjs"
pause
