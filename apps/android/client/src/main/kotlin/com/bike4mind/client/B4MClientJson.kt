package com.bike4mind.client

import io.ktor.client.HttpClientConfig
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.serialization.kotlinx.json.json
import java.math.BigDecimal
import kotlinx.serialization.json.Json
import kotlinx.serialization.modules.SerializersModule

/**
 * The JSON configuration every generated API class must use. The generator installs ContentNegotiation
 * without a converter, so pass [installB4MJson] as each API's `httpClientConfig`.
 *
 * - `ignoreUnknownKeys`: the server adds fields without a version bump; a shipped build must still decode.
 * - `explicitNulls = false`: an optional field the server omits decodes as null.
 * - Decimal is registered contextually because the generator also marks `number` properties `@Contextual`.
 */
val B4MClientJson: Json = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    serializersModule = SerializersModule {
        contextual(BigDecimal::class, DecimalSerializer)
    }
}

/** Installs the [B4MClientJson] converter; Ktor merges it into the generated client's ContentNegotiation. */
fun HttpClientConfig<*>.installB4MJson() {
    install(ContentNegotiation) {
        json(B4MClientJson)
    }
}
