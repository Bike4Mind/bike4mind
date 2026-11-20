package com.bike4mind.kit.auth

import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

/** RFC 7636 PKCE (S256) and the OAuth `state`, all URL-safe base64 without padding. */
object Pkce {
    private val random = SecureRandom()
    private val encoder = Base64.getUrlEncoder().withoutPadding()

    fun verifier(): String = randomToken(32)

    fun challenge(verifier: String): String =
        encoder.encodeToString(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)))

    fun state(): String = randomToken(16)

    private fun randomToken(byteCount: Int): String = encoder.encodeToString(ByteArray(byteCount).also(random::nextBytes))
}
