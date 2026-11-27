package com.bike4mind.kit.onboarding

/** One screen of the first-launch welcome. The app picks the icon by [id]. */
data class OnboardingPage(val id: String, val title: String, val message: String)

/**
 * What the welcome says and when it appears. Twin of apps/ios B4MKit/Onboarding/Onboarding.swift: keep the page
 * ids (the Maestro flows address `onboarding-page-<id>`) and copy in sync, except the sentence on how the
 * platform asks for notifications. The sign-in screen that follows is not a page here.
 */
object Onboarding {
    val pages: List<OnboardingPage> = listOf(
        OnboardingPage(
            id = "welcome",
            title = "Your AI workspace, in your pocket",
            message = "Chat with the models you use on the web, start long-running agents, and keep your images, " +
                "video and music in one place.",
        ),
        OnboardingPage(
            id = "notifications",
            title = "Know the moment it's ready",
            message = "Agents and long answers can take a while. Bike4Mind can notify you, so you can put the phone " +
                "down. If Android asks for permission, it's once, right after you sign in, and you can change it any " +
                "time in Settings.",
        ),
    )

    /**
     * [isCompleted] is null until this install first decides. An install that predates the welcome ([isUpgrade])
     * starts completed, so an upgrade never shows it; a fresh install (or a reinstall, which wipes app data)
     * starts not completed.
     */
    fun initialCompleted(isCompleted: Boolean?, isUpgrade: Boolean): Boolean = isCompleted ?: isUpgrade
}
