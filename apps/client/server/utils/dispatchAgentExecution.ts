import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { resolveAgentExecutorFunctionName } from './agentExecutorFunctionName';

type ExecutorTarget = { kind: 'lambda'; functionName: string } | { kind: 'http'; url: string; secret: string };
const lambdaClient = new LambdaClient({});

export class AgentExecutorRejectedError extends Error {}

export function resolveAgentExecutorTarget(): ExecutorTarget | undefined {
  const service = process.env.AGENT_EXECUTOR_SERVICE?.trim();
  if (service) {
    const secret = process.env.AGENT_EXECUTOR_INTERNAL_SECRET?.trim();
    if (!secret) throw new Error('AGENT_EXECUTOR_INTERNAL_SECRET is required with AGENT_EXECUTOR_SERVICE');
    const url = new URL(service);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('AGENT_EXECUTOR_SERVICE must be an HTTP endpoint without credentials, query, or fragment');
    }
    return { kind: 'http', url: `${service.replace(/\/+$/, '')}/execute`, secret };
  }
  const functionName = resolveAgentExecutorFunctionName();
  return functionName ? { kind: 'lambda', functionName } : undefined;
}

export async function dispatchAgentExecution(
  payload: Record<string, unknown>,
  target = resolveAgentExecutorTarget()
): Promise<void> {
  if (!target) throw new Error('Agent execution is not available in this deployment');
  if (target.kind === 'lambda') {
    await lambdaClient.send(
      new InvokeCommand({
        FunctionName: target.functionName,
        InvocationType: 'Event',
        Payload: Buffer.from(JSON.stringify(payload)),
      })
    );
    return;
  }
  // Automatic retries after an ambiguous ACK can enqueue the same run twice.
  const response = await fetch(target.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${target.secret}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status !== 202) {
    const message = `Agent executor dispatch failed: HTTP ${response.status}`;
    if ([400, 401, 403, 404, 413].includes(response.status)) throw new AgentExecutorRejectedError(message);
    throw new Error(message);
  }
}
