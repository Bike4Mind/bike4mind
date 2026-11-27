package com.bike4mind.kit.artifacts

import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ArtifactDocumentsTest {
    @Test
    fun aPageKeepsItsOwnScriptsAndGainsAPolicyFirstInTheHead() {
        val html = ArtifactDocuments.page("<!doctype html><html><head><title>t</title></head><body><script>run()</script></body></html>")

        assertContains(html, "<script>run()</script>")
        assertTrue(html.indexOf("Content-Security-Policy") < html.indexOf("<title>"))
        assertContains(html, "connect-src 'none'")
        assertContains(html, "form-action 'none'")
        assertContains(html, "frame-src 'none'")
    }

    @Test
    fun aFragmentIsWrappedSoThePolicyStillComesFirst() {
        val html = ArtifactDocuments.page("<h1>Hi</h1><script>x()</script>")
        assertTrue(html.startsWith("<!doctype html>"))
        assertTrue(html.indexOf("Content-Security-Policy") < html.indexOf("<script>"))
    }

    @Test
    fun anHtmlElementWithoutAHeadGetsOne() {
        val html = ArtifactDocuments.page("<html lang=\"en\"><body>x</body></html>")
        assertTrue(html.indexOf("<head>") in 0 until html.indexOf("<body>"))
        assertContains(html, "Content-Security-Policy")
    }

    @Test
    fun aPageCannotReplaceThePolicyRedirectOrEmbedAFrame() {
        val html = ArtifactDocuments.page(
            """<head><META HTTP-EQUIV="refresh" content="0;url=https://evil.test"><meta http-equiv="Content-Security-Policy" content="default-src *">
            <base href="https://evil.test/"><link rel="preload" href="https://evil.test/x"></head>
            <body><iframe src="https://evil.test"></iframe><IFRAME src="x">inner</IFRAME><object data="x"></object><embed src="x"></body>""",
        )

        assertFalse(html.contains("evil.test"))
        assertFalse(html.contains("default-src *"))
        assertFalse(html.contains("<iframe", ignoreCase = true))
        assertFalse(html.contains("<object", ignoreCase = true))
        assertFalse(html.contains("<embed", ignoreCase = true))
        assertFalse(html.contains("<base", ignoreCase = true))
        assertEquals(1, Regex("Content-Security-Policy").findAll(html).count())
    }

    @Test
    fun anSvgLosesEveryWayToRunCode() {
        val html = ArtifactDocuments.svg(
            """<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" onload="steal()"><script>steal()</script>
            <a href="javascript:steal()"><rect onclick='steal()' width="1" height="1"/></a>
            <foreignObject><div>x</div></foreignObject><circle r="2"/></svg>""",
        )

        assertFalse(html.contains("steal"))
        assertFalse(html.contains("<script", ignoreCase = true))
        assertFalse(html.contains("foreignObject", ignoreCase = true))
        assertFalse(html.contains("<?xml"))
        assertContains(html, "<circle r=\"2\"/>")
        assertContains(html, "script-src 'none'")
    }

    @Test
    fun aDiagramSourceIsTextNeverMarkup() {
        val html = ArtifactDocuments.mermaid("graph TD; A-->B; B-->C[<img src=x onerror=steal()>]")

        assertFalse(html.contains("<img"))
        assertContains(html, "A--&gt;B")
        assertContains(html, "securityLevel:'strict'")
        assertContains(html, ArtifactDocuments.MERMAID_SCRIPT_URL)
        // Only the bundled renderer's host may serve a script besides the inline ones.
        assertContains(html, "script-src 'unsafe-inline' https://${ArtifactDocuments.ASSET_HOST};")
    }
}
