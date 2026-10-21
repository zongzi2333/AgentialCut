@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"
title OpenFilm Studio - stop

set "PIDFILE=packages\openfilm\.dev\dev.pid"
set "FOUND="

REM 1) stop the dev supervisor from its pid file (taskkill /T takes the vite watch and Studio server with it)
if exist "%PIDFILE%" (
  for /f "usebackq delims=" %%p in ("%PIDFILE%") do set "DEVPID=%%p"
  if defined DEVPID (
    taskkill /PID !DEVPID! /T /F >nul 2>&1
    if errorlevel 1 (
      echo [stop] dev.pid !DEVPID! was already gone.
    ) else (
      echo [stop] stopped dev process tree !DEVPID!.
      set "FOUND=1"
    )
  )
  del /f /q "%PIDFILE%" >nul 2>&1
)

REM 2) fallback: kill whatever still listens on the Studio port or the film port
for %%P in (4848 4849) do (
  for /f "tokens=2,4,5" %%a in ('netstat -ano ^| findstr /R /C:"^  TCP"') do (
    if /i "%%b"=="LISTENING" (
      echo %%a | findstr /E /C:":%%P" >nul && (
        taskkill /PID %%c /T /F >nul 2>&1
        if not errorlevel 1 (
          echo [stop] killed pid %%c listening on port %%P.
          set "FOUND=1"
        )
      )
    )
  )
)

if defined FOUND (
  echo [stop] done.
) else (
  echo [stop] nothing was running.
)
if /i not "%~1"=="quiet" pause
exit /b 0
