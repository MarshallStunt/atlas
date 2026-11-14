@echo off
rem Double-click to install Atlas on this PC (no admin needed).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
pause
