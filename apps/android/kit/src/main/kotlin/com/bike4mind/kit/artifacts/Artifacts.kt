package com.bike4mind.kit.artifacts

import com.bike4mind.kit.networking.ApiException
import java.time.Instant
import java.time.format.DateTimeParseException

/** The artifact types the public API names, plus [Unknown] for one a newer server adds. */
enum class ArtifactType(val wire: String) {
    HTML("html"),
    SVG("svg"),
    CODE("code"),
    PYTHON("python"),
    BLOG_DRAFT("blog-draft"),
    FILE("file"),
    MERMAID("mermaid"),
    REACT("react"),
    RECHARTS("recharts"),
    LATTICE("lattice"),
    CHESS("chess"),
    QUEST("quest"),
    QUESTMASTER("questmaster"),
    UNKNOWN("");

    /** How the mobile viewer shows this type. */
    val presentation: ArtifactPresentation
        get() = when (this) {
            HTML -> ArtifactPresentation.WEB_PAGE
            SVG -> ArtifactPresentation.IMAGE
            MERMAID -> ArtifactPresentation.DIAGRAM
            CODE, PYTHON, FILE -> ArtifactPresentation.TEXT
            BLOG_DRAFT -> ArtifactPresentation.MARKDOWN
            // Server-transpiled in the web app, so only the web app draws them at full fidelity.
            REACT, RECHARTS, LATTICE, CHESS, QUEST, QUESTMASTER, UNKNOWN -> ArtifactPresentation.FULL_VERSION_ONLY
        }

    companion object {
        fun fromWire(wire: String): ArtifactType = entries.firstOrNull { it.wire == wire && it != UNKNOWN } ?: UNKNOWN
    }
}

enum class ArtifactPresentation {
    /** Sandboxed WebView, scripts allowed (an interactive page). */
    WEB_PAGE,

    /** Sandboxed WebView, scripts off (a picture). */
    IMAGE,

    /** Sandboxed WebView running the bundled diagram renderer. */
    DIAGRAM,

    /** Selectable monospace text. */
    TEXT,

    /** Selectable prose. */
    MARKDOWN,

    /** Not drawn natively: offer to open the web app. */
    FULL_VERSION_ONLY,
}

/** One row of the artifacts list. */
data class ArtifactSummary(
    val id: String,
    val type: ArtifactType,
    val title: String,
    val description: String?,
    val version: Int,
    val updatedAt: Instant,
)

data class ArtifactPage(val items: List<ArtifactSummary>, val nextCursor: String?)

/** An artifact with its current content. [content] is null when the server withholds it. */
data class ArtifactDetail(val summary: ArtifactSummary, val content: String?)

/** What the artifacts screens ask of the backend; [ArtifactsRepository] is the live one. */
interface ArtifactsBackend {
    suspend fun list(cursor: String?, limit: Int = PAGE_SIZE): ArtifactPage

    suspend fun get(id: String): ArtifactDetail

    companion object {
        const val PAGE_SIZE = 25
    }
}

/** Why a load failed, for the screen to word; kept apart from strings so :kit stays resource-free. */
sealed interface ArtifactError {
    data object Offline : ArtifactError
    data object NotFound : ArtifactError
    data object RateLimited : ArtifactError
    data class Server(val status: Int) : ArtifactError

    val isRetryable: Boolean
        get() = this != NotFound

    companion object {
        fun from(failure: Exception): ArtifactError = when (failure) {
            is ApiException -> when (failure.status) {
                403, 404 -> NotFound
                429 -> RateLimited
                else -> Server(failure.status)
            }
            else -> Offline
        }
    }
}

internal fun parseInstant(raw: String): Instant = try {
    Instant.parse(raw)
} catch (unparseable: DateTimeParseException) {
    Instant.EPOCH
}
