package com.bike4mind.kit.push

/**
 * Push categories the server sends, and the `user.preferences.pushNotifications` keys
 * (b4m-core/common/src/schemas/pushNotification.ts). A missing key means enabled. Twin of apps/ios
 * NotificationCategory; the titles and descriptions live in the app's strings.
 */
enum class NotificationCategory(val wire: String) {
    AGENT_COMPLETED("agent_completed"),
    AGENT_FAILED("agent_failed"),
    APPROVAL_NEEDED("approval_needed"),
    CHAT_COMPLETED("chat_completed"),
    GENERATION_READY("generation_ready"),
    AGENT_MESSAGE("agent_message"),
    BRIEF_READY("brief_ready"),
    ;

    companion object {
        fun fromWire(value: String): NotificationCategory? = entries.firstOrNull { it.wire == value }
    }
}
