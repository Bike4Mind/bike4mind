import { describe, expect, it } from 'vitest';
import type { Model } from 'mongoose';
import { ApiKeyUsageLog } from '../auth/ApiKeyUsageLogModel';
import { UserApiKey } from '../auth/UserApiKeyModel';
import { Quest } from '../content/QuestModel';
import { AgentExecutionModel } from './AgentExecutionModel';
import { CreditTransaction } from './CreditTransactionModel';

const partialIndexOn = (model: Model<never>, field: string) =>
  model.schema
    .indexes()
    .find(([keys, options]) => field in keys && options?.partialFilterExpression?.[field] !== undefined);

describe('side-app attribution schema fields', () => {
  it.each([
    ['CreditTransaction', CreditTransaction as unknown as Model<never>, ['oauthClientId', 'payerStanding']],
    ['ApiKeyUsageLog', ApiKeyUsageLog as unknown as Model<never>, ['oauthClientId', 'payerStanding']],
    ['Quest', Quest as unknown as Model<never>, ['apiKeyId', 'oauthClientId']],
    ['AgentExecution', AgentExecutionModel as unknown as Model<never>, ['oauthClientId']],
  ])('%s declares its fields and a partial oauthClientId index', (_name, model, fields) => {
    for (const field of fields) expect(model.schema.path(field)).toBeDefined();
    expect(partialIndexOn(model, 'oauthClientId')).toBeDefined();
  });

  it('restricts payerStanding to paid or unpaid on the ledger and request log', () => {
    for (const model of [CreditTransaction, ApiKeyUsageLog] as unknown as Model<Record<string, unknown>>[]) {
      expect(model.schema.path('payerStanding').options.enum).toEqual(['paid', 'unpaid']);
    }
  });

  it('keeps payerStanding in the UserApiKey metadata sub-schema', () => {
    const doc = new UserApiKey({
      userId: 'u',
      name: 'k',
      metadata: { createdFrom: 'oauth-exchange', oauthClientId: 'app-1', payerStanding: 'paid' },
    });
    expect(doc.toObject().metadata).toMatchObject({ payerStanding: 'paid' });
    const bad = new UserApiKey({ userId: 'u', name: 'k', metadata: { payerStanding: 'bogus' } });
    expect(bad.validateSync()?.errors['metadata.payerStanding']).toBeDefined();
  });
});
