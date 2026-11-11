// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { stripComments } from './helpers/infraSource';

// Every SQS call apps/client/pages/api/admin/dlq/replay.ts makes through
// packages/server-utils/src/utils/sqs.ts. The route tests mock that module, so a call the web
// function's role does not allow only fails against real SQS; this list must stay in sync with the route.
const REPLAY_ROUTE_ACTIONS = [
  'sqs:ReceiveMessage',
  'sqs:DeleteMessage',
  'sqs:ChangeMessageVisibility',
  'sqs:GetQueueAttributes',
  'sqs:SendMessage',
];

const stageQueueStatements = (source: string) =>
  [...stripComments(source).matchAll(/\{\s*actions:\s*\[([^\]]*)\],\s*resources:\s*\[stageQueueArns\],?\s*\}/g)].map(
    match => [...match[1].matchAll(/'([^']+)'/g)].map(action => action[1])
  );

describe('web function SQS permissions for admin DLQ replay', () => {
  const source = readFileSync(new URL('../web.ts', import.meta.url), 'utf8');

  it('grants each action the replay route uses, on this stage queues only', () => {
    const statements = stageQueueStatements(source);

    expect(statements).toHaveLength(1);
    expect([...statements[0]].sort()).toEqual([...REPLAY_ROUTE_ACTIONS].sort());
  });
});
