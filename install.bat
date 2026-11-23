@echo off
setlocal EnableDelayedExpansion
title GHOSTLINK - Requirements Installer
color 0A

:: ============================================
::   GHOSTLINK Requirements Installer
:: ============================================

echo.
echo  +-----------------------------------------------------------+
echo  :                                                           :
echo  :               G H O S T L I N K                           :
echo  :                                                           :
echo  :           Requirements Installer v1.0                     :
echo  :                                                           :
echo  +-----------------------------------------------------------+
echo.

:: Track installation status
set "NEED_INSTALL=0"
set "NODE_OK=0"
set "NPM_OK=0"
set "DEPS_OK=0"

echo  -------------------------------------------------------------
echo   [1/4] Checking Node.js...
echo  -------------------------------------------------------------

:: Check Node.js
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo   [X] Node.js is NOT installed
    echo   [!] Requirement: Node.js v18 or higher
    set "NEED_INSTALL=1"
    set "NEED_NODE=1"
) else (
    for /f "tokens=1" %%v in ('node -v') do set NODE_VER=%%v
    echo   [OK] Node.js is installed: !NODE_VER!
    set "NODE_OK=1"
)
echo.

echo  -------------------------------------------------------------
echo   [2/4] Checking npm...
echo  -------------------------------------------------------------

:: Check npm
where npm >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo   [X] npm is NOT installed
    echo   [!] Requirement: npm comes with Node.js
    set "NEED_INSTALL=1"
    set "NEED_NPM=1"
) else (
    for /f "tokens=1" %%v in ('npm -v') do set NPM_VER=%%v
    echo   [OK] npm is installed: v!NPM_VER!
    set "NPM_OK=1"
)
echo.

echo  -------------------------------------------------------------
echo   [3/4] Checking Tor binary...
echo  -------------------------------------------------------------

:: Check Tor binary
if exist "%~dp0tor\bin\tor\tor.exe" (
    echo   [OK] Tor binary is present
    set "TOR_OK=1"
) else (
    echo   [--] Tor binary not found
    echo   [!] Tor will be auto-downloaded on first run
    set "TOR_OK=0"
)
echo.

echo  -------------------------------------------------------------
echo   [4/4] Checking npm dependencies...
echo  -------------------------------------------------------------

:: Check if node_modules exists
if not exist "%~dp0node_modules" (
    echo   [X] node_modules folder not found
    echo   [!] Dependencies need to be installed
    set "NEED_INSTALL=1"
    set "NEED_DEPS=1"
    goto :check_complete
)

:: Check individual packages
set "MISSING_DEPS="

:: Check express
if not exist "%~dp0node_modules\express" (
    set "MISSING_DEPS=!MISSING_DEPS! express"
)

:: Check cors
if not exist "%~dp0node_modules\cors" (
    set "MISSING_DEPS=!MISSING_DEPS! cors"
)

:: Check socks
if not exist "%~dp0node_modules\socks" (
    set "MISSING_DEPS=!MISSING_DEPS! socks"
)

:: Check socks-proxy-agent
if not exist "%~dp0node_modules\socks-proxy-agent" (
    set "MISSING_DEPS=!MISSING_DEPS! socks-proxy-agent"
)

:: Check better-sqlite3
if not exist "%~dp0node_modules\better-sqlite3" (
    set "MISSING_DEPS=!MISSING_DEPS! better-sqlite3"
)

if "!MISSING_DEPS!"=="" (
    echo   [OK] express - Web framework
    echo   [OK] cors - Cross-origin support
    echo   [OK] socks - SOCKS proxy
    echo   [OK] socks-proxy-agent - Proxy agent
    echo   [OK] better-sqlite3 - Database
    echo.
    echo   All npm dependencies are installed!
    set "DEPS_OK=1"
) else (
    echo   [X] Missing packages:!MISSING_DEPS!
    set "NEED_INSTALL=1"
    set "NEED_DEPS=1"
)

:check_complete
echo.
echo  =============================================================
echo   REQUIREMENTS SUMMARY
echo  =============================================================
echo.

if !NODE_OK!==1 (
    echo   [OK] Node.js .............. SATISFIED
) else (
    echo   [X] Node.js .............. REQUIRED
)

if !NPM_OK!==1 (
    echo   [OK] npm .................. SATISFIED
) else (
    echo   [X] npm .................. REQUIRED
)

if !TOR_OK!==1 (
    echo   [OK] Tor Binary ........... SATISFIED
) else (
    echo   [--] Tor Binary ........... AUTO-DOWNLOAD
)

if !DEPS_OK!==1 (
    echo   [OK] npm Dependencies ..... SATISFIED
) else (
    echo   [X] npm Dependencies ..... REQUIRED
)

echo.

:: If Node.js is missing, we need to install it first
if defined NEED_NODE (
    echo  =============================================================
    echo   INSTALLING NODE.JS
    echo  =============================================================
    echo.
    echo   Node.js is required but not installed.
    echo   Please install Node.js manually from: https://nodejs.org/
    echo.
    echo   After installing Node.js, run this script again.
    echo.
    echo   Press any key to open Node.js download page...
    pause >nul
    start "" "https://nodejs.org/en/download/"
    goto :end
)

:: Install npm dependencies if needed
if defined NEED_DEPS (
    echo  =============================================================
    echo   INSTALLING NPM DEPENDENCIES
    echo  =============================================================
    echo.
    echo   Installing packages from package.json...
    echo.
    
    cd /d "%~dp0"
    
    echo   Running: npm install
    echo.
    call npm install
    
    if !ERRORLEVEL! NEQ 0 (
        echo.
        echo   [X] Installation failed!
        echo   [!] Please check your internet connection and try again.
        echo   [!] You can also try: npm install --force
        goto :end
    )
    
    echo.
    echo   -------------------------------------------------------------
    echo   [OK] All npm dependencies installed successfully!
    echo   -------------------------------------------------------------
)

:: Final status
echo.
echo  =============================================================
echo   INSTALLATION COMPLETE
echo  =============================================================
echo.
echo   All requirements are now satisfied!
echo.
echo   You can now run GHOSTLINK using:
echo     - Double-click start.bat
echo     - Or run: npm start
echo.
echo   The browser will open at:
echo     - http://localhost:3000
echo.

:end
echo.
echo   Press any key to close...
pause >nul
exit
