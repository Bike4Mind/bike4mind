import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LOOP_DIRECTIVE_TOOL_NAMES,
  LOOP_OVERSEER_TOOL_NAMES,
  LOOP_TICKET_TOOL_NAMES,
  LOOP_VERSIONED_FIELDS,
} from '@bike4mind/common';

/**
 * Loop settings (stages, models, tools, schedule, budget and the other guardrails) are written only by the owner's
 * routes: PATCH /api/loops/:id and the coach (apps/client/server/utils/loopConfig.ts). No agent tool a loop run, an
 * overseer included, can call may write them. A new loop tool fails the pin below until it is reviewed against that.
 */
describe('loop agent tools cannot write loop settings', () => {
  it('the loop tool set is pinned', () => {
    expect([...LOOP_TICKET_TOOL_NAMES, ...LOOP_DIRECTIVE_TOOL_NAMES, ...LOOP_OVERSEER_TOOL_NAMES].sort()).toEqual([
      'loop_directive_issue',
      'loop_directive_respond',
      'loop_oversee_status',
      'loop_resume',
      'loop_run_now',
      'loop_ticket_create',
      'loop_ticket_handoff',
      'loop_ticket_list',
      'loop_ticket_split',
      'loop_ticket_unsure',
      'loop_ticket_update',
    ]);
  });

  const toolFiles = readdirSync(__dirname).filter(name => /^agentExecutor\.loop\w*Tools\.ts$/.test(name));
  const sources = toolFiles.map(name => [name, readFileSync(join(__dirname, name), 'utf8')] as const);

  it('finds the tool files', () => {
    expect(toolFiles).toEqual(
      expect.arrayContaining(['agentExecutor.loopTicketTools.ts', 'agentExecutor.loopDirectiveTools.ts'])
    );
  });

  it('the only loop write is loop_resume setting the status, and none goes through the settings writer', () => {
    for (const [name, source] of sources) {
      expect(source, name).not.toMatch(/applyLoopConfigPatch|loopConfig'|\/api\/loops/);
      const writes = source.match(/loopRepository\.(?!findByIdAndUserId\b|makeDueNow\b)\w+/g) ?? [];
      expect(writes, name).toEqual(
        name === 'agentExecutor.loopDirectiveTools.ts' ? ['loopRepository.updateForUser'] : []
      );
    }
    // Its patch is nextStatusPatch's (status, nextRunAt, consecutiveFailures, statusReason, autoResume), pinned
    // field by field in agentExecutor.loopDirectiveTools.test.ts.
    const directiveTools = sources.find(([name]) => name === 'agentExecutor.loopDirectiveTools.ts')![1];
    expect(directiveTools).toMatch(/loopRepository\.updateForUser\(\s*target\.id,\s*userId,\s*nextStatusPatch\(/);
  });

  it('no versioned or guardrail field name is set by a tool', () => {
    const guarded = [
      ...LOOP_VERSIONED_FIELDS,
      'mergePolicy',
      'serviceLevelHours',
      'p2RunsPerDay',
      'holdLabels',
      'oversees',
      'coachTrial',
      'coachDismissed',
    ];
    for (const [name, source] of sources) {
      for (const field of guarded) {
        expect(source, `${name} sets ${field}`).not.toMatch(new RegExp(`\\$set:\\s*{[^}]*\\b${field}\\b`));
      }
    }
  });
});
