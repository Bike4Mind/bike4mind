package com.bike4mind.kit.push

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlinx.coroutines.test.runTest

class PushRegistrationCoordinatorTest {
    private class FakeApi : PushTokenApi {
        val calls = mutableListOf<String>()
        var failRegister = false

        override suspend fun register(token: String, appVersion: String?) {
            if (failRegister) throw IllegalStateException("offline")
            calls += "register:$token:$appVersion"
        }

        override suspend fun unregister(token: String) {
            calls += "unregister:$token"
        }
    }

    private class FakeMemory(var token: String? = null) : PushTokenMemory {
        override suspend fun load() = token
        override suspend fun save(token: String?) {
            this.token = token
        }
    }

    private val api = FakeApi()
    private val memory = FakeMemory()
    private val coordinator = PushRegistrationCoordinator(api, memory, appVersion = "0.1.0")

    @Test
    fun registersOnlyOnceASessionIsActiveNotificationsAreAllowedAndATokenExists() = runTest {
        coordinator.onDeviceToken("t1")
        coordinator.onNotificationsAllowed(true)
        assertEquals(emptyList(), api.calls)

        coordinator.sessionDidStart()

        assertEquals(listOf("register:t1:0.1.0"), api.calls)
        assertEquals("t1", memory.token)
    }

    @Test
    fun aDeniedUserIsNeverRegistered() = runTest {
        coordinator.sessionDidStart()
        coordinator.onDeviceToken("t1")
        coordinator.onNotificationsAllowed(false)

        assertEquals(emptyList(), api.calls)
    }

    @Test
    fun theSameTokenIsNotRegisteredTwice() = runTest {
        coordinator.sessionDidStart()
        coordinator.onNotificationsAllowed(true)
        coordinator.onDeviceToken("t1")
        coordinator.onDeviceToken("t1")

        assertEquals(listOf("register:t1:0.1.0"), api.calls)
    }

    @Test
    fun aRotatedTokenIsRegisteredAndTheOldOneWithdrawn() = runTest {
        coordinator.sessionDidStart()
        coordinator.onNotificationsAllowed(true)
        coordinator.onDeviceToken("t1")
        coordinator.onDeviceToken("t2")

        assertEquals(listOf("register:t1:0.1.0", "register:t2:0.1.0", "unregister:t1"), api.calls)
        assertEquals("t2", memory.token)
    }

    @Test
    fun aNewSessionRegistersTheSameTokenAgain() = runTest {
        coordinator.onNotificationsAllowed(true)
        coordinator.onDeviceToken("t1")
        coordinator.sessionDidStart()
        coordinator.sessionDidEnd()
        coordinator.sessionDidStart()

        assertEquals(listOf("register:t1:0.1.0", "register:t1:0.1.0"), api.calls)
    }

    @Test
    fun turningNotificationsOffWithdrawsTheRegisteredToken() = runTest {
        coordinator.sessionDidStart()
        coordinator.onNotificationsAllowed(true)
        coordinator.onDeviceToken("t1")
        coordinator.onNotificationsAllowed(false)

        assertEquals(listOf("register:t1:0.1.0", "unregister:t1"), api.calls)
        assertEquals(null, memory.token)
    }

    @Test
    fun aFailedRegistrationIsRetriedOnTheNextSync() = runTest {
        coordinator.sessionDidStart()
        coordinator.onNotificationsAllowed(true)
        api.failRegister = true
        coordinator.onDeviceToken("t1")
        assertEquals(emptyList(), api.calls)

        api.failRegister = false
        coordinator.onNotificationsAllowed(true)

        assertEquals(listOf("register:t1:0.1.0"), api.calls)
    }

    @Test
    fun signOutUnregistersTheTokenAndEndsTheSession() = runTest {
        coordinator.sessionDidStart()
        coordinator.onNotificationsAllowed(true)
        coordinator.onDeviceToken("t1")

        coordinator.unregisterBeforeSignOut()
        coordinator.onDeviceToken("t1")

        assertEquals(listOf("register:t1:0.1.0", "unregister:t1"), api.calls)
    }
}
