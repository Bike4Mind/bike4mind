import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  roles: [] as string[],
  arns: ['consumer-one-arn', 'consumer-two-arn'],
  document: vi.fn(),
  policy: vi.fn(),
  attach: vi.fn(),
}));
vi.mock('../cron', () => ({}));
vi.mock('../dlqAlarms', () => ({}));
vi.mock('../dlqTriagePermissions', () => ({ dlqTriageRoleNames: h.roles }));
vi.mock('../web', () => ({ dlqConsumerFunctionArns: h.arns }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  h.roles.length = 0;
  h.document.mockReturnValue({ json: 'exact-consumer-policy' });
  vi.stubGlobal('aws', {
    iam: {
      getPolicyDocumentOutput: h.document,
      Policy: class {
        arn = 'policy-arn';
        constructor(name: string, args: unknown) {
          h.policy(name, args);
        }
      },
      RolePolicyAttachment: class {
        constructor(name: string, args: unknown) {
          h.attach(name, args);
        }
      },
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('late DLQ triage consumer metadata policy', () => {
  it('uses only the registered consumer ARNs and attaches to both triage roles', async () => {
    h.roles.push('sweep-role', 'alarm-role');
    await import('../dlqTriageFunctionLogs');
    expect(h.document).toHaveBeenCalledExactlyOnceWith({
      statements: [{ actions: ['lambda:GetFunctionConfiguration'], resources: h.arns }],
    });
    expect(h.attach.mock.calls).toEqual([
      ['DlqTriageConsumerLogsAttachment0', { role: 'sweep-role', policyArn: 'policy-arn' }],
      ['DlqTriageConsumerLogsAttachment1', { role: 'alarm-role', policyArn: 'policy-arn' }],
    ]);
  });
  it('creates no policy when no triage worker runs in the stage', async () => {
    await import('../dlqTriageFunctionLogs');
    expect(h.document).not.toHaveBeenCalled();
    expect(h.policy).not.toHaveBeenCalled();
    expect(h.attach).not.toHaveBeenCalled();
  });
});
