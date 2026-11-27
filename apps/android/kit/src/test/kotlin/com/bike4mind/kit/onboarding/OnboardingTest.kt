package com.bike4mind.kit.onboarding

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class OnboardingTest {
    @Test
    fun welcomeIsShortAndEveryPageHasCopy() {
        assertTrue(Onboarding.pages.size in 2..3)
        for (page in Onboarding.pages) {
            assertTrue(page.title.isNotBlank())
            assertTrue(page.message.isNotBlank())
        }
        assertEquals(Onboarding.pages.size, Onboarding.pages.map { it.id }.toSet().size)
    }

    @Test
    fun pageIdsMatchIos() {
        assertEquals(listOf("welcome", "notifications"), Onboarding.pages.map { it.id })
    }

    @Test
    fun freshInstallShowsTheWelcomeAndAnUpgradeDoesNot() {
        assertFalse(Onboarding.initialCompleted(isCompleted = null, isUpgrade = false))
        assertTrue(Onboarding.initialCompleted(isCompleted = null, isUpgrade = true))
    }

    @Test
    fun aRecordedAnswerWinsOverTheInstallHistory() {
        // A fresh install updated before the welcome was finished still shows it.
        assertFalse(Onboarding.initialCompleted(isCompleted = false, isUpgrade = true))
        assertTrue(Onboarding.initialCompleted(isCompleted = true, isUpgrade = false))
    }

    @Test
    fun copyIsAscii() {
        for (page in Onboarding.pages) {
            assertTrue((page.title + page.message).all { it.code < 128 }, page.id)
        }
    }
}
