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

  it('caps the delegation task at 4000 characters', () => {
    expect(delegationPayloadSchema.safeParse({ targetActorId: 'a1', task: 'a'.repeat(4000) }).success).toBe(true);
    expect(delegationPayloadSchema.safeParse({ targetActorId: 'a1', task: 'a'.repeat(4001) }).success).toBe(false);
  });

  // The registry must point presence at the null-tolerant wrapper, not the bare
  // shape - that mapping is what keeps the write route and the projection from
  // disagreeing about a contentless post. Delegation stays strict: a null
  // payload is not a delegation.
  it('maps presence to a null-tolerant schema and delegation to a strict one', () => {
    expect(knownMachinePayloadSchemas[PRESENCE_PAYLOAD_SCHEMA_NAME].safeParse(null).success).toBe(true);
    expect(knownMachinePayloadSchemas[DELEGATION_PAYLOAD_SCHEMA_NAME].safeParse(null).success).toBe(false);
  });
});
