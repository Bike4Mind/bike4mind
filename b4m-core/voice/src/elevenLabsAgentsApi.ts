/**
 * Thin wrappers around the ElevenLabs Conversational AI agents REST API.
 *
 * Reference: https://elevenlabs.io/docs/conversational-ai/api-reference/agents
 */

const CONVAI_BASE = 'https://api.elevenlabs.io/v1/convai/agents';

/**
 * ElevenLabs `conversation_config.turn.turn_timeout` (seconds) - how long the
 * agent waits through user silence before taking a turn. Applied at create time;
 * on update it is only sent when the caller explicitly passes turnTimeoutSeconds
 * (a partial edit leaves the existing value unchanged). A modest
 * value (vs. ElevenLabs' ~7s default) gives the user room to think without the
 * agent going fully silent; -1 would disable the silence-triggered turn entirely.
 */
export const SILENCE_TURN_TIMEOUT_SECONDS = 10;

/**
 * ElevenLabs `conversation_config.turn.turn_eagerness` - how readily the agent
 * ends the user's turn and starts responding when it detects a pause:
 *   - `patient`: waits longest; best when users pause mid-thought (avoids the
 *     agent cutting in on a half-finished sentence and answering a partial).
 *   - `normal`: ElevenLabs' balanced default.
 *   - `eager`: responds at the earliest pause; snappiest but most likely to clip.
 * Defaults to `patient` for B4M voice agents since voice users frequently pause
 * mid-sentence; admins can change it per agent.
 */
export type TurnEagerness = 'patient' | 'normal' | 'eager';
export const DEFAULT_TURN_EAGERNESS: TurnEagerness = 'patient';

/**
 * ElevenLabs `conversation_config.agent.prompt.cascade_timeout_seconds` -
 * how long ElevenLabs waits for our Custom LLM proxy to respond before
 * cascading to a backup LLM. ElevenLabs' default is 8s, which our voice turns
 * regularly exceed once a slow tool (web_search, RAG, deep_research) runs.
 * 15 is the API-enforced maximum (valid range: 2-15 inclusive) - anything
 * higher is rejected with 422.
 */
const LLM_CASCADE_TIMEOUT_SECONDS = 15;

/**
 * Built-in (system) tools enabled on every B4M-managed voice agent, shaped for
 * ElevenLabs' `conversation_config.agent.prompt.built_in_tools` - an object
 * keyed by tool name, where each entry needs `name` and a
 * `params.system_tool_type` discriminant. Empty description = ElevenLabs'
 * default prompting tuned per tool. ElevenLabs adds these to the `tools` array
 * sent to our Custom LLM proxy and executes the tool call the proxy emits.
 * - `end_call` lets the agent hang up on its own when the conversation concludes.
 * - `language_detection` lets the agent switch spoken language mid-conversation
 *   when it detects the user has changed languages.
 *
 * NOTE: the older `prompt.tools` array is deprecated for system tools - they
 * must be declared here under `built_in_tools` or ElevenLabs ignores them.
 */
const BUILT_IN_TOOLS = {
  end_call: {
    name: 'end_call',
    description: '',
    params: { system_tool_type: 'end_call' },
  },
  language_detection: {
    name: 'language_detection',
    description: '',
    params: { system_tool_type: 'language_detection' },
  },
} as const;

export interface CreateElevenLabsAgentInput {
  /** Display name in ElevenLabs. */
  name: string;
  /** ElevenLabs voice ID the agent will speak with. */
  voiceId: string;
  /** System prompt for the assistant. */
  systemPrompt: string;
  /** Spoken greeting the agent opens with. Defaults to empty (no greeting). */
  firstMessage?: string;
  /**
   * Fully-qualified URL of our Custom LLM proxy
   * (e.g. `https://your-deployment.example.com/api/voice/v2/llm-proxy`).
   * ElevenLabs appends `/chat/completions` at call time.
   */
  customLlmUrl: string;
  /** Optional override language (BCP-47). Defaults to 'en'. */
  language?: string;
  /** Turn-taking eagerness. Defaults to DEFAULT_TURN_EAGERNESS ('patient'). */
  turnEagerness?: TurnEagerness;
  /** Seconds of user silence before the agent re-engages. Defaults to SILENCE_TURN_TIMEOUT_SECONDS. */
  turnTimeoutSeconds?: number;
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch;
}

export interface CreateElevenLabsAgentResult {
  agentId: string;
  /** Raw response payload for callers that want it. */
  raw: unknown;
}

interface AgentsCreateResponse {
  agent_id?: string;
}

/**
 * Creates a Conversational AI agent in the configured ElevenLabs workspace
 * with our Custom LLM pre-wired and the override permissions needed by Voice
 * v2 (custom_llm_extra_body for caller identity, tts.voice_id for per-user
 * voice selection at session start).
 */
export async function createElevenLabsAgent(
  apiKey: string,
  input: CreateElevenLabsAgentInput
): Promise<CreateElevenLabsAgentResult> {
  if (!apiKey) throw new Error('ElevenLabs API key is required to create an agent');
  if (!input.name) throw new Error('Agent name is required');
  if (!input.voiceId) throw new Error('Voice ID is required');
  if (!input.customLlmUrl) throw new Error('Custom LLM URL is required');

  const fetchImpl = input.fetchImpl ?? fetch;
  const body = {
    name: input.name,
    conversation_config: {
      agent: {
        first_message: input.firstMessage ?? '',
        language: input.language ?? 'en',
        prompt: {
          prompt: input.systemPrompt,
          llm: 'custom-llm',
          custom_llm: {
            url: input.customLlmUrl,
            model_id: 'custom-llm',
          },
          built_in_tools: BUILT_IN_TOOLS,
          // Bumped from the 8s default so slow tools (web_search, RAG) don't
          // trigger a cascade to backup LLM mid-turn. 15 is the API max.
          cascade_timeout_seconds: LLM_CASCADE_TIMEOUT_SECONDS,
        },
      },
      tts: {
        voice_id: input.voiceId,
      },
      // Give the user room to pause without the agent jumping in too eagerly
      // (ElevenLabs' ~7s default produces filler like "are you still there?"
      // with our Custom LLM). turn_eagerness governs how readily a pause ends the
      // user's turn; turn_timeout is the silence-before-re-engage window.
      turn: {
        turn_timeout: input.turnTimeoutSeconds ?? SILENCE_TURN_TIMEOUT_SECONDS,
        turn_eagerness: input.turnEagerness ?? DEFAULT_TURN_EAGERNESS,
      },
    },
    platform_settings: {
      overrides: {
        conversation_config_override: {
          tts: { voice_id: true },
          agent: { prompt: { prompt: true } },
        },
        custom_llm_extra_body: true,
      },
    },
  };

  const res = await fetchImpl(`${CONVAI_BASE}/create`, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`ElevenLabs agent create failed: ${res.status} ${detail}`);
  }

  const json = (await res.json()) as AgentsCreateResponse;
  if (!json.agent_id) {
    throw new Error('ElevenLabs agent create response missing agent_id');
  }

  return { agentId: json.agent_id, raw: json };
}

export interface GetElevenLabsAgentOptions {
  fetchImpl?: typeof fetch;
}

/**
 * Fetches the full live agent configuration from ElevenLabs - the complete
 * `conversation_config` / `platform_settings` document as ElevenLabs stores it,
 * which is a superset of the thin mirror (voice, prompt, first message) we keep
 * on the B4M agent record. Returned verbatim for export/inspection.
 */
export async function getElevenLabsAgent(
  apiKey: string,
  agentId: string,
  options: GetElevenLabsAgentOptions = {}
): Promise<unknown> {
  if (!apiKey) throw new Error('ElevenLabs API key is required to fetch an agent');
  if (!agentId) throw new Error('Agent ID is required');

  const fetchImpl = options.fetchImpl ?? fetch;
  const res = await fetchImpl(`${CONVAI_BASE}/${encodeURIComponent(agentId)}`, {
    method: 'GET',
    headers: { 'xi-api-key': apiKey },
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`ElevenLabs agent fetch failed: ${res.status} ${detail}`);
  }

  return res.json();
}

export interface UpdateElevenLabsAgentInput {
  /** New display name. Omit to leave unchanged. */
  name?: string;
  /** New voice. Omit to leave unchanged. */
  voiceId?: string;
  /** New system prompt. Omit to leave unchanged. */
  systemPrompt?: string;
  /** New spoken greeting. Omit to leave unchanged. */
  firstMessage?: string;
  /** New language (BCP-47). Omit to leave unchanged. */
  language?: string;
  /** New turn-taking eagerness. Omit to leave unchanged. */
  turnEagerness?: TurnEagerness;
  /** New silence-before-re-engage window (seconds). Omit to leave unchanged. */
  turnTimeoutSeconds?: number;
  /** Override fetch for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Patches an existing ElevenLabs agent. Only the provided fields are sent;
 * ElevenLabs merges them into the existing `conversation_config`. The Custom
 * LLM URL and override permissions set at create time are preserved because
 * we never overwrite them here.
 */
export async function updateElevenLabsAgent(
  apiKey: string,
  agentId: string,
  input: UpdateElevenLabsAgentInput
): Promise<void> {
  if (!apiKey) throw new Error('ElevenLabs API key is required to update an agent');
  if (!agentId) throw new Error('Agent ID is required');

  const fetchImpl = input.fetchImpl ?? fetch;

  // Build a minimal partial conversation_config from only the changed fields.
  const agentPrompt: Record<string, unknown> = {};
  if (input.systemPrompt !== undefined) agentPrompt.prompt = input.systemPrompt;
  // Always (re)assert the system tools so agents created before this - or in the
  // dashboard without them - gain end_call / language_detection on any edit.
  agentPrompt.built_in_tools = BUILT_IN_TOOLS;
  // Always (re)assert the cascade timeout so agents created before this - or
  // in the dashboard with the 8s default - get the longer window on any edit.
  agentPrompt.cascade_timeout_seconds = LLM_CASCADE_TIMEOUT_SECONDS;
  const agentConfig: Record<string, unknown> = {};
  if (Object.keys(agentPrompt).length > 0) agentConfig.prompt = agentPrompt;
  if (input.firstMessage !== undefined) agentConfig.first_message = input.firstMessage;
  if (input.language !== undefined) agentConfig.language = input.language;

  const conversationConfig: Record<string, unknown> = {};
  if (Object.keys(agentConfig).length > 0) conversationConfig.agent = agentConfig;
  if (input.voiceId !== undefined) conversationConfig.tts = { voice_id: input.voiceId };
  // Only (re)assert the turn-taking fields the caller actually specified,
  // so a partial update that omits them leaves the existing dashboard/agent values
  // intact - symmetric for both fields, matching the agentConfig pattern above.
  // (Defaults are applied at create time in createElevenLabsAgent, not on update.)
  const turnConfig: Record<string, unknown> = {};
  if (input.turnTimeoutSeconds !== undefined) turnConfig.turn_timeout = input.turnTimeoutSeconds;
  if (input.turnEagerness !== undefined) turnConfig.turn_eagerness = input.turnEagerness;
  if (Object.keys(turnConfig).length > 0) conversationConfig.turn = turnConfig;

  const body: Record<string, unknown> = {
    conversation_config: conversationConfig,
  };
  if (input.name !== undefined) body.name = input.name;

  const res = await fetchImpl(`${CONVAI_BASE}/${encodeURIComponent(agentId)}`, {
    method: 'PATCH',
    headers: {
      'xi-api-key': apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`ElevenLabs agent update failed: ${res.status} ${detail}`);
  }
}

export interface DeleteElevenLabsAgentOptions {
  fetchImpl?: typeof fetch;
}

/** Deletes an agent in the configured ElevenLabs workspace. */
export async function deleteElevenLabsAgent(
  apiKey: string,
  agentId: string,
  options: DeleteElevenLabsAgentOptions = {}
): Promise<void> {
  if (!apiKey) throw new Error('ElevenLabs API key is required to delete an agent');
  if (!agentId) throw new Error('Agent ID is required');

  const fetchImpl = options.fetchImpl ?? fetch;
  const res = await fetchImpl(`${CONVAI_BASE}/${encodeURIComponent(agentId)}`, {
    method: 'DELETE',
    headers: { 'xi-api-key': apiKey },
  });

  // Treat 404 as success - the agent is gone either way.
  if (!res.ok && res.status !== 404) {
    const detail = await res.text().catch(() => '');
    throw new Error(`ElevenLabs agent delete failed: ${res.status} ${detail}`);
  }
}
