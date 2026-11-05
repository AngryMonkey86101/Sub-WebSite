@echo off
rem Pereezd semeynogo VPN na novyy VPS: zapuskaet migrate.ps1 ryadom (dvoynoy shchelchok).
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0migrate.ps1" %*
pause
