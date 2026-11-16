import org.jetbrains.kotlin.gradle.dsl.JvmTarget

// The engine: everything that is not a view (wire, auth, view-model state), plain Kotlin/JVM so its suite
// runs on the host without an emulator. Twin of apps/ios Packages/B4MKit.
plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    compilerOptions.jvmTarget.set(JvmTarget.JVM_17)
}

dependencies {
    api(project(":client"))
    api(libs.kotlinx.coroutines.core)
    implementation(libs.ktor.client.websockets)

    testImplementation(kotlin("test"))
    testImplementation(libs.ktor.client.mock)
    testImplementation(libs.kotlinx.coroutines.test)
}
