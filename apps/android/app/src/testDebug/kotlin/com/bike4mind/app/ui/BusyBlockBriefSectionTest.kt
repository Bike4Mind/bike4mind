package com.bike4mind.app.ui

import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import com.bike4mind.app.R
import com.bike4mind.kit.briefs.BusyBlockBriefError
import com.bike4mind.kit.briefs.BusyBlockBriefState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class BusyBlockBriefSectionTest {
    @get:Rule
    val compose = createComposeRule()

    private fun string(id: Int) = RuntimeEnvironment.getApplication().getString(id)

    @Test
    fun anEnabledSwitchStaysVisibleWhileSystemNotificationsAreOff() {
        assertTrue(showsBusyBlockBrief(systemAllowsNotifications = false, BusyBlockBriefState(isEnabled = true)))
        assertTrue(showsBusyBlockBrief(systemAllowsNotifications = true, BusyBlockBriefState()))
        assertFalse(showsBusyBlockBrief(systemAllowsNotifications = false, BusyBlockBriefState()))
    }

    @Test
    fun theSwitchWaitsForTheFirstLoad() {
        compose.setContent { BusyBlockBriefSection(BusyBlockBriefState(), onToggle = {}, onOpenSettings = {}) }

        compose.onNodeWithTag("settings-busy-block-brief-switch").assertIsNotEnabled()
    }

    @Test
    fun turningItOnReportsTheToggle() {
        val toggles = mutableListOf<Boolean>()
        compose.setContent {
            BusyBlockBriefSection(BusyBlockBriefState(isLoaded = true), onToggle = { toggles += it }, onOpenSettings = {})
        }

        compose.onNodeWithTag("settings-busy-block-brief-switch").assertIsOff().performClick()

        assertEquals(listOf(true), toggles)
        compose.onNodeWithTag("settings-busy-block-open-settings-btn").assertDoesNotExist()
        compose.onNodeWithTag("settings-busy-block-footer").assertTextEquals(string(R.string.settings_busy_block_detail))
    }

    @Test
    fun aDeniedRequestOffersTheSystemSettings() {
        var opened = 0
        compose.setContent {
            BusyBlockBriefSection(
                BusyBlockBriefState(isLoaded = true, isAccessDenied = true),
                onToggle = {},
                onOpenSettings = { opened++ },
            )
        }

        compose.onNodeWithTag("settings-busy-block-brief-switch").assertIsOff()
        compose.onNodeWithTag("settings-busy-block-footer").assertTextEquals(string(R.string.settings_busy_block_denied))
        compose.onNodeWithTag("settings-busy-block-open-settings-btn").performClick()

        assertEquals(1, opened)
    }

    @Test
    fun aFailedSaveShowsWhy() {
        compose.setContent {
            BusyBlockBriefSection(
                BusyBlockBriefState(isEnabled = true, isLoaded = true, error = BusyBlockBriefError.SAVE),
                onToggle = {},
                onOpenSettings = {},
            )
        }

        compose.onNodeWithTag("settings-busy-block-brief-switch").assertIsOn()
        compose.onNodeWithTag("settings-busy-block-footer").assertTextEquals(string(R.string.settings_busy_block_save_failed))
    }
}
