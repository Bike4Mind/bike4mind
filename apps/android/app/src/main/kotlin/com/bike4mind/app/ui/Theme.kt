package com.bike4mind.app.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private fun BrandColorPair.pick(dark: Boolean): Color = if (dark) this.dark else light

/**
 * The brand Material 3 scheme from the generated tokens. Roles the tokens do not cover keep the Material
 * defaults. Exposed separately from [B4MTheme] so it can be tested without composition.
 */
internal fun brandColorScheme(dark: Boolean): ColorScheme {
    val colors = BrandTokens.Colors
    val base = if (dark) darkColorScheme() else lightColorScheme()
    return base.copy(
        primary = colors.accent.pick(dark),
        onPrimary = colors.backgroundBody.pick(dark),
        background = colors.backgroundBody.pick(dark),
        onBackground = colors.textPrimary.pick(dark),
        surface = colors.surface.pick(dark),
        onSurface = colors.textPrimary.pick(dark),
        surfaceContainerLowest = colors.backgroundBody.pick(dark),
        surfaceContainerLow = colors.surface.pick(dark),
        surfaceContainer = colors.surface.pick(dark),
        surfaceContainerHigh = colors.surface.pick(dark),
        surfaceContainerHighest = colors.promptBubble.pick(dark),
        surfaceVariant = colors.panel.pick(dark),
        onSurfaceVariant = colors.textSecondary.pick(dark),
        outline = colors.borderSolid.pick(dark),
        outlineVariant = colors.borderSoft.pick(dark),
        error = colors.destructive.pick(dark),
    )
}

/**
 * Always the brand palette: dynamic (Material You) color is deliberately off, matching iOS and the web, which
 * have no wallpaper-derived color either.
 */
@Composable
fun B4MTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = brandColorScheme(isSystemInDarkTheme()), content = content)
}
