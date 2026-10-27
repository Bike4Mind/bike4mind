/**
 * Reads the per-stage Slack mention setting the alarm relays prepend to production page-level
 * alarms. It lives in an SSM parameter (created in infra/alarmSlackMention.ts, value ignored
 * after creation) rather than a secret so an operator can flip it without a deploy.
 */

import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

export const ALARM_SLACK_MENTION_PARAMETER_ENV = 'ALARM_SLACK_MENTION_PARAMETER';

/** Seconds; one Lambda container re-reads the parameter at most this often. */
const CACHE_TTL_MS = 60_000;

let cache: { name: string; value: string | undefined; readAt: number } | undefined;
let client: SSMClient | undefined;

export interface MentionReader {
  getParameter(name: string): Promise<string | undefined>;
}

const defaultReader: MentionReader = {
  async getParameter(name) {
    client ??= new SSMClient({});
    const result = await client.send(new GetParameterCommand({ Name: name }));
    return result.Parameter?.Value;
  },
};

/**
 * The raw setting, or undefined when no parameter is configured, it does not exist, or the read
 * fails. A broken read must never stop an alarm from posting, so errors are logged and swallowed.
 */
export async function readAlarmMention(
  parameterName: string | undefined = process.env[ALARM_SLACK_MENTION_PARAMETER_ENV],
  reader: MentionReader = defaultReader,
  now: () => number = Date.now
): Promise<string | undefined> {
  const name = parameterName?.trim();
  if (!name) return undefined;
  if (cache && cache.name === name && now() - cache.readAt < CACHE_TTL_MS) return cache.value;

  let value: string | undefined;
  try {
    value = await reader.getParameter(name);
  } catch (error) {
    const code = (error as { name?: string })?.name;
    if (code !== 'ParameterNotFound') {
      console.warn(`[alarmSlackMention] could not read ${name}: ${code ?? String(error)}`);
    }
  }
  cache = { name, value, readAt: now() };
  return value;
}

/** Test hook. */
export function __resetAlarmMentionCacheForTesting(): void {
  cache = undefined;
}
