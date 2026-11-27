package com.bike4mind.client

import com.bike4mind.client.apis.AccountApi
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import java.io.File
import java.math.BigDecimal
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest

class GeneratedClientTest {
    private fun accountApi(path: String, body: String): AccountApi {
        val engine = MockEngine { request ->
            assertEquals(path, request.url.encodedPath)
            respond(body, HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
        }
        return AccountApi(baseUrl = "https://app.example.test", httpClientEngine = engine) { it.installB4MJson() }
    }

    @Test
    fun getMeDecodesUnknownEnumValuesAndIgnoresUnknownFields() = runTest {
        val api = accountApi(
            "/api/v1/me",
            """
            {
              "id": "u1",
              "name": "Ada",
              "tier": "a-tier-added-after-this-build",
              "subscription": null,
              "credits": { "balance": 12.5, "addedLater": true },
              "entitlements": ["chat"],
              "fieldAddedAfterThisBuild": { "nested": [1, 2] }
            }
            """.trimIndent(),
        )

        val me = api.getMe().body()

        assertEquals("a-tier-added-after-this-build", me.tier)
        assertNull(me.subscription)
        assertEquals(BigDecimal("12.5"), me.credits.balance)
        assertEquals(listOf("chat"), me.entitlements)
    }

    @Test
    fun getClientConfigKeepsDecimalsExactAndOpensNestedEnums() = runTest {
        val api = accountApi("/api/v1/client-config", CLIENT_CONFIG)

        val config = api.getClientConfig().body()

        assertEquals("a-status-added-after-this-build", config.server.status)
        assertEquals(BigDecimal("0.1"), config.limits.lowCreditsThreshold)
        assertEquals(BigDecimal("250"), config.limits.maxUploadSizeMb)
        val model = config.models.available.single()
        assertEquals("a-backend-added-after-this-build", model.backend)
        assertEquals(listOf("low", "an-effort-added-after-this-build"), model.reasoningEfforts)
        assertEquals(BigDecimal("3.000001"), model.creditsPer1mTokens?.input)
    }

    // open_enums.py strips every string enum before generation; a closed Kotlin enum in a model would throw on
    // the first value the server adds, on every installed build. Infrastructure enums (RequestMethod) never
    // decode server data. Mirrors apps/ios GeneratedClientTests.testNoGeneratedEnumIsClosed.
    @Test
    fun noGeneratedModelEnumIsClosed() {
        val generated = File("generated/src/main/kotlin/com/bike4mind/client/models")
        assertTrue(generated.isDirectory, "run from the client module directory")
        val closed = generated.walkTopDown()
            .filter { it.isFile && it.extension == "kt" }
            .filter { file -> file.readText().contains(Regex("""\benum class\b""")) }
            .map { it.name }
            .toList()
        assertEquals(emptyList(), closed)
    }

    private companion object {
        val CLIENT_CONFIG =
            """
            {
              "server": { "status": "a-status-added-after-this-build", "app_url": "https://app.example.test", "support_email": null },
              "features": {
                "agents": true, "agent_mode": true, "artifacts": true, "data_lakes": false, "deep_research": false,
                "knowledge_base_search": true, "mcp_server": false, "custom_mcp_connectors": false, "mementos": true,
                "quest_master": false, "rapid_reply": true, "research_engine": false, "team_plan": false,
                "voice_sessions": false, "a_feature_added_after_this_build": true
              },
              "limits": { "max_upload_size_mb": 250, "credits_enforced": true, "low_credits_threshold": 0.1 },
              "models": {
                "default_id": "m1",
                "recommended_ids": ["m1"],
                "available": [
                  {
                    "id": "m1", "name": "Model One", "type": "text", "backend": "a-backend-added-after-this-build",
                    "description": null, "context_window": 200000, "max_output_tokens": 64000,
                    "supports_streaming": true, "supports_thinking": true, "reasons_within_output_budget": false,
                    "reasoning_efforts": ["low", "an-effort-added-after-this-build"], "supports_tools": true,
                    "supports_tool_search": false, "supports_tool_changes": true, "supports_assistant_prefill": false,
                    "supports_vision": true, "deprecation_date": null, "replaced_by": null, "image": null,
                    "credits_per_1m_tokens": { "input": 3.000001, "output": 15, "cached_input": null }
                  }
                ]
              }
            }
            """.trimIndent()
    }
}
