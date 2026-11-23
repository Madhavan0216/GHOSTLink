@echo off
title GHOSTLINK - Anonymous Browsing System
color 0A

echo.
echo  +-----------------------------------------------------------+
echo  :                                                           :
echo  :               G H O S T L I N K                           :
echo  :                                                           :
echo  :            Anonymous Browsing System                      :
echo  :                                                           :
echo  +-----------------------------------------------------------+
echo.
echo ========================================================================
echo.

:: Change to project directory
cd /d "%~dp0"

:: Check if Node.js is installed
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js is not installed or not in PATH
    echo Please install Node.js from https://nodejs.org/
    pause
    exit /b 1
)

:: Kill any existing node processes for this project
echo [*] Cleaning up any existing processes...
taskkill /F /IM node.exe >nul 2>nul

:: Wait a moment
timeout /t 2 /nobreak >nul

:: Start the server in background
echo [*] Starting GHOSTLINK server...
start /B cmd /c "node server.js > ghostlink.log 2>&1"

:: Wait for server to start
echo [*] Waiting for server to initialize...
timeout /t 5 /nobreak >nul

:: Check if server started successfully
netstat -an | find "3000" >nul
if %ERRORLEVEL% neq 0 (
    echo [WARNING] Server may not have started properly. Check ghostlink.log
)

:: Open browser
echo [*] Opening browser...
start "" "http://localhost:3000"

echo.
echo ========================================================================
echo.
echo [SUCCESS] GHOSTLINK is now running!
echo.
echo   Server: http://localhost:3000
echo.
echo   To stop GHOSTLINK, run: stop.bat
echo   Or press Ctrl+C in this window
echo.
echo ========================================================================
echo.

:: Keep the window open and show logs
echo [*] Server logs - Press Ctrl+C to stop:
echo.
type nul > ghostlink.log 2>nul
powershell -Command "Get-Content -Path 'ghostlink.log' -Wait"
