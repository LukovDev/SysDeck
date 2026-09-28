@echo off

where pythonw >nul 2>nul
if %errorlevel%==0 (start "" pythonw "%~dp0SysDeck.pyw" %*) else (start "" pyw "%~dp0SysDeck.pyw" %*)
