@echo off
cd /d "%~dp0"

echo Cleaning up...
del /f /q data\active-room-state.json 2>nul
taskkill /f /im node.exe 2>nul
timeout /t 2 /nobreak >nul

echo Starting server...
start /b node server.js > server-log.txt 2>&1

echo Waiting for server...
timeout /t 4 /nobreak >nul

echo Running atomic fix test...
node test-atomic-fix.js

set EXITCODE=%ERRORLEVEL%

echo.
echo Stopping server...
taskkill /f /im node.exe 2>nul

exit /b %EXITCODE%
