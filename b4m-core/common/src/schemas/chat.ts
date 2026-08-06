import { z } from 'zod';

/**
 * Request schema for POST /api/chat - the simplified external chat surface.
 *
 * Shared between the Next.js API handler (apps/client/pages/api/chat.ts, which
 * validates req.body with this exact object) and the OpenAPI registry
 * (b4m-core/common/src/openapi), so the published contract cannot drift from
 * what the handler actually accepts. The model is optional here and resolved
 * server-side from admin settings when omitted.
 *
 * Public-API rule: no `.catch()` / top-level `.transform()`. Both silently mutate
 * caller input (fail-quiet) and are opaque to zod-to-openapi. `historyCount` uses
 * `.default()` (fail loud on a bad value); unknown tool ids are filtered in the
 * handler (see filterKnownTools) instead of by a schema transform. This keeps the
 * schema fully OpenAPI-representable with no doc projection needed.
 */
export const SimplifiedChatRequestSchema = z.object({
  sessionId: z.string().nullish(), // Accepts string, null, or undefined - null treated as "not provided"
  message: z.string(),
  model: z.string().optional(), // Made optional - will use admin setting if not provided
  temperature: z.number().min(0).max(2).optional(),
  // Output-budget override. `max_tokens` is the canonical field; `maxTokens` and
  // `maxOutputTokens` are accepted aliases so callers using either casing aren't
  // silently ignored (Zod strips unknown keys). All three coalesce in transformToInternalFormat.
  max_tokens: z.number().positive().optional(),
  maxTokens: z.number().positive().optional(),
  maxOutputTokens: z.number().positive().optional(),
  stream: z.boolean().prefault(false),
  historyCount: z.number().positive().default(10),
  fileIds: z.array(z.string()).prefault([]),
  // New synchronous option - wait for completion before returning
  wait: z.boolean().prefault(false),
  // Enable full tool access for agent requests (e.g., voice agent_request portal)
  enableTools: z.boolean().prefault(false),
  // Tool selection mode: 'fast' = no tools (pure chat), 'smart' = auto-select tools based on prompt
  // When set, overrides enableTools. When not set, falls back to enableTools behavior.
  toolMode: z.enum(['fast', 'smart']).optional(),
  // Explicit tool ids (combined with auto-selected in smart mode). Unknown ids are
  // filtered by the handler (filterKnownTools), not here - see the rule above.
  tools: z.array(z.string()).optional(),
  // Explicit overrides - when enableTools is true, these default to true but can be
  // individually disabled (e.g., voice agent_request disables QuestMaster so replies
  // aren't cleared and replaced with a plan document)
  enableQuestMaster: z.boolean().optional(),
  enableMementos: z.boolean().optional(),
  enableAgents: z.boolean().optional(),
});

export type SimplifiedChatRequest = z.infer<typeof SimplifiedChatRequestSchema>;

/**
 * Async ACK returned on the default (wait:false) path of POST /api/chat. The
 * handler assembles this body inline (apps/client/pages/api/chat.ts), so this
 * schema MUST stay in sync with that `res.json({...})` shape.
 */
export const ChatAckSchema = z.object({
  id: z.string(),
  status: z.string(),
  message_received: z.boolean(),
  timestamp: z.string(),
  model: z.string(),
  message: z.string().optional(),
  tracking_info: z.object({
    quest_id: z.string(),
    check_status_url: z.string(),
    poll_url: z.string().optional(),
  }),
});

export type ChatAck = z.infer<typeof ChatAckSchema>;

/** Reusable JSON error envelope (plain; the OpenAPI layer annotates it). */
export const ApiErrorSchema = z.object({
  error: z.string(),
  request_id: z.string().optional(),
});
