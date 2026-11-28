package com.bike4mind.kit.artifacts

import com.bike4mind.client.apis.ArtifactsApi
import com.bike4mind.client.models.GetArtifactResponse200
import com.bike4mind.client.models.ListArtifactsResponse200DataInner
import com.bike4mind.kit.links.Route
import com.bike4mind.kit.networking.ApiException
import com.bike4mind.kit.networking.requireBody

/** `GET /api/v1/artifacts` and `/{id}` (read-only), mapped from the generated client. Twin of apps/ios B4MKit/Artifacts. */
class ArtifactsRepository(private val api: ArtifactsApi) : ArtifactsBackend {
    override suspend fun list(cursor: String?, limit: Int): ArtifactPage {
        val page = api.listArtifacts(limit = limit, cursor = cursor).requireBody()
        return ArtifactPage(page.`data`.map(::summary), page.nextCursor)
    }

    override suspend fun get(id: String): ArtifactDetail {
        // Anything that is not a plain id never reaches the URL.
        if (!Route.isValidId(id)) throw ApiException(404)
        val artifact = api.getArtifact(id).requireBody()
        return ArtifactDetail(summary(artifact), artifact.content)
    }

    private fun summary(row: ListArtifactsResponse200DataInner) =
        ArtifactSummary(row.id, ArtifactType.fromWire(row.type), row.title.ifBlank { UNTITLED }, row.description, row.version, parseInstant(row.updatedAt))

    private fun summary(artifact: GetArtifactResponse200) =
        ArtifactSummary(artifact.id, ArtifactType.fromWire(artifact.type), artifact.title.ifBlank { UNTITLED }, artifact.description, artifact.version, parseInstant(artifact.updatedAt))

    private companion object {
        const val UNTITLED = "Untitled"
    }
}
