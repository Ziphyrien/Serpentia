@echo off
setlocal

if not defined SERPENTIA_ANDROID_ROOT set "SERPENTIA_ANDROID_ROOT=D:\Android"
set "ANDROID_USER_HOME=%SERPENTIA_ANDROID_ROOT%\android-user-home"
set "HOME=%ANDROID_USER_HOME%"
set "USERPROFILE=%ANDROID_USER_HOME%"
set "HOMEDRIVE=D:"
set "HOMEPATH=\Android\android-user-home"
set "ANDROID_VENDOR_KEYS=%ANDROID_USER_HOME%\.android"
set "TEMP=%SERPENTIA_ANDROID_ROOT%\tmp"
set "TMP=%SERPENTIA_ANDROID_ROOT%\tmp"

if not exist "%ANDROID_USER_HOME%\.android" mkdir "%ANDROID_USER_HOME%\.android"
if not exist "%SERPENTIA_ANDROID_ROOT%\sdk\platform-tools\adb.exe" (
  echo adb not found under %SERPENTIA_ANDROID_ROOT%\sdk.
  exit /b 1
)

"%SERPENTIA_ANDROID_ROOT%\sdk\platform-tools\adb.exe" %*
exit /b %ERRORLEVEL%
