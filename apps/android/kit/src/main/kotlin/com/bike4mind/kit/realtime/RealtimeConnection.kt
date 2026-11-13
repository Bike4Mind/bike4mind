package com.bike4mind.kit.realtime

import com.bike4mind.client.B4MClientJson
import com.bike4mind.kit.environment.ServerEnvironment
import com.bike4mind.kit.networking.ApiException
import io.ktor.client.HttpClient
import io.ktor.client.plugins.websocket.webSocket
import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.statement.bodyAsText
import io.ktor.http.isSuccess
import io.ktor.websocket.Frame
import io.ktor.websocket.readText
import kotlinx.coroutines.channels.ClosedReceiveChannelException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.channelFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.Serializable

/**
 * One realtime socket: serverConfig -> single-use ticket -> connect, then heartbeats and parsed chat frames.
 * Twin of apps/ios Realtime (RealtimeHandshake, WSClient). [http] must have the Ktor WebSockets plugin and the
 * B4MTransport installed, so the handshake calls are authenticated and the upgrade carries the identity headers.
 *
 * [completions] is cold and finishes when the socket closes or goes silent; the caller decides whether to
 * reconnect, and must refetch state it may have missed meanwhile (frames are not replayed).
 * Not yet ported from iOS: `reauth_connection` on token rotation and `subscribe_query` data subscriptions.
 */
class RealtimeConnection(private val environment: ServerEnvironment, private val http: HttpClient) {
    @Serializable
    private data class ServerConfig(val websocketUrl: String? = null)

    @Serializable
    private data class Ticket(val ticket: String)

    fun completions(): Flow<RealtimeFrames.StreamedCompletion> = channelFlow {
        val url = socketUrl()
        http.webSocket(url) {
            val reassembler = ChunkReassembler()
            val heartbeat = launch {
                while (isActive) {
                    delay(HEARTBEAT_INTERVAL_MS)
                    outgoing.send(Frame.Text(RealtimeFrames.HEARTBEAT))
                    reassembler.purgeExpired()
                }
            }
            try {
                while (true) {
                    val frame = withTimeoutOrNull(SILENCE_TIMEOUT_MS) { incoming.receive() } ?: break
                    if (frame !is Frame.Text) continue
                    RealtimeFrames.parse(frame.readText(), reassembler)?.let { send(it) }
                }
            } catch (closed: ClosedReceiveChannelException) {
                // The server or network closed the socket; the flow completes and the caller reconnects.
            } finally {
                heartbeat.cancel()
            }
        }
    }

    private suspend fun socketUrl(): String {
        val configResponse = http.get(environment.baseUrl + "/api/settings/serverConfig")
        if (!configResponse.status.isSuccess()) throw ApiException(configResponse.status.value)
        val base = B4MClientJson.decodeFromString(ServerConfig.serializer(), configResponse.bodyAsText()).websocketUrl
            ?.takeIf { it.startsWith("wss://") || it.startsWith("ws://") }
            ?: throw IllegalStateException("serverConfig has no websocketUrl")
        val ticketResponse = http.post(environment.baseUrl + "/api/websocket/ticket")
        if (!ticketResponse.status.isSuccess()) throw ApiException(ticketResponse.status.value)
        val ticket = B4MClientJson.decodeFromString(Ticket.serializer(), ticketResponse.bodyAsText()).ticket
        val separator = if ('?' in base) '&' else '?'
        return base + separator + "ticket=" + java.net.URLEncoder.encode(ticket, Charsets.UTF_8)
    }

    companion object {
        const val HEARTBEAT_INTERVAL_MS = 15_000L
        const val SILENCE_TIMEOUT_MS = 60_000L
    }
}
