/**
 * Keeps the voice session alive when the phone screen locks.
 *
 * Layered strategies:
 * 1. Wake Lock API - prevents screen from dimming/locking
 * 2. AudioContext resume - resumes suspended audio processing on foreground
 * 3. Silent oscillator keep-alive - keeps iOS audio session active via Web Audio API
 * 4. Media Session API - registers as active media so iOS grants background audio
 * 5. Audio session category - tells iOS we need play-and-record (mic + speaker)
 * 6. Mic track recovery - re-acquires mic if OS kills the track
 * 7. WebRTC connection monitoring - logs connection state for diagnostics
 */

import { type RefObject, useEffect, useRef } from 'react';
import { APP_NAME } from '@client/config/general';

/**
 * Declare the Web Audio Session API (WebKit proposal, available in Safari/iOS WebKit).
 * This is not yet in lib.dom.d.ts so we type it manually.
 */
interface AudioSession {
  type: 'auto' | 'playback' | 'transient' | 'play-and-record' | 'ambient';
}

declare global {
  interface Navigator {
    audioSession?: AudioSession;
  }
}

interface VoiceKeepAliveOptions {
  isActive: boolean;
  audioContextRef: RefObject<AudioContext | null>;
  pcRef: RefObject<RTCPeerConnection | null>;
  audioElementRef: RefObject<HTMLAudioElement | null>;
  addDebugLog: (msg: string) => void;
  onMicTrackEnded: () => void;
}

export function useVoiceKeepAlive({
  isActive,
  audioContextRef,
  pcRef,
  audioElementRef,
  addDebugLog,
  onMicTrackEnded,
}: VoiceKeepAliveOptions): void {
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

  // Strategy 1: Wake Lock API
  useEffect(() => {
    if (!isActive) return;
    if (!('wakeLock' in navigator)) {
      addDebugLog('[KeepAlive] Wake Lock API not supported');
      return;
    }

    let released = false;

    const requestWakeLock = async () => {
      if (released) return;
      try {
        const sentinel = await navigator.wakeLock.request('screen');
        if (released) {
          sentinel.release();
          return;
        }
        wakeLockRef.current = sentinel;
        addDebugLog('[KeepAlive] Wake lock acquired');
        sentinel.addEventListener('release', () => {
          addDebugLog('[KeepAlive] Wake lock released');
          wakeLockRef.current = null;
        });
      } catch (err) {
        addDebugLog(`[KeepAlive] Wake lock failed: ${String(err)}`);
      }
    };

    // Re-acquire wake lock when returning to foreground (it auto-releases on hide)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && !released) {
        requestWakeLock();
      }
    };

    requestWakeLock();
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      released = true;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      wakeLockRef.current?.release();
      wakeLockRef.current = null;
    };
  }, [isActive, addDebugLog]);

  // Strategy 2: AudioContext resume on foreground
  useEffect(() => {
    if (!isActive) return;

    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;

      const ctx = audioContextRef.current;
      if (ctx && ctx.state === 'suspended') {
        ctx
          .resume()
          .then(() => addDebugLog('[KeepAlive] AudioContext resumed'))
          .catch(err => addDebugLog(`[KeepAlive] AudioContext resume failed: ${String(err)}`));
      }

      // Also try to resume the assistant audio element (iOS pauses it on background)
      const audioEl = audioElementRef.current;
      if (audioEl && audioEl.paused && audioEl.srcObject) {
        audioEl.play().catch(() => {
          // Autoplay blocked - user interaction needed
        });
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [isActive, audioContextRef, audioElementRef, addDebugLog]);

  // Strategy 3: silent oscillator keep-alive (iOS)
  // Uses the WebRTC AudioContext to run a near-inaudible oscillator.
  // This keeps the iOS audio session active even when the screen locks,
  // because it's tied to the same AudioContext as the WebRTC connection.
  // A data URI <audio> element doesn't register as active media in iOS PWA.
  useEffect(() => {
    if (!isActive) return;

    const ctx = audioContextRef.current;
    if (!ctx) {
      addDebugLog('[KeepAlive] No AudioContext for silent oscillator');
      return;
    }

    // Connected nodes keep the audio graph alive regardless of signal.
    // Zero gain ensures absolute silence - no DC offset to confuse Bluetooth devices.
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.frequency.value = 1;
    gain.gain.value = 0;
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start();

    addDebugLog('[KeepAlive] Silent oscillator keep-alive started');

    return () => {
      try {
        oscillator.stop();
        oscillator.disconnect();
        gain.disconnect();
      } catch {
        // Already stopped/disconnected
      }
      addDebugLog('[KeepAlive] Silent oscillator keep-alive stopped');
    };
  }, [isActive, audioContextRef, addDebugLog]);

  // Strategy 4: Media Session API
  // Registers a media session so iOS recognizes the app as actively
  // playing media. This enables background audio in iOS PWA (standalone)
  // and shows Now Playing controls on the lock screen.
  useEffect(() => {
    if (!isActive) return;
    if (!('mediaSession' in navigator)) {
      addDebugLog('[KeepAlive] Media Session API not supported');
      return;
    }

    navigator.mediaSession.metadata = new MediaMetadata({
      title: 'Voice Session',
      artist: APP_NAME,
      album: 'Active Conversation',
    });

    // Provide no-op action handlers so iOS knows we're handling media playback
    const actions: MediaSessionAction[] = ['play', 'pause', 'stop'];
    const handlers: Array<[MediaSessionAction, MediaSessionActionHandler]> = actions.map(action => {
      const handler: MediaSessionActionHandler = () => {
        addDebugLog(`[KeepAlive] MediaSession action: ${action}`);
      };
      return [action, handler];
    });

    for (const [action, handler] of handlers) {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch {
        // Action not supported on this platform
      }
    }

    navigator.mediaSession.playbackState = 'playing';
    addDebugLog('[KeepAlive] Media Session registered');

    return () => {
      navigator.mediaSession.playbackState = 'none';
      navigator.mediaSession.metadata = null;
      for (const [action] of handlers) {
        try {
          navigator.mediaSession.setActionHandler(action, null);
        } catch {
          // Already cleared
        }
      }
      addDebugLog('[KeepAlive] Media Session cleared');
    };
  }, [isActive, addDebugLog]);

  // Strategy 5: audio session category (iOS WebKit)
  // Sets the audio session type to 'play-and-record' which tells iOS
  // that the app needs both microphone input and audio output.
  // Without this, iOS PWA defaults to 'ambient' which gets suspended.
  useEffect(() => {
    if (!isActive) return;

    const audioSession = navigator.audioSession;
    if (!audioSession) {
      addDebugLog('[KeepAlive] Audio Session API not available');
      return;
    }

    const previousType = audioSession.type;
    audioSession.type = 'play-and-record';
    addDebugLog(`[KeepAlive] Audio session set to play-and-record (was: ${previousType})`);

    return () => {
      audioSession.type = previousType;
      addDebugLog(`[KeepAlive] Audio session restored to ${previousType}`);
    };
  }, [isActive, addDebugLog]);

  // Strategy 6: mic track recovery
  useEffect(() => {
    if (!isActive) return;

    const pc = pcRef.current;
    if (!pc) return;

    const sender = pc.getSenders().find(s => s.track?.kind === 'audio');
    const track = sender?.track;
    if (!track || !sender) return;

    const handleTrackEnded = async () => {
      addDebugLog('[KeepAlive] Mic track ended — attempting recovery');
      onMicTrackEnded();

      try {
        const newStream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        const newTrack = newStream.getAudioTracks()[0];

        // replaceTrack works without SDP renegotiation
        await sender.replaceTrack(newTrack);
        addDebugLog('[KeepAlive] Mic track recovered successfully');
      } catch (err) {
        addDebugLog(`[KeepAlive] Mic track recovery failed: ${String(err)}`);
      }
    };

    track.addEventListener('ended', handleTrackEnded);
    return () => track.removeEventListener('ended', handleTrackEnded);
  }, [isActive, pcRef, addDebugLog, onMicTrackEnded]);

  // Strategy 7: WebRTC connection state monitoring
  useEffect(() => {
    if (!isActive) return;

    const pc = pcRef.current;
    if (!pc) return;

    const handleConnectionStateChange = () => {
      addDebugLog(`[KeepAlive] PC connectionState: ${pc.connectionState}`);
    };
    const handleIceStateChange = () => {
      addDebugLog(`[KeepAlive] PC iceConnectionState: ${pc.iceConnectionState}`);
    };

    pc.addEventListener('connectionstatechange', handleConnectionStateChange);
    pc.addEventListener('iceconnectionstatechange', handleIceStateChange);

    return () => {
      pc.removeEventListener('connectionstatechange', handleConnectionStateChange);
      pc.removeEventListener('iceconnectionstatechange', handleIceStateChange);
    };
  }, [isActive, pcRef, addDebugLog]);
}
