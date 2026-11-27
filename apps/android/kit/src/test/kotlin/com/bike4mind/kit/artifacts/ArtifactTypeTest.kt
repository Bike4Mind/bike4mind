package com.bike4mind.kit.artifacts

import com.bike4mind.kit.environment.ServerEnvironment
import kotlin.test.Test
import kotlin.test.assertEquals

class ArtifactTypeTest {
    @Test
    fun everyTypeTheApiNamesHasAPresentation() {
        val expected = mapOf(
            "html" to ArtifactPresentation.WEB_PAGE,
            "svg" to ArtifactPresentation.IMAGE,
            "mermaid" to ArtifactPresentation.DIAGRAM,
            "code" to ArtifactPresentation.TEXT,
            "python" to ArtifactPresentation.TEXT,
            "file" to ArtifactPresentation.TEXT,
            "blog-draft" to ArtifactPresentation.MARKDOWN,
            "react" to ArtifactPresentation.FULL_VERSION_ONLY,
            "recharts" to ArtifactPresentation.FULL_VERSION_ONLY,
            "lattice" to ArtifactPresentation.FULL_VERSION_ONLY,
            "chess" to ArtifactPresentation.FULL_VERSION_ONLY,
        )
        expected.forEach { (wire, presentation) -> assertEquals(presentation, ArtifactType.fromWire(wire).presentation, wire) }
    }

    @Test
    fun anUnknownTypeFallsBackToTheFullVersion() {
        assertEquals(ArtifactType.UNKNOWN, ArtifactType.fromWire("hologram"))
        assertEquals(ArtifactType.UNKNOWN, ArtifactType.fromWire(""))
        assertEquals(ArtifactPresentation.FULL_VERSION_ONLY, ArtifactType.UNKNOWN.presentation)
    }

    @Test
    fun theFullVersionIsTheArtifactPageOnThisServer() {
        val environment = ServerEnvironment.Custom("https://staging.example.test")
        assertEquals("https://staging.example.test/artifacts/a1", ArtifactDocuments.fullVersionUrl(environment, "a1"))
    }
}
