package com.bike4mind.client

import java.math.BigDecimal
import kotlinx.serialization.KSerializer
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.JsonUnquotedLiteral
import kotlinx.serialization.json.jsonPrimitive

/**
 * The generated models' type for an OpenAPI `number` (client/build.gradle.kts maps it here).
 * BigDecimal keeps credit amounts exact; the annotation carries the serializer into every generated use,
 * including collection elements, where the generator would otherwise emit an unserializable BigDecimal.
 */
typealias Decimal = @kotlinx.serialization.Serializable(with = DecimalSerializer::class) BigDecimal

/** Reads and writes a JSON number as its exact decimal literal, never through a Double. */
object DecimalSerializer : KSerializer<BigDecimal> {
    override val descriptor: SerialDescriptor =
        PrimitiveSerialDescriptor("com.bike4mind.client.Decimal", PrimitiveKind.STRING)

    override fun deserialize(decoder: Decoder): BigDecimal =
        if (decoder is JsonDecoder) {
            BigDecimal(decoder.decodeJsonElement().jsonPrimitive.content)
        } else {
            BigDecimal(decoder.decodeString())
        }

    override fun serialize(encoder: Encoder, value: BigDecimal) {
        if (encoder is JsonEncoder) {
            encoder.encodeJsonElement(JsonUnquotedLiteral(value.toPlainString()))
        } else {
            encoder.encodeString(value.toPlainString())
        }
    }
}
