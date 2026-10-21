import { z } from 'zod';
import { COMPLETION_SOURCES } from '../types/analytics';
import { USAGE_EVENT_STATUSES } from '../types/entities/UsageEventTypes';

export const FLEET_USAGE_MAX_DAYS = 31;
export const FLEET_USAGE_MAX_ROWS = 10_000;
export const FLEET_USAGE_DAY_MS = 86_400_000;

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(value => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, 'Expected a real UTC calendar date');
const id = z.string().trim().min(1).max(256);
const counter = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const FleetUsageExportQuerySchema = z
  .object({ from: date, to: date })
  .strict()
  .refine(({ from, to }) => {
    const span = Date.parse(to) - Date.parse(from);
    return span >= 0 && span < FLEET_USAGE_MAX_DAYS * FLEET_USAGE_DAY_MS;
  }, 'Expected an inclusive range of 1 to 31 UTC days');

export const FleetUsageExportScopeSchema = z
  .object({
    userIds: z.array(id).min(1).max(1000),
    owners: z
      .array(
        z
          .object({
            ownerId: id,
            ownerType: z.enum(['User', 'Organization', 'Agent']),
          })
          .strict()
      )
      .min(1)
      .max(100),
  })
  .strict();

export const FleetUsageExportRowSchema = z
  .object({
    userId: id,
    email: z.string().email().max(320).nullable(),
    ownerId: id,
    ownerType: z.enum(['User', 'Organization', 'Agent']),
    provider: z.string().min(1).max(256),
    model: z.string().min(1).max(512),
    source: z.enum([...COMPLETION_SOURCES, 'unclassified']),
    settledBasis: z.enum(['provider', 'local', 'unclassified']),
    status: z.enum(USAGE_EVENT_STATUSES),
    inputTokens: counter,
    outputTokens: counter,
    providerInputTokens: counter.nullable(),
    providerOutputTokens: counter.nullable(),
    cacheReadTokens: counter,
    cacheWriteTokens: counter,
    costUsd: counter,
    creditsCharged: counter,
    writtenOffCredits: counter,
    requests: counter.int().positive(),
  })
  .strict();

export const FleetUsageExportSchema = z
  .object({
    version: z.literal(1),
    from: date,
    to: date,
    generatedAt: z.string().datetime(),
    days: z
      .array(z.object({ date, rows: z.array(FleetUsageExportRowSchema).max(FLEET_USAGE_MAX_ROWS) }).strict())
      .min(1)
      .max(FLEET_USAGE_MAX_DAYS),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!FleetUsageExportQuerySchema.safeParse({ from: value.from, to: value.to }).success) {
      ctx.addIssue({ code: 'custom', message: 'Invalid snapshot range' });
      return;
    }
    const expected = (Date.parse(value.to) - Date.parse(value.from)) / FLEET_USAGE_DAY_MS + 1;
    if (
      value.days.length !== expected ||
      value.days.some(
        (day, i) => day.date !== new Date(Date.parse(value.from) + i * FLEET_USAGE_DAY_MS).toISOString().slice(0, 10)
      ) ||
      value.days.reduce((sum, day) => sum + day.rows.length, 0) > FLEET_USAGE_MAX_ROWS
    ) {
      ctx.addIssue({ code: 'custom', message: 'Expected every UTC day exactly once within row limits' });
    }
  });

export type FleetUsageExport = z.infer<typeof FleetUsageExportSchema>;
export type FleetUsageExportRow = z.infer<typeof FleetUsageExportRowSchema>;
export type FleetUsageExportScope = z.infer<typeof FleetUsageExportScopeSchema>;
