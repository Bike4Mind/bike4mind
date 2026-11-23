package com.bike4mind.kit.account

import com.bike4mind.client.B4MClientJson
import com.bike4mind.kit.links.Route
import com.bike4mind.kit.push.NotificationCategory
import java.util.Base64
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject

/**
 * Who is signed in, from the self view of `GET /api/users/{id}`, plus their push opt-outs. Display only: every
 * field may be missing and none is trusted for authorization. Twin of apps/ios AccountProfile.
 */
data class AccountProfile(
    val displayName: String?,
    val email: String?,
    /** Only the categories the user ever set; a missing one is enabled. */
    val pushPreferences: Map<NotificationCategory, Boolean> = emptyMap(),
) {
    /** The avatar letter, from the display name; null when there is none. */
    val initial: String? get() = displayName?.firstOrNull()?.uppercaseChar()?.toString()

    fun isEnabled(category: NotificationCategory): Boolean = pushPreferences[category] ?: true

    companion object {
        /** Reads the self view. `name` is the display name; without one the `username` stands in. */
        fun fromUserJson(body: String): AccountProfile? {
            val user = runCatching { B4MClientJson.parseToJsonElement(body).jsonObject }.getOrNull() ?: return null
            val push = (user["preferences"] as? JsonObject)?.get("pushNotifications") as? JsonObject
            return AccountProfile(
                displayName = user.string("name") ?: user.string("username"),
                email = user.string("email"),
                pushPreferences = push.orEmpty().mapNotNull { (key, value) ->
                    val category = NotificationCategory.fromWire(key) ?: return@mapNotNull null
                    val enabled = (value as? JsonPrimitive)?.booleanOrNull ?: return@mapNotNull null
                    category to enabled
                }.toMap(),
            )
        }

        /**
         * The user id in a Bike4Mind access token (its `id` claim). Unverified on purpose: it only picks which
         * profile to ask for, and the server still authorizes that request against the bearer.
         */
        fun userId(accessToken: String): String? {
            val segments = accessToken.split('.')
            if (segments.size != 3) return null
            val payload = runCatching { String(Base64.getUrlDecoder().decode(segments[1])) }.getOrNull() ?: return null
            val claims = runCatching { B4MClientJson.parseToJsonElement(payload).jsonObject }.getOrNull() ?: return null
            return claims.string("id")?.takeIf(Route::isValidId)
        }

        private fun JsonObject.string(key: String): String? =
            (get(key) as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull?.trim()?.ifEmpty { null }
    }
}
