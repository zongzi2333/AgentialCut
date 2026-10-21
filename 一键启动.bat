@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
title OpenFilm Studio (source)

REM pnpm 9.15.9 standalone build. Edit this path if you move the exe.
set "PNPM=D:\Interpreter\pnpm\pnpm-9.15.9\pnpm-win-x64.exe"
set "PIDFILE=packages\openfilm\.dev\dev.pid"

if not exist "%PNPM%" (
  echo [error] pnpm 9.15.9 not found at:
  echo         %PNPM%
  echo Edit the PNPM line in this script.
  if /i not "%~1"=="quiet" pause
  exit /b 1
)

REM already running? say so instead of failing inside the dev script
if exist "%PIDFILE%" (
  for /f "usebackq delims=" %%p in ("%PIDFILE%") do set "DEVPID=%%p"
  if defined DEVPID (
    tasklist /FI "PID eq !DEVPID!" /NH 2>nul | findstr /I "!DEVPID!" >nul
    if not errorlevel 1 (
      echo [info] Studio is already running ^(pid !DEVPID!^).
      echo        http://127.0.0.1:4848
      start "" http://127.0.0.1:4848
      if /i not "%~1"=="quiet" pause
      exit /b 0
    )
  )
)

if not exist "node_modules" goto install
if not exist "packages\openfilm\node_modules" goto install
goto run

:install
echo [setup] dependencies missing, installing from npmmirror...
"%PNPM%" install --filter "openfilm..." --frozen-lockfile --registry=https://registry.npmmirror.com
if errorlevel 1 (
  echo [error] install failed, see the log above.
  if /i not "%~1"=="quiet" pause
  exit /b 1
)
echo [setup] done.
echo.

:run
echo [start] source-mode Studio. A browser tab opens when it is ready.
echo         http://127.0.0.1:4848
echo         Close this window or run the stop script to stop it.
echo.
"%PNPM%" --filter openfilm dev
set "CODE=%errorlevel%"
echo.
if not "%CODE%"=="0" echo [exit] Studio stopped with code %CODE%, see the log above.
if "%CODE%"=="0" echo [exit] Studio stopped.
if /i not "%~1"=="quiet" pause
exit /b %CODE%
