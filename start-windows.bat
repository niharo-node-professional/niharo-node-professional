@echo off
set PORT=3000
if "%ADMIN_PASSWORD%"=="" set ADMIN_PASSWORD=1234
if "%APP_SECRET%"=="" set APP_SECRET=change-this-secret-before-public-hosting
node server.js
pause
