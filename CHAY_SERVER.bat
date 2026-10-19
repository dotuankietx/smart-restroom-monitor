@echo off
chcp 65001 > nul
title MAY CHU GIAM SAT GIAY VE SINH (FASTAPI)

echo ============================================================
echo   DANG KHOI DONG HE THONG GIAM SAT GIAY VE SINH...
echo ============================================================
echo.

echo [1/2] Kiem tra va giai phong cong 8000 neu bi chiem...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :8000') do (
    echo Dang tat tien trinh cu chiem cong 8000: PID %%a
    taskkill /F /PID %%a >nul 2>&1
)
timeout /t 1 /nobreak > nul

echo.
echo   Dia chi Web Dashboard : http://localhost:8000
echo   Tai khoan mac dinh    : admin / admin123
echo ============================================================
echo.

cd /d "%~dp0"
python -m uvicorn main:app --host 0.0.0.0 --port 8000

pause
