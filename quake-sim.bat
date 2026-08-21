@echo off
title QuakeSim Server Manager
cd /d %~dp0

:menu
cls
echo ========================================
echo     Earthquake Simulator Manager
echo ========================================
echo   1. Start server (localhost:3000)
echo   2. Stop server  (kill node.exe)
echo   3. Exit
echo ========================================
set /p choice="Select [1/2/3]: "

if "%choice%"=="1" goto start
if "%choice%"=="2" goto stop
if "%choice%"=="3" goto exit
goto menu

:start
echo.
echo Starting server...
start "QuakeSim" /MIN node server.js
echo Server started: http://localhost:3000
echo.
pause
goto menu

:stop
echo.
echo Stopping server...
taskkill /f /im node.exe >nul 2>&1
if %errorlevel% equ 0 (
    echo Server stopped.
) else (
    echo No node process found.
)
echo.
pause
goto menu

:exit
exit /b
