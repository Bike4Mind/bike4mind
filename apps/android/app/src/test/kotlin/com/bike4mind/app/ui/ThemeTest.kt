package com.bike4mind.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class ThemeTest {
    @Test
    fun lightSchemeUsesTheBrandLightValues() {
        val scheme = brandColorScheme(dark = false)
        assertEquals(BrandTokens.Colors.accent.light, scheme.primary)
        assertEquals(BrandTokens.Colors.backgroundBody.light, scheme.background)
        assertEquals(BrandTokens.Colors.textPrimary.light, scheme.onSurface)
    }

    @Test
    fun darkSchemeUsesTheBrandDarkValues() {
        val scheme = brandColorScheme(dark = true)
        assertEquals(BrandTokens.Colors.accent.dark, scheme.primary)
        assertEquals(BrandTokens.Colors.backgroundBody.dark, scheme.background)
        assertEquals(BrandTokens.Colors.destructive.dark, scheme.error)
    }

    @Test
    fun lightAndDarkBackgroundsDiffer() {
        assertNotEquals(brandColorScheme(dark = false).background, brandColorScheme(dark = true).background)
    }
}
