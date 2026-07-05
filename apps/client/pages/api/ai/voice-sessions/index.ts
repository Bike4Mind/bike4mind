import {
  adminSettingsRepository,
  apiKeyRepository,
  sessionRepository,
  projectRepository,
  fabFileRepository,
  userRepository,
  questRepository,
} from '@bike4mind/database';
import { AiEvents, ApiKeyType, ISessionDocument, redactSessionForClient } from '@bike4mind/common';
import { apiKeyService, sessionService } from '@bike4mind/services';
import {
  buildVoiceInstructions,
  ForbiddenError,
  formatVoiceHistory,
  getSettingsMap,
  getSettingsValue,
  usdToCredits,
} from '@bike4mind/utils';
import { logEvent } from '@server/utils/analyticsLog';
import { baseApi } from '@server/middlewares/baseApi';
import { shouldReuseVoiceHold } from '@server/voice/voiceSessionLimits';
import axios from 'axios';
import { z } from 'zod';

const CreateSessionBodySchema = z.object({
  sessionId: z.string().optional(),
  // Set by the client when re-establishing a dropped connection. Lets the handler
  // reuse the existing credit hold instead of reserving (and charging) a second time.
  isReconnect: z.boolean().optional(),
});

const handler = baseApi().post(async (req, res) => {
  const { sessionId, isReconnect } = CreateSessionBodySchema.parse(req.body);

  const settings = await getSettingsMap(
    {
      adminSettings: adminSettingsRepository,
    },
    {
      names: [
        'enableVoiceSession',
        'voiceSessionAiVoice',
        'voiceSessionVadType',
        'voiceSessionVadEagerness',
        'enforceCredits',
      ],
    }
  );
  const enableVoiceSession = getSettingsValue('enableVoiceSession', settings);
  const adminVoiceSessionAiVoice = getSettingsValue('voiceSessionAiVoice', settings);

  // Use user's preferred voice if set, otherwise fall back to admin setting
  const voiceSessionAiVoice = req.user?.preferredVoice || adminVoiceSessionAiVoice;

  const voiceSessionTranscriptionModel = getSettingsValue('voiceSessionTranscriptionModel', settings, 'whisper-1');
  const vadType = getSettingsValue('voiceSessionVadType', settings, 'semantic_vad');
  const vadEagerness = getSettingsValue('voiceSessionVadEagerness', settings, 'medium');
  if (!enableVoiceSession) {
    throw new ForbiddenError('Voice session is not enabled');
  }

  // Block voice sessions when user has no credits and credit enforcement is enabled
  const enforceCredits = getSettingsValue('enforceCredits', settings);
  if (enforceCredits && (req.user?.currentCredits ?? 0) <= 0) {
    throw new ForbiddenError('Out of Credits!');
  }

  // Enforce concurrent voice session limit
  const MAX_CONCURRENT_VOICE_SESSIONS = 2;
  const activeVoiceCount = await sessionRepository.countActiveVoiceSessionsByUserId(req.user.id);
  if (activeVoiceCount >= MAX_CONCURRENT_VOICE_SESSIONS) {
    throw new ForbiddenError(`Maximum ${MAX_CONCURRENT_VOICE_SESSIONS} concurrent voice sessions allowed`);
  }

  // Pre-reserve credits for max session duration (60 min x ~$0.77/hr audio)
  // Reservation prevents unbounded post-facto billing for long sessions.
  const VOICE_RESERVE_USD = 0.77; // ~60 min worst-case cost
  const reservedCredits = usdToCredits(VOICE_RESERVE_USD);
  if (enforceCredits && !isReconnect) {
    const currentCredits = req.user?.currentCredits ?? 0;
    if (currentCredits < reservedCredits) {
      throw new ForbiddenError(`Insufficient credits for voice session (requires ~${reservedCredits} credits)`);
    }
    // Credit deduction happens below, immediately before the OpenAI API call.
    // Deferring it until after API key fetch and session creation ensures any pre-flight
    // error (missing key, session not found) cannot strand reserved credits.
  }

  const realtimeModel = 'gpt-realtime-1.5';

  const openaiApiKey = await apiKeyService.getEffectiveApiKey(
    req.user?.id,
    { type: ApiKeyType.openai, nullIfMissing: true },
    { db: { apiKeys: apiKeyRepository, adminSettings: adminSettingsRepository } }
  );

  let session: ISessionDocument | null = null;

  if (sessionId) {
    session = await sessionService.getSession(
      req.user.id,
      { id: sessionId },
      {
        db: {
          sessions: sessionRepository,
          users: userRepository,
        },
      }
    );
  } else {
    session = await sessionService.createSession(
      req.user,
      {
        name: 'New Voice Session',
      },
      {
        db: {
          sessions: sessionRepository,
          projects: projectRepository,
          fabFiles: fabFileRepository,
        },
      }
    );
  }

  // A reconnect re-attaches to a session that still holds a live reservation from
  // the original connect. Reuse that hold: skip the second deduction and keep the
  // original voiceSessionStartedAt, so the single end-reconciliation covers the
  // whole call (including reconnect gaps, against MAX_SESSION_SECONDS). Without
  // this, every mobile reconnect would burn another full reserve that's never
  // refunded. Guarded by an explicit live hold so a stray flag can't skip a real charge.
  const reuseHold = shouldReuseVoiceHold(isReconnect, session);

  // Build voice instructions with conversation history context
  const brand = process.env.APP_NAME || '';
  const baseInstructions = `You are a helpful AI assistant engaged in a voice conversation.
Be conversational, friendly, and concise in your responses.
When the user asks about previous discussions, refer back to the conversation context naturally.
Keep responses brief and suitable for voice - avoid long lists or complex formatting.

You have access to an agent_request tool that connects to the full ${brand ? `${brand} AI system` : 'AI system'}.
Use it when the user asks you to:
- Search their files, documents, or knowledge base
- Generate or edit images
- Do deep research on a topic
- Create charts or diagrams
- Access connected services (GitHub, Jira, Confluence, etc.)
- Read, create, or edit files
- Publish or edit blog posts
- Use math or calculation tools
- Anything that requires data or tools beyond what you have directly

For casual conversation, questions, opinions, brainstorming, and general chat — respond directly.

IMPORTANT — Tool call behavior:
Before calling ANY tool (web_search, weather_info, current_datetime, agent_request), you MUST first speak a brief verbal acknowledgment to the user. Examples:
- "Sure, let me look that up for you."
- "Let me roll those dice!"
- "One moment, I'll check the weather."
- "Great question, let me search your files for that."
This verbal acknowledgment must be audio output BEFORE you invoke the function call.
Never silently call a tool — always speak first so the user knows you heard them.
When you get the tool result back, summarize it conversationally for voice.`;

  let instructions = baseInstructions;

  // If this is an existing session, fetch conversation history for context
  if (sessionId && session) {
    try {
      // Fetch exactly the number of items we'll use (10 recent messages)
      const historyItems = await questRepository.getMostRecentChatHistory(session.id, 10);

      if (historyItems && historyItems.length > 0) {
        // Reverse to get chronological order (getMostRecentChatHistory returns newest first)
        const chronologicalHistory = [...historyItems].reverse();

        const historyContext = formatVoiceHistory(chronologicalHistory, {
          maxChars: 3000,
          recentMessageCount: 10,
          maxCharsPerMessage: 300,
        });

        instructions = buildVoiceInstructions(baseInstructions, historyContext);
        console.log(
          `[Voice Session] Added ${chronologicalHistory.length} history items to context (${instructions.length} chars)`
        );
      }
    } catch (error) {
      console.error('[Voice Session] Failed to fetch history for context:', error);
      // Continue without history context - don't fail the session
    }
  }

  const requestBody = {
    session: {
      type: 'realtime',
      model: realtimeModel,
      output_modalities: ['audio'],
      instructions,
      audio: {
        input: {
          transcription: {
            model: voiceSessionTranscriptionModel,
          },
          turn_detection:
            vadType === 'semantic_vad'
              ? {
                  type: 'semantic_vad',
                  eagerness: vadEagerness,
                  create_response: true,
                  interrupt_response: true,
                }
              : {
                  type: 'server_vad',
                  threshold: 0.5,
                  prefix_padding_ms: 400,
                  silence_duration_ms: 1500,
                  create_response: true,
                },
        },
        output: {
          voice: voiceSessionAiVoice || undefined,
        },
      },
      tools: [
        {
          type: 'function',
          name: 'web_search',
          description:
            'Search the web for current information. Use this when you need up-to-date information or facts.',
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'The search query',
              },
              num_results: {
                type: 'number',
                description: 'Number of results to return (default: 3)',
              },
            },
            required: ['query'],
          },
        },
        {
          type: 'function',
          name: 'web_fetch',
          description:
            'Fetch and read the full content of a specific URL. Use this when the user provides a direct URL link and wants you to read or summarize its content.',
          parameters: {
            type: 'object',
            properties: {
              url: {
                type: 'string',
                format: 'uri',
                description: 'The URL to fetch content from (must be http or https)',
              },
            },
            required: ['url'],
          },
        },
        {
          type: 'function',
          name: 'weather_info',
          description:
            'Get current weather information for a location using latitude and longitude coordinates. Use this when users ask about weather.',
          parameters: {
            type: 'object',
            properties: {
              lat: {
                type: 'number',
                description: 'Latitude of the location',
              },
              lon: {
                type: 'number',
                description: 'Longitude of the location',
              },
              units: {
                type: 'string',
                description: 'Temperature units: "imperial" (Fahrenheit) or "metric" (Celsius)',
                enum: ['imperial', 'metric'],
              },
            },
            required: ['lat', 'lon'],
          },
        },
        {
          type: 'function',
          name: 'current_datetime',
          description:
            'Get the current date and time. Use this when users ask about the current time, date, day of week, etc.',
          parameters: {
            type: 'object',
            properties: {},
          },
        },
        {
          type: 'function',
          name: 'agent_request',
          description:
            `Send a request to the full ${brand ? `${brand} AI system` : 'AI system'} for capabilities beyond basic conversation. ` +
            'Use this when the user asks you to: search their files or knowledge base, generate images, ' +
            'do deep research, create charts, access connected services (GitHub, Jira, etc.), ' +
            'read or edit files, publish blog posts, use math tools, or anything that requires ' +
            "tools and data you don't have direct access to. The system has 30+ tools, RAG " +
            "(retrieval augmented generation) over the user's uploaded documents, and integrations " +
            "with external services. Pass the user's request as-is in the message parameter.",
          parameters: {
            type: 'object',
            properties: {
              message: {
                type: 'string',
                description: "The user's request to process through the full AI system, in natural language",
              },
            },
            required: ['message'],
          },
        },
      ],
      tool_choice: 'auto',
      max_output_tokens: 4096,
    },
  };

  // Deduct credits immediately before the API call - all pre-flight checks have passed.
  // Deferral from the original position ensures no pre-flight throw can strand credits.
  // A reconnect reuses the original hold (reuseHold), so it must not deduct again.
  if (enforceCredits && !reuseHold) {
    await userRepository.incrementCredits(req.user.id, -reservedCredits);
  }

  let result;
  try {
    result = await axios.post('https://api.openai.com/v1/realtime/client_secrets', requestBody, {
      headers: {
        Authorization: `Bearer ${openaiApiKey}`,
        'Content-Type': 'application/json',
      },
    });
  } catch (error: unknown) {
    // Refund reservation on any API failure - credits were pre-deducted and no session started
    if (enforceCredits && !reuseHold) {
      await userRepository.incrementCredits(req.user.id, reservedCredits);
    }
    if (axios.isAxiosError(error)) {
      const responseData = error.response?.data;
      const status = error.response?.status;
      console.error('[Voice Session] OpenAI Realtime API error:', status, JSON.stringify(responseData));
      return res.status(status || 500).json({
        error: 'OpenAI Realtime API error',
        status,
        details: responseData,
      });
    }
    throw error;
  }

  if (!session) {
    // Refund reservation if session creation failed
    if (enforceCredits && !reuseHold) {
      await userRepository.incrementCredits(req.user.id, reservedCredits);
    }
    return res.status(500).json({ error: 'Failed to create or retrieve session' });
  }

  // Record reservation and start time on session for reconciliation at session end.
  // A reconnect leaves the original reservation record untouched so end-reconciliation
  // measures the full call duration, not just the post-reconnect segment.
  if (!reuseHold) {
    const voiceSessionStartedAt = new Date();
    await sessionRepository.update({
      id: session.id,
      voiceReservedCredits: enforceCredits ? reservedCredits : null,
      voiceSessionStartedAt,
    });
  }

  await logEvent(
    {
      userId: req.user?.id,
      type: AiEvents.AI_VOICE_SESSION_STARTED,
      metadata: { sessionId: session.id, model: realtimeModel },
    },
    { ability: req.ability }
  );

  return res.json({
    session: redactSessionForClient(session),
    model: realtimeModel,
    voice: voiceSessionAiVoice || 'alloy',
    ephemeralKey: result.data.value,
  });
});

export default handler;
