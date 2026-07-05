/**
 * Headless hook containing all voice session logic.
 *
 * Extracted from VoiceSessionModal/index.tsx so the same WebRTC lifecycle,
 * transcript management, debug logging, and tool execution can be driven
 * by any UI surface (inline indicator, debug drawer, or the legacy modal).
 */

import {
  setupRealtimeConnection,
  startRealtimeConnection,
} from '@client/app/components/Session/VoiceSessionModal/realtimeConnection';
import { useVoiceSessionStore } from '@client/app/components/Session/VoiceSessionModal/voiceSessionStore';
import { api } from '@client/app/contexts/ApiContext';
import { useUser } from '@client/app/contexts/UserContext';
import { useWebsocket } from '@client/app/contexts/WebsocketContext';
import { useGetSettingsValue } from '@client/app/hooks/data/settings';
import { ISessionDocument } from '@bike4mind/common';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import type { TranscriptItem } from './types';
import { useVoiceKeepAlive } from './useVoiceKeepAlive';

// Re-export so consumers can import from one place
export type { TranscriptItem } from './types';

// Module-level pending connection
// When connect() creates a new session and navigates, the component remounts.
// We store the API response here so the new instance can resume the WebRTC
// setup without making a second API call.
interface PendingVoiceConnect {
  ephemeralKey: string;
  sessionId: string;
  model: string;
  voice: string;
}
let pendingVoiceConnect: PendingVoiceConnect | null = null;

// Bounded auto-reconnect after the WebRTC peer connection drops (network handoff
// or signal dip - common on mobile). Fully re-establishes against the same B4M
// session (fresh ephemeral key + SDP exchange), since the OpenAI Realtime
// handshake is a one-shot POST and ICE-restart renegotiation isn't supported.
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_BACKOFF_MS = [1000, 2000, 4000];

export interface UseVoiceSessionEngineOptions {
  sessionId?: string;
  autoConnect?: boolean;
  onSessionCreated?: (newSessionId: string) => void;
  onSessionEnded?: () => void;
}

export interface UseVoiceSessionEngine {
  // Connection state
  connectionStatus: 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
  isEnding: boolean;
  isActive: boolean;

  // Audio state
  isMuted: boolean;
  userStream: MediaStream | null;
  assistantStream: MediaStream | null;
  userSpeaking: boolean;
  assistantSpeaking: boolean;

  // Session info
  selectedVoice: string | null;
  activeSessionId: string | null;

  // Transcript
  transcriptItems: TranscriptItem[];

  // Debug
  debugLogs: string[];
  addDebugLog: (msg: string) => void;
  copyDebugLogs: () => void;
  clearDebugLogs: () => void;

  // Actions
  connect: () => Promise<void>;
  endSession: () => void;
  toggleMute: () => void;
}

export function useVoiceSessionEngine(options: UseVoiceSessionEngineOptions = {}): UseVoiceSessionEngine {
  const { sessionId, autoConnect = false, onSessionCreated, onSessionEnded } = options;

  // External hooks
  const { currentUser, refreshUser } = useUser();
  const { sendJsonMessage, subscribeToAction } = useWebsocket();
  const queryClient = useQueryClient();
  const adminVoice = useGetSettingsValue('voiceSessionAiVoice');
  const enforceCredits = !!useGetSettingsValue('enforceCredits');

  // Zustand store
  const {
    isMuted,
    userSpeaking,
    assistantSpeaking,
    connectionStatus,
    isEnding,
    setConnectionStatus,
    setMuted,
    setEnding,
    reset,
  } = useVoiceSessionStore();

  // Local state
  const [userStream, setUserStream] = useState<MediaStream | null>(null);
  const [assistantStream, setAssistantStream] = useState<MediaStream | null>(null);
  const [createdSessionId, setCreatedSessionId] = useState<string | null>(null);
  const [selectedVoice, setSelectedVoice] = useState<string | null>(null);
  const [transcriptItems, setTranscriptItems] = useState<TranscriptItem[]>([]);
  const [debugLogs, setDebugLogs] = useState<string[]>([]);

  // Refs
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const waitingForResponseDoneRef = useRef<boolean>(false);
  const endSessionTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const debouncedSendRef = useRef<Record<string, NodeJS.Timeout>>({});
  const questInvalidationTimerRef = useRef<NodeJS.Timeout | null>(null);
  // Track the sessionId that was active when the connection started so we
  // don't lose it if the parent component's sessionId prop changes.
  const connectedSessionIdRef = useRef<string | null>(null);
  // Reconnect state
  const reconnectAttemptsRef = useRef<number>(0);
  // A pending timer doubles as the in-flight guard: while one reconnect is
  // queued, the second of a 'disconnected'->'failed' pair (and any other repeat)
  // is ignored. A closed pc only emits 'closed', so it can't re-trigger.
  const reconnectTimerRef = useRef<NodeJS.Timeout | null>(null);
  // Holds the latest reconnect() so the pc state handlers can invoke it without
  // creating a connect()/reconnect() dependency cycle.
  const reconnectRef = useRef<(() => void) | null>(null);
  // Derived state
  const isActive = connectionStatus !== 'disconnected';
  const activeSessionId = sessionId || createdSessionId;

  // Debug logging
  const addDebugLog = useCallback((message: string) => {
    const timestamp = new Date().toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      fractionalSecondDigits: 3,
    });
    const entry = `[${timestamp}] ${message}`;
    console.log(`[VoiceDebug] ${message}`);
    setDebugLogs(prev => {
      const next = [...prev, entry];
      return next.length > 500 ? next.slice(-500) : next;
    });
  }, []);

  const copyDebugLogs = useCallback(() => {
    const logText = debugLogs.join('\n');
    navigator.clipboard.writeText(logText).then(() => {
      addDebugLog('[UI] Debug logs copied to clipboard');
    });
  }, [debugLogs, addDebugLog]);

  const clearDebugLogs = useCallback(() => {
    setDebugLogs([]);
  }, []);

  // Transcript persistence
  const sendTranscriptToServerImmediate = useCallback(
    async (transcriptData: {
      type: 'input' | 'response';
      sessionId: string;
      conversationItemId: string;
      transcript: string;
      timestamp?: Date;
    }) => {
      if (!currentUser?.id) {
        console.warn('No user id available for transcript');
        return;
      }
      try {
        sendJsonMessage({
          action: 'voice_session_send_transcript',
          sessionId: transcriptData.sessionId,
          transcript: transcriptData.transcript,
          type: transcriptData.type,
          conversationItemId: transcriptData.conversationItemId,
          userId: currentUser.id,
          timestamp: transcriptData.timestamp,
        });

        // Debounced invalidation so the chat UI picks up the new transcript
        // quickly without hammering React Query on every delta event
        if (questInvalidationTimerRef.current) {
          clearTimeout(questInvalidationTimerRef.current);
        }
        questInvalidationTimerRef.current = setTimeout(() => {
          queryClient.invalidateQueries({ queryKey: ['quests', 'session', transcriptData.sessionId] });
          questInvalidationTimerRef.current = null;
        }, 500);
      } catch (error) {
        console.error('Failed to send transcript:', error);
      }
    },
    [sendJsonMessage, currentUser, queryClient]
  );

  const sendTranscriptToServer = useCallback(
    (transcriptData: Parameters<typeof sendTranscriptToServerImmediate>[0]) => {
      const key = transcriptData.conversationItemId;
      if (debouncedSendRef.current[key]) {
        clearTimeout(debouncedSendRef.current[key]);
      }
      debouncedSendRef.current[key] = setTimeout(() => {
        sendTranscriptToServerImmediate(transcriptData);
        delete debouncedSendRef.current[key];
      }, 300);
    },
    [sendTranscriptToServerImmediate]
  );

  // Transcript helpers
  const addTranscriptMessage = useCallback(
    (sid: string, itemId: string, role: 'user' | 'assistant', text = '', isHidden = false) => {
      setTranscriptItems(prev => {
        if (prev.some(log => log.itemId === itemId)) return prev;

        const newItem: TranscriptItem = {
          itemId,
          role,
          title: text,
          timestamp: new Date(),
          createdAtMs: Date.now(),
          status: 'IN_PROGRESS',
          isHidden,
        };

        sendTranscriptToServer({
          type: newItem.role === 'user' ? 'input' : 'response',
          sessionId: sid,
          conversationItemId: newItem.itemId,
          transcript: newItem.title ?? '',
          timestamp: newItem.timestamp,
        });

        return [...prev, newItem];
      });
    },
    [sendTranscriptToServer]
  );

  const updateTranscriptMessage = useCallback(
    (sid: string, itemId: string, newText: string, append = false) => {
      setTranscriptItems(prev =>
        prev.map(item => {
          if (item.itemId === itemId) {
            const updatedItem = {
              ...item,
              title: append ? (item.title ?? '') + newText : newText,
            };
            sendTranscriptToServer({
              type: updatedItem.role === 'user' ? 'input' : 'response',
              sessionId: sid,
              conversationItemId: itemId,
              transcript: updatedItem.title ?? '',
              timestamp: updatedItem.timestamp,
            });
            return updatedItem;
          }
          return item;
        })
      );
    },
    [sendTranscriptToServer]
  );

  const updateTranscriptItem = useCallback(
    (sid: string, itemId: string, updatedProperties: Partial<TranscriptItem>) => {
      setTranscriptItems(prev =>
        prev.map(item => {
          if (item.itemId === itemId) {
            const updatedItem = { ...item, ...updatedProperties };
            sendTranscriptToServer({
              type: updatedItem.role === 'user' ? 'input' : 'response',
              sessionId: sid,
              conversationItemId: itemId,
              transcript: updatedItem.title ?? '',
              timestamp: updatedItem.timestamp,
            });
            return updatedItem;
          }
          return item;
        })
      );
    },
    [sendTranscriptToServer]
  );

  // Release WebRTC resources.
  // Tears down the peer connection, data channel, audio, and pending sends but
  // does NOT touch connectionStatus - so a reconnect can reuse it to drop the
  // dead connection while staying in the 'reconnecting' state.
  const releaseRealtimeResources = useCallback(() => {
    if (pcRef.current) {
      pcRef.current.getSenders().forEach(sender => {
        if (sender.track) sender.track.stop();
      });
      pcRef.current.close();
      pcRef.current = null;
    }

    if (dcRef.current) {
      // No need to removeEventListener - the anonymous listeners added during
      // setup are unreachable, and nulling the ref drops the channel anyway.
      dcRef.current = null;
    }

    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    if (audioElementRef.current) {
      audioElementRef.current.pause();
      audioElementRef.current.src = '';
      audioElementRef.current.load();
      audioElementRef.current = null;
    }

    Object.keys(debouncedSendRef.current).forEach(key => {
      clearTimeout(debouncedSendRef.current[key]);
    });
    debouncedSendRef.current = {};

    setUserStream(null);
    setAssistantStream(null);
  }, []);

  // WebRTC disconnect (terminal)
  const handleDisconnectFromRealtime = useCallback(() => {
    // Cancel any in-flight reconnect - this is a real teardown, not a blip.
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    reconnectAttemptsRef.current = 0;

    releaseRealtimeResources();
    setConnectionStatus('disconnected');
  }, [releaseRealtimeResources, setConnectionStatus]);

  // Session end completion
  const completeSessionEnd = useCallback(() => {
    reset();
    setSelectedVoice(null);
    setTranscriptItems([]);
    setDebugLogs([]);

    const targetSessionId = connectedSessionIdRef.current || sessionId || createdSessionId;
    if (targetSessionId) {
      api.post(`/api/sessions/${targetSessionId}/auto-rename`).catch(error => {
        console.error('[Voice] Failed to auto-rename session:', targetSessionId, error);
      });
    }

    queryClient.invalidateQueries({ queryKey: ['quests'] });
    queryClient.invalidateQueries({ queryKey: ['sessions'] });

    connectedSessionIdRef.current = null;
    onSessionEnded?.();
  }, [reset, queryClient, sessionId, createdSessionId, onSessionEnded]);

  // Connect to Realtime API
  const connect = useCallback(
    async (opts?: { isReconnect?: boolean }) => {
      const isReconnect = opts?.isReconnect ?? false;
      // Allow re-entry when resuming after navigation (status stays 'connecting'
      // to avoid a UI flash where isActive briefly flips to false), and when a
      // reconnect re-establishes a dropped connection (status is 'reconnecting').
      if (
        !isReconnect &&
        connectionStatus !== 'disconnected' &&
        !(connectionStatus === 'connecting' && pendingVoiceConnect)
      )
        return;
      if (!currentUser?.id) return;

      setConnectionStatus(isReconnect ? 'reconnecting' : 'connecting');

      let ephemeralKey: string;
      let resolvedSessionId: string;
      let model: string;

      // Check for pending connection data from a pre-navigation API call.
      // When connect() creates a new session on a route without a sessionId,
      // it navigates to /notebooks/$id which remounts the component. The API
      // response is stashed here so the new instance can resume without a
      // second round-trip. A reconnect skips this handoff entirely - it always
      // re-fetches a fresh ephemeral key for the already-resolved session.
      if (!isReconnect && pendingVoiceConnect) {
        const pending = pendingVoiceConnect;
        pendingVoiceConnect = null;
        ephemeralKey = pending.ephemeralKey;
        resolvedSessionId = pending.sessionId;
        model = pending.model;
        connectedSessionIdRef.current = resolvedSessionId;
        if (pending.voice && pending.voice !== selectedVoice) {
          setSelectedVoice(pending.voice);
        }
        addDebugLog('[RT] Resuming voice connect after navigation');
      } else {
        const { data } = await api.post<{
          session: ISessionDocument;
          model: string;
          voice: string;
          ephemeralKey: string;
        }>('/api/ai/voice-sessions', {
          // On reconnect, force the already-resolved session so we re-attach to it
          // (and don't create a second empty session) rather than the prop.
          sessionId: isReconnect ? connectedSessionIdRef.current : sessionId,
          // Tell the server to reuse the existing credit hold rather than reserving
          // (and charging) a second time for the same call.
          isReconnect,
        });

        resolvedSessionId = data.session.id;
        connectedSessionIdRef.current = resolvedSessionId;
        model = data.model;
        ephemeralKey = data.ephemeralKey;

        if (data.voice && data.voice !== selectedVoice) {
          setSelectedVoice(data.voice);
        }

        if (!isReconnect && !sessionId && resolvedSessionId) {
          // New session created - navigation to /notebooks/$id will remount this
          // component. Stash the API response and let the new instance finish
          // the WebRTC setup.
          console.debug('New session created by speech API:', data.session.id);
          pendingVoiceConnect = {
            ephemeralKey,
            sessionId: resolvedSessionId,
            model,
            voice: data.voice,
          };
          setCreatedSessionId(data.session.id);
          // Keep status as 'connecting' - don't reset to 'disconnected' - so
          // isActive stays true across the navigation remount and the UI doesn't
          // flash between the voice controls and the regular input.
          onSessionCreated?.(data.session.id);
          return;
        }

        if (!ephemeralKey) {
          setConnectionStatus('disconnected');
          return;
        }
      }

      if (!audioElementRef.current) {
        audioElementRef.current = document.createElement('audio');
      }
      audioElementRef.current.autoplay = true;
      audioElementRef.current.setAttribute('playsinline', '');

      // Phase 1: Create peer connection, acquire mic, create data channel.
      // No SDP exchange yet - we attach listeners first to avoid race conditions.
      const { pc, dc, userStream: localStream, audioContext } = await setupRealtimeConnection();

      // The user may have hit End (or a reconnect been superseded) while
      // setupRealtimeConnection was awaiting. The closure's `isEnding` is stale
      // across that await, so read the live store value - otherwise we'd park a
      // freshly-built pc/dc/audioContext in the refs *after* teardown already ran,
      // leaking a live peer connection (and the mic) the UI thinks is closed.
      if (useVoiceSessionStore.getState().isEnding) {
        pc.close();
        audioContext.close();
        localStream.getTracks().forEach(track => track.stop());
        return;
      }

      audioContextRef.current = audioContext;

      pcRef.current = pc;
      dcRef.current = dc;

      // Watch for the peer connection dropping so we can auto-reconnect. Attached
      // directly to this pc (not via a hook effect) so it always binds to the live
      // connection and re-binds on every reconnect. 'disconnected'/'failed' on a
      // mobile network (Wi-Fi/cellular handoff, signal dip) triggers recovery.
      pc.addEventListener('connectionstatechange', () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          reconnectRef.current?.();
        }
      });
      pc.addEventListener('iceconnectionstatechange', () => {
        if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
          reconnectRef.current?.();
        }
      });

      // Surface the local mic stream to React state immediately
      // (previously deferred to ontrack which only fires for the remote track).
      setUserStream(localStream);

      // Attach ALL data channel listeners BEFORE the SDP exchange
      dc.addEventListener('open', () => {
        addDebugLog('[DC] DataChannel opened');
      });

      dc.addEventListener('close', () => {
        addDebugLog('[DC] DataChannel closed');
      });

      dc.addEventListener('error', err => {
        addDebugLog(`[DC] DataChannel error: ${String(err)}`);
      });

      dc.addEventListener('message', (event: MessageEvent) => {
        const serverEvent = JSON.parse(event.data);

        switch (serverEvent.type) {
          case 'session.created':
            addDebugLog('[RT] Session created — connected');
            // A clean connect clears the reconnect budget so a later independent
            // drop gets its own full set of retries.
            if (reconnectTimerRef.current) {
              clearTimeout(reconnectTimerRef.current);
              reconnectTimerRef.current = null;
            }
            reconnectAttemptsRef.current = 0;
            setConnectionStatus('connected');
            break;
          case 'output_audio_buffer.started':
            useVoiceSessionStore.getState().setAssistantSpeaking(true);
            break;
          case 'output_audio_buffer.stopped':
            useVoiceSessionStore.getState().setAssistantSpeaking(false);
            break;
          case 'conversation.item.created':
          case 'conversation.item.added': {
            let text = serverEvent.item?.content?.[0]?.text || serverEvent.item?.content?.[0]?.transcript || '';
            const role = serverEvent.item?.role as 'user' | 'assistant';
            const itemId = serverEvent.item?.id;

            addDebugLog(
              `[RT] item.${serverEvent.type.split('.').pop()}: role=${role} id=${itemId} text="${text.substring(0, 80)}"`
            );

            if (itemId && role) {
              if (role === 'user' && !text) {
                text = '[Transcribing...]';
              }
              addTranscriptMessage(resolvedSessionId, itemId, role, text);
            }
            break;
          }
          case 'conversation.item.input_audio_transcription.completed': {
            const itemId = serverEvent.item_id;
            const finalTranscript =
              !serverEvent.transcript || serverEvent.transcript === '\n' ? '[inaudible]' : serverEvent.transcript;

            addDebugLog(`[RT] Transcription complete: "${finalTranscript.substring(0, 100)}"`);

            if (itemId) {
              updateTranscriptMessage(resolvedSessionId, itemId, finalTranscript, false);
            }
            break;
          }
          case 'response.output_audio_transcript.delta': {
            const itemId = serverEvent.item_id;
            const deltaText = serverEvent.delta || '';
            if (itemId) {
              updateTranscriptMessage(resolvedSessionId, itemId, deltaText, true);
            }
            break;
          }
          case 'response.done': {
            const usage = serverEvent.response?.usage;
            if (usage) {
              const usageData = {
                audioInputTokens: usage.input_token_details.audio_tokens,
                audioCachedInputTokens: usage.input_token_details.cached_tokens_details.audio_tokens,
                audioOutputTokens: usage.output_token_details.audio_tokens,
                textInputTokens: usage.input_token_details.text_tokens,
                textOutputTokens: usage.output_token_details.text_tokens,
                textCachedInputTokens: usage.input_token_details.cached_tokens_details.text_tokens,
              };

              sendJsonMessage({
                action: 'voice_session_ended',
                sessionId: resolvedSessionId,
                model,
                usage: usageData,
                userId: currentUser.id,
              });
            }

            if (waitingForResponseDoneRef.current) {
              waitingForResponseDoneRef.current = false;
              if (endSessionTimeoutRef.current) {
                clearTimeout(endSessionTimeoutRef.current);
                endSessionTimeoutRef.current = null;
              }
              handleDisconnectFromRealtime();
              completeSessionEnd();
            }
            break;
          }
          case 'response.output_item.done': {
            const itemId = serverEvent.item?.id;
            if (itemId) {
              updateTranscriptItem(resolvedSessionId, itemId, { status: 'DONE' });
            }
            break;
          }
          case 'response.function_call_arguments.delta':
            break;
          case 'response.function_call_arguments.done': {
            const callId = serverEvent.call_id;
            const functionName = serverEvent.name;
            const functionArgs = JSON.parse(serverEvent.arguments || '{}');

            addDebugLog(
              `[RT] Tool call: ${functionName} callId=${callId} args=${JSON.stringify(functionArgs).substring(0, 200)}`
            );

            import('./voiceToolExecutor')
              .then(async ({ executeVoiceTool, formatToolExecution }) => {
                const toolMessage = formatToolExecution(functionName, functionArgs);
                addTranscriptMessage(resolvedSessionId, `tool_${callId}`, 'assistant', toolMessage, true);

                addDebugLog(`[RT] Executing tool: ${functionName}...`);
                const toolResult = await executeVoiceTool(
                  functionName,
                  functionArgs,
                  resolvedSessionId,
                  addDebugLog,
                  subscribeToAction
                );

                addDebugLog(
                  `[RT] Tool result: success=${toolResult.success} resultLength=${toolResult.result?.length ?? 0} error=${toolResult.error ?? 'none'}`
                );

                if (dcRef.current && dcRef.current.readyState === 'open') {
                  const outputText = toolResult.success ? toolResult.result : `Error: ${toolResult.error}`;
                  addDebugLog(`[RT] Sending function_call_output to Realtime API (${outputText?.length ?? 0} chars)`);

                  dcRef.current.send(
                    JSON.stringify({
                      type: 'conversation.item.create',
                      item: {
                        type: 'function_call_output',
                        call_id: callId,
                        output: outputText,
                      },
                    })
                  );

                  addDebugLog('[RT] Sending response.create to trigger AI speech');
                  dcRef.current.send(JSON.stringify({ type: 'response.create' }));
                } else {
                  addDebugLog(
                    `[RT] WARNING: DataChannel not open (state=${dcRef.current?.readyState ?? 'null'}), cannot send tool result`
                  );
                }
              })
              .catch(importError => {
                addDebugLog(`[RT] CRITICAL: Failed to load voiceToolExecutor module: ${String(importError)}`);
                if (dcRef.current && dcRef.current.readyState === 'open') {
                  dcRef.current.send(
                    JSON.stringify({
                      type: 'conversation.item.create',
                      item: {
                        type: 'function_call_output',
                        call_id: callId,
                        output: 'Error: Tool system temporarily unavailable. Please try again.',
                      },
                    })
                  );
                  dcRef.current.send(JSON.stringify({ type: 'response.create' }));
                }
              });
            break;
          }
          default:
            break;
        }
      });

      // Phase 2: Now that all listeners are attached, perform the SDP exchange.
      // Any events (including session.created) will be caught by the listeners above.
      await startRealtimeConnection(pc, ephemeralKey, audioElementRef, stream => {
        setAssistantStream(stream);
      });
    },
    [
      connectionStatus,
      currentUser?.id,
      sessionId,
      selectedVoice,
      sendJsonMessage,
      setConnectionStatus,
      addDebugLog,
      addTranscriptMessage,
      updateTranscriptMessage,
      updateTranscriptItem,
      handleDisconnectFromRealtime,
      completeSessionEnd,
      subscribeToAction,
      onSessionCreated,
    ]
  );

  // Reconnect after an abnormal connection drop.
  // Triggered by the keep-alive PC monitor when the peer connection fails.
  // Tears down the dead connection and re-establishes against the same session
  // with bounded, backed-off retries. Exhaustion ends the session honestly.
  const reconnect = useCallback(() => {
    // Don't fight a user-initiated end, and ignore repeats while a reconnect is
    // already queued (e.g. the 'disconnected'->'failed' pair for one drop).
    if (isEnding || waitingForResponseDoneRef.current) return;
    if (reconnectTimerRef.current) return;
    if (!connectedSessionIdRef.current) return;

    releaseRealtimeResources();
    setConnectionStatus('reconnecting');

    const attempt = reconnectAttemptsRef.current;
    if (attempt >= MAX_RECONNECT_ATTEMPTS) {
      addDebugLog('[RT] Reconnect attempts exhausted — ending session');
      handleDisconnectFromRealtime();
      toast.error('Voice connection lost. Please try again.');
      return;
    }

    const delay = RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)];
    reconnectAttemptsRef.current = attempt + 1;
    addDebugLog(`[RT] Connection lost — reconnecting (attempt ${attempt + 1}/${MAX_RECONNECT_ATTEMPTS}) in ${delay}ms`);

    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      connect({ isReconnect: true }).catch(err => {
        addDebugLog(`[RT] Reconnect attempt failed: ${String(err)}`);
        // A failed establish counts as another drop - try again or give up.
        reconnectRef.current?.();
      });
    }, delay);
  }, [isEnding, connect, releaseRealtimeResources, handleDisconnectFromRealtime, setConnectionStatus, addDebugLog]);

  // Keep the ref pointing at the latest reconnect so the keep-alive monitor and
  // the self-retry path above can invoke it without a dependency cycle.
  useEffect(() => {
    reconnectRef.current = reconnect;
  }, [reconnect]);

  // End session (graceful)
  const endSession = useCallback(() => {
    if (isEnding || waitingForResponseDoneRef.current) return;

    setEnding(true);

    // Immediately disable the mic so no audio reaches server VAD during teardown.
    // Without this, the user can still speak and trigger new responses while ending.
    if (pcRef.current) {
      pcRef.current.getSenders().forEach(sender => {
        if (sender.track) sender.track.enabled = false;
      });
    }

    if (connectionStatus === 'connected' && dcRef.current?.readyState === 'open') {
      console.debug('Waiting for response.done before ending session...');
      waitingForResponseDoneRef.current = true;

      try {
        dcRef.current.send(JSON.stringify({ type: 'response.cancel' }));
      } catch (error) {
        console.warn('Failed to send response.cancel:', error);
      }

      endSessionTimeoutRef.current = setTimeout(() => {
        console.warn('Timeout waiting for response.done, forcing session end');
        waitingForResponseDoneRef.current = false;
        handleDisconnectFromRealtime();
        completeSessionEnd();
      }, 10000);
    } else {
      handleDisconnectFromRealtime();
      completeSessionEnd();
    }
  }, [isEnding, connectionStatus, setEnding, handleDisconnectFromRealtime, completeSessionEnd]);

  // Toggle mute
  const toggleMute = useCallback(() => {
    if (!userStream) return;
    const audioTrack = userStream.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled;
      setMuted(!audioTrack.enabled);
    }
  }, [userStream, setMuted]);

  // Effects

  // Refresh user data when engine activates (to get latest voice preference)
  useEffect(() => {
    if (isActive) {
      refreshUser();
    }
  }, [isActive, refreshUser]);

  // Auto-end voice session when credits run out mid-session (client-side fallback)
  useEffect(() => {
    if (!isActive || !enforceCredits) return;
    if ((currentUser?.currentCredits ?? 0) <= 0) {
      toast.error('Out of Credits! Voice session ended.');
      endSession();
    }
  }, [isActive, enforceCredits, currentUser?.currentCredits, endSession]);

  // Server-side enforcement: listen for voice_credits_exhausted signal
  useEffect(() => {
    if (!isActive) return;
    const unsubscribe = subscribeToAction('voice_credits_exhausted', async () => {
      toast.error('Out of Credits! Voice session ended.');
      // Just kill the WebRTC connection - don't call completeSessionEnd()
      // which triggers navigation and session callbacks
      handleDisconnectFromRealtime();
      reset();
      setSelectedVoice(null);
      setTranscriptItems([]);
      connectedSessionIdRef.current = null;
    });
    return unsubscribe;
  }, [isActive, subscribeToAction, handleDisconnectFromRealtime, reset]);

  // Update voice selection from user prefs / admin settings
  useEffect(() => {
    if (isActive || autoConnect) {
      const voice = currentUser?.preferredVoice || (typeof adminVoice === 'string' ? adminVoice : null) || 'alloy';
      setSelectedVoice(voice);
    }
  }, [isActive, autoConnect, currentUser?.preferredVoice, adminVoice]);

  // Auto-connect when autoConnect is true
  useEffect(() => {
    if (autoConnect && connectionStatus === 'disconnected') {
      connect().catch(err => console.error(err));
    }
  }, [autoConnect, connectionStatus, connect]);

  // Resume voice connection after navigation-induced remount.
  // When connect() creates a new session on a route without a sessionId,
  // it stashes the API response in pendingVoiceConnect and navigates.
  // Once the new component mounts and sessionId resolves to the new ID,
  // this effect fires and completes the WebRTC setup.
  useEffect(() => {
    if (pendingVoiceConnect && sessionId === pendingVoiceConnect.sessionId && connectionStatus === 'connecting') {
      connect().catch(err => console.error('Failed to resume voice session after navigation:', err));
    }
  }, [sessionId, connectionStatus, connect]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      Object.keys(debouncedSendRef.current).forEach(key => {
        clearTimeout(debouncedSendRef.current[key]);
      });
      debouncedSendRef.current = {};

      if (endSessionTimeoutRef.current) {
        clearTimeout(endSessionTimeoutRef.current);
        endSessionTimeoutRef.current = null;
      }

      if (questInvalidationTimerRef.current) {
        clearTimeout(questInvalidationTimerRef.current);
        questInvalidationTimerRef.current = null;
      }

      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }

      waitingForResponseDoneRef.current = false;
      // Only tear down WebRTC if there's no pending handoff to the next instance
      if (!pendingVoiceConnect) {
        handleDisconnectFromRealtime();
      }
    };
  }, [handleDisconnectFromRealtime]);

  // Keep-alive strategies (wake lock, audio resume, silent audio, etc.)
  useVoiceKeepAlive({
    isActive,
    audioContextRef,
    pcRef,
    audioElementRef,
    addDebugLog,
    onMicTrackEnded: () => {
      addDebugLog('[Voice] Mic track ended event fired — OS may have killed audio');
    },
  });

  return {
    // Connection state
    connectionStatus,
    isEnding,
    isActive,

    // Audio state
    isMuted,
    userStream,
    assistantStream,
    userSpeaking,
    assistantSpeaking,

    // Session info
    selectedVoice,
    activeSessionId,

    // Transcript
    transcriptItems,

    // Debug
    debugLogs,
    addDebugLog,
    copyDebugLogs,
    clearDebugLogs,

    // Actions
    connect,
    endSession,
    toggleMute,
  };
}
