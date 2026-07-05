import type { ICompletionOptionTools } from '@bike4mind/llm-adapters';
import { openaiRequestToB4M, type OpenAIChatRequest } from './translator';

/** A tool call the model made, captured for echoing back to the voice transport. */
export interface CapturedToolCall {
  name: string;
  /** Raw JSON arguments string, as the model emitted them. */
  arguments: string;
}

/**
 * A tool the reasoning model may call but the proxy does NOT execute. This is
 * structurally compatible with the services `ToolDefinition`
 * (`{ name, implementation: (ctx, cfg) => ICompletionOptionTools }`) so it can be
 * handed straight to `ChatCompletionProcess`'s `externalTools` - without this
 * low-level package taking a dependency on `@bike4mind/services`.
 */
export interface VoiceClientTool {
  name: string;
  implementation: () => ICompletionOptionTools;
}

/**
 * The benign result a passthrough tool hands back to the model, keyed by tool
 * name. The pipeline always executes tools, so a client/system tool (run by the
 * transport, not us) still needs a result. Tools not listed here get a generic
 * `Done.` ack.
 * - `end_call`: tell the model to stop so the bounded follow-up turn doesn't
 *   tack on a second farewell on top of any goodbye it already spoke.
 * - `language_detection`: tell the model to keep responding in the user's
 *   language so the turn still yields spoken text (a bare call leaves it empty).
 */
const TOOL_ACKS: Record<string, string> = {
  end_call: 'The call is ending. Do not say anything further.',
  language_detection: "Continue the conversation in the user's language.",
};

export function toolAcknowledgement(toolName: string): string {
  return TOOL_ACKS[toolName] ?? 'Done.';
}

/**
 * Turn the OpenAI tools a voice transport offers (ElevenLabs system tools like
 * `end_call`, `language_detection`, `transfer_to_number`, ...) into client tools the
 * reasoning model can call. These are the transport's OWN tools: it executes them
 * when we echo back a matching tool_call, so each executor here does no work - it
 * records the call via `capture` (the proxy emits it as a native OpenAI tool_call)
 * and returns a benign acknowledgement. The model decides using the transport's
 * real tool descriptions, so any system tool works with no per-tool code.
 *
 * Returns an empty record when the request offers no tools.
 */
export function buildClientToolPassthrough(
  req: OpenAIChatRequest,
  capture: (call: CapturedToolCall) => void
): Record<string, VoiceClientTool> {
  const { toolSchemas } = openaiRequestToB4M(req);
  const passthrough: Record<string, VoiceClientTool> = {};
  for (const schema of toolSchemas) {
    passthrough[schema.name] = {
      name: schema.name,
      implementation: () => ({
        toolSchema: {
          name: schema.name,
          description: schema.description,
          // Transport-supplied JSON schema; the LLM adapter validates the shape at call time.
          parameters: schema.parameters as ICompletionOptionTools['toolSchema']['parameters'],
        },
        toolFn: async (args: unknown) => {
          capture({ name: schema.name, arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}) });
          return toolAcknowledgement(schema.name);
        },
      }),
    };
  }
  return passthrough;
}
