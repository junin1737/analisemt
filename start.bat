@echo off
title Painel CLIPP - MT Automacoes
echo.
echo  ╔══════════════════════════════════════════╗
echo  ║   Painel de Análise CLIPP               ║
echo  ║   MT Automações                         ║
echo  ╚══════════════════════════════════════════╝
echo.
echo  Iniciando servidor...

cd /d "%~dp0"

:: Verifica se node esta instalado
where node >nul 2>&1
if errorlevel 1 (
  echo.
  echo  ERRO: Node.js nao encontrado. Instale em https://nodejs.org
  pause
  exit /b 1
)

:: Verifica se dependencias estao instaladas
if not exist "node_modules" (
  echo  Instalando dependencias (primeira vez)...
  npm install
)

:: Abre o browser apos 2 segundos
start "" /b cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:5050"

:: Inicia o servidor (mantém janela aberta)
node server.js

echo.
echo  Servidor encerrado.
pause
