// The Compose app: screens and Android glue only. Behavior lives in :kit (twin of apps/ios Bike4Mind over B4MKit).
// AGP 9 compiles Kotlin itself (built-in Kotlin), so the kotlin-android plugin is not applied.
plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

// Debug builds talk to this server; pass -Pb4m.serverUrl=https://... (a preview, a local server) to override.
// Release builds always use production (ServerEnvironment.Production).
val debugServerUrl = providers.gradleProperty("b4m.serverUrl").orElse("https://app.staging.bike4mind.com")

android {
    namespace = "com.bike4mind.app"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.bike4mind.app"
        minSdk = 28
        targetSdk = 36
        versionCode = 1
        // Sent as X-Client-Version; keep it one to three integers (ClientIdentity.semanticVersion), no suffix.
        versionName = "0.1.0"
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
}
