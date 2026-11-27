package com.bike4mind.kit.agents

import com.bike4mind.kit.environment.ServerEnvironment
import com.bike4mind.kit.networking.ApiException
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.TextContent
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest

class AgentRunWireTest {
    private val environment = ServerEnvironment.Custom("https://staging.example.test")

    private fun wire(status: HttpStatusCode, body: String, onRequest: (HttpRequestData) -> Unit = {}) =
        AgentRunWire(
            environment,
            HttpClient(
                MockEngine { request ->
                    onRequest(request)
                    respond(body, status)
                },
            ),
        )

    @Test
    fun startSendsOnlyTheSessionAndMessageToTheContractRoute() = runTest {
        var request: HttpRequestData? = null
        val receipt = wire(
            HttpStatusCode.Accepted,
            """{"id":"e1","status":"pending","session_id":"s1","tracking_info":{"execution_id":"e1","quest_id":"q9","poll_url":"/x"}}""",
        ) { request = it }.start("s1", "Audit this")

        val sent = request!!
        assertEquals(HttpMethod.Post, sent.method)
        assertEquals("/api/v1/agent-executions", sent.url.encodedPath)
        assertEquals("""{"session_id":"s1","message":"Audit this"}""", (sent.body as TextContent).text)
        assertEquals(AgentRunReceipt("e1", "q9", "s1"), receipt)
        assertEquals("q9", receipt.trackingId)
    }

    @Test
    fun aReceiptWithoutAQuestIsTrackedByItsExecution() = runTest {
        val receipt = wire(
            HttpStatusCode.Accepted,
            """{"id":"e1","status":"pending","session_id":"s1","tracking_info":{"execution_id":"e1","quest_id":""}}""",
        ).start("s1", "go")
        assertNull(receipt.questId)
        assertEquals("e1", receipt.trackingId)
    }

    @Test
    fun startFailuresCarryTheStatus() = runTest {
        for (status in listOf(404, 409, 429, 502)) {
            val failure = assertFailsWith<ApiException> { wire(HttpStatusCode.fromValue(status), "{}").start("s1", "go") }
            assertEquals(status, failure.status)
        }
    }

    @Test
    fun anUnreadableAckIsMalformed() = runTest {
        assertFailsWith<MalformedAgentRunException> { wire(HttpStatusCode.Accepted, "nope").start("s1", "go") }
        assertFailsWith<MalformedAgentRunException> { wire(HttpStatusCode.Accepted, "{}").start("s1", "go") }
    }

    @Test
    fun pollingReadsStatusTheToolTraceAndIterations() = runTest {
        var path = ""
        val run = wire(
            HttpStatusCode.OK,
            """
            {"id":"e1","status":"awaiting_permission","session_id":"s1","answer":null,"error":null,
             "steps":[{"type":"thought","content":"x","iteration":0},
                      {"type":"action","content":"y","iteration":0,"tool_name":"web_search"},
                      {"type":"mystery","content":"z"}],
             "total_iterations":2,"created_at":"a","updated_at":"b"}
            """,
        ) { path = it.url.encodedPath }.run("e1")

        assertEquals("/api/v1/agent-executions/e1", path)
        assertEquals(AgentRunStatus.State.AWAITING_PERMISSION, run.state)
        assertEquals(2, run.iterations)
        assertEquals(
            listOf(
                AgentRunStatus.Step(AgentRunStatus.Step.Kind.THOUGHT),
                AgentRunStatus.Step(AgentRunStatus.Step.Kind.ACTION, "web_search"),
                AgentRunStatus.Step(AgentRunStatus.Step.Kind.OTHER),
            ),
            run.steps,
        )
    }

    @Test
    fun anUnknownRunStatusDecodesAsRunning() = runTest {
        val run = wire(HttpStatusCode.OK, """{"id":"e1","status":"brand_new","steps":[],"total_iterations":null}""").run("e1")
        assertEquals(AgentRunStatus.State.RUNNING, run.state)
        assertNull(run.iterations)
    }

    @Test
    fun aKnownStepTotalIsReadAndANullOneStaysNull() = runTest {
        val known = wire(HttpStatusCode.OK, """{"id":"e1","status":"running","steps":[],"step_progress":{"completed":2,"total":5}}""").run("e1")
        assertEquals(StepProgress(2, 5), known.stepProgress)

        assertNull(wire(HttpStatusCode.OK, """{"id":"e1","status":"running","steps":[],"step_progress":null}""").run("e1").stepProgress)
        assertNull(wire(HttpStatusCode.OK, """{"id":"e1","status":"running","steps":[]}""").run("e1").stepProgress)
        assertNull(wire(HttpStatusCode.OK, """{"id":"e1","status":"running","steps":[],"step_progress":{"completed":1,"total":0}}""").run("e1").stepProgress)
    }

    @Test
    fun aFailedRunCarriesItsReason() = runTest {
        val run = wire(HttpStatusCode.OK, """{"id":"e1","status":"failed","error":"Tool needs approval: web_browse","steps":[]}""").run("e1")
        assertEquals("Tool needs approval: web_browse", run.error)
        assertTrue(run.state.isTerminal)
    }

    @Test
    fun executionIdsThatCouldEscapeThePathNeverReachTheServer() = runTest {
        var called = false
        val wire = wire(HttpStatusCode.OK, "{}") { called = true }
        for (id in listOf("", "../admin", "a/b", "x".repeat(65))) {
            assertEquals(404, assertFailsWith<ApiException> { wire.run(id) }.status)
        }
        assertTrue(!called)
    }
}
