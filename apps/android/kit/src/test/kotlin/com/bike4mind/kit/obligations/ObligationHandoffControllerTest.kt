package com.bike4mind.kit.obligations

import com.bike4mind.kit.capture.CaptureApi
import com.bike4mind.kit.capture.CaptureRejectedException
import com.bike4mind.kit.capture.RemoteFileStatus
import com.bike4mind.kit.capture.SentTurnLookup
import com.bike4mind.kit.capture.UploadTicket
import com.bike4mind.kit.environment.ServerEnvironment
import com.bike4mind.kit.networking.ApiException
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.TextContent
import java.io.File
import java.math.BigDecimal
import java.util.Locale
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonObject

class ObligationHandoffControllerTest {
    private val extracted = Obligation(
        id = "ob-1", documentKind = "invoice", fileId = "file-1", amount = ObligationAmount(120.5, "USD"),
        payee = "City Water", dueDate = "2026-12-05", destination = ObligationDestination("lake-bills", "Bills"),
        summary = "Water bill",
    )

    private class FakeCapture : CaptureApi {
        var uploaded = 0
        override suspend fun createUpload(fileName: String, mimeType: String, byteCount: Long) =
            UploadTicket("file-1", "https://upload.example.test/k", null)
        override suspend fun upload(ticket: UploadTicket, file: File, mimeType: String) { uploaded++ }
        override suspend fun fileStatus(fileId: String) = RemoteFileStatus.CLEAN
        override suspend fun findSentTurn(sessionId: String, message: String) = SentTurnLookup.NotFound
    }

    private class FakeObligations(
        val handOffReplies: MutableList<Result<Obligation>>,
        var updateReply: Result<Obligation>,
    ) : ObligationsApi {
        val handOffTexts = mutableListOf<String?>()
        val patches = mutableListOf<ObligationPatch>()
        override suspend fun handOff(fileId: String, text: String?): Obligation {
            handOffTexts += text
            return handOffReplies.removeAt(0).getOrThrow()
        }
        override suspend fun update(id: String, patch: ObligationPatch): Obligation {
            patches += patch
            return updateReply.getOrThrow()
        }
        override suspend fun lakes() = listOf(LakeOption("lake-home", "Home"))
    }

    private val scan = File.createTempFile("scan", ".pdf").apply { writeText("%PDF-1.4"); deleteOnExit() }

    private fun controller(api: FakeObligations, locale: Locale = Locale.US) =
        ObligationHandoffController(FakeCapture(), api, locale, retryDelayMillis = 0, maximumAttempts = 3)

    @Test
    fun extractedFieldsFillTheSheetAndTheSuggestedLakeIsListed() = runTest {
        val api = FakeObligations(mutableListOf(Result.success(extracted)), Result.success(extracted))
        val controller = controller(api)
        controller.start(scan, "  Invoice 42 ")
        val state = controller.state.value
        assertEquals(HandoffPhase.REVIEWING, state.phase)
        assertEquals("120.5", state.amountText)
        assertEquals("City Water", state.payee)
        assertEquals("lake-bills", state.destinationLakeId)
        assertEquals(listOf("lake-bills", "lake-home"), state.lakes.map { it.id })
        assertEquals(listOf<String?>("Invoice 42"), api.handOffTexts)
    }

    @Test
    fun longOcrTextIsCutToTheServerLimit() = runTest {
        val api = FakeObligations(mutableListOf(Result.success(extracted)), Result.success(extracted))
        controller(api).start(scan, "a".repeat(ObligationHandoffController.HAND_OFF_TEXT_LIMIT + 5))
        assertEquals(ObligationHandoffController.HAND_OFF_TEXT_LIMIT, api.handOffTexts.single()?.length)
    }

    @Test
    fun theTextCapNeverSplitsASurrogatePair() {
        assertEquals("abc", ObligationHandoffController.capHandOffText("abc", limit = 3))
        assertEquals("ab", ObligationHandoffController.capHandOffText("ab\uD83D\uDE00", limit = 3))
        assertEquals("ab\uD83D\uDE00", ObligationHandoffController.capHandOffText("ab\uD83D\uDE00x", limit = 4))
    }

    @Test
    fun blankOcrTextIsLeftForTheServer() = runTest {
        val api = FakeObligations(mutableListOf(Result.success(extracted)), Result.success(extracted))
        controller(api).start(scan, " \n ")
        assertEquals(listOf<String?>(null), api.handOffTexts)
    }

    @Test
    fun stillCheckingRetriesThenSucceedsAndGivesUpPastTheBudget() = runTest {
        val retried = FakeObligations(
            mutableListOf(Result.failure(StillCheckingException()), Result.success(extracted)), Result.success(extracted),
        )
        controller(retried).start(scan, null)
        assertEquals(2, retried.handOffTexts.size)

        val stuck = FakeObligations(MutableList(3) { Result.failure(StillCheckingException()) }, Result.success(extracted))
        val controller = controller(stuck)
        controller.start(scan, null)
        assertEquals(HandoffPhase.FAILED, controller.state.value.phase)
        assertEquals(HandoffProblem.STILL_CHECKING, controller.state.value.problem)
    }

    @Test
    fun aMissingFileFails() = runTest {
        val api = FakeObligations(mutableListOf(Result.failure(ApiException(404))), Result.success(extracted))
        val controller = controller(api)
        controller.start(scan, null)
        assertEquals(HandoffProblem.NOT_FOUND, controller.state.value.problem)
    }

    @Test
    fun amountParsingFollowsTheLocaleAndRejectsBadInput() {
        fun parse(raw: String, locale: Locale = Locale.US) = ObligationHandoffController.parseAmount(raw, locale)
        assertNull(parse("").getOrThrow())
        assertEquals(0, BigDecimal("1234.5").compareTo(parse("1,234.50").getOrThrow()))
        assertEquals(0, BigDecimal("12.5").compareTo(parse("12,5", Locale.GERMANY).getOrThrow()))
        assertEquals(0, BigDecimal("99.99").compareTo(parse("99.99").getOrThrow()))
        assertEquals(AmountProblem.NEGATIVE, (parse("-3").exceptionOrNull() as AmountException).problem)
        assertEquals(AmountProblem.NOT_A_NUMBER, (parse("12abc").exceptionOrNull() as AmountException).problem)
    }

    @Test
    fun confirmSendsOnlyChangedFieldsPlusStatus() = runTest {
        val api = FakeObligations(mutableListOf(Result.success(extracted)), Result.success(extracted))
        val controller = controller(api)
        controller.start(scan, null)
        controller.edit { it.copy(amountText = "99.99", destinationLakeId = "lake-home", payee = "  ") }
        assertTrue(controller.canConfirm)
        controller.confirm()
        assertEquals(HandoffPhase.DONE, controller.state.value.phase)
        val body = api.patches.single().toJson()
        assertEquals(setOf("amount", "payee", "destination_lake_id", "status"), body.keys)
        assertEquals("""{"value":99.99,"currency":"USD"}""", body["amount"].toString())
        assertEquals(JsonNull, body["payee"])
    }

    @Test
    fun anUnchangedConfirmSendsOnlyTheStatus() = runTest {
        val api = FakeObligations(mutableListOf(Result.success(extracted)), Result.success(extracted))
        val controller = controller(api)
        controller.start(scan, null)
        controller.confirm()
        assertEquals("""{"status":"confirmed"}""", api.patches.single().toJson().toString())
    }

    @Test
    fun anInvalidAmountBlocksConfirm() = runTest {
        val api = FakeObligations(mutableListOf(Result.success(extracted)), Result.success(extracted))
        val controller = controller(api)
        controller.start(scan, null)
        controller.edit { it.copy(amountText = "-5") }
        assertFalse(controller.canConfirm)
        controller.confirm()
        assertTrue(api.patches.isEmpty())
    }

    @Test
    fun aFailedConfirmKeepsEditsForRetry() = runTest {
        val api = FakeObligations(
            mutableListOf(Result.success(extracted)), Result.failure(CaptureRejectedException("Pick a lake you manage.")),
        )
        val controller = controller(api)
        controller.start(scan, null)
        controller.edit { it.copy(amountText = "80", payee = "City Water Dept") }
        controller.confirm()
        val failed = controller.state.value
        assertEquals(HandoffPhase.REVIEWING, failed.phase)
        assertEquals(HandoffProblem.REJECTED, failed.problem)
        assertEquals("Pick a lake you manage.", controller.rejectionMessage)
        assertEquals("80", failed.amountText)
        assertEquals("City Water Dept", failed.payee)

        api.updateReply = Result.success(extracted)
        controller.confirm()
        assertEquals(HandoffPhase.DONE, controller.state.value.phase)
        assertEquals(api.patches[0], api.patches[1])
    }

    @Test
    fun theWirePostsHandOffAndMaps409() = runTest {
        var request: HttpRequestData? = null
        var status = HttpStatusCode.Created
        val reply = """{"id":"ob-1","status":"pending","document_kind":"invoice","file_id":"file-1",
            "amount":{"value":120.5,"currency":"USD"},"payee":"City Water","due_date":"2026-12-05",
            "destination":{"lake_id":"lake-bills","name":"Bills"},"summary":"Water bill",
            "created_at":"2026-11-25T00:00:00.000Z","confirmed_at":null}"""
        val wire = ObligationsWire(
            ServerEnvironment.Custom("https://app.example.test"),
            HttpClient(MockEngine { sent -> request = sent; respond(reply, status) }),
        )
        assertEquals(extracted, wire.handOff("file-1", "Invoice"))
        assertEquals("/api/v1/obligations", request?.url?.encodedPath)
        val sent = Json.parseToJsonElement((request?.body as TextContent).text).jsonObject
        assertEquals(setOf("file_id", "text"), sent.keys)

        status = HttpStatusCode.Conflict
        assertFailsWith<StillCheckingException> { wire.handOff("file-1", null) }
    }

    @Test
    fun theWireListsOnlyLakesTheUserCanFileInto() = runTest {
        val reply = """{"data":[{"id":"l1","name":"Bills","built_in":false,"can_manage":true},
            {"id":"l2","name":"Shared","built_in":false,"can_manage":false},
            {"id":"l3","name":"Docs","built_in":true,"can_manage":false}]}"""
        val wire = ObligationsWire(
            ServerEnvironment.Custom("https://app.example.test"),
            HttpClient(MockEngine { respond(reply, HttpStatusCode.OK) }),
        )
        assertEquals(listOf(LakeOption("l1", "Bills")), wire.lakes())
    }

    @Test
    fun theWireMapsRejectionsDismissalsAndOtherStatuses() = runTest {
        var status = HttpStatusCode.UnprocessableEntity
        val wire = ObligationsWire(
            ServerEnvironment.Custom("https://app.example.test"),
            HttpClient(MockEngine { respond("""{"error":"nothing readable"}""", status) }),
        )
        for (rejected in listOf(HttpStatusCode.BadRequest, HttpStatusCode.UnprocessableEntity, HttpStatusCode.BadGateway)) {
            status = rejected
            val failure = assertFailsWith<CaptureRejectedException> { wire.handOff("file-1", null) }
            assertEquals("nothing readable", failure.message)
        }
        status = HttpStatusCode.Conflict
        assertFailsWith<ObligationDismissedException> { wire.update("ob-1", ObligationPatch()) }
        status = HttpStatusCode.InternalServerError
        assertEquals(500, assertFailsWith<ApiException> { wire.handOff("file-1", null) }.status)
    }

    @Test
    fun failuresMapToTheirProblem() = runTest {
        suspend fun problemAfterStart(failure: Exception): HandoffProblem? {
            val api = FakeObligations(mutableListOf(Result.failure(failure)), Result.success(extracted))
            val controller = controller(api)
            controller.start(scan, "text")
            assertEquals(HandoffPhase.FAILED, controller.state.value.phase)
            return controller.state.value.problem
        }
        assertEquals(HandoffProblem.OFFLINE, problemAfterStart(java.io.IOException("down")))
        assertEquals(HandoffProblem.NOT_FOUND, problemAfterStart(ApiException(404)))
        assertEquals(HandoffProblem.GENERIC, problemAfterStart(ApiException(500)))
        assertEquals(HandoffProblem.REJECTED, problemAfterStart(CaptureRejectedException("nope")))
    }

    @Test
    fun aDismissedObligationFailsTheConfirm() = runTest {
        val api = FakeObligations(mutableListOf(Result.success(extracted)), Result.failure(ObligationDismissedException()))
        val controller = controller(api)
        controller.start(scan, "text")
        controller.confirm()
        assertEquals(HandoffPhase.REVIEWING, controller.state.value.phase)
        assertEquals(HandoffProblem.DISMISSED, controller.state.value.problem)
    }
}
