import { z } from 'zod';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const findById = vi.fn();
const findByEmail = vi.fn();
vi.mock('@bike4mind/database', () => ({
  userRepository: {
    findById: (...args: unknown[]) => findById(...args),
    findByEmail: (...args: unknown[]) => findByEmail(...args),
  },
}));

import { resolveAdminUserRef } from './resolveAdminUserRef';
import { AdminUserRefFields, AdminUserRefSchema, withExactlyOneUserRef } from './schemas';

const USER_ID = '65f1a2b3c4d5e6f708192a3b';

describe('resolveAdminUserRef', () => {
  beforeEach(() => {
    findById.mockReset();
    findByEmail.mockReset();
  });

  it('delegates an email lookup to findByEmail (case-insensitivity is its collation)', async () => {
    const user = { id: USER_ID, email: 'Ada@Example.com' };
    findByEmail.mockResolvedValue(user);

    await expect(resolveAdminUserRef({ email: 'ADA@example.com' })).resolves.toBe(user);
    expect(findByEmail).toHaveBeenCalledWith('ADA@example.com');
    expect(findById).not.toHaveBeenCalled();
  });

  it('finds a user by id', async () => {
    findById.mockResolvedValue({ id: USER_ID });

    await expect(resolveAdminUserRef({ userId: USER_ID })).resolves.toEqual({ id: USER_ID });
  });

  it('returns null for an unknown email', async () => {
    findByEmail.mockResolvedValue(null);

    await expect(resolveAdminUserRef({ email: 'nobody@example.com' })).resolves.toBeNull();
  });
});

describe('AdminUserRefSchema', () => {
  it('rejects both or neither of userId/email', () => {
    expect(AdminUserRefSchema.safeParse({ userId: USER_ID, email: 'a@example.com' }).success).toBe(false);
    expect(AdminUserRefSchema.safeParse({}).success).toBe(false);
    expect(AdminUserRefSchema.safeParse({ userId: USER_ID }).success).toBe(true);
    expect(AdminUserRefSchema.safeParse({ email: 'a@example.com' }).success).toBe(true);
  });

  it('rejects null and empty-string refs as invalid input', () => {
    expect(AdminUserRefSchema.safeParse({ userId: USER_ID, email: null }).success).toBe(false);
    expect(AdminUserRefSchema.safeParse({ userId: USER_ID, email: '' }).success).toBe(false);
  });

  it('tells the model to provide exactly one of userId or email', () => {
    const { properties } = z.toJSONSchema(AdminUserRefSchema, { io: 'input' }) as {
      properties: Record<string, { description?: string }>;
    };

    expect(properties.userId?.description).toContain('exactly one of userId or email');
    expect(properties.email?.description).toContain('exactly one of userId or email');
  });

  it('composes with extra fields through the unrefined base', () => {
    const schema = withExactlyOneUserRef(AdminUserRefFields.extend({ days: z.number().max(90) }));

    expect(schema.safeParse({ email: 'a@example.com', days: 7 }).success).toBe(true);
    expect(schema.safeParse({ days: 7 }).success).toBe(false);
  });
});
