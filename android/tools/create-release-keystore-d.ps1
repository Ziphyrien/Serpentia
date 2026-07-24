param(
  [string]$ToolchainRoot = $(if ($env:SERPENTIA_ANDROID_ROOT) { $env:SERPENTIA_ANDROID_ROOT } else { "D:\Android" }),
  [string]$KeyAlias = "serpentia-release",
  [string]$DistinguishedName = "CN=Serpentia Android Release, OU=Mobile, O=Serpentia, C=CN"
)

$ErrorActionPreference = "Stop"
$resolvedRoot = [IO.Path]::GetFullPath($ToolchainRoot)
if (-not $resolvedRoot.StartsWith("D:\", [StringComparison]::OrdinalIgnoreCase)) {
  throw "ToolchainRoot must be on D: (received '$resolvedRoot')."
}

$jdkHome = Join-Path $resolvedRoot "jdk-21"
$keytool = Join-Path $jdkHome "bin\keytool.exe"
$keystoreDirectory = Join-Path $resolvedRoot "keystores"
$keystoreFile = Join-Path $keystoreDirectory "serpentia-release.p12"
$propertiesFile = Join-Path $keystoreDirectory "serpentia-release.properties"
$certificateFile = Join-Path $keystoreDirectory "serpentia-release-cert.pem"
$tempRoot = Join-Path $resolvedRoot "tmp"

if (-not (Test-Path $keytool)) {
  throw "JDK keytool not found at $keytool. Run tools\bootstrap-d.ps1 first."
}
if ((Test-Path $keystoreFile) -xor (Test-Path $propertiesFile)) {
  throw "Only one signing file exists. Refusing to overwrite a potentially recoverable release key."
}
if ((Test-Path $keystoreFile) -and (Test-Path $propertiesFile)) {
  Write-Host "Release signing already exists:"
  Write-Host "  Keystore:   $keystoreFile"
  Write-Host "  Properties: $propertiesFile"
  exit 0
}

New-Item -ItemType Directory -Path $keystoreDirectory, $tempRoot -Force | Out-Null
$env:TEMP = $tempRoot
$env:TMP = $tempRoot
$env:TMPDIR = $tempRoot
$env:JAVA_HOME = $jdkHome
$env:JAVA_TOOL_OPTIONS = "-Djava.io.tmpdir=$tempRoot -Duser.home=$resolvedRoot\android-user-home"

function New-CryptographicPassword {
  $bytes = New-Object byte[] 32
  $random = [Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $random.GetBytes($bytes)
  } finally {
    $random.Dispose()
  }
  return [Convert]::ToBase64String($bytes)
}

$storePassword = New-CryptographicPassword
$env:SERPENTIA_RELEASE_STORE_PASSWORD = $storePassword

try {
  & $keytool `
    -genkeypair `
    -noprompt `
    -alias $KeyAlias `
    -dname $DistinguishedName `
    -keyalg RSA `
    -keysize 4096 `
    -sigalg SHA256withRSA `
    -validity 36500 `
    -storetype PKCS12 `
    -keystore $keystoreFile `
    "-storepass:env" SERPENTIA_RELEASE_STORE_PASSWORD `
    "-keypass:env" SERPENTIA_RELEASE_STORE_PASSWORD
  if ($LASTEXITCODE -ne 0) { throw "keytool failed to generate the release key." }

  $propertiesText = @(
    "storeFile=$($keystoreFile.Replace('\', '/'))",
    "storePassword=$storePassword",
    "keyAlias=$KeyAlias",
    "keyPassword=$storePassword",
    "storeType=PKCS12"
  ) -join "`n"
  $utf8WithoutBom = New-Object Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($propertiesFile, "$propertiesText`n", $utf8WithoutBom)

  & $keytool `
    -exportcert `
    -rfc `
    -alias $KeyAlias `
    -keystore $keystoreFile `
    "-storepass:env" SERPENTIA_RELEASE_STORE_PASSWORD `
    -file $certificateFile
  if ($LASTEXITCODE -ne 0) { throw "keytool failed to export the public certificate." }

  $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  foreach ($privateFile in @($keystoreFile, $propertiesFile)) {
    & icacls.exe $privateFile /inheritance:r /grant:r "${identity}:(F)" "SYSTEM:(F)" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Failed to restrict ACL for $privateFile" }
  }

  Write-Host "Release key created. Back up both private files before publishing:"
  Write-Host "  $keystoreFile"
  Write-Host "  $propertiesFile"
  Write-Host "Public certificate: $certificateFile"
  Write-Host "Certificate fingerprint:"
  & $keytool `
    -list `
    -alias $KeyAlias `
    -keystore $keystoreFile `
    "-storepass:env" SERPENTIA_RELEASE_STORE_PASSWORD
} catch {
  if (-not (Test-Path $propertiesFile)) {
    Remove-Item $keystoreFile, $certificateFile -Force -ErrorAction SilentlyContinue
  }
  throw
} finally {
  Remove-Item Env:SERPENTIA_RELEASE_STORE_PASSWORD -ErrorAction SilentlyContinue
  $storePassword = $null
}
