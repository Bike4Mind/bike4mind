import { describe, it, expect, vi } from 'vitest';
import { updateUser, applyBaseUserUpdates, type UpdateUserParameters } from './update';
import { IUserDocument } from '@bike4mind/common';
import bcrypt from 'bcryptjs';

describe('applyBaseUserUpdates', () => {
  it('should update user fields without password', () => {
    // Arrange - OAuth user without password
    const oauthUser: IUserDocument = {
      id: 'user1',
      username: 'oauthuser',
      name: 'OAuth User',
      email: 'oauth@example.com',
      password: undefined,
      isAdmin: false,
      authProviders: ['google'],
      storageLimit: 1000,
      currentStorageSize: 0,
      currentCredits: 0,
      tags: [],
      level: 'DemoUser',
      isBanned: false,
      isModerated: false,
      systemFiles: [],
      oauthCredentials: {},
      counters: { counters: [] },
      numReferralsAvailable: 0,
      regInvites: [],
      loginRecords: [],
      showCreditsUsed: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as IUserDocument;

    const params = {
      name: 'Updated OAuth User',
      isAdmin: true,
    };

    // Act
    const result = applyBaseUserUpdates(oauthUser, params);

    // Assert
    expect(result.name).toBe('Updated OAuth User');
    expect(result.isAdmin).toBe(true);
  });

  it('should update password for user with existing password', () => {
    // Arrange
    const hashedPassword = bcrypt.hashSync('oldpassword', 10);
    const regularUser: IUserDocument = {
      id: 'user2',
      username: 'regularuser',
      name: 'Regular User',
      email: 'regular@example.com',
      password: hashedPassword,
      isAdmin: false,
      authProviders: [],
      storageLimit: 1000,
      currentStorageSize: 0,
      currentCredits: 0,
      tags: [],
      level: 'DemoUser',
      isBanned: false,
      isModerated: false,
      systemFiles: [],
      oauthCredentials: {},
      counters: { counters: [] },
      numReferralsAvailable: 0,
      regInvites: [],
      loginRecords: [],
      showCreditsUsed: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as IUserDocument;

    const params = {
      password: 'newpassword',
    };

    // Act
    const result = applyBaseUserUpdates(regularUser, params);

    // Assert
    expect(result.password).toBeDefined();
    expect(result.password).not.toBe(hashedPassword);
    expect(bcrypt.compareSync('newpassword', result.password!)).toBe(true);
  });

  it('should throw error when trying to set password for OAuth user', () => {
    // Arrange - OAuth user without password
    const oauthUser: IUserDocument = {
      id: 'user3',
      username: 'oauthuser2',
      name: 'OAuth User 2',
      email: 'oauth2@example.com',
      password: undefined,
      isAdmin: false,
      authProviders: ['google'],
      storageLimit: 1000,
      currentStorageSize: 0,
      currentCredits: 0,
      tags: [],
      level: 'DemoUser',
      isBanned: false,
      isModerated: false,
      systemFiles: [],
      oauthCredentials: {},
      counters: { counters: [] },
      numReferralsAvailable: 0,
      regInvites: [],
      loginRecords: [],
      showCreditsUsed: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as IUserDocument;

    const params = {
      password: 'newpassword',
    };

    // Act & Assert
    expect(() => applyBaseUserUpdates(oauthUser, params)).toThrow(
      'User does not have a password. Cannot update password for OAuth users.'
    );
  });

  it('should throw (not crash) when setting a password on a passwordless shell account (password: null)', () => {
    // Shell/provisioned accounts now store password: null (not a fake hash).
    // The password-change path must reject cleanly, never bcrypt.compare against null.
    const shellUser: IUserDocument = {
      id: 'user-shell',
      username: 'shelluser',
      name: 'Shell User',
      email: 'shell@example.com',
      password: null,
      isAdmin: false,
      authProviders: [],
      storageLimit: 1000,
      currentStorageSize: 0,
      currentCredits: 0,
      tags: [],
      level: 'DemoUser',
      isBanned: false,
      isModerated: false,
      systemFiles: [],
      oauthCredentials: {},
      counters: { counters: [] },
      numReferralsAvailable: 0,
      regInvites: [],
      loginRecords: [],
      showCreditsUsed: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as IUserDocument;

    expect(() => applyBaseUserUpdates(shellUser, { password: 'newpassword' })).toThrow(
      'User does not have a password. Cannot update password for OAuth users.'
    );
  });

  it('should throw error when new password matches old password', () => {
    // Arrange
    const hashedPassword = bcrypt.hashSync('samepassword', 10);
    const regularUser: IUserDocument = {
      id: 'user4',
      username: 'regularuser2',
      name: 'Regular User 2',
      email: 'regular2@example.com',
      password: hashedPassword,
      isAdmin: false,
      authProviders: [],
      storageLimit: 1000,
      currentStorageSize: 0,
      currentCredits: 0,
      tags: [],
      level: 'DemoUser',
      isBanned: false,
      isModerated: false,
      systemFiles: [],
      oauthCredentials: {},
      counters: { counters: [] },
      numReferralsAvailable: 0,
      regInvites: [],
      loginRecords: [],
      showCreditsUsed: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as IUserDocument;

    const params = {
      password: 'samepassword',
    };

    // Act & Assert
    expect(() => applyBaseUserUpdates(regularUser, params)).toThrow(
      'New password cannot be the same as the old password'
    );
  });

  it('should update multiple fields at once', () => {
    // Arrange
    const oauthUser: IUserDocument = {
      id: 'user5',
      username: 'oauthuser3',
      name: 'OAuth User 3',
      email: 'oauth3@example.com',
      password: undefined,
      isAdmin: false,
      authProviders: ['google'],
      storageLimit: 1000,
      currentStorageSize: 0,
      currentCredits: 0,
      tags: [],
      level: 'DemoUser',
      isBanned: false,
      isModerated: false,
      systemFiles: [],
      oauthCredentials: {},
      counters: { counters: [] },
      numReferralsAvailable: 0,
      regInvites: [],
      loginRecords: [],
      showCreditsUsed: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as IUserDocument;

    const params = {
      name: 'Updated Name',
      email: 'newemail@example.com',
      phone: '+1234567890',
      preferredLanguage: 'en',
    };

    // Act
    const result = applyBaseUserUpdates(oauthUser, params);

    // Assert
    expect(result.name).toBe('Updated Name');
    expect(result.email).toBe('newemail@example.com');
    expect(result.phone).toBe('+1234567890');
    expect(result.preferredLanguage).toBe('en');
  });

  it('should handle null password parameter without error', () => {
    // Arrange - OAuth user
    const oauthUser: IUserDocument = {
      id: 'user6',
      username: 'oauthuser4',
      name: 'OAuth User 4',
      email: 'oauth4@example.com',
      password: undefined,
      isAdmin: false,
      authProviders: ['google'],
      storageLimit: 1000,
      currentStorageSize: 0,
      currentCredits: 0,
      tags: [],
      level: 'DemoUser',
      isBanned: false,
      isModerated: false,
      systemFiles: [],
      oauthCredentials: {},
      counters: { counters: [] },
      numReferralsAvailable: 0,
      regInvites: [],
      loginRecords: [],
      showCreditsUsed: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as IUserDocument;

    const params = {
      name: 'Updated Name',
      password: null,
    };

    // Act
    const result = applyBaseUserUpdates(oauthUser, params);

    // Assert
    expect(result.name).toBe('Updated Name');
    expect(() => applyBaseUserUpdates(oauthUser, params)).not.toThrow();
  });
});

describe('updateUser', () => {
  it('should update OAuth user without password', async () => {
    // Arrange
    const oauthUser: IUserDocument = {
      id: 'user1',
      username: 'oauthuser',
      name: 'OAuth User',
      email: 'oauth@example.com',
      password: undefined,
      isAdmin: false,
      authProviders: ['google'],
      storageLimit: 1000,
      currentStorageSize: 0,
      currentCredits: 0,
      tags: [],
      level: 'DemoUser',
      isBanned: false,
      isModerated: false,
      systemFiles: [],
      oauthCredentials: {},
      counters: { counters: [] },
      numReferralsAvailable: 0,
      regInvites: [],
      loginRecords: [],
      showCreditsUsed: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as IUserDocument;

    const mockUserRepository = {
      findByIdWithPassword: vi.fn().mockResolvedValue(oauthUser),
      update: vi.fn().mockResolvedValue(oauthUser),
    };

    const params = {
      name: 'Updated OAuth User',
    };

    // Act
    const result = await updateUser('user1', params, {
      db: { users: mockUserRepository as any },
    });

    // Assert
    expect(mockUserRepository.findByIdWithPassword).toHaveBeenCalledWith('user1');
    expect(mockUserRepository.update).toHaveBeenCalled();
    expect(result.name).toBe('Updated OAuth User');
  });

  it('should throw error when user not found', async () => {
    // Arrange
    const mockUserRepository = {
      findByIdWithPassword: vi.fn().mockResolvedValue(null),
      update: vi.fn(),
    };

    // Act & Assert
    await expect(
      updateUser('nonexistent', { name: 'Test' }, { db: { users: mockUserRepository as any } })
    ).rejects.toThrow('User not found');
  });

  it('strips `tags` from a non-admin self-update — cannot self-assign access-control tags (#9342)', async () => {
    // A non-admin updating their own profile must not be able to set `tags`, which
    // feed the entitlement registry (tag->key passthrough) and dev-bypass gates.
    // `tags` was removed from updateUserSchema, so secureParameters drops it here.
    const user = {
      id: 'user-tags',
      username: 'normaluser',
      name: 'Normal User',
      email: 'normal@example.com',
      password: undefined,
      isAdmin: false,
      tags: ['Customer'],
      level: 'DemoUser',
      systemFiles: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as IUserDocument;

    const mockUserRepository = {
      findByIdWithPassword: vi.fn().mockResolvedValue(user),
      update: vi.fn().mockImplementation((u: IUserDocument) => Promise.resolve(u)),
    };

    // Malicious raw body: a legitimate field plus arbitrary access-control tags a
    // non-admin is trying to self-grant. The strip is value-agnostic, so the test uses
    // neutral placeholders rather than real entitlement keys - re-typing those keys
    // outside the entitlement registry is exactly what the libonc module-boundary guard
    // forbids, and the assertion is identical either way. Cast via `unknown` (repo
    // avoids `any`) since `tags` is no longer part of UpdateUserParameters.
    const result = await updateUser(
      'user-tags',
      { name: 'Renamed', tags: ['injected-admin', 'gated-product:pro'] } as unknown as UpdateUserParameters,
      { db: { users: mockUserRepository as any } }
    );

    // The benign field is applied; the injected tags are stripped (untouched).
    expect(result.name).toBe('Renamed');
    expect(result.tags).toEqual(['Customer']);
    const persisted = mockUserRepository.update.mock.calls[0][0] as IUserDocument;
    expect(persisted.tags).toEqual(['Customer']);
  });
});
