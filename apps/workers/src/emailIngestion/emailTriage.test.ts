import { describe, it, expect, vi } from 'vitest';
import { BRIEF_LIMITS } from '@bike4mind/common';
import { buildTriagePrompt, parseTriageReply, triageEmail, type EmailTriageDeps } from './emailTriage';

const email = {
  id: 'email-1',
  userId: 'user-1',
  from: 'vendor@example.com',
  subject: 'Renewal',
  date: new Date('2026-11-17T09:00:00Z'),
  bodyText: 'Can you confirm the renewal date?',
};
const analysis = { summary: 'Vendor asks about renewal', actionItems: [{ description: 'Confirm date' }] };

describe('parseTriageReply', () => {
  it('keeps a decision draft addressed to the sender on record', () => {
    const reply = 'Here you go: {"kind":"decision","summary":"Confirm renewal","draftReply":{"body":"Yes, the 1st."}}';
    expect(parseTriageReply(reply, email)).toEqual({
      kind: 'decision',
      summary: 'Confirm renewal',
      draftReply: { to: 'vendor@example.com', subject: 'Re: Renewal', body: 'Yes, the 1st.' },
    });
  });

  it('ignores a model-supplied recipient', () => {
    const reply = JSON.stringify({
      kind: 'decision',
      summary: 's',
      draftReply: { to: 'attacker@example.net', subject: 'x', body: 'b' },
    });
    expect(parseTriageReply(reply, email).draftReply?.to).toBe('vendor@example.com');
  });

  it('drops a draft on a handled or fyi item', () => {
    for (const kind of ['handled', 'fyi']) {
      const parsed = parseTriageReply(JSON.stringify({ kind, summary: 's', draftReply: { body: 'b' } }), email);
      expect(parsed).toEqual({ kind, summary: 's' });
    }
  });

  it('keeps a decision without a draft body as a decision with no draft', () => {
    expect(parseTriageReply('{"kind":"decision","summary":"s"}', email)).toEqual({ kind: 'decision', summary: 's' });
  });

  it('clips an oversized summary, subject and body to the brief limits', () => {
    const reply = JSON.stringify({
      kind: 'decision',
      summary: 's'.repeat(BRIEF_LIMITS.itemText + 50),
      draftReply: { subject: 'j'.repeat(BRIEF_LIMITS.draftSubject + 5), body: 'b'.repeat(BRIEF_LIMITS.draftBody + 5) },
    });
    const parsed = parseTriageReply(reply, email);
    expect(parsed.summary).toHaveLength(BRIEF_LIMITS.itemText);
    expect(parsed.draftReply?.subject).toHaveLength(BRIEF_LIMITS.draftSubject);
    expect(parsed.draftReply?.body).toHaveLength(BRIEF_LIMITS.draftBody);
  });

  it.each([
    ['an unknown kind', '{"kind":"spam","summary":"s"}'],
    ['a missing summary', '{"kind":"fyi"}'],
    ['a blank summary', '{"kind":"fyi","summary":"   "}'],
    ['no JSON', 'I think this is a decision.'],
    ['broken JSON', '{"kind":"fyi",'],
  ])('throws on %s', (_label, reply) => {
    expect(() => parseTriageReply(reply, email)).toThrow();
  });
});

describe('buildTriagePrompt', () => {
  it('marks the email as untrusted data and clips the body', () => {
    const prompt = buildTriagePrompt({ ...email, bodyText: 'z'.repeat(9000) }, analysis);
    expect(prompt).toContain('untrusted data from a third');
    expect(prompt).toContain('- Confirm date');
    expect(prompt.match(/z+/)?.[0]).toHaveLength(4000);
  });
});

const makeDeps = (overrides: Partial<EmailTriageDeps> = {}) => {
  const deps = {
    enabled: vi.fn(async () => true),
    items: {
      existsForEmail: vi.fn(async () => false),
      upsertForEmail: vi.fn(async () => ({ created: true })),
    },
    complete: vi.fn(async () => ({
      reply: '{"kind":"handled","summary":"Receipt filed"}',
      model: 'test-model',
      tokensUsed: 42,
    })),
    logger: { info: vi.fn(), warn: vi.fn() },
    ...overrides,
  };
  return deps as typeof deps & EmailTriageDeps;
};

describe('triageEmail', () => {
  it('stores the parsed triage for the email owner', async () => {
    const deps = makeDeps();
    expect(await triageEmail(deps, { email, analysis })).toBe('created');
    expect(deps.items.upsertForEmail).toHaveBeenCalledWith({
      userId: 'user-1',
      emailId: 'email-1',
      kind: 'handled',
      summary: 'Receipt filed',
      model: 'test-model',
      tokensUsed: 42,
    });
  });

  it('makes no model call when the setting is off', async () => {
    const deps = makeDeps({ enabled: vi.fn(async () => false) });
    expect(await triageEmail(deps, { email, analysis })).toBe('disabled');
    expect(deps.complete).not.toHaveBeenCalled();
  });

  it('makes no model call when the email already has a triage item', async () => {
    const deps = makeDeps();
    deps.items.existsForEmail.mockResolvedValue(true);
    expect(await triageEmail(deps, { email, analysis })).toBe('exists');
    expect(deps.complete).not.toHaveBeenCalled();
    expect(deps.items.upsertForEmail).not.toHaveBeenCalled();
  });

  it('logs and resolves when the model reply is invalid', async () => {
    const deps = makeDeps({ complete: vi.fn(async () => ({ reply: 'nope', model: 'm', tokensUsed: null })) });
    expect(await triageEmail(deps, { email, analysis })).toBe('failed');
    expect(deps.items.upsertForEmail).not.toHaveBeenCalled();
    expect(deps.logger.warn).toHaveBeenCalled();
  });

  it('resolves when the model call throws', async () => {
    const deps = makeDeps({ complete: vi.fn(async () => Promise.reject(new Error('throttled'))) });
    await expect(triageEmail(deps, { email, analysis })).resolves.toBe('failed');
  });

  it('reports a lost race as a duplicate', async () => {
    const deps = makeDeps();
    deps.items.upsertForEmail.mockResolvedValue({ created: false });
    expect(await triageEmail(deps, { email, analysis })).toBe('duplicate');
  });
});
