import { describe, it, expect, vi } from 'vitest';

vi.mock('@client/services/operationsModelService', () => ({
  OperationsModelService: { getOperationsModel: vi.fn() },
  getEffectiveApiKeyByBackend: vi.fn(),
}));

import { classifySkill, type ClassifierLlm } from './classifySkill';

const snapshot = { name: 'fmt', description: 'Formats text', body: 'Rewrite the text as bullets.' };

const valid = {
  verdict: 'pass',
  confidence: 0.92,
  findings: [{ rule: 'note', severity: 'low', message: 'fine' }],
  honestSummary: {
    whatItDoes: 'Rewrites text as bullets.',
    toolsUsed: [],
    dataItTouches: 'The text you paste.',
    riskNotes: [],
    descriptionMatches: true,
  },
};

const llm = (complete: ClassifierLlm['complete']): ClassifierLlm => ({ model: 'test-model', complete });

describe('classifySkill', () => {
  it('returns the verdict, findings and honest summary from well-formed output (fenced JSON ok)', async () => {
    const result = await classifySkill(
      snapshot,
      llm(async () => '```json\n' + JSON.stringify(valid) + '\n```')
    );
    expect(result).toMatchObject({ ok: true, verdict: 'pass', confidence: 0.92, model: 'test-model' });
    if (result.ok) {
      expect(result.findings[0]).toMatchObject({ source: 'classifier' });
      expect(result.honestSummary.descriptionMatches).toBe(true);
    }
  });

  it('fails closed on unparseable output', async () => {
    const result = await classifySkill(
      snapshot,
      llm(async () => 'Sure! This skill looks safe.')
    );
    expect(result.ok).toBe(false);
  });

  it('fails closed on schema-violating JSON (e.g. a missing honest summary)', async () => {
    const { honestSummary: _h, ...rest } = valid;
    const result = await classifySkill(
      snapshot,
      llm(async () => JSON.stringify(rest))
    );
    expect(result.ok).toBe(false);
  });

  it('tolerates cosmetic drift: long free-form rule names, severity case, unknown severity, null mismatchNote', async () => {
    const drifted = {
      ...valid,
      findings: [
        {
          rule: 'exfiltrating conversation content, files, memory, keys or personal data',
          severity: 'Critical',
          message: 'x',
        },
        { rule: 'odd', severity: 'info', message: 'y' },
      ],
      honestSummary: { ...valid.honestSummary, descriptionMatches: false, mismatchNote: null },
    };
    const result = await classifySkill(
      snapshot,
      llm(async () => JSON.stringify(drifted))
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.findings.map(f => f.severity)).toEqual(['critical', 'high']);
      expect(result.findings[0].rule).toHaveLength(60);
      expect(result.honestSummary).toMatchObject({ descriptionMatches: false });
      expect(result.honestSummary.mismatchNote).toBeUndefined();
    }
  });

  it('still fails closed on a non-boolean descriptionMatches and names the field', async () => {
    const bad = { ...valid, honestSummary: { ...valid.honestSummary, descriptionMatches: 'mostly' } };
    const result = await classifySkill(
      snapshot,
      llm(async () => JSON.stringify(bad))
    );
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toContain('honestSummary.descriptionMatches');
  });

  it('fails closed when the model call throws', async () => {
    const result = await classifySkill(
      snapshot,
      llm(async () => {
        throw new Error('provider down');
      })
    );
    expect(result).toMatchObject({ ok: false, error: 'provider down' });
  });

  it('passes the skill as nonce-delimited data the body cannot predict', async () => {
    const seen: string[] = [];
    await classifySkill(
      snapshot,
      llm(async (_system, user) => {
        seen.push(user);
        return JSON.stringify(valid);
      })
    );
    await classifySkill(
      snapshot,
      llm(async (_system, user) => {
        seen.push(user);
        return JSON.stringify(valid);
      })
    );
    const nonce = (s: string) => s.match(/=====BEGIN SKILL DATA ([0-9a-f]+)=====/)?.[1];
    expect(nonce(seen[0])).toBeTruthy();
    expect(nonce(seen[0])).not.toBe(nonce(seen[1]));
    expect(seen[0]).toContain(`=====END SKILL DATA ${nonce(seen[0])}=====`);
  });

  it('fails closed on a hung model call instead of waiting forever', async () => {
    vi.useFakeTimers();
    try {
      const pending = classifySkill(
        snapshot,
        llm(() => new Promise<string>(() => {}))
      );
      await vi.advanceTimersByTimeAsync(25_000);
      expect(await pending).toMatchObject({ ok: false, error: 'Classifier timed out' });
    } finally {
      vi.useRealTimers();
    }
  });
});
