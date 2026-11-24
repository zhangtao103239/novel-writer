@echo off
REM Novel Writer launcher (Windows): start local server, then open Edge/Chrome app window.
REM Keep this file ASCII-only + CRLF: cmd.exe misparses UTF-8 Chinese on codepage 936.
setlocal
pushd "%~dp0"
if "%NOVEL_PORT%"=="" set "NOVEL_PORT=7788"
set "URL=http://127.0.0.1:%NOVEL_PORT%/"

REM 1) already running?
curl -s -o NUL --max-time 1 "%URL%" >NUL 2>&1
if not errorlevel 1 goto open

REM start server in background; log to novel-writer.log
start "" /b cmd /c "node server.js > novel-writer.log 2>&1"

REM wait up to 10s
for /l %%i in (1,1,40) do (
  curl -s -o NUL --max-time 1 "%URL%" >NUL 2>&1
  if not errorlevel 1 goto open
  ping -n 1 -w 250 127.0.0.1 >NUL
)
echo [novel-writer] server failed to start, see novel-writer.log 1>&2
popd
exit /b 1

:open
REM 2) find browser (Edge first, then Chrome)
set "BROWSER="
for %%p in (
  "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
  "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
  "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
  "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
) do if not defined BROWSER if exist "%%~p" set "BROWSER=%%~p"

if not defined BROWSER (
  start "" "%URL%"
  popd
  exit /b 0
)

start "" "%BROWSER%" --app="%URL%" --user-data-dir="%LOCALAPPDATA%\novel-writer\browser" --disable-extensions --no-first-run --no-default-browser-check --window-size=1240,860
popd
exit /b 0
