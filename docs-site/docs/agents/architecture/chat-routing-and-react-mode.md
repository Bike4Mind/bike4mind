---
title: Chat Routing & ReAct Mode
description: How chat messages route between regular chat completion and the ReAct AgentExecutor pipeline, and what's required to trigger subagent delegation.
sidebar_position: 10
---

# Chat Routing & ReAct Mode

The chat input has **two execution paths**:

1. **Regular chat completion** — sends the prompt to the configured LLM with the agent's system prompt mixed in, streams the response back. The default for every message.
2. **ReAct AgentExecutor pipeline** — dispatches `agent_execute` over WebSocket to the Lambda executor, which runs an iterative thought / action / observation loop, can call tools (including `delegate_to_agent` for subagents), and streams `iteration_step` / `subagent_*` events back to the UI.

This doc explains exactly when each path fires, what triggers the ReAct path, and how to set up an agent + send a prompt that exercises it (essential for E2E testing the subagent flow).

## The routing decision

A single function — `routeQuery()` — is the source of truth for the chat-vs-ReAct decision. It lives (duplicated client/server) in `queryComplexityClassifier.ts` and is called from `apps/client/app/components/Session/SessionBottom/useSendMessage.ts`.

```ts
const routeTarget = routeQuery({
  message: prompt,
  complexity,                       // classifyQueryComplexity(): 'simple' | 'contextual' | 'complex'
  agentExecutorEnabled: isAgentsEnabled,
  userOverride,                     // 'force_agent' from the composer bolt, @agent literal, or agentModeDefault='on'/classifier
  hasOrchestrationAgent: orchestrationAgent !== null,
  autoRouteEnabled,                 // agentModeDefault === 'auto' — gates the complexity heuristic (rule 5) on explicit opt-in
});
// routeTarget === 'agent_executor' → dispatch agent_execute; otherwise regular chat completion.
```

`routeQuery` evaluates these rules, **first match wins**:

1. `userOverride === 'force_agent'` → `agent_executor` (composer bolt on, `@agent` literal, Smart Routing `'on'`, or the intent classifier upgraded the message).
2. A mentioned **orchestration agent** + `agentExecutorEnabled` → `agent_executor` (preserves the legacy `@specific-agent` path).
3. `!agentExecutorEnabled` → `quest_processor`.
4. `@agent` literal → `agent_executor`.
5. `complexity === 'complex'` **and** `autoRouteEnabled` (Smart Routing `'auto'`) → `agent_executor`.
6. otherwise → `quest_processor`.

> **Note:** `agentExecutorEnabled` is wired to `isAgentsEnabled` (the composer **Agents** tools toggle, backed by the `enableAgents` feature), **not** the Smart Routing flag. The complexity heuristic (rule 5) is additionally gated on `autoRouteEnabled`, which is set only when Smart Routing is `'auto'`. So a genuinely *complex* prompt auto-routes to the executor **only when the user has opted into auto-routing** — not merely because Agents tools are enabled. With Smart Routing **Off**, rule 5 never fires; the executor engages only on the explicit signals (composer bolt, orchestration-agent mention, or `@agent` literal). The `'on'` (always-on) and `'auto'` (classifier) behaviors are layered on top via `userOverride`.

### Smart Routing (the `agentModeDefault` tri-state)

When **Agent Mode** is enabled (see [Enablement](#enablement)), users get a **Smart Routing** control (Profile → Settings → Beta Features) with three states stored in `user.preferences.agentModeDefault`:

| State | Behavior |
|---|---|
| **Off** | No default auto-routing. Agent mode engages only on the composer bolt, an `@mention` of an orchestration agent, or an `@agent` literal. The complexity heuristic (rule 5) does **not** fire in this state — a complex prompt alone stays on regular chat completion. |
| **Auto** | Runs the intent classifier (`/api/ai/classify-intent`) on borderline `'contextual'` prompts and upgrades to the executor when it predicts agent-worthiness. Dismissing an auto-routed reply pauses the classifier for the rest of the session (`disableAutoRouteForThisSession`). |
| **Always on** | Forces `agent_executor` on every send (`force_agent`). Highest token usage. |

### Enablement

Agent Mode / Smart Routing is gated by two admin settings (Admin → Settings → Experimental) plus a per-user Beta toggle:

- **`EnableAgentMode`** (admin, default **on**) — master availability. Set to off to hide the feature org-wide.
- **`EnableAgentModeDefault`** (admin, default **off**) — whether it's on for users who never toggled it. Leave off for an opt-in rollout.
- **Beta Features → "Agent Mode"** (per user) — self-serve opt-in; sets `user.preferences.experimentalFeatures.agentMode`.

All three resolve through `useFeatureEnabled('agentMode')`, which is the single Layer-1 gate every consumer (the profile card, the composer bolt, and `routeQuery`) must read — `EnableAgentMode` (admin) overrides the per-user `agentMode` pref, so the org-wide kill switch reaches every surface. When the gate is off, neither the Smart Routing control nor the composer bolt render, and `agentModeDefault` has no effect.

### Gate 1: `isAgentsEnabled`

A boolean in the LLM Zustand store (`LLMContext.tsx:74`, defaults to `false`). Controlled by the user.

- **UI location:** Chat input bar → **AI Settings** → **Tools section** → **"Agents"** `SquareSlideToggle`
  (`apps/client/app/components/Session/AISettings/ToolsSection.tsx:935`)
- **Persistence:** Saved to user settings. Once toggled on, stays on across sessions for that user.
- **Note:** This is a *user preference*, not an org/feature flag. The feature-flag `enableAgents` (checked via `isFeatureEnabled('enableAgents')` elsewhere) gates the entire agents *feature* visibility — distinct from this per-user toggle.

### Gate 2: `orchestrationAgent` is non-null

Computed at `useSendMessage.ts:317-338`:

```ts
const lexicalMentions = lexicalInputRef.current?.getMentions() ?? [];
const textMentions = detectAgentMentions(prompt);
const mentions = [...new Set([...lexicalMentions, ...textMentions])];
const mentionedAgents = findAgentsByMentions(mentions, availableAgents);
const orchestrationAgent = pickOrchestrationAgent(mentionedAgents);
```

Two sub-conditions:

1. The message must contain `@<name>` where `<name>` matches either the agent's display name (case-insensitive) OR one of its trigger words (with `@` stripped).
   - Detection runs against the Lexical editor's structured mention nodes first, then falls back to regex over the raw text.
   - Implementation: `findAgentsByMentions` in `apps/client/app/hooks/useAgentMentions.ts:16`.
2. At least one matched agent must have **orchestration fields** set on its `IAgent` doc.

### Orchestration fields — what makes an agent a ReAct orchestrator

`apps/client/app/utils/agentOrchestration.ts:13`

```ts
function hasOrchestrationFields(agent: IAgent): boolean {
  if (agent.maxIterations?.quick || agent.maxIterations?.medium || agent.maxIterations?.very_thorough) return true;
  if (agent.allowedTools && agent.allowedTools.length > 0) return true;
  if (agent.deniedTools && agent.deniedTools.length > 0) return true;
  if (agent.defaultThoroughness) return true;
  return false;
}
```

An agent qualifies for the ReAct path if **any one** of these fields is set:

| Field | Schema location | Notes |
|---|---|---|
| `allowedTools: string[]` | `IAgent` (`b4m-core/common/src/types/entities/AgentTypes.ts`) | Allow-list of tool names the agent may call. Empty array = no list applied (all tools available). Most common way to flip the gate — adding any tool here promotes the agent. |
| `deniedTools: string[]` | same | Deny-list. |
| `maxIterations: { quick, medium, very_thorough }` | same | Iteration caps per thoroughness level. |
| `defaultThoroughness: 'quick' \| 'medium' \| 'very_thorough'` | same | Runtime default thoroughness. |

**UI to set these:** Agent edit page → **Advanced — Orchestration** accordion (collapsed by default). Adding any tool to **Allowed tools** or setting **Default thoroughness** is enough.

**Backward compatibility:** Agents created before orchestration fields existed have all four unset → they're treated as plain chat-completion agents. `@mentioning` them attaches them to the session (their system prompt is mixed in) but does NOT trigger ReAct mode.

## How to trigger the ReAct AgentExecutor (for testing)

End-to-end checklist:

1. **Create at least one orchestrator agent** with orchestration fields set.
   - Quickest way: set `allowedTools: ['delegate_to_agent']` (also required to actually delegate to subagents). See [Subagent delegation](#) for the full subagent setup.
   - Optional but recommended: set `defaultThoroughness: 'medium'` for sensible iteration budgets.
2. **(For delegation)** Create at least one child agent the orchestrator can delegate to. Any agent reachable in the user's / org's agent store works — `delegate_to_agent` resolves children by `agentName`.
3. **Enable the per-user toggle:** chat input bar → **AI Settings** (gear icon next to the model name) → **Tools** → toggle **Agents** on. The button shows a small badge with the number of enabled tools when active.
4. **In the chat input, mention the orchestrator by name:**
   ```
   @Orchestrator analyze the EV market — use the MarketAnalyst subagent
   ```
   The Lexical editor's typeahead picker offers matching agents as you type `@`. You can also paste raw text — the regex fallback matches `@Name` against agent name (case-insensitive) and trigger words.
5. **Send.** The UI mounts `IterationStream` under the prompt, the WebSocket subscription count ticks up (visible in the sidebar footer: `WS: N`), and `iteration_step` / `subagent_started` / `subagent_iteration_step` events stream in live.

**Sanity check signals:**
- Status pill in the iteration stream header (`Starting…` → `Running` → `Completed`).
- Iteration accordions appear, expanding as steps stream.
- For foreground delegations: `SubagentStepNest` mounts under each `delegate_to_agent` action step with the child agent's name and iteration count.
- The persisted Quest bubble (after completion) shows a **"Show reasoning"** disclosure (`ReasoningDisclosure` component) — this is the post-hoc replay path.

**If `isAgentsEnabled` is off OR the agent has no orchestration fields:**
- The chat goes through `/api/sessions/<id>/chat`.
- The status reads "Generating insights…" rather than "Starting…" / "Running".
- No iteration stream, no nest, no "Show reasoning" disclosure on the resulting Quest.
- This is **easy to mistake for the ReAct path running and failing silently** — always check the WS subscription count and look for the iteration stream UI to confirm which path fired.

## Dispatch payload

`apps/client/app/hooks/useAgentExecution.ts:417-427` sends:

```json
{
  "action": "agent_execute",
  "command": "start",
  "sessionId": "<notebook id>",
  "questId": "<notebook id>",
  "query": "<the user's prompt verbatim>",
  "model": "<orchestrationAgent.preferredModel or session model>",
  "organizationId": "<optional>",
  "enabledTools": ["<from orchestrationAgent.allowedTools>"],
  "maxIterations": <from defaultThoroughness mapping>
}
```

The Lambda handler at `apps/client/server/websocket/agentExecute.ts` validates session ownership and invokes the AgentExecutor Lambda, which runs the ReAct loop.

## Server-side: what the executor does with subagents

When the orchestrator calls `delegate_to_agent(agentName: 'MarketAnalyst', task: '...')`:

1. `ServerSubagentOrchestrator.onStart` creates a child `AgentExecution` doc (parented to the orchestrator's executionId via `parentExecutionId`).
2. `subagentConfig` is persisted on the child doc at creation time: `{ agentName, thoroughness, maxIterations }`. This is what lets `SubagentStepNest` show the real agent name on reload.
3. The child either runs in-process (synchronously, in the same Lambda invocation) or is dispatched to its own Lambda (for `background: true` or when the parent's remaining time is insufficient).
4. Live events stream to the client: `subagent_started` → `subagent_iteration_step` (one per child step) → `subagent_completed` / `subagent_failed`.
5. On completion, the child's `result.steps[]` is written to its doc, so the post-completion replay path (`/api/agent-executions/[id]` + `ReasoningDisclosure`) can re-render the nest.

## Related files

| Concern | Path |
|---|---|
| Routing decision | `apps/client/app/components/Session/SessionBottom/useSendMessage.ts:556` |
| Per-user toggle | `apps/client/app/components/Session/AISettings/ToolsSection.tsx:935` |
| LLM store / `isAgentsEnabled` | `apps/client/app/contexts/LLMContext.tsx:74,124` |
| Orchestration field check | `apps/client/app/utils/agentOrchestration.ts:13` |
| Mention detection | `apps/client/app/hooks/useAgentMentions.ts:16` (client), `b4m-core/common/src/...` (shared `detectAgentMentions`) |
| WS dispatch | `apps/client/app/hooks/useAgentExecution.ts:412` |
| WS handler | `apps/client/server/websocket/agentExecute.ts` |
| Subagent orchestrator | `b4m-core/services/src/llm/agents/ServerSubagentOrchestrator.ts` |
| Lambda executor + subagent tracker | `apps/client/server/queueHandlers/agentExecutor.ts` |
| Subagent UI nest | `apps/client/app/components/Session/AgentExecution/SubagentStepNest.tsx` |
| Iteration stream | `apps/client/app/components/Session/AgentExecution/IterationStream.tsx` |
| Post-completion replay | `apps/client/app/components/Session/AgentExecution/ReasoningDisclosure.tsx` + `pages/api/agent-executions/[id]/index.ts` |

## Common pitfalls

- **"I toggled Agents and @-mentioned the agent but nothing happens"** → check the agent has at least one orchestration field set (e.g. `allowedTools: ['delegate_to_agent']`). Without that, the gate fails silently and you fall through to chat completion.
- **"WS: 0 in the footer during what looks like an agent run"** → you're on the chat-completion path. The WS subscription only ticks up once `execution_started` arrives.
- **"The orchestrator wrote a JSON-looking blob instead of actually delegating"** → also the chat-completion path. The LLM is just talking about delegating because the system prompt mentioned it; no actual tool call happened.
- **Trigger word vs. name** — `@<triggerWord>` works (with `@` stripped), but if multiple agents share a trigger word (e.g. both have `@help`), the first match wins. Use unique trigger words or mention by full agent name for predictable routing.
