@echo off
rem Stop the Cherysis web server - double-click this file.
rem Same rule as the other launcher: keep this file ASCII-only (cmd mis-parses multi-byte
rem characters in batch files); all Chinese messages live in scripts\stop-web.cjs.
rem It shuts down whichever process listens on the configured port, and prints who that was
rem before killing it - VS Code itself is also node.exe, so it refuses to blind-kill.
chcp 65001 >nul
cd /d "%~dp0"
node "scripts\stop-web.cjs"
pause
