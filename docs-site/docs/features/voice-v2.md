---
title: Voice v2 — Conversational AI
description: Model-agnostic conversational voice powered by ElevenLabs Conversational AI with any B4M reasoning model
sidebar_position: 30
tags: [voice, elevenlabs, conversational-ai]
---

# Voice v2 — Conversational AI

Voice v2 adds a fully-conversational voice interface to any notebook session. ElevenLabs handles the realtime audio (speech-to-text, voice activity detection, TTS, and barge-in), and any B4M reasoning model — OpenAI, Anthropic, Gemini, xAI — supplies the responses through a Custom LLM proxy.

Admins create voice agents inside B4M (which provisions the matching ElevenLabs Conversational AI agent automatically) and designate one as the **org-wide default**. Every voice conversation routes through that default agent. Users don't pick an agent — instead they can optionally layer their own **voice and system-prompt overrides** on top of it.

## How it works

```
Browser  ── WebRTC ──▶  ElevenLabs Conversational AI agent
                              │    (org default voice agent)
                              │  (Custom LLM call, per turn)
                              ▼
                       /api/voice/v2/llm-proxy/chat/completions
                              │
                              │  (OpenAI-compatible SSE)
                              ▼
                  Selected B4M reasoning model
```

1. **Admin** creates a "Voice Agent" at `/admin → General Ops → Voice Settings`. B4M calls the ElevenLabs `convai/agents/create` API with the chosen voice, system prompt, and our Custom LLM URL pre-wired. The resulting ElevenLabs agent ID is stored on a B4M `Agent` document (`type: 'voice'`, `provider: 'elevenlabs'`, `isPublic: true`). One voice agent is flagged as the org default (`isDefaultVoiceAgent`).
2. Voice agents appear in the **unified agent list** (`/agents`) alongside personas, badged with a **"Voice"** chip. There is no separate tab and no per-user selection.
3. **User** opens the voice modal in a notebook. `POST /api/voice/v2/sessions` resolves the org default voice agent via `agentRepository.findDefaultVoiceAgent()`, reads its `elevenLabsAgentId`, and mints an ElevenLabs signed URL. Any per-user `voiceOverrideId` / `voiceSystemPromptOverride` are layered on as ElevenLabs overrides (`tts.voiceId`, `agent.prompt.prompt`).
4. `POST /api/voice/v2/sessions` also mints a **signed, session-bound JWT** (the session token) carrying `userId`, `organizationId`, `sessionId`, and `reasoningModelId`. The browser forwards it to ElevenLabs via `customLlmExtraBody.b4m_session` — it never sees the raw claims as editable fields.
5. For each conversational turn, ElevenLabs POSTs an OpenAI-shaped Chat Completions request to `/api/voice/v2/llm-proxy/chat/completions`, echoing the session token under `elevenlabs_extra_body.b4m_session`. The proxy **verifies the token** (signature, audience, expiry) and trusts only its claims as the caller's identity. A missing, forged, or expired token is rejected with `401` — reaching the proxy URL grants nothing on its own.
6. The proxy translates the request to B4M's internal LLM interface, streams the reply as OpenAI SSE chunks, ElevenLabs converts the reply to speech using the agent's configured voice. A model's `<think>` reasoning is stripped server-side so it is never spoken.
7. The proxy persists each user utterance and AI reply as `voice_transcript` quest rows under the originating notebook session during the turn. The client invalidates the session's quest query, so the notebook transcript updates **in real time** as the conversation progresses.

### Ending the call

The agent can hang up on its own when the conversation concludes (user says goodbye, task done, or they indicate they're finished) — no manual **End Call** click required.

- Every B4M-managed voice agent is registered with the ElevenLabs **`end_call`** system tool via `conversation_config.agent.prompt.built_in_tools` (`createElevenLabsAgent` / `updateElevenLabsAgent`), so ElevenLabs includes it in the `tools` of each proxy request and executes the tool call we echo back. (The legacy `prompt.tools` array is deprecated for system tools and is ignored by ElevenLabs.)
- The proxy forwards whatever system tools ElevenLabs offers in `body.tools` to the reasoning model as real function tools (via the pipeline's `externalTools` hook, reusing `openaiRequestToB4M`). Their executors don't run a side effect — ElevenLabs does — they just capture the call. After the turn, the proxy emits the captured calls back as native OpenAI `tool_calls` (`finish_reason: "tool_calls"`). The model decides using ElevenLabs' own tool descriptions, so additional system tools (`language_detection`, `transfer_to_number`, …) work with no extra code once registered on the agent.
- Existing agents gain the capability the next time they're edited in Voice Settings; the user can still end the call manually at any time.

## Admin setup

Voice v2 requires two admin settings plus at least one voice agent created from the Voice Settings page.

### 1. ElevenLabs workspace

1. Create or sign in to an ElevenLabs workspace at https://elevenlabs.io.
2. Copy a workspace **API key** (Profile → API keys; needs the `convai_write` scope).
3. No agent creation is needed in the ElevenLabs dashboard — B4M provisions agents for you when an admin clicks **New voice agent** below.

### 2. B4M admin settings

Under **Admin → Settings → AI → Voice Session**:

| Setting | Purpose |
| --- | --- |
| **Enable Voice v2 (Model-Agnostic)** (`voiceV2Enabled`) | Gate for the feature. When off, `POST /api/voice/v2/sessions` returns 403 and the toolbar button is hidden. |
| **ElevenLabs Server API Key (Voice v2)** (`elevenLabsServerApiKey`) | Server-only key used to provision agents, mint signed URLs, and list workspace voices. Distinct from the per-user ElevenLabs key used for TTS preview. Marked sensitive — won't render in the UI after save. |

Save each setting; they take effect on the next call without a redeploy.

### 3. Create voice agents and set the default

Navigate to **Admin → General Ops → Voice Settings**.

1. Click **New voice agent**.
2. Fill the form:
   - **Name** — what users see on the `/agents` card (e.g. *"British Concierge"*).
   - **Description** — optional, shown on the user-facing card.
   - **Voice** — pick from the workspace voices dropdown (sourced from ElevenLabs `/v1/voices`).
   - **System prompt** — the assistant's instructions.
3. Click **Create**. B4M calls `convai/agents/create` with the voice + prompt + our Custom LLM URL (`https://<host>/api/voice/v2/llm-proxy`), enables the required override permissions (`custom_llm_extra_body`), and creates a B4M `Agent` document linked to the new ElevenLabs agent.
4. **Set one agent as the default.** Edit a voice agent and toggle **Set as default** (`isDefaultVoiceAgent`). At most one default exists at a time — setting a new one clears the flag on the previous. **Voice sessions fail with a 400 until a default is set**, because every conversation routes through the default agent.

Voice agents are deleted via the trash icon next to each row — that removes both the B4M document and the ElevenLabs agent.

### 4. Verify

1. Open `/agents`. The voice agent you created appears in the unified list with a **"Voice"** badge (no separate tab).
2. Open a notebook session. The mic-with-equalizer icon should appear in the toolbar; click it.
3. The modal should reach **Connected** within a few seconds and the indicator should flip between **Listening** and **Assistant speaking** as you talk. The voice should match the org default agent.
4. Speak — the notebook transcript should fill in live as you talk.
5. Tail the SST logs and look for the `[voice-v2/llm-proxy]` request log — confirm a session context was parsed (or that the admin-demo-key fallback was used).

## User-facing usage

- The voice button appears in the session toolbar whenever `voiceV2Enabled` is true. There's no per-user agent selection — the org default voice agent is always used.
- **Customizing your voice/prompt:** in `/agents`, click the edit (pencil) button on a voice agent card. This opens a per-user customization modal with a **Voice override** (pick a different ElevenLabs voice) and a **System prompt override**. These are saved on your user (`voiceOverrideId`, `voiceSystemPromptOverride`) and layered on top of the default agent at session start. Leave blank to use the agent's own voice and prompt.
- Voice v2 uses the **reasoning model currently selected in SessionBottom** — switching models in the dropdown changes which backend handles the next call. Close and reopen the modal after switching to pick up the new selection.
- Each call is anchored to the active notebook session; transcripts persist as `voice_transcript` quests so the session continues seamlessly in chat after the call ends. Launch the call from inside a notebook to see transcripts appear in that notebook live; launching from a fresh session creates a new `Voice • <model>` notebook.
- User turns and AI replies are paired into a single quest row (`prompt` + `replies`). If the agent speaks first (no user turn yet), a new reply-only quest is created.

## Cost & credits

- Each session reserves a pessimistic credit hold up to **5 minutes** of voice time (`MAX_SESSION_SECONDS` in `apps/client/server/voice/voiceSessionLimits.ts`).
- Reservation is skipped when `enforceCredits` is disabled.
- On call end the browser calls `POST /api/voice/v2/sessions/:id/end`, which **reconciles the hold down to the actual call duration and refunds the unused portion** (`creditsForElapsed`). The endpoint is owner-scoped and idempotent. It fires from both the user-initiated end and a natural disconnect.
- A user may hold at most **2 concurrent voice sessions** (`MAX_CONCURRENT_VOICE_SESSIONS`), matching v1.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Toolbar button missing | `voiceV2Enabled` is false, or the user's browser-cached settings are stale (reload). |
| `POST /api/voice/v2/sessions` returns 403 | Feature disabled, or user is out of credits with `enforceCredits` on. |
| `POST /api/voice/v2/sessions` returns 400 "No default voice agent configured" | No voice agent is flagged as the org default. Admin → Voice Settings → edit an agent → **Set as default**. |
| `POST /api/voice/v2/sessions` returns 500 "ElevenLabs server API key must be configured" | `elevenLabsServerApiKey` admin setting is empty. |
| `POST /api/admin/voice-agents` returns 502 "Failed to create ElevenLabs agent" | API key invalid/expired, ElevenLabs API down, or the request shape is rejected by ElevenLabs. Detail string echoes the upstream status + body. |
| Proxy returns `401` "Missing/Invalid or expired b4m_session token" | The ElevenLabs agent's **Custom LLM Extra Body** override permission isn't set, so the session token never reaches the proxy. B4M-created agents have this enabled at create-time; agents created manually in the ElevenLabs dashboard need it toggled on under the agent's Security tab. A token can also expire if the call outlives `MAX_SESSION_SECONDS` + buffer. |
| No voice agents appear in `/agents` | No admin has created any voice agents yet. Admin → Voice Settings → New voice agent. |
| `GET /api/voice/v2/voices` returns 502 with "Failed to fetch ElevenLabs voices" | API key is invalid/expired, or the ElevenLabs API is unreachable. Check `elevenLabsServerApiKey` and tail SST logs for the upstream status code. |
| Proxy logs `model not in available list` | The selected `reasoningModelId` isn't in `getAvailableModels()` for the resolved API key table — check that the relevant provider's API key is configured (per-user or admin demo). |
| Modal stuck at "Connecting…" | Usually a CSP issue (need `https://api.elevenlabs.io` + `wss://api.elevenlabs.io` + `https://*.livekit.cloud` + `wss://*.livekit.cloud` in `connect-src`) or `Permissions-Policy` blocking `microphone` (must include `microphone=(self)`). Both are already configured in `apps/client/proxy.ts`. |
| Browser console shows `NotAllowedError` | User denied microphone permission. Re-grant via the browser's lock icon next to the URL. |

## Security notes

- The `b4m_session` payload is a **signed JWT** (HMAC, `JWT_SECRET`) minted by `/sessions` and verified by the proxy via `apps/client/server/voice/voiceSessionToken.ts`. The proxy trusts only the verified claims, never raw body fields, so reaching the proxy URL cannot be used to impersonate a user. The token is scoped by an audience claim and expires shortly after `MAX_SESSION_SECONDS`.
- The proxy is intentionally `auth: false` because ElevenLabs calls it directly and cannot present a B4M JWT in the `Authorization` header — the signed session token **is** the authentication. Restricting the route to ElevenLabs's egress IPs at the CDN layer is still recommended as defense-in-depth once those IPs are documented.
- Voice v2 does **not** use the per-user ElevenLabs API key configured in profile settings. That key powers the older TTS preview surface only.
- Voice agent CRUD endpoints (`/api/admin/voice-agents`) are gated on `req.user.isAdmin`.

## Related code

- Server: `apps/client/pages/api/voice/v2/sessions.ts`, `apps/client/pages/api/voice/v2/sessions/[id]/end.ts` (credit reconciliation), `apps/client/pages/api/voice/v2/llm-proxy/chat/completions.ts`, `apps/client/pages/api/voice/v2/voices.ts`, `apps/client/pages/api/voice/v2/agents.ts`
- Session auth & limits: `apps/client/server/voice/voiceSessionToken.ts` (sign/verify JWT), `apps/client/server/voice/voiceSessionLimits.ts` (`MAX_SESSION_SECONDS`, `creditsForElapsed`)
- Admin endpoints: `apps/client/pages/api/admin/voice-agents/index.ts`, `apps/client/pages/api/admin/voice-agents/[id].ts`
- Transport: `b4m-core/voice/src/transports/elevenlabsConversational.ts`
- ElevenLabs REST helpers: `b4m-core/voice/src/elevenLabsAgentsApi.ts`, `b4m-core/voice/src/voicesCache.ts`
- Request translator: `b4m-core/voice/src/llmProxy/translator.ts`
- UI (user): `apps/client/app/components/Session/ConversationalVoice/`, `apps/client/app/components/AgentList/AgentsGrid.tsx` (Voice badge), `apps/client/app/components/AgentList/AgentQuickActions.tsx` (edit → customize for voice agents), `apps/client/app/components/AgentList/VoiceCustomizeModal.tsx` (per-user voice/prompt overrides)
- UI (admin): `apps/client/app/components/admin/VoiceSettingsTab.tsx`
- Unified agent list: `apps/client/app/routes/agents/index.tsx`, `apps/client/pages/api/agents/index.ts` (merges public voice agents into the list)
- Schema: `b4m-core/common/src/types/entities/AgentTypes.ts` (search `AgentKind`), `packages/database/src/models/AgentModel.ts` (search `type: 'voice'`)
- Admin settings: `b4m-core/common/src/schemas/settings.ts` (search `voiceV2Enabled`)
