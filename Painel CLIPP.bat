@echo off
title Painel CLIPP - MT Automacoes
cd /d "%~dp0"

:: Remove ELECTRON_RUN_AS_NODE que conflita com outro projeto
set ELECTRON_RUN_AS_NODE=

:: Verifica node
where node >nul 2>&1
if errorlevel 1 (
  echo ERRO: Node.js nao encontrado. Instale em https://nodejs.org
  pause & exit /b 1
)

if not exist "node_modules" (
  echo Instalando dependencias...
  npm install
)

:: Inicia como app Electron
if exist "node_modules\electron\dist\electron.exe" (
  node_modules\electron\dist\electron.exe .
) else (
  echo Electron nao instalado. Abrindo no browser...
  start "" /b cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:5050"
  node server.js
)
