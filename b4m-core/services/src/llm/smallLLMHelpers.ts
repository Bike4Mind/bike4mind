import type { SmallLLMAdapters, SmallLLMMessageRole, SmallLLMMetrics, SmallLLMTaskType } from '@bike4mind/common';

/**
 * Extracts JSON from LLM text response.
 * Handles common wrapping patterns: markdown code blocks, extra text before/after JSON.
 * Returns the extracted JSON string or null if no valid JSON found.
 */
export function extractJSON(text: string): string | null {
  const trimmed = text.trim();

  // Try direct parse first (cleanest case)
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      JSON.parse(trimmed);
      return trimmed;
    } catch {
      // Fall through to extraction logic
    }
  }

  // Strip markdown code blocks (```json ... ``` or ``` ... ```)
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (codeBlockMatch) {
    const inner = codeBlockMatch[1].trim();
    try {
      JSON.parse(inner);
      return inner;
    } catch {
      // Fall through
    }
  }

  // Find first { or [ and match to last } or ]
  const objectStart = trimmed.indexOf('{');
  const arrayStart = trimmed.indexOf('[');

  let start: number;
  let endChar: string;

  if (objectStart === -1 && arrayStart === -1) return null;

  if (objectStart === -1) {
    start = arrayStart;
    endChar = ']';
  } else if (arrayStart === -1) {
    start = objectStart;
    endChar = '}';
  } else {
    // Use whichever comes first
    if (objectStart < arrayStart) {
      start = objectStart;
      endChar = '}';
    } else {
      start = arrayStart;
      endChar = ']';
    }
  }

  // Try successive end positions to find the first parseable JSON region.
  // Using lastIndexOf can grab too much if there's a stray brace after valid JSON.
  let end = trimmed.indexOf(endChar, start + 1);
  while (end !== -1) {
    const candidate = trimmed.slice(start, end + 1);
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // Not valid JSON yet, try the next possible end position.
    }
    end = trimmed.indexOf(endChar, end + 1);
  }

  return null;
}

/**
 * Wraps the streaming ICompletionBackend.complete() callback pattern
 * into a simple Promise that returns accumulated text and metrics.
 */
export async function accumulateStream(
  adapters: SmallLLMAdapters,
  messages: Array<{ role: SmallLLMMessageRole; content: string }>,
  options: { temperature?: number; maxTokens?: number; timeoutMs?: number },
  taskType: SmallLLMTaskType
): Promise<{ text: string; metrics: Omit<SmallLLMMetrics, 'retried'> }> {
  const startTime = Date.now();
  let accumulated = '';
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;

  const completionPromise = adapters.llm.complete(
    adapters.modelId,
    messages,
    {
      temperature: options.temperature,
      maxTokens: options.maxTokens,
    },
    async (texts, completionInfo) => {
      for (const chunk of texts) {
        if (chunk != null) {
          accumulated += chunk;
        }
      }
      if (completionInfo && completionInfo.inputTokens !== undefined) {
        inputTokens = completionInfo.inputTokens;
      }
      if (completionInfo && completionInfo.outputTokens !== undefined) {
        outputTokens = completionInfo.outputTokens;
      }
    }
  );

  // Apply timeout if specified
  if (options.timeoutMs && options.timeoutMs > 0) {
    let timer: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`SmallLLMService: timeout after ${options.timeoutMs}ms`)),
        options.timeoutMs
      );
    });
    try {
      await Promise.race([completionPromise, timeoutPromise]);
    } finally {
      clearTimeout(timer!);
    }
  } else {
    await completionPromise;
  }

  return {
    text: accumulated.trim(),
    metrics: {
      latencyMs: Date.now() - startTime,
      inputTokens,
      outputTokens,
      modelId: adapters.modelId,
      taskType,
    },
  };
}
