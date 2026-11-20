package com.bike4mind.kit.networking

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ClientIdentityTest {
    @Test
    fun padsVersionNamesToStrictSemVer() {
        assertEquals("1.0.0", ClientIdentity.semanticVersion("1"))
        assertEquals("1.2.0", ClientIdentity.semanticVersion("1.2"))
        assertEquals("1.2.3", ClientIdentity.semanticVersion(" 1.2.3 "))
        assertEquals("10.0.0", ClientIdentity.semanticVersion("10.0"))
    }

    @Test
    fun rejectsVersionsTheServerCannotCompare() {
        listOf("", "1.2.3.4", "1.2-debug", "01.2", "+1", "-1", "1..2", "v1").forEach {
            assertNull(ClientIdentity.semanticVersion(it), it)
        }
    }

    @Test
    fun androidIdentityStampsNameAndVersion() {
        val identity = ClientIdentity.android("2.1")
        assertEquals(mapOf("X-Client-Name" to "b4m-android", "X-Client-Version" to "2.1.0"), identity.headers)
        assertTrue(ClientIdentity.android("2.1-debug").headers.isEmpty())
    }
}
