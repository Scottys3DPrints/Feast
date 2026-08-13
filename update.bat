@echo off
setlocal enabledelayedexpansion
title Feast - build and install over USB

REM ---------------------------------------------------------------------------
REM  Builds Feast and installs it OVER the copy already on your phone, by cable.
REM
REM  This is an in-place upgrade, not a reinstall: "adb install -r" keeps the app's
REM  data, so your catalog, ratings, bookmarks, collections and listening positions
REM  survive untouched. Feast is never uninstalled.
REM
REM  Use this one when you have the phone plugged in, or when a change touched native
REM  code and you want it on the phone right now. For everything else use
REM  publish-update.bat and press the button in the app.
REM ---------------------------------------------------------------------------

cd /d "%~dp0"

set "ADB=%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe"
set "APK=apps\mobile\android\app\build\outputs\apk\release\app-release.apk"

echo.
echo  == Feast ==
echo.

if not exist "apps\mobile\keystore.properties" (
    echo  [X] apps\mobile\keystore.properties is missing.
    echo.
    echo      Without the original signing key Android will refuse to update the
    echo      installed app, and the only way forward would be uninstalling it -
    echo      which destroys your library state. Restore your backup of
    echo      keystore.properties and feast-release.jks before continuing.
    echo.
    pause
    exit /b 1
)

echo  Building release...
call pnpm --filter @feast/mobile exec expo run:android --variant release --no-install --no-bundler
if errorlevel 1 (
    echo.
    echo  [X] Build failed. Nothing was sent to the phone.
    pause
    exit /b 1
)

echo.
echo  Looking for your phone...
"%ADB%" start-server >nul 2>&1
for /f "skip=1 tokens=1,2" %%a in ('"%ADB%" devices') do (
    if "%%b"=="device" set "DEVICE=%%a"
)

if not defined DEVICE (
    echo.
    echo  [!] No phone detected.
    echo.
    echo      Plug it in and make sure USB debugging is on
    echo      ^(Settings ^> Developer options ^> USB debugging^).
    echo.
    echo      The APK is still built and ready here:
    echo      %CD%\%APK%
    echo.
    pause
    exit /b 1
)

echo  Found !DEVICE!. Installing over the existing app...
echo.
"%ADB%" install -r "%APK%"

if errorlevel 1 (
    echo.
    echo  [X] Install failed.
    echo.
    echo      If it says INSTALL_FAILED_UPDATE_INCOMPATIBLE, this APK was signed with
    echo      a different key than the one already on the phone. Do NOT uninstall to
    echo      work around it - that erases your library state. Find the original
    echo      feast-release.jks instead.
    echo.
    pause
    exit /b 1
)

echo.
echo  [OK] Updated in place. Your data was not touched.
echo.
pause
