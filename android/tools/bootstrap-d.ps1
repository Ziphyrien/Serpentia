param(
  [string]$ToolchainRoot = $(if ($env:SERPENTIA_ANDROID_ROOT) { $env:SERPENTIA_ANDROID_ROOT } else { "D:\Android" })
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$resolvedRoot = [System.IO.Path]::GetFullPath($ToolchainRoot)
if (-not $resolvedRoot.StartsWith("D:\", [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "ToolchainRoot must be on D: (received '$resolvedRoot')."
}

$jdkHome = Join-Path $resolvedRoot "jdk-21"
$sdkRoot = Join-Path $resolvedRoot "sdk"
$gradleHome = Join-Path $resolvedRoot "gradle-8.10.2"
$gradleUserHome = Join-Path $resolvedRoot "gradle-home"
$androidUserHome = Join-Path $resolvedRoot "android-user-home"
$downloads = Join-Path $resolvedRoot "downloads"
$staging = Join-Path $resolvedRoot "staging"
$tempRoot = Join-Path $resolvedRoot "tmp"
$androidProject = Split-Path $PSScriptRoot -Parent

@(
  $resolvedRoot,
  $sdkRoot,
  $gradleUserHome,
  $androidUserHome,
  $downloads,
  $staging,
  $tempRoot
) | ForEach-Object { New-Item -ItemType Directory -Path $_ -Force | Out-Null }

$env:TEMP = $tempRoot
$env:TMP = $tempRoot
$env:TMPDIR = $tempRoot
$env:GRADLE_USER_HOME = $gradleUserHome
$env:ANDROID_HOME = $sdkRoot
$env:ANDROID_SDK_ROOT = $sdkRoot
$env:ANDROID_USER_HOME = $androidUserHome
$env:HOME = $androidUserHome
$env:USERPROFILE = $androidUserHome
$env:HOMEDRIVE = "D:"
$env:HOMEPATH = "\Android\android-user-home"
$env:JAVA_TOOL_OPTIONS = "-Djava.io.tmpdir=$tempRoot -Duser.home=$androidUserHome"

Add-Type -AssemblyName System.IO.Compression.FileSystem

function Test-ZipArchive {
  param([string]$Path)
  if (-not (Test-Path $Path)) { return $false }
  try {
    $archive = [System.IO.Compression.ZipFile]::OpenRead($Path)
    $valid = $archive.Entries.Count -gt 0
    $archive.Dispose()
    return $valid
  } catch {
    return $false
  }
}

function Download-File {
  param([string]$Url, [string]$Destination)
  if (Test-ZipArchive $Destination) {
    Write-Host "Using verified cache $(Split-Path $Destination -Leaf)"
    return
  }
  if (Test-Path $Destination) {
    Write-Host "Resuming incomplete $(Split-Path $Destination -Leaf)"
  } else {
    Write-Host "Downloading $Url"
  }
  & curl.exe --fail --location --retry 5 --retry-all-errors --continue-at - --silent --show-error --output $Destination $Url
  if ($LASTEXITCODE -ne 0 -or -not (Test-ZipArchive $Destination)) {
    throw "Download is incomplete or invalid: $Url"
  }
}

function Expand-CleanArchive {
  param([string]$Archive, [string]$Destination)
  Remove-Item $Destination -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  Expand-Archive -LiteralPath $Archive -DestinationPath $Destination -Force
}

if (-not (Test-Path (Join-Path $jdkHome "bin\java.exe"))) {
  $existingJdk = Join-Path $env:ProgramFiles "Zulu\zulu-21"
  if (Test-Path (Join-Path $existingJdk "bin\java.exe")) {
    Write-Host "Mirroring existing JDK 21 to $jdkHome (no writes to C:)"
    Remove-Item $jdkHome -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Path $jdkHome -Force | Out-Null
    Copy-Item (Join-Path $existingJdk "*") $jdkHome -Recurse -Force
  } else {
    $jdkArchive = Join-Path $downloads "temurin-jdk21-win-x64.zip"
    Download-File "https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jdk/hotspot/normal/eclipse?project=jdk" $jdkArchive
    $jdkStage = Join-Path $staging "jdk"
    Expand-CleanArchive $jdkArchive $jdkStage
    $extractedJdk = Get-ChildItem $jdkStage -Directory |
      Where-Object { Test-Path (Join-Path $_.FullName "bin\java.exe") } |
      Select-Object -First 1
    if (-not $extractedJdk) { throw "The JDK archive did not contain bin\java.exe." }
    Remove-Item $jdkHome -Recurse -Force -ErrorAction SilentlyContinue
    Move-Item $extractedJdk.FullName $jdkHome
    Remove-Item $jdkStage -Recurse -Force
  }
}

$env:JAVA_HOME = $jdkHome
$env:Path = "$jdkHome\bin;$sdkRoot\platform-tools;$env:Path"

$sdkManager = Join-Path $sdkRoot "cmdline-tools\latest\bin\sdkmanager.bat"
if (-not (Test-Path $sdkManager)) {
  $toolsArchive = Join-Path $downloads "android-commandlinetools-win.zip"
  Download-File "https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip" $toolsArchive
  $toolsStage = Join-Path $staging "android-commandline-tools"
  Expand-CleanArchive $toolsArchive $toolsStage
  $latestRoot = Join-Path $sdkRoot "cmdline-tools\latest"
  New-Item -ItemType Directory -Path (Split-Path $latestRoot -Parent) -Force | Out-Null
  Remove-Item $latestRoot -Recurse -Force -ErrorAction SilentlyContinue
  Move-Item (Join-Path $toolsStage "cmdline-tools") $latestRoot
  Remove-Item $toolsStage -Recurse -Force
}

$androidLicense = Join-Path $sdkRoot "licenses\android-sdk-license"
if (-not (Test-Path $androidLicense)) {
  Write-Host "Accepting Android SDK licenses..."
  $licenseInput = Join-Path $tempRoot "android-license-input.txt"
  $licenseScript = Join-Path $tempRoot "accept-android-licenses.cmd"
  Set-Content -LiteralPath $licenseInput -Value (1..50 | ForEach-Object { "y" }) -Encoding ASCII
  Set-Content -LiteralPath $licenseScript -Value @(
    "@echo off",
    "call `"$sdkManager`" `"--sdk_root=$sdkRoot`" --licenses < `"$licenseInput`""
  ) -Encoding ASCII
  & $licenseScript
  if ($LASTEXITCODE -ne 0) { throw "Android SDK license acceptance failed." }
} else {
  Write-Host "Using accepted Android SDK licenses"
}

Write-Host "Installing Android SDK packages into $sdkRoot"
$sdkPackages = @(
  @{ Name = "platform-tools"; Marker = "platform-tools\adb.exe"; InstallPath = "platform-tools" },
  @{ Name = "platforms;android-35"; Marker = "platforms\android-35\android.jar"; InstallPath = "platforms\android-35" },
  @{ Name = "build-tools;35.0.0"; Marker = "build-tools\35.0.0\aapt2.exe"; InstallPath = "build-tools\35.0.0" }
)
foreach ($package in $sdkPackages) {
  if (Test-Path (Join-Path $sdkRoot $package.Marker)) {
    Write-Host "Using installed $($package.Name)"
    continue
  }
  $installed = $false
  for ($attempt = 1; $attempt -le 5 -and -not $installed; $attempt++) {
    Write-Host "Installing $($package.Name) (attempt $attempt/5)"
    Remove-Item (Join-Path $sdkRoot $package.InstallPath) -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $sdkRoot ".temp\*") -Recurse -Force -ErrorAction SilentlyContinue
    & $sdkManager "--sdk_root=$sdkRoot" $package.Name
    $installed = $LASTEXITCODE -eq 0 -and (Test-Path (Join-Path $sdkRoot $package.Marker))
    if (-not $installed) { Start-Sleep -Seconds 3 }
  }
  if (-not $installed) { throw "Android SDK package installation failed: $($package.Name)" }
}

if (-not (Test-Path (Join-Path $gradleHome "bin\gradle.bat"))) {
  $gradleArchive = Join-Path $downloads "gradle-8.10.2-bin.zip"
  Download-File "https://mirrors.cloud.tencent.com/gradle/gradle-8.10.2-bin.zip" $gradleArchive
  Expand-Archive -LiteralPath $gradleArchive -DestinationPath $resolvedRoot -Force
}

$sdkProperty = $sdkRoot.Replace("\", "/")
Set-Content -LiteralPath (Join-Path $androidProject "local.properties") -Value "sdk.dir=$sdkProperty" -Encoding ASCII

Write-Host "Generating Gradle wrapper without configuring Android plugins..."
$wrapperProject = Join-Path $staging "gradle-wrapper-project"
Remove-Item $wrapperProject -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $wrapperProject -Force | Out-Null
Set-Content -LiteralPath (Join-Path $wrapperProject "settings.gradle") -Value "rootProject.name = 'wrapper-bootstrap'" -Encoding ASCII
Set-Content -LiteralPath (Join-Path $wrapperProject "build.gradle") -Value "" -Encoding ASCII
& (Join-Path $gradleHome "bin\gradle.bat") -p $wrapperProject wrapper --gradle-version 8.10.2 --distribution-type bin --gradle-distribution-url https://mirrors.cloud.tencent.com/gradle/gradle-8.10.2-bin.zip
if ($LASTEXITCODE -ne 0) { throw "Gradle wrapper generation failed." }
Copy-Item (Join-Path $wrapperProject "gradlew") $androidProject -Force
Copy-Item (Join-Path $wrapperProject "gradlew.bat") $androidProject -Force
New-Item -ItemType Directory -Path (Join-Path $androidProject "gradle") -Force | Out-Null
Copy-Item (Join-Path $wrapperProject "gradle\wrapper") (Join-Path $androidProject "gradle") -Recurse -Force
$wrapperProperties = Join-Path $androidProject "gradle\wrapper\gradle-wrapper.properties"
$wrapperText = [IO.File]::ReadAllText($wrapperProperties)
$wrapperText = $wrapperText.Replace("`r`n", "`n").Replace("networkTimeout=10000", "networkTimeout=120000")
$utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($wrapperProperties, $wrapperText, $utf8WithoutBom)
Remove-Item $wrapperProject -Recurse -Force

Write-Host ""
Write-Host "Android toolchain ready."
Write-Host "  JDK:         $jdkHome"
Write-Host "  SDK:         $sdkRoot"
Write-Host "  Gradle:      $gradleHome"
Write-Host "  Gradle cache:$gradleUserHome"
Write-Host "Build with: android\gradlew-d.bat assembleDebug"
