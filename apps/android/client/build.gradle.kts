import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.openapitools.generator.gradle.plugin.tasks.GenerateTask

plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.openapi.generator)
}

// Bytecode level of the Android app that consumes this module; any JDK 17+ builds it.
java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    compilerOptions.jvmTarget.set(JvmTarget.JVM_17)
}

// Generated sources are committed (see README "Generated API client"), so building never runs the
// generator; `make generate-client` is the only caller of this task.
tasks.named<GenerateTask>("openApiGenerate") {
    generatorName.set("kotlin")
    library.set("jvm-ktor")
    // Written by `make generate-client`: the snapshot with enums opened and operations filtered
    // (scripts/open_enums.py, scripts/filter_operations.py).
    inputSpec.set(layout.buildDirectory.file("openapi-filtered.json"))
    outputDir.set(layout.projectDirectory.dir("generated"))
    // The parser's 3.1 validator rejects info.license without an `identifier`, a doc-only field;
    // the generated code does not depend on it.
    skipValidateSpec.set(true)
    packageName.set("com.bike4mind.client")
    apiPackage.set("com.bike4mind.client.apis")
    modelPackage.set("com.bike4mind.client.models")
    // Session schemas declare both `id` and `_id`, which collide as one Kotlin property without a rename.
    nameMappings.set(mapOf("_id" to "underscoreId"))
    // kotlinx.serialization has no serializer for kotlin.Any or BigDecimal: free-form values decode as JSON
    // trees, and every `number` as the hand-written Decimal (an exact BigDecimal that carries its serializer).
    typeMappings.set(mapOf("AnyType" to "JsonElement", "number" to "Decimal", "decimal" to "Decimal"))
    importMappings.set(
        mapOf(
            "JsonElement" to "kotlinx.serialization.json.JsonElement",
            "Decimal" to "com.bike4mind.client.Decimal",
        ),
    )
    configOptions.set(
        mapOf(
            "serializationLibrary" to "kotlinx_serialization",
            "dateLibrary" to "string",
            "enumPropertyNaming" to "UPPERCASE",
            "sortParamsByRequiredFlag" to "true",
            "omitGradleWrapper" to "true",
            "omitGradlePluginVersions" to "true",
        ),
    )
    globalProperties.set(
        mapOf(
            "apiDocs" to "false",
            "modelDocs" to "false",
            "apiTests" to "false",
            "modelTests" to "false",
        ),
    )
    generateApiDocumentation.set(false)
    generateModelDocumentation.set(false)
    generateApiTests.set(false)
    generateModelTests.set(false)
}

sourceSets {
    main {
        kotlin.srcDir("generated/src/main/kotlin")
    }
}

dependencies {
    api(libs.ktor.client.core)
    api(libs.ktor.client.content.negotiation)
    api(libs.ktor.serialization.kotlinx.json)
    api(libs.kotlinx.serialization.json)

    testImplementation(kotlin("test"))
    testImplementation(libs.ktor.client.mock)
    testImplementation(libs.kotlinx.coroutines.test)
}
