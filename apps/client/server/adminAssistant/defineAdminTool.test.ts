import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import type { ToolContext } from '@bike4mind/services/llm/tools';
import { defineAdminTool } from './defineAdminTool';
import { AdminUserRefFields, withExactlyOneUserRef } from './schemas';

const makeContext = (isAdmin: boolean) => {
  const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  return {
    context: { user: { isAdmin }, userId: 'u1', logger } as unknown as Omit<ToolContext, 'config'>,
    logger,
  };
};

const buildTool = (run: Parameters<typeof defineAdminTool>[0]['run']) =>
  defineAdminTool({
    name: 'admin_get_health',
    description: 'dummy',
    input: z.object({ limit: z.number().int().min(1).max(50) }),
    run,
  });

describe('defineAdminTool', () => {
  it('returns forbidden for a non-admin and never calls run', async () => {
    const run = vi.fn();
    const { context } = makeContext(false);
    const tool = buildTool(run).implementation(context, undefined);

    const result = JSON.parse(await tool.toolFn({ limit: 5 }));

    expect(result).toMatchObject({ ok: false, error: 'forbidden' });
    expect(run).not.toHaveBeenCalled();
  });

  it('returns invalid_input for limit 100000 and never calls run', async () => {
    const run = vi.fn();
    const { context } = makeContext(true);
    const tool = buildTool(run).implementation(context, undefined);

    const result = JSON.parse(await tool.toolFn({ limit: 100000 }));

    expect(result).toMatchObject({ ok: false, error: 'invalid_input' });
    expect(run).not.toHaveBeenCalled();
  });

  it('returns failed and logs when run throws', async () => {
    const { context, logger } = makeContext(true);
    const tool = buildTool(async () => {
      throw new Error('boom');
    }).implementation(context, undefined);

    const raw = await tool.toolFn({ limit: 5 });

    expect(JSON.parse(raw)).toMatchObject({ ok: false, error: 'failed' });
    expect(raw).not.toContain('boom');
    expect(raw).not.toContain('at ');
    expect(logger.error).toHaveBeenCalled();
  });

  it('emits a JSON schema whose properties match the zod input', () => {
    const { context } = makeContext(true);
    const { toolSchema } = buildTool(vi.fn()).implementation(context, undefined);

    expect(toolSchema.name).toBe('admin_get_health');
    expect(toolSchema.parameters).not.toHaveProperty('$schema');
    expect(toolSchema.parameters.properties.limit).toMatchObject({ maximum: 50, minimum: 1 });
    expect(toolSchema.parameters.required).toEqual(['limit']);
  });

  it('does not mark defaulted fields as required in the JSON schema', () => {
    const { context } = makeContext(true);
    const tool = defineAdminTool({
      name: 'admin_get_health',
      description: 'dummy',
      input: z.object({ days: z.number().default(30), limit: z.number() }),
      run: vi.fn(),
    }).implementation(context, undefined);

    expect(tool.toolSchema.parameters.required).toEqual(['limit']);
    expect(tool.toolSchema.parameters.properties.days).toMatchObject({ default: 30 });
  });

  it('emits userId and email as plain string properties with no nested anyOf or const', () => {
    const { context } = makeContext(true);
    const tool = defineAdminTool({
      name: 'admin_get_user',
      description: 'dummy',
      input: withExactlyOneUserRef(AdminUserRefFields.extend({ limit: z.number().default(5) })),
      run: vi.fn(),
    }).implementation(context, undefined);

    const { properties } = tool.toolSchema.parameters;
    expect(properties.userId).toMatchObject({ type: 'string' });
    expect(properties.email).toMatchObject({ type: 'string' });
    expect(JSON.stringify(tool.toolSchema.parameters)).not.toMatch(/anyOf|"const"|"null"/);
  });

  it('returns the run result as JSON for an admin', async () => {
    const run = vi.fn(async (args: { limit: number }) => ({ ok: true as const, data: { echoed: args.limit } }));
    const { context } = makeContext(true);
    const tool = buildTool(run).implementation(context, undefined);

    const result = JSON.parse(await tool.toolFn({ limit: 7 }));

    expect(result).toEqual({ ok: true, data: { echoed: 7 } });
    expect(run).toHaveBeenCalledWith({ limit: 7 }, context);
  });
});
