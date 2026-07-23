@echo off
setlocal

if not defined SERPENTIA_ANDROID_ROOT set "SERPENTIA_ANDROID_ROOT=D:\Android"
set "JAVA_HOME=%SERPENTIA_ANDROID_ROOT%\jdk-21"
set "ANDROID_HOME=%SERPENTIA_ANDROID_ROOT%\sdk"
set "ANDROID_SDK_ROOT=%SERPENTIA_ANDROID_ROOT%\sdk"
set "ANDROID_USER_HOME=%SERPENTIA_ANDROID_ROOT%\android-user-home"
set "HOME=%ANDROID_USER_HOME%"
set "USERPROFILE=%ANDROID_USER_HOME%"
set "HOMEDRIVE=D:"
set "HOMEPATH=\Android\android-user-home"
set "GRADLE_USER_HOME=%SERPENTIA_ANDROID_ROOT%\gradle-home"
set "TEMP=%SERPENTIA_ANDROID_ROOT%\tmp"
set "TMP=%SERPENTIA_ANDROID_ROOT%\tmp"
set "TMPDIR=%SERPENTIA_ANDROID_ROOT%\tmp"
set "JAVA_TOOL_OPTIONS=-Djava.io.tmpdir=%TEMP% -Duser.home=%ANDROID_USER_HOME%"
set "PATH=%JAVA_HOME%\bin;%ANDROID_SDK_ROOT%\platform-tools;%PATH%"

if not exist "%JAVA_HOME%\bin\java.exe" (
  echo Android JDK not found at %JAVA_HOME%.
  echo Run powershell -ExecutionPolicy Bypass -File tools\bootstrap-d.ps1 first.
  exit /b 1
)

pushd "%~dp0"
call ".\gradlew.bat" %*
set "GRADLE_EXIT_CODE=%ERRORLEVEL%"
popd
exit /b %GRADLE_EXIT_CODE%
