@echo off
setlocal
cd /d "%~dp0"
where git >nul 2>nul
if errorlevel 1 (
  winget install --id Git.Git --exact --accept-package-agreements --accept-source-agreements
  if errorlevel 1 goto failed
)
where uv >nul 2>nul
if errorlevel 1 (
  winget install --id astral-sh.uv --exact --accept-package-agreements --accept-source-agreements
  if errorlevel 1 goto failed
)
rem winget may not refresh PATH in this window. Find uv in its standard locations.
where uv >nul 2>nul
if errorlevel 1 (
  if exist "%USERPROFILE%\.local\bin\uv.exe" set "PATH=%USERPROFILE%\.local\bin;%PATH%"
  if exist "%LOCALAPPDATA%\Microsoft\WinGet\Links\uv.exe" set "PATH=%LOCALAPPDATA%\Microsoft\WinGet\Links;%PATH%"
)
uv run --no-project --python 3.13 scripts\launch.py
if errorlevel 1 goto failed
exit /b 0
:failed
echo Gloss could not start. See the message above and README.md.
pause
exit /b 1
