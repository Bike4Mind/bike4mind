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

android {
    namespace = "com.bike4mind.app"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.bike4mind.app"
        minSdk = 28
        targetSdk = 37
        versionCode = 1
        // Sent as X-Client-Version; keep it one to three integers (ClientIdentity.semanticVersion), no suffix.
        versionName = "0.1.0"

        buildConfigField("String", "FCM_APPLICATION_ID", "\"${fcmProperty("applicationId")}\"")
        buildConfigField("String", "FCM_API_KEY", "\"${fcmProperty("apiKey")}\"")
        buildConfigField("String", "FCM_PROJECT_ID", "\"${fcmProperty("projectId")}\"")
        buildConfigField("String", "FCM_SENDER_ID", "\"${fcmProperty("senderId")}\"")
    }

    buildTypes {
        debug {
            buildConfigField("String", "SERVER_URL", "\"${debugServerUrl.get()}\"")
        }
        release {
            buildConfigField("String", "SERVER_URL", "\"\"")
            isMinifyEnabled = false
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

    implementation(platform(libs.firebase.bom))
    implementation(libs.firebase.messaging)
}
