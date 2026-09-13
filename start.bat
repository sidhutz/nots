@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
 echo Install Node.js 24 or newer, then try again.
 pause
 exit /b 1
)
node -e "if(Number(process.versions.node.split('.')[0])<24)process.exit(1)"
if errorlevel 1 (
 echo Node.js 24 or newer is required.
 pause
 exit /b 1
)
echo Starting Nest FIXED v1.1 from this folder...
node server.mjs
pause
