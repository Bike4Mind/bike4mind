import { createHash } from 'node:crypto';
import { selectSessions } from './selection';
import type {
  ContextEntry,
  ContextIssue,
  ContextLimits,
  ContextReaders,
  ContextRequest,
  ContextSnapshot,
  ContextSource,
  ContextText,
} from './types';

export const CONTEXT_LIMITS: ContextLimits = Object.freeze({
  candidates: 256,
  sessions: 12,
  sources: 128,
  sourceBytes: 16_384,
  totalBytes: 65_536,
});

export function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function boundedText(text: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    bytes += Buffer.byteLength(character);
    if (bytes > maxBytes) break;
    end += character.length;
  }
  return text.slice(0, end);
}

export function immutable<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

export class ContextCollector {
  private readonly limits: ContextLimits;

  constructor(
    private readonly readers: ContextReaders,
    limits: Partial<ContextLimits> = {}
  ) {
    this.limits = { ...CONTEXT_LIMITS };
    for (const key of Object.keys(CONTEXT_LIMITS) as (keyof ContextLimits)[]) {
      const value = limits[key] ?? CONTEXT_LIMITS[key];
      if (!Number.isSafeInteger(value) || value < 1 || value > CONTEXT_LIMITS[key]) {
        throw new RangeError(`Invalid context limit: ${key}`);
      }
      this.limits = { ...this.limits, [key]: value };
    }
  }

  scopeKey(): string {
    return this.readers.scopeKey();
  }

  async collect(input: ContextRequest, signal: AbortSignal): Promise<ContextSnapshot> {
    signal.throwIfAborted();
    const ids = input.selection.kind === 'explicit' ? input.selection.sessionIds : [];
    if (
      ids.length > this.limits.candidates ||
      (input.files?.length ?? 0) > this.limits.candidates ||
      [input.sessionId, ...ids, ...(input.files ?? [])].some(value => !value || value.length > 4096)
    ) {
      throw new RangeError('Context selection exceeds input limits');
    }
    const request = structuredClone(input);
    const scope = this.readers.scopeKey();
    const check = () => {
      signal.throwIfAborted();
      if (this.readers.scopeKey() !== scope) throw new Error('Context account scope changed');
    };
    check();
    const entries: ContextEntry[] = [];
    const issues: ContextIssue[] = [];
    const seen = new Set<string>();
    let totalBytes = 0;
    let attempts = 0;
    const available = () => attempts < this.limits.sources && totalBytes < this.limits.totalBytes;
    const add = (key: string, source: ContextSource, value: ContextText) => {
      if (seen.has(key)) return;
      seen.add(key);
      const text = boundedText(value.text, Math.min(this.limits.sourceBytes, this.limits.totalBytes - totalBytes));
      const truncated = value.truncated === true || text !== value.text;
      const bytes = Buffer.byteLength(text);
      totalBytes += bytes;
      entries.push({ source, text, bytes, sha256: hash(text), truncated });
      if (truncated) issues.push({ source: key, reason: 'truncated' });
    };
    const candidates =
      request.selection.kind === 'family'
        ? await this.readers.listSessions(request.sessionId, this.limits.candidates, signal)
        : [];
    check();
    const selected = selectSessions(
      request.sessionId,
      request.selection,
      candidates.slice(0, this.limits.candidates),
      this.limits.sessions
    );
    if (selected.truncated || candidates.length >= this.limits.candidates)
      issues.push({ source: 'sessions', reason: 'limit' });
    const sessionIds: string[] = [];
    for (const id of selected.ids) {
      check();
      if (!available()) {
        issues.push({ source: 'sources', reason: 'limit' });
        break;
      }
      const result = await this.readers.readSession(request.sessionId, id, signal);
      check();
      if (result.status !== 'ok') {
        issues.push({ source: id, reason: result.status });
        continue;
      }
      if (result.value.id !== id) throw new Error('Context reader returned a different session');
      sessionIds.push(id);
      let visited = 0;
      for (const message of result.value.messages) {
        if (++visited > this.limits.sources) {
          issues.push({ source: id, reason: 'limit' });
          break;
        }
        if (!available()) {
          issues.push({ source: id, reason: 'limit' });
          break;
        }
        const key = JSON.stringify(['message', id, message.id]);
        if (!seen.has(key)) {
          attempts++;
          add(
            key,
            { kind: 'message', sessionId: id, messageId: message.id, role: message.role },
            { text: message.content }
          );
        }
        for (const original of message.attachments ?? []) {
          const attachment = { ...original };
          if (++visited > this.limits.sources) {
            issues.push({ source: id, reason: 'limit' });
            break;
          }
          if (!available()) {
            issues.push({ source: id, reason: 'limit' });
            break;
          }
          const attachmentKey = JSON.stringify(['attachment', id, attachment.id]);
          if (seen.has(attachmentKey)) continue;
          attempts++;
          const read = await this.readers.readAttachment(
            request.sessionId,
            id,
            { ...attachment },
            Math.min(this.limits.sourceBytes, this.limits.totalBytes - totalBytes),
            signal
          );
          check();
          if (read.status === 'ok')
            add(
              attachmentKey,
              { kind: 'attachment', sessionId: id, attachmentId: attachment.id },
              { ...read.value, truncated: read.value.truncated || attachment.truncated }
            );
          else {
            seen.add(attachmentKey);
            issues.push({ source: attachmentKey, reason: read.status });
          }
        }
      }
    }
    const paths = new Set<string>();
    for (const path of request.files ?? []) {
      check();
      if (paths.has(path)) continue;
      paths.add(path);
      if (!available()) {
        issues.push({ source: 'files', reason: 'limit' });
        break;
      }
      attempts++;
      const result = await this.readers.readFile(
        request.sessionId,
        path,
        Math.min(this.limits.sourceBytes, this.limits.totalBytes - totalBytes),
        signal
      );
      check();
      if (result.status === 'ok')
        add(
          JSON.stringify(['file', result.value.canonicalPath]),
          { kind: 'file', path: result.value.canonicalPath },
          result.value
        );
      else issues.push({ source: path, reason: result.status });
    }
    check();
    const snapshot = {
      sessionId: request.sessionId,
      selection: request.selection,
      sessionIds,
      entries,
      issues,
      totalBytes,
    };
    return immutable({ ...snapshot, sha256: hash(JSON.stringify(snapshot)) });
  }
}
