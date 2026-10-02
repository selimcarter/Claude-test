@echo off
rem Lanceur Windows de l'hote natif : Chrome ne peut pas executer un .py directement.
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 "%~dp0host.py" %*
) else (
  python "%~dp0host.py" %*
)
