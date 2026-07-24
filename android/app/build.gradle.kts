import java.net.URI
import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
}

fun buildConfigString(value: String): String =
  "\"${value.replace("\\", "\\\\").replace("\"", "\\\"")}\""

val configuredAppUrl = providers.gradleProperty("SERPENTIA_APP_URL")
  .orElse(providers.environmentVariable("SERPENTIA_APP_URL"))
val configuredReleaseAppUrl = providers.gradleProperty("SERPENTIA_RELEASE_APP_URL")
  .orElse(providers.environmentVariable("SERPENTIA_RELEASE_APP_URL"))
  .orElse(configuredAppUrl)
val releaseAppUrl = configuredReleaseAppUrl.orNull?.trim().orEmpty()
val signingPropertiesFile = file(
  providers.gradleProperty("SERPENTIA_SIGNING_PROPERTIES")
    .orElse(providers.environmentVariable("SERPENTIA_SIGNING_PROPERTIES"))
    .orElse("D:/Android/keystores/serpentia-release.properties")
    .get(),
)
val signingProperties = signingPropertiesFile.takeIf { it.isFile }?.let { source ->
  Properties().apply { source.inputStream().use(::load) }
}
val releaseArtifactRequested = gradle.startParameter.taskNames.any { requestedTask ->
  val task = requestedTask.substringAfterLast(':').lowercase()
  task in setOf("assemble", "build", "bundle") ||
    (task.contains("release") &&
      listOf("assemble", "bundle", "install", "package", "publish").any(task::startsWith))
}

fun signingProperty(name: String): String =
  signingProperties?.getProperty(name)?.trim()?.takeIf(String::isNotEmpty)
    ?: throw GradleException("Missing '$name' in ${signingPropertiesFile.absolutePath}")

if (releaseArtifactRequested) {
  if (signingProperties == null) {
    throw GradleException(
      "Release signing is not configured. Run android/tools/create-release-keystore-d.ps1.",
    )
  }
  val releaseUri = runCatching { URI(releaseAppUrl) }.getOrNull()
  if (releaseUri?.scheme != "https" || releaseUri.host.isNullOrBlank()) {
    throw GradleException(
      "Release builds require SERPENTIA_RELEASE_APP_URL=https://your-domain.example",
    )
  }
}

android {
  namespace = "io.serpentia.android"
  compileSdk = 35

  defaultConfig {
    applicationId = "io.serpentia.android"
    minSdk = 26
    targetSdk = 35
    versionCode = 1
    versionName = "0.1.0"
  }

  val releaseSigningConfig = signingProperties?.let { properties ->
    signingConfigs.create("release") {
      storeFile = file(signingProperty("storeFile"))
      storePassword = signingProperty("storePassword")
      keyAlias = signingProperty("keyAlias")
      keyPassword = signingProperty("keyPassword")
      storeType = properties.getProperty("storeType", "PKCS12")
    }
  }

  buildTypes {
    debug {
      buildConfigField(
        "String",
        "SERPENTIA_APP_URL",
        buildConfigString(configuredAppUrl.orElse("http://10.0.2.2:3000").get()),
      )
      manifestPlaceholders["usesCleartextTraffic"] = "true"
    }
    release {
      signingConfig = releaseSigningConfig
      isMinifyEnabled = true
      isShrinkResources = true
      buildConfigField(
        "String",
        "SERPENTIA_APP_URL",
        buildConfigString(releaseAppUrl),
      )
      manifestPlaceholders["usesCleartextTraffic"] = "false"
      proguardFiles(
        getDefaultProguardFile("proguard-android-optimize.txt"),
        "proguard-rules.pro",
      )
    }
  }

  buildFeatures {
    buildConfig = true
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  kotlin {
    compilerOptions {
      jvmTarget.set(JvmTarget.JVM_17)
    }
  }

  lint {
    abortOnError = true
    checkReleaseBuilds = true
  }
}
