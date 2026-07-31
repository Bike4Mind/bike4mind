import { describe, it, expect } from 'vitest';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { chatContract } from '@bike4mind/common';
import { defineLambdaRoute } from './defineLambdaRoute';

/**
 * Proves the SAME contract that drives the Next.js /api/chat handler and the
 * OpenAPI spec also drives a Lambda Function URL handler - validation and shape
 * come from chatContract, not from a hand-rolled per-transport copy.
 */
const makeEvent = (body: unknown): APIGatewayProxyEventV2 =>
  ({ headers: {}, body: JSON.stringify(body) }) as unknown as APIGatewayProxyEventV2;

const asResult = (r: Awaited<ReturnType<ReturnType<typeof defineLambdaRoute>>>) =>
  r as APIGatewayProxyStructuredResultV2;

describe('defineLambdaRoute + chatContract', () => {
  const route = defineLambdaRoute(chatContract, async ({ validated }) => ({
    statusCode: 200,
    // `validated` is typed as the contract's request body - `.message` is string.
    body: { id: 'quest_1', status: 'queued', echoed: validated.message },
  }));

  it('validates with the contract schema and passes the typed body through', async () => {
    const res = asResult(await route(makeEvent({ message: 'hello' })));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body as string)).toMatchObject({ status: 'queued', echoed: 'hello' });
  });

  it('rejects a body that fails contract validation with 422', async () => {
    const res = asResult(await route(makeEvent({ notMessage: 1 })));
    expect(res.statusCode).toBe(422);
  });

  it('rejects unparseable JSON with 400', async () => {
    const res = asResult(await route({ headers: {}, body: '{not json' } as unknown as APIGatewayProxyEventV2));
    expect(res.statusCode).toBe(400);
  });
});
