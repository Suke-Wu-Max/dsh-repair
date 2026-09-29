@echo off
chcp 65001 >nul 2>nul
setlocal enabledelayedexpansion
title dsh-tudian - DSH startup failure repair tool

rem ============================================================
rem  dsh-tudian - DSH startup failure repair tool
rem  Windows double-click entry.
rem
rem  IMPORTANT - THIS FILE MUST STAY PURE ASCII (no Chinese).
rem  Reason (measured, not guessed): cmd.exe mis-parses .bat files
rem  that contain multi-byte characters. With UTF-8 content it
rem  splits lines in the wrong place and then tries to run the
rem  second half of a Chinese sentence as a command, e.g.
rem      '...is not recognized as an internal or external command'
rem  So: all Chinese output is produced by the Node program below,
rem  never by this file. `chcp 65001` makes that UTF-8 output show
rem  correctly in the console.
rem ============================================================

cd /d "%~dp0"

echo.
echo   ============================================================
echo     dsh-tudian  -  DSH startup failure repair tool
echo   ============================================================
echo.

rem ---- check Node.js --------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo   [X] Node.js not found.
  echo.
  echo   This tool needs Node.js to run. Please install the LTS version:
  echo       https://nodejs.org/
  echo.
  echo   Then double-click this file again.
  echo.
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node -v') do set "NODEVER=%%v"
echo   Node.js !NODEVER!
echo.

rem ---- prefer the local source (works offline), fall back to npx -------
if exist "%~dp0bin\dsh-tudian.mjs" (
  node "%~dp0bin\dsh-tudian.mjs" %*
) else (
  echo   Local source not found, fetching it via npx ...
  echo.
  npx -y dsh-tudian %*
)

echo.
echo   ------------------------------------------------------------
echo   Done. Log file written to:
echo     %~dp0dsh-tudian-log.txt
echo   If something went wrong, please share that log file.
echo   ------------------------------------------------------------
echo.
pause
