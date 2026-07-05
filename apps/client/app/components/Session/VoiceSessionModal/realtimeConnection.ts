import { RefObject } from 'react';

/**
 * Phase 1: Create the RTCPeerConnection, acquire microphone, and create the
 * data channel. No SDP exchange yet - callers should attach event listeners
 * to `dc` before calling `startRealtimeConnection`.
 *
 * Follows the GA Realtime API WebRTC pattern exactly:
 * https://developers.openai.com/api/docs/guides/realtime-webrtc
 */
export async function setupRealtimeConnection(): Promise<{
  pc: RTCPeerConnection;
  dc: RTCDataChannel;
  userStream: MediaStream;
  audioContext: AudioContext;
}> {
  const pc = new RTCPeerConnection();

  const userStream = await navigator.mediaDevices.getUserMedia({
    audio: true,
  });

  // Add mic track directly - no AudioContext routing, matching GA docs exactly
  pc.addTrack(userStream.getTracks()[0]);

  const dc = pc.createDataChannel('oai-events');

  // AudioContext is needed by useVoiceKeepAlive to resume suspended audio on
  // foreground (iOS pauses AudioContexts when backgrounded).
  const audioContext = new AudioContext();

  return { pc, dc, userStream, audioContext };
}

/**
 * Phase 2: Wire up `ontrack`, perform the SDP offer/answer exchange with
 * OpenAI, and set the remote description. Call this only after all data
 * channel listeners have been attached.
 */
export async function startRealtimeConnection(
  pc: RTCPeerConnection,
  ephemeralKey: string,
  audioElement: RefObject<HTMLAudioElement | null>,
  onAssistantStream?: (assistantStream: MediaStream) => void
): Promise<void> {
  pc.ontrack = e => {
    const assistantStream = e.streams[0];
    if (audioElement.current) {
      audioElement.current.srcObject = assistantStream;
    }
    onAssistantStream?.(assistantStream);
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  const sdpResponse = await fetch('https://api.openai.com/v1/realtime/calls', {
    method: 'POST',
    body: offer.sdp,
    headers: {
      Authorization: `Bearer ${ephemeralKey}`,
      'Content-Type': 'application/sdp',
    },
  });

  if (!sdpResponse.ok) {
    const errorBody = await sdpResponse.text();
    console.error('[RealtimeConnection] SDP exchange failed:', sdpResponse.status, errorBody);
    throw new Error(`SDP exchange failed (${sdpResponse.status}): ${errorBody}`);
  }

  const answerSdp = await sdpResponse.text();
  await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
}
