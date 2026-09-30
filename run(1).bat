@echo off
setlocal

title P2P Connect Pro

echo.
echo ========================================
echo       P2P Connect Pro - Launcher
echo ========================================
echo.

REM Vérifier que Python est installé
python --version >nul 2>&1
if errorlevel 1 (
    echo [ERREUR] Python est introuvable.
    echo Installe Python 3.10 ou une version plus récente depuis :
    echo https://www.python.org/downloads/
    echo.
    echo Pendant l'installation, coche "Add Python to PATH".
    pause
    exit /b 1
)

echo [OK] Python détecté.

REM Créer l'environnement virtuel s'il n'existe pas
if not exist ".venv\Scripts\python.exe" (
    echo [INFO] Création de l'environnement virtuel...
    python -m venv .venv

    if errorlevel 1 (
        echo [ERREUR] Impossible de créer l'environnement virtuel.
        pause
        exit /b 1
    )

    echo [OK] Environnement virtuel créé.
) else (
    echo [OK] Environnement virtuel déjà présent.
)

REM Installer les dépendances
echo [INFO] Installation des dépendances...
".venv\Scripts\python.exe" -m pip install --upgrade pip
".venv\Scripts\python.exe" -m pip install -r requirements.txt

if errorlevel 1 (
    echo.
    echo [ERREUR] Installation des dépendances échouée.
    pause
    exit /b 1
)

echo [OK] Dépendances installées.
echo.

REM Démarrer l'application
echo ========================================
echo       Démarrage de P2P Connect Pro
echo ========================================
echo.
echo Ouvre ton navigateur à l'adresse :
echo http://localhost:5000
echo.
echo Appuie sur Ctrl+C pour arrêter le serveur.
echo.

".venv\Scripts\python.exe" app.py

if errorlevel 1 (
    echo.
    echo [ERREUR] L'application s'est arrêtée avec une erreur.
    pause
)

endlocal