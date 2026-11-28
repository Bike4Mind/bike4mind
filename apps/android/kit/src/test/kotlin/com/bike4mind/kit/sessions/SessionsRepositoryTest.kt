package com.bike4mind.kit.sessions

import com.bike4mind.client.models.ListSessionQuestsResponse200DataInnerPendingAction
import com.bike4mind.client.models.ListSessionQuestsResponse200DataInnerPendingActionCustomConnector
import java.math.BigDecimal
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlinx.serialization.json.JsonPrimitive

class SessionsRepositoryTest {
    private fun rest(connector: ListSessionQuestsResponse200DataInnerPendingActionCustomConnector?) =
        ListSessionQuestsResponse200DataInnerPendingAction(
            tool = "create_issue",
            params = mapOf("title" to JsonPrimitive("Bug")),
            ts = BigDecimal(1700000000123L),
            customConnector = connector,
        )

    @Test
    fun aHistoryActionCarriesItsConnector() {
        val action = rest(ListSessionQuestsResponse200DataInnerPendingActionCustomConnector("Acme", "mcp.acme.test"))
            .toPendingAction()!!
        assertEquals(PendingActionConnector("Acme", "mcp.acme.test"), action.connector)
        assertEquals("create_issue", action.tool)
        assertEquals(mapOf("title" to "Bug"), action.params)
        assertEquals(1700000000123L, action.requestedAtMs)
    }

    @Test
    fun aBuiltInHistoryActionHasNoConnector() {
        assertNull(rest(null).toPendingAction()!!.connector)
    }

    @Test
    fun aConnectorThatDoesNotNameItsTargetDropsTheCard() {
        assertNull(rest(ListSessionQuestsResponse200DataInnerPendingActionCustomConnector("Acme", " ")).toPendingAction())
        assertNull(rest(ListSessionQuestsResponse200DataInnerPendingActionCustomConnector("", "mcp.acme.test")).toPendingAction())
    }
}
