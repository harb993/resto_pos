@echo off
rem ASCII only, on purpose: cmd.exe parses .bat files in the OEM codepage, not UTF-8,
rem so Arabic text in here is read as mojibake and executed as commands. The Arabic
rem lives in update.ps1, which PowerShell reads as UTF-8 correctly.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update.ps1" %*
