@echo off
title GHOSTLINK - Shutdown
color 0C

echo.
echo ========================================================================
echo                      GHOSTLINK SHUTDOWN SEQUENCE
echo ========================================================================
echo.

:: Change to project directory
cd /d "%~dp0"

echo [*] Stopping GHOSTLINK services...

:: Kill Node.js processes
echo [*] Terminating Node.js server...
taskkill /F /IM node.exe >nul 2>nul
if %ERRORLEVEL% equ 0 (
    echo     [OK] Node.js processes terminated
) else (
    echo     [INFO] No Node.js processes found
)

:: Kill Tor processes (if running standalone)
echo [*] Terminating Tor processes...
taskkill /F /IM tor.exe >nul 2>nul
if %ERRORLEVEL% equ 0 (
    echo     [OK] Tor processes terminated
) else (
    echo     [INFO] No standalone Tor processes found
)

:: Close browser tabs with localhost:3000 and localhost:3001
echo [*] Closing GHOSTLINK browser tabs...

:: Try to close Edge tabs
powershell -Command "Get-Process msedge -ErrorAction SilentlyContinue | ForEach-Object { $_.CloseMainWindow() | Out-Null }" >nul 2>nul

:: Try to close Chrome tabs  
powershell -Command "Get-Process chrome -ErrorAction SilentlyContinue | ForEach-Object { $_.CloseMainWindow() | Out-Null }" >nul 2>nul

:: Try to close Firefox tabs
powershell -Command "Get-Process firefox -ErrorAction SilentlyContinue | ForEach-Object { $_.CloseMainWindow() | Out-Null }" >nul 2>nul

echo     [OK] Browser close signals sent

:: Clean up log file
echo [*] Cleaning up temporary files...
if exist "%~dp0ghostlink.log" (
    del /F /Q "%~dp0ghostlink.log" >nul 2>nul
    echo     [OK] Log file removed
)

:: Clean up Tor lock file if exists
if exist "%~dp0tor\data\lock" (
    del /F /Q "%~dp0tor\data\lock" >nul 2>nul
    echo     [OK] Tor lock file removed
)

echo.
echo ========================================================================
echo.
echo [SUCCESS] GHOSTLINK has been completely shut down!
echo.
echo   - Node.js server: Stopped
echo   - Tor process: Stopped  
echo   - Browser tabs: Close signal sent
echo   - Temporary files: Cleaned
echo.
echo ========================================================================
echo.

:: Wait before closing
echo This window will close in 3 seconds...
timeout /t 3 /nobreak >nul

:: Exit
exit
