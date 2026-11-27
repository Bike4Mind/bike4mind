import { BadRequestError } from '@bike4mind/common';

export function assertEvaluationTextWire(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach(assertEvaluationTextWire);
    return;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.type === 'string' && /image|audio|video|file|search|computer|code_interpreter/.test(record.type)) {
    throw new BadRequestError('Evaluation supports text and client-side function tools only.');
  }
  if (Object.keys(record).some(key => ['image_url', 'audio', 'file_id', 'previous_response_id'].includes(key))) {
    throw new BadRequestError('Unsupported evaluation transformation.');
  }
  Object.values(record).forEach(assertEvaluationTextWire);
}

export function assertEvaluationWireBound(value: unknown, contextWindow: number): void {
  const serialized = JSON.stringify(value);
  const record = value as { messages?: unknown[]; input?: unknown[] };
  const items = record.messages ?? record.input ?? [];
  // UTF-8 bytes dominate text BPE tokens; reserve extra framing for every message and tool.
  const bound = Buffer.byteLength(serialized, 'utf8') + 1024 + items.length * 256;
  if (!Number.isSafeInteger(contextWindow) || bound > contextWindow)
    throw new BadRequestError('Evaluation wire input exceeds its conservative context bound.');
}
