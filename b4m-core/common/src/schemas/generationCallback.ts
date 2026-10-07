import { z } from 'zod';

/**
 * Completion callbacks for queued generation jobs (image generation, image edit, video
 * generation). A caller that passes `callbackUrl` receives one signed POST when the quest
 * settles, carrying the same body `GET /api/v1/quests/{id}` returns.
 *
 * The request-time guard here is syntactic only; the server also resolves the host and rejects
 * private/link-local targets (apps/client/server/utils/ssrfProtection.ts) before accepting it,
 * and again before every delivery attempt.
 */
export const GENERATION_CALLBACK_URL_MAX_LENGTH = 2048;

export const GenerationCallbackUrlSchema = z
  .url({ protocol: /^https$/, error: 'callbackUrl must be an https URL' })
  .max(GENERATION_CALLBACK_URL_MAX_LENGTH)
  .describe(
    'Optional https URL that receives one signed POST when the job settles (success or failure). ' +
      'Requires API-key authentication and a callback signing secret on that key. The body is the ' +
      'GET /api/v1/quests/{id} response. Verify it with the `X-Webhook-Signature-256` header: ' +
      '`sha256=` + hex HMAC-SHA256 of `<X-Webhook-Timestamp>.<raw body>` keyed with the signing secret. ' +
      'Polling keeps working either way.'
  );

/** `X-Event-Type` value of a settled-quest callback. */
export const GENERATION_CALLBACK_EVENT_TYPE = 'quest.settled';

/**
 * Lifecycle of a quest's callback. `pending` means armed but not yet handed to the delivery
 * queue; the dispatch claim moves it to `dispatched` exactly once, and the delivery handler
 * records the final outcome.
 */
export const QuestCallbackStateSchema = z.enum(['pending', 'dispatched', 'delivered', 'failed']);
export type QuestCallbackState = z.infer<typeof QuestCallbackStateSchema>;

export type IQuestCallback = {
  url: string;
  /** The API key whose signing secret signs the delivery. */
  apiKeyId: string;
  /**
   * The receiver's dedupe key (`X-Webhook-Event-ID`). Minted per arm, so it holds across one
   * arm's retries and DLQ replays, while a retried quest (re-armed) is a new event.
   */
  eventId: string;
  state: QuestCallbackState;
  /** When the current claim was made; a stale-dispatch reclaim moves it forward. */
  dispatchedAt?: Date;
  /**
   * How many times the sweep backstop re-enqueued a callback stuck at `dispatched`; bounds those
   * reclaims so a message the handler can never process is not re-enqueued forever.
   */
  redispatchCount?: number;
  completedAt?: Date;
  lastStatusCode?: number;
  lastError?: string;
};

/**
 * The `callbackUrl` paragraph of every queued-generation contract description (image generation,
 * image edit, video generation), shared so the three cannot drift. Must stay true of
 * apps/workers/src/queueHandlers/generationCallback.ts and server/webhooks/signedWebhook.ts.
 */
export const GENERATION_CALLBACK_DESCRIPTION =
  'Optional `callbackUrl`: an https URL that receives a signed POST when the quest settles (success, ' +
  'failure, or a stop; a failed render is `type: "error"` in the body, same as the poll). The body is ' +
  'the `GET /api/v1/quests/{id}` response. Headers: `X-Webhook-Event-ID` (the same on every attempt for ' +
  'one settlement; delivery is at-least-once, so dedupe on it, and a retried quest settles again under ' +
  'a new one), `X-Webhook-Delivery-ID` (unique per attempt), `X-Webhook-Timestamp` (unix seconds), ' +
  '`X-Webhook-Signature-256` (`sha256=` + hex HMAC-SHA256 of `<timestamp>.<raw body>` keyed with the ' +
  "API key's callback signing secret), and `X-Event-Type: quest.settled`. Delivery makes up to 5 " +
  'attempts, retrying on a 5xx, 408, 429, timeout or network error - never on any other 4xx, and redirects are not ' +
  'followed; your endpoint must answer 2xx within 10 seconds. Requires API-key authentication and a ' +
  'signing secret on that key (returned once at key creation, or via ' +
  '`POST /api/user-api-keys/{id}/callback-secret`). A `callbackUrl` is rejected with a 400 when the ' +
  'request is not API-key authenticated, the key has no signing secret, the URL resolves to a private ' +
  'address, or the deployment does not deliver callbacks; a URL that is not https fails request ' +
  'validation with a 422. Polling still works whether or not `callbackUrl` is set.';

/**
 * The 400 clause every queued-generation contract declares for a rejected `callbackUrl`; must stay
 * in sync with the rejections in apps/client/server/generationCallback/armGenerationCallback.ts.
 */
export const GENERATION_CALLBACK_REJECTED_DESCRIPTION =
  '`callbackUrl` was rejected: the request is not API-key authenticated, the key has no callback ' +
  'signing secret, the URL resolves to a private address, or the deployment does not deliver callbacks.';
