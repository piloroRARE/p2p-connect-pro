@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul

title P2P Connect Pro - Launcher

echo.
echo ========================================
echo   P2P Connect Pro - Launcher
echo ========================================
echo.

python --version >nul 2>&1
if errorlevel 1 (
    echo [ERREUR] Python est introuvable.
    echo Installe Python 3.10+ depuis https://www.python.org
    echo et coche "Add Python to PATH"
    pause
    exit /b 1
)

echo [OK] Python détecté

if not exist ".venv\Scripts\python.exe" (
    echo [INFO] Création de l'environnement virtuel...
    python -m venv .venv
    echo [OK] Environnement virtuel créé
) else (
    echo [OK] Environnement virtuel existant
)

echo [INFO] Installation des dépendances...
".venv\Scripts\python.exe" -m pip install --upgrade pip -q
".venv\Scripts\python.exe" -m pip install -r requirements.txt -q

if errorlevel 1 (
    echo [ERREUR] Installation échouée
    pause
    exit /b 1
)

echo [OK] Dépendances installées
echo.
echo ========================================
echo   Démarrage du serveur
echo ========================================
echo.
echo Ouvre : http://localhost:5000
echo Appuie sur Ctrl+C pour arrêter
echo.

".venv\Scripts\python.exe" app.py

if errorlevel 1 (
    echo.
    echo [ERREUR] Le serveur s'est arrêté
    pause
)

endlocal
