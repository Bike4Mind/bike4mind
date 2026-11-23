package com.bike4mind.kit.capture

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** Why a capture did not go through. Persisted with a share's job; the app words each one. */
@Serializable
sealed interface CaptureFailure {
    @Serializable @SerialName("offline")
    data object Offline : CaptureFailure

    @Serializable @SerialName("blocked")
    data object Blocked : CaptureFailure

    /** Still being scanned after the polls one pass allows. */
    @Serializable @SerialName("still_scanning")
    data object StillScanning : CaptureFailure

    @Serializable @SerialName("upgrade_required")
    data object UpgradeRequired : CaptureFailure

    @Serializable @SerialName("signed_out")
    data object SignedOut : CaptureFailure

    /** The shared file was removed from this device before it was sent. */
    @Serializable @SerialName("payload_missing")
    data object PayloadMissing : CaptureFailure

    /** The chat it was going to no longer exists, or this account may not post to it. */
    @Serializable @SerialName("destination_gone")
    data object DestinationGone : CaptureFailure

    /**
     * An earlier send may have reached the server and there is no way to check, so sending again could post
     * (and charge for) the turn twice. Only the user's retry sends it again.
     */
    @Serializable @SerialName("delivery_unknown")
    data object DeliveryUnknown : CaptureFailure

    /** The server explained its refusal (an upload it cannot take, or a turn it refused); safe to show. */
    @Serializable @SerialName("rejected")
    data class Rejected(val message: String?) : CaptureFailure

    @Serializable @SerialName("failed")
    data object Failed : CaptureFailure
}
