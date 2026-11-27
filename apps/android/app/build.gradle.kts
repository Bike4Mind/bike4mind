// The Compose app: screens and Android glue only. Behavior lives in :kit (twin of apps/ios Bike4Mind over B4MKit).
// AGP 9 compiles Kotlin itself (built-in Kotlin), so the kotlin-android plugin is not applied.
plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

// Debug builds talk to this server; pass -Pb4m.serverUrl=https://... (a preview, a local server) to override.
// Release builds always use production (ServerEnvironment.Production).
val debugServerUrl = providers.gradleProperty("b4m.serverUrl").orElse("https://app.staging.bike4mind.com")

// FCM client config (the values in the Firebase console's google-services.json), supplied as Gradle properties so
// no project-specific file is committed: pass -Pb4m.fcm.projectId=... or set them in ~/.gradle/gradle.properties.
// Any one missing and the build still works, with push turned off (see push/FcmClient.kt). The google-services
// plugin is deliberately not used: it fails the build without the committed-by-nobody JSON.
fun fcmProperty(name: String) = providers.gradleProperty("b4m.fcm.$name").orElse("").get()

// The Play lane (.github/workflows/android-play-internal.yml) passes the train version and build number and
// decodes its upload keystore to ANDROID_KEYSTORE_PATH. Without them, release builds stay unsigned at 0.1.0 (1).
val releaseKeystore = providers.environmentVariable("ANDROID_KEYSTORE_PATH").orNull

android {
    namespace = "com.bike4mind.app"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.bike4mind.app"
        minSdk = 28
        targetSdk = 37
        versionCode = providers.gradleProperty("b4m.versionCode").map(String::toInt).orElse(1).get()
        // Sent as X-Client-Version; keep it one to three integers (ClientIdentity.semanticVersion), no suffix.
        versionName = providers.gradleProperty("b4m.versionName").orElse("0.1.0").get()

        buildConfigField("String", "FCM_APPLICATION_ID", "\"${fcmProperty("applicationId")}\"")
        buildConfigField("String", "FCM_API_KEY", "\"${fcmProperty("apiKey")}\"")
        buildConfigField("String", "FCM_PROJECT_ID", "\"${fcmProperty("projectId")}\"")
        buildConfigField("String", "FCM_SENDER_ID", "\"${fcmProperty("senderId")}\"")
    }

    signingConfigs {
        if (releaseKeystore != null) {
            create("release") {
                storeFile = file(releaseKeystore)
                storePassword = providers.environmentVariable("ANDROID_KEYSTORE_PASSWORD").get()
                keyAlias = providers.environmentVariable("ANDROID_KEY_ALIAS").get()
                keyPassword = providers.environmentVariable("ANDROID_KEY_PASSWORD").get()
            }
        }
    }

    buildTypes {
        debug {
            buildConfigField("String", "SERVER_URL", "\"${debugServerUrl.get()}\"")
        }
        release {
            buildConfigField("String", "SERVER_URL", "\"\"")
            isMinifyEnabled = false
            if (releaseKeystore != null) signingConfig = signingConfigs.getByName("release")
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    lint {
        abortOnError = true
        checkDependencies = false
        // New versions of dependencies are bumped deliberately (gradle/libs.versions.toml), not by lint.
        disable += setOf("GradleDependency", "NewerVersionAvailable", "AndroidGradlePluginVersion")
    }

    // Compose UI tests run on the JVM under Robolectric, so `make test` and CI cover them without an emulator.
    testOptions {
        unitTests.isIncludeAndroidResources = true
        // Robolectric's SDK 36 sandbox reaches into FileDescriptor internals, which newer JDKs keep unexported.
        unitTests.all { it.jvmArgs("--add-exports=java.base/jdk.internal.access=ALL-UNNAMED") }
    }

    packaging {
        resources.excludes += setOf("META-INF/INDEX.LIST", "META-INF/io.netty.versions.properties")
    }
}

dependencies {
    implementation(project(":kit"))
    implementation(libs.ktor.client.okhttp)
    implementation(libs.ktor.client.websockets)

    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.ui.tooling.preview)
    debugImplementation(libs.androidx.compose.ui.tooling)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.browser)
    implementation(libs.androidx.core.ktx)
    // Shares from other apps finish uploading after the app is gone.
    implementation(libs.androidx.work.runtime)
    // Document scanning UI, run by Google Play services, so the app ships no camera or edge-detection code.
    implementation(libs.mlkit.document.scanner)
    // Unbundled: the model comes from Play services, so the APK does not carry it.
    implementation(libs.mlkit.text.recognition)

    // Firebase pulls an old fragment; the activity-result permission launcher needs 1.3.0 or later (lint-enforced).
    implementation(libs.androidx.fragment)
    implementation(platform(libs.firebase.bom))
    implementation(libs.firebase.messaging)

    testImplementation(platform(libs.androidx.compose.bom))
    testImplementation(libs.androidx.compose.ui.test.junit4)
    testImplementation(libs.robolectric)
    testImplementation(libs.junit)
    testImplementation(libs.ktor.client.mock)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.androidx.work.testing)
    // Declares the empty activity Compose UI tests host their content in; debug builds only.
    debugImplementation(libs.androidx.compose.ui.test.manifest)
}
