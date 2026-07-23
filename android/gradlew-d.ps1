param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$GradleArguments
)

$ErrorActionPreference = "Stop"
$root = if ($env:SERPENTIA_ANDROID_ROOT) { $env:SERPENTIA_ANDROID_ROOT } else { "D:\Android" }
$env:JAVA_HOME = Join-Path $root "jdk-21"
$env:ANDROID_HOME = Join-Path $root "sdk"
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:ANDROID_USER_HOME = Join-Path $root "android-user-home"
$env:HOME = $env:ANDROID_USER_HOME
$env:USERPROFILE = $env:ANDROID_USER_HOME
$env:HOMEDRIVE = "D:"
$env:HOMEPATH = "\Android\android-user-home"
$env:GRADLE_USER_HOME = Join-Path $root "gradle-home"
$env:TEMP = Join-Path $root "tmp"
$env:TMP = $env:TEMP
$env:TMPDIR = $env:TEMP
$env:JAVA_TOOL_OPTIONS = "-Djava.io.tmpdir=$env:TEMP -Duser.home=$env:ANDROID_USER_HOME"
$env:Path = "$env:JAVA_HOME\bin;$env:ANDROID_SDK_ROOT\platform-tools;$env:Path"

$java = Join-Path $env:JAVA_HOME "bin\java.exe"
if (-not (Test-Path $java)) {
  throw "Android JDK not found at $java. Run tools\bootstrap-d.ps1 first."
}

Push-Location $PSScriptRoot
try {
  & ".\gradlew.bat" @GradleArguments
  $gradleExitCode = $LASTEXITCODE
} finally {
  Pop-Location
}
exit $gradleExitCode
