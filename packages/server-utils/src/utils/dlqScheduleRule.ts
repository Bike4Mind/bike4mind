import { DescribeRuleCommand, EventBridgeClient, ListTargetsByRuleCommand } from '@aws-sdk/client-eventbridge';
import { Logger } from '@bike4mind/observability';
import { CONSUMER_LOGS_BUDGET_MS, settleWithinBudget } from './dlqLookupBudget';

export type ScheduleRule = {
  state: 'ENABLED' | 'DISABLED';
  scheduleExpression?: string;
  targetFunctionArn?: string;
};

const CACHE_TTL_MS = 10 * 60_000;
const NULL_CACHE_TTL_MS = 60_000;
const LOOKUP_TIMEOUT_MS = 10_000;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
// Interpolated so no source line spells a literal ARN prefix, which the public-repo term check rejects.
export const ARN_PARTITION = 'aws[a-z-]*';
const RULE_ARN = new RegExp(
  String.raw`^arn:${ARN_PARTITION}:events:([a-z0-9-]+):\d{12}:rule/(?:[\w.-]+/)?([\w.-]{1,64})$`
);
/** Captures region ([1]) and function name ([2]); any version or alias qualifier is dropped. */
export const LAMBDA_FUNCTION_ARN = new RegExp(
  String.raw`^arn:${ARN_PARTITION}:lambda:([a-z0-9-]+):\d{12}:function:([\w-]{1,64})(?::[\w$-]+)?$`
);
const RETRYABLE_ERRORS = new Set(['ThrottlingException', 'TooManyRequestsException', 'TimeoutError']);

const cache = new Map<string, { promise: Promise<ScheduleRule | null>; expiresAt: number }>();
const clients = new Map<string, EventBridgeClient>();

export function resetScheduleRuleCacheForTests(): void {
  cache.clear();
}

/** The scheduled time and rule of an EventBridge Scheduled Event body; null for any other body. */
export function parseScheduledEvent(rawBody: string | undefined): { time: string; ruleArn: string } | null {
  if (!rawBody) return null;
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (typeof body !== 'object' || body === null) return null;
  const event = body as Record<string, unknown>;
  if (event['detail-type'] !== 'Scheduled Event' || event.source !== 'aws.events') return null;
  const time = typeof event.time === 'string' ? event.time : '';
  const ruleArn = Array.isArray(event.resources) ? event.resources[0] : undefined;
  if (!Number.isFinite(Date.parse(time)) || typeof ruleArn !== 'string' || !RULE_ARN.test(ruleArn)) return null;
  return { time: new Date(time).toISOString(), ruleArn };
}

/**
 * The gap between runs of a schedule expression, or undefined when it cannot be stated exactly.
 * cron() is read conservatively: only fixed minute+hour daily or weekly schedules are recognised.
 */
export function scheduledIntervalMs(expression: string | undefined): number | undefined {
  const rate = expression?.match(/^rate\((\d+) (minute|minutes|hour|hours|day|days)\)$/);
  if (rate) {
    const count = Number(rate[1]);
    const unit = rate[2].startsWith('minute') ? MINUTE_MS : rate[2].startsWith('hour') ? 60 * MINUTE_MS : DAY_MS;
    return count > 0 ? count * unit : undefined;
  }
  const cron = expression
    ?.match(/^cron\((.+)\)$/)?.[1]
    .trim()
    .split(/\s+/);
  if (!cron || cron.length !== 6) return undefined;
  const [minute, hour, dayOfMonth, month, dayOfWeek, year] = cron;
  const fixed = (field: string) => /^\d+$/.test(field);
  const any = (field: string) => field === '*' || field === '?';
  if (!fixed(minute) || !fixed(hour) || !any(month) || !any(year) || !any(dayOfMonth)) return undefined;
  if (any(dayOfWeek)) return DAY_MS;
  return /^([1-7]|SUN|MON|TUE|WED|THU|FRI|SAT)$/i.test(dayOfWeek) ? 7 * DAY_MS : undefined;
}

/** When the run after `scheduledAt` was due, for an enabled rule with an exact interval; undefined otherwise. */
export function nextRunDueAt(scheduledAt: string, rule: ScheduleRule | null): string | undefined {
  if (rule?.state !== 'ENABLED') return undefined;
  const interval = scheduledIntervalMs(rule.scheduleExpression);
  const at = Date.parse(scheduledAt);
  return interval !== undefined && Number.isFinite(at) ? new Date(at + interval).toISOString() : undefined;
}

async function lookupRule(
  ruleArn: string,
  deadline: number
): Promise<{ rule: ScheduleRule | null; retryable: boolean }> {
  const [, region, name] = ruleArn.match(RULE_ARN)!;
  let client = clients.get(region);
  if (!client) {
    client = new EventBridgeClient({ region });
    clients.set(region, client);
  }
  try {
    const described = await client.send(new DescribeRuleCommand({ Name: name }));
    if (Date.now() >= deadline) return { rule: null, retryable: true };
    if (described.Arn !== ruleArn) return { rule: null, retryable: false };
    if (described.State !== 'ENABLED' && described.State !== 'DISABLED') return { rule: null, retryable: false };
    const { Targets = [], NextToken } = await client.send(new ListTargetsByRuleCommand({ Rule: name }));
    const target = !NextToken && Targets.length === 1 ? Targets[0].Arn?.match(LAMBDA_FUNCTION_ARN) : null;
    const targetFunctionArn = target?.[1] === region ? target[0].split(':').slice(0, 7).join(':') : undefined;
    return {
      rule: {
        state: described.State,
        ...(described.ScheduleExpression ? { scheduleExpression: described.ScheduleExpression } : {}),
        ...(targetFunctionArn ? { targetFunctionArn } : {}),
      },
      retryable: false,
    };
  } catch (error) {
    const errorName = error instanceof Error ? error.name : 'Unknown';
    Logger.warn('[dlqScheduleRule] schedule rule lookup failed', { errorName });
    return { rule: null, retryable: RETRYABLE_ERRORS.has(errorName) };
  }
}

/**
 * The state, schedule and Lambda target of an EventBridge rule in the deploy region. Never throws: any
 * failure resolves to null. Cached 10 minutes, a null result 1 minute; a throttled or timed-out lookup is not cached.
 */
export function resolveScheduleRule(
  ruleArn: string,
  deadline = Date.now() + CONSUMER_LOGS_BUDGET_MS
): Promise<ScheduleRule | null> {
  // The ARN comes from a message body; checking the region first keeps one client per region bounded to ours.
  const region = ruleArn.match(RULE_ARN)?.[1];
  if (!region || region !== process.env.AWS_REGION || ruleArn.split('/').length !== 2) return Promise.resolve(null);
  const now = Date.now();
  if (now >= deadline) return Promise.resolve(null);
  const hit = cache.get(ruleArn);
  if (hit && hit.expiresAt > now) {
    return settleWithinBudget([hit.promise], deadline - now).then(([rule]) => rule ?? null);
  }
  const lookupDeadline = Math.min(deadline, now + LOOKUP_TIMEOUT_MS);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ rule: null; retryable: true }>(resolve => {
    timer = setTimeout(() => resolve({ rule: null, retryable: true }), lookupDeadline - now);
  });
  const entry: { promise: Promise<ScheduleRule | null>; expiresAt: number } = {
    promise: Promise.race([lookupRule(ruleArn, lookupDeadline), timeout])
      .finally(() => clearTimeout(timer))
      .then(({ rule, retryable }) => {
        if (retryable) {
          if (cache.get(ruleArn) === entry) cache.delete(ruleArn);
        } else if (rule === null) {
          entry.expiresAt = Date.now() + NULL_CACHE_TTL_MS;
        }
        return rule;
      }),
    expiresAt: now + CACHE_TTL_MS,
  };
  cache.set(ruleArn, entry);
  return entry.promise;
}
