@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 24 or newer is required. Install it from https://nodejs.org/
  pause
  exit /b 1
)
echo Open http://127.0.0.1:43127 in Codex or your browser.
echo Keep this window open while using the panel. Press Ctrl+C to stop.
node server.mjs
pause
