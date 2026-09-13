import { describe, expect, it } from 'vitest';
import {
  COMMON_PLACEHOLDERS,
  NOT_CONFIGURED_PLACEHOLDER,
  SST_PLACEHOLDER_VALUE,
  TIER1_SECRET_SPECS,
  evaluateTier1Secrets,
  formatTier1DeployFailure,
} from '../tier1Secrets.js';

const REAL = '4f'.repeat(32);
const REAL_MONGO = 'mongodb+srv://user:pw@cluster.example.com/b4m';

/** Every tier-1 secret set to something valid. */
function allConfigured(): Record<string, string> {
  return Object.fromEntries(
    TIER1_SECRET_SPECS.map(spec => [spec.name, spec.name === 'MONGODB_URI' ? REAL_MONGO : REAL])
  );
}

function evaluate(values: Record<string, string | undefined>, stage: string, isProductionStage: boolean) {
  return evaluateTier1Secrets({ stage, isProductionStage, read: name => values[name] });
}

describe('TIER1_SECRET_SPECS', () => {
  it('covers every secret named in the fix criteria', () => {
    expect(TIER1_SECRET_SPECS.map(s => s.name)).toEqual([
      'MONGODB_URI',
      'SESSION_SECRET',
      'JWT_SECRET',
      'SECRET_ENCRYPTION_KEY',
      'CHAT_COMPLETION_INTERNAL_SECRET',
      'SECOPS_ZAP_INGEST_TOKEN',
      'SECOPS_CODE_INGEST_TOKEN',
      'SECOPS_PACKAGES_INGEST_TOKEN',
      'SECOPS_SECRETS_INGEST_TOKEN',
      'SECOPS_PROWLER_INGEST_TOKEN',
      'SECOPS_ATTACK_SIMULATION_INGEST_TOKEN',
      'RATE_LIMIT_INGEST_TOKEN',
    ]);
  });

  it('gives every spec a paste-ready sst secret set hint for the stage', () => {
    for (const spec of TIER1_SECRET_SPECS) {
      expect(spec.hint('pr123')).toContain(`sst secret set ${spec.name}`);
      expect(spec.hint('pr123')).toContain('--stage pr123');
    }
  });
});

describe('evaluateTier1Secrets', () => {
  it('passes a fully configured stage', () => {
    const statuses = evaluate(allConfigured(), 'production', true);
    expect(statuses.every(s => s.status === 'configured')).toBe(true);
    expect(statuses.some(s => s.blocksDeploy)).toBe(false);
  });

  it('reports a never-set secret as a placeholder, not as missing', () => {
    const values = allConfigured();
    delete values.CHAT_COMPLETION_INTERNAL_SECRET;
    const status = evaluate(values, 'production', true).find(s => s.name === 'CHAT_COMPLETION_INTERNAL_SECRET');
    expect(status?.status).toBe('placeholder');
    expect(status?.message).toContain('infra/secrets.ts');
    expect(status?.blocksDeploy).toBe(true);
  });

  it('blocks on the shipped SST placeholder literal', () => {
    const statuses = evaluate({ ...allConfigured(), JWT_SECRET: SST_PLACEHOLDER_VALUE }, 'production', true);
    const jwt = statuses.find(s => s.name === 'JWT_SECRET');
    expect(jwt?.status).toBe('placeholder');
    expect(jwt?.blocksDeploy).toBe(true);
  });

  it('blocks on the not-configured literal for an ingest token on a production stage', () => {
    const statuses = evaluate(
      { ...allConfigured(), RATE_LIMIT_INGEST_TOKEN: NOT_CONFIGURED_PLACEHOLDER },
      'production',
      true
    );
    expect(statuses.find(s => s.name === 'RATE_LIMIT_INGEST_TOKEN')?.blocksDeploy).toBe(true);
  });

  it('blocks on every COMMON_PLACEHOLDERS entry, case- and whitespace-insensitive', () => {
    for (const placeholder of COMMON_PLACEHOLDERS) {
      const statuses = evaluate(
        { ...allConfigured(), JWT_SECRET: `  ${placeholder.toUpperCase()} ` },
        'production',
        true
      );
      expect(statuses.find(s => s.name === 'JWT_SECRET')?.blocksDeploy).toBe(true);
    }
  });

  it('still blocks an always-enforced secret on a preview stage', () => {
    const values = allConfigured();
    delete values.JWT_SECRET;
    delete values.CHAT_COMPLETION_INTERNAL_SECRET;
    const statuses = evaluate(values, 'pr123', false);
    expect(statuses.find(s => s.name === 'JWT_SECRET')?.blocksDeploy).toBe(true);
    expect(statuses.find(s => s.name === 'CHAT_COMPLETION_INTERNAL_SECRET')?.blocksDeploy).toBe(true);
  });

  it('reports but does not block an unset ingest token on a preview stage', () => {
    const values = allConfigured();
    delete values.SECOPS_ZAP_INGEST_TOKEN;
    const status = evaluate(values, 'pr123', false).find(s => s.name === 'SECOPS_ZAP_INGEST_TOKEN');
    expect(status?.status).toBe('placeholder');
    expect(status?.blocksDeploy).toBe(false);
  });

  it('does not block on a JWT_SECRET that is short but above the hard floor', () => {
    const status = evaluate({ ...allConfigured(), JWT_SECRET: 'a1'.repeat(20) }, 'production', true).find(
      s => s.name === 'JWT_SECRET'
    );
    expect(status?.status).toBe('warning');
    expect(status?.blocksDeploy).toBe(false);
  });

  it('never returns a secret value', () => {
    const serialized = JSON.stringify(evaluate(allConfigured(), 'production', true));
    expect(serialized).not.toContain(REAL);
    expect(serialized).not.toContain(REAL_MONGO);
  });
});

describe('formatTier1DeployFailure', () => {
  it('names the blocking secrets and their remediation without echoing any value', () => {
    const values = allConfigured();
    delete values.CHAT_COMPLETION_INTERNAL_SECRET;
    values.JWT_SECRET = SST_PLACEHOLDER_VALUE;
    const statuses = evaluate(values, 'production', true);

    const message = formatTier1DeployFailure('production', statuses);

    expect(message).toContain('Refusing to deploy stage "production"');
    expect(message).toContain('2 tier-1 secrets');
    expect(message).toContain('CHAT_COMPLETION_INTERNAL_SECRET');
    expect(message).toContain('sst secret set JWT_SECRET');
    expect(message).not.toContain(REAL);
    expect(message).not.toContain(SST_PLACEHOLDER_VALUE);
  });

  it('uses singular wording for a single blocker', () => {
    const values = allConfigured();
    delete values.SESSION_SECRET;
    const message = formatTier1DeployFailure('pr123', evaluate(values, 'pr123', false));
    expect(message).toContain('1 tier-1 secret is not configured');
  });
});
