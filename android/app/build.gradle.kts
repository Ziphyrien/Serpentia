import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
}

fun buildConfigString(value: String): String =
  "\"${value.replace("\\", "\\\\").replace("\"", "\\\"")}\""

val configuredAppUrl = providers.gradleProperty("SERPENTIA_APP_URL")
  .orElse(providers.environmentVariable("SERPENTIA_APP_URL"))

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
      isMinifyEnabled = true
      isShrinkResources = true
      buildConfigField(
        "String",
        "SERPENTIA_APP_URL",
        buildConfigString(configuredAppUrl.orElse("").get()),
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
