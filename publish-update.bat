@echo off
setlocal enabledelayedexpansion
title Feast - publish an update

REM ---------------------------------------------------------------------------
REM  Builds a signed release and publishes it so the phone can update itself over
REM  the air. No cable, no laptop needed afterwards.
REM
REM  Produces in dist\ :
REM      feast-<version>.apk    the signed build
REM      feast-update.json      the manifest the app polls
REM
REM  Then uploads both to a GitHub release. The app looks at
REM      .../releases/latest/download/feast-update.json
REM  which GitHub always points at the newest release, so the URL never changes and
REM  the phone finds every future version without being rebuilt.
REM
REM  On the phone: Settings > Updates > Check for updates.
REM ---------------------------------------------------------------------------

cd /d "%~dp0"

REM ---- Where updates are published ------------------------------------------
REM  Must match EXPO_PUBLIC_UPDATE_MANIFEST_URL / the default in app.config.ts.
REM  The repo has to be PUBLIC: the phone downloads the release asset with no
REM  credentials, and GitHub requires a token for assets on a private repo.
REM  Only the app's source code lives there - no audio, nothing from the library.
set "GH_OWNER=Scottys3DPrints"
set "GH_REPO=Feast"

echo.
echo  == Feast - publish ==
echo.

if not exist "apps\mobile\keystore.properties" (
    echo  [X] apps\mobile\keystore.properties is missing - the build would be signed
    echo      with a throwaway debug key and could never update an existing install.
    echo      Restore your backup of keystore.properties and feast-release.jks.
    pause
    exit /b 1
)

REM Read the version straight out of app.config.ts so it can never drift from what
REM the APK actually reports to Android.
for /f "tokens=2 delims==;" %%v in ('findstr /r /c:"^const VERSION_CODE" apps\mobile\app.config.ts') do set "VCODE=%%v"
for /f "tokens=2 delims==;" %%v in ('findstr /r /c:"^const VERSION_NAME" apps\mobile\app.config.ts') do set "VNAME=%%v"
set "VCODE=%VCODE: =%"
set "VNAME=%VNAME: =%"
set "VNAME=%VNAME:'=%"

if "%VCODE%"=="" (
    echo  [X] Could not read VERSION_CODE from apps\mobile\app.config.ts
    pause
    exit /b 1
)

echo  Version %VNAME% ^(build %VCODE%^)
echo.

REM ---- The guard -------------------------------------------------------------
REM  Bastion runs its tests here for the same reason: this is the last point at which
REM  a broken build can be stopped before it reaches a phone that has no cable
REM  attached and no way back.
echo  Typechecking...
call pnpm typecheck
if errorlevel 1 (
    echo.
    echo  [X] Typecheck failed - not publishing.
    pause
    exit /b 1
)

echo  Building release...
call pnpm --filter @feast/mobile exec expo prebuild --platform android
if errorlevel 1 ( echo  [X] Prebuild failed. & pause & exit /b 1 )

pushd apps\mobile\android
call gradlew.bat :app:assembleRelease --console=plain -q
set "BUILD_ERR=%errorlevel%"
popd
if not "%BUILD_ERR%"=="0" (
    echo  [X] Build failed.
    pause
    exit /b 1
)

if not exist "dist" mkdir dist
set "SRC=apps\mobile\android\app\build\outputs\apk\release\app-release.apk"
set "APK=dist\feast-%VNAME%.apk"
copy /y "%SRC%" "%APK%" >nul

for /f %%h in ('powershell -NoProfile -Command "(Get-FileHash '%APK%' -Algorithm MD5).Hash.ToLower()"') do set "MD5=%%h"
for /f %%s in ('powershell -NoProfile -Command "(Get-Item '%APK%').Length"') do set "SIZE=%%s"
for /f %%d in ('powershell -NoProfile -Command "(Get-Date).ToString('yyyy-MM-dd')"') do set "TODAY=%%d"

>dist\feast-update.json (
    echo {
    echo   "versionCode": %VCODE%,
    echo   "versionName": "%VNAME%",
    echo   "apkUrl": "https://github.com/%GH_OWNER%/%GH_REPO%/releases/download/v%VNAME%/feast-%VNAME%.apk",
    echo   "md5": "%MD5%",
    echo   "sizeBytes": %SIZE%,
    echo   "notes": "Feast %VNAME%",
    echo   "releasedAt": "%TODAY%"
    echo }
)

echo.
echo  [OK] Built dist\feast-%VNAME%.apk  ^(%SIZE% bytes, md5 %MD5%^)
echo.

REM ---- Publish ---------------------------------------------------------------
where gh >nul 2>&1
if errorlevel 1 (
    echo  [!] GitHub CLI not found. The files are ready in dist\ - upload both to a
    echo      release tagged v%VNAME% yourself, then the phone will find them.
    pause
    exit /b 0
)

echo  Publishing release v%VNAME%...
gh release view "v%VNAME%" --repo "%GH_OWNER%/%GH_REPO%" >nul 2>&1
if errorlevel 1 (
    gh release create "v%VNAME%" "%APK%" "dist\feast-update.json" ^
        --repo "%GH_OWNER%/%GH_REPO%" --title "Feast %VNAME%" --notes "Feast %VNAME% (build %VCODE%)"
) else (
    echo  Release v%VNAME% already exists - replacing its files.
    gh release upload "v%VNAME%" "%APK%" "dist\feast-update.json" ^
        --repo "%GH_OWNER%/%GH_REPO%" --clobber
)

if errorlevel 1 (
    echo.
    echo  [X] Publishing failed. The build is fine and is still in dist\ - you can
    echo      upload it by hand, or fix the error above and re-run.
    pause
    exit /b 1
)

echo.
echo  [OK] Published.
echo.
echo      On your phone: Settings ^> Updates ^> Check for updates.
echo.
echo      Next time, bump VERSION_CODE and VERSION_NAME at the top of
echo      apps\mobile\app.config.ts before running this. Android ignores a build
echo      whose versionCode did not increase, so a forgotten bump looks to the
echo      phone like there is no update at all.
echo.
pause
