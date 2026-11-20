package com.bike4mind.app.ui

import androidx.compose.ui.unit.dp

/**
 * The spacing scale for paddings and gaps. Same steps as apps/ios BrandTokens.Spacing and SPACING_STEPS in
 * packages/design-tokens/src/emitters/native/nativeTheme.ts (keep in sync); replace with the generated Compose
 * tokens (packages/design-tokens Kotlin emitter) once they land. Use a step, never a raw dp value.
 */
object Spacing {
    val xs = 4.dp
    val s = 8.dp
    val m = 16.dp
    val l = 24.dp
    val xl = 32.dp
    val xxl = 48.dp
}
