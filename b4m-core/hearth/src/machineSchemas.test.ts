import { describe, expect, it } from 'vitest';
import { DELEGATION_PAYLOAD_SCHEMA_NAME, delegationPayloadSchema, knownMachinePayloadSchemas } from './machineSchemas';
import { PRESENCE_PAYLOAD_SCHEMA_NAME } from './presence';

describe('machine payload schemas', () => {
  it('knows exactly the delegation and presence contracts', () => {
    expect(Object.keys(knownMachinePayloadSchemas).sort()).toEqual(
      [DELEGATION_PAYLOAD_SCHEMA_NAME, PRESENCE_PAYLOAD_SCHEMA_NAME].sort()
    );
  });

  it('delegation keeps extra keys and requires a target and a task', () => {
    expect(delegationPayloadSchema.parse({ targetActorId: 'a1', task: 'do it', priority: 'high' })).toEqual({
      targetActorId: 'a1',
      task: 'do it',
      priority: 'high',
    });
    expect(delegationPayloadSchema.safeParse({ task: 'do it' }).success).toBe(false);
    expect(delegationPayloadSchema.safeParse({ targetActorId: '', task: 'do it' }).success).toBe(false);
    expect(delegationPayloadSchema.safeParse({ targetActorId: 'a1', task: '' }).success).toBe(false);
  });
});
