import { describe, expect, it } from 'vitest';
import { makeComponent, makeIncident } from './__fixtures__/statusFixtures';
import { StatusComponentAdminSchema, StatusIncidentAdminSchema } from './schemas.admin';

describe('admin schemas', () => {
  it('accept the documents the fixtures describe', () => {
    expect(StatusComponentAdminSchema.safeParse(makeComponent()).success).toBe(true);
    expect(StatusIncidentAdminSchema.safeParse(makeIncident()).success).toBe(true);
  });

  it('reject a document with a field of the wrong type', () => {
    expect(StatusIncidentAdminSchema.safeParse({ ...makeIncident(), startedAt: 'not a date' }).success).toBe(false);
    expect(StatusComponentAdminSchema.safeParse({ ...makeComponent(), order: 'first' }).success).toBe(false);
  });
});
