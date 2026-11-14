@echo off
rem Double-click to install Aura on this PC (no admin needed).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
pause
