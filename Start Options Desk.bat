@echo off
setlocal
pushd "%~dp0"
start "Options Desk Server" /min cmd.exe /k python -u server.py
timeout /t 3 /nobreak >nul
start "" "http://localhost:8001/"
popd
endlocal
