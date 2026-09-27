@echo off
chcp 65001 >nul
title Splendor Duel Server
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js 가 설치되어 있지 않아요.
  echo  https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행해 주세요.
  echo.
  pause
  exit /b 1
)

rem 서버가 뜨면 serve.js 가 이 컴퓨터의 브라우저로 게임을 엽니다.
rem 8080 포트가 사용 중이면 다음 포트를 쓰므로 주소는 serve.js 가 정합니다.
rem --tunnel: 멀리 있는 상대를 위한 인터넷 주소도 만듭니다.
node tools\serve.js --tunnel --open
pause
