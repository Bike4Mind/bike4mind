import { describe, it, expect, beforeEach, Mock, vi } from 'vitest';
import { create } from './create';
import { IFileTagRepository, TagType } from '@bike4mind/common';

type Repo = Pick<IFileTagRepository, 'create' | 'findByFoldedNameAndUserId'>;

describe('tagService - create', () => {
  const userId = 'test-user-123';
  let mockFileTagRepo: Repo;
  let adapters: { db: { fileTags: Repo } };

  beforeEach(() => {
    mockFileTagRepo = {
      create: vi.fn(),
      // No existing tag unless a test says otherwise.
      findByFoldedNameAndUserId: vi.fn().mockResolvedValue(null),
    };
    adapters = {
      db: {
        fileTags: mockFileTagRepo,
      },
    };
  });

  it('should create a file tag with minimal required parameters', async () => {
    // Arrange
    const params = {
      name: 'Test Tag',
      type: TagType.FILE,
    };

    const expectedInput = {
      userId,
      name: params.name,
      type: params.type,
      fileCount: 0,
      createdAt: expect.any(Date),
      updatedAt: expect.any(Date),
      lastActivityAt: expect.any(Date),
    };

    const mockResponse = { ...expectedInput, id: 'mock-id-123' };
    (mockFileTagRepo.create as Mock).mockResolvedValueOnce(mockResponse);

    // Act
    const result = await create(userId, params, adapters);

    // Assert
    expect(result).toEqual(mockResponse);
    expect(mockFileTagRepo.create).toHaveBeenCalledWith(expectedInput);
  });

  it('should create a file tag with all optional parameters', async () => {
    // Arrange
    const params = {
      name: 'Test Tag',
      type: TagType.FILE,
      icon: '📁',
      description: 'Test Description',
      color: '#FF0000',
    };

    const expectedInput = {
      userId,
      name: params.name,
      type: params.type,
      icon: params.icon,
      description: params.description,
      color: params.color,
      fileCount: 0,
      createdAt: expect.any(Date),
      updatedAt: expect.any(Date),
      lastActivityAt: expect.any(Date),
    };

    const mockResponse = { ...expectedInput, id: 'mock-id-123' };
    (mockFileTagRepo.create as Mock).mockResolvedValueOnce(mockResponse);

    // Act
    const result = await create(userId, params, adapters);

    // Assert
    expect(result).toEqual(mockResponse);
    expect(mockFileTagRepo.create).toHaveBeenCalledWith(expectedInput);
  });

  it('should throw an error for invalid tag type', async () => {
    // Arrange
    const params = {
      name: 'Test Tag',
      type: 'INVALID_TYPE' as TagType,
    };

    // Act & Assert
    await expect(create(userId, params, adapters)).rejects.toThrow('Invalid option');
  });

  // A 4xx, not a 500: the route forces the type so this is unreachable over HTTP, but a direct
  // service call should still refuse like every other guard here rather than reading as an outage.
  it('rejects a session tag as a client error, which this path has no branch for', async () => {
    const attempt = create(userId, { name: 'Test Tag', type: TagType.SESSION }, adapters);
    await expect(attempt).rejects.toThrow('Invalid tag type');
    await expect(attempt).rejects.toMatchObject({ statusCode: 400 });
    expect(mockFileTagRepo.create).not.toHaveBeenCalled();
  });

  // The whole point of the guard: the count aggregate groups on the exact stored name while the
  // file-list filter and the row chips fold case, so a pair differing only by case makes the two
  // disagree permanently. Refusing the second name is what keeps that state unreachable.
  describe('name collisions', () => {
    it('refuses a name the user already holds in a different casing, naming the existing tag', async () => {
      (mockFileTagRepo.findByFoldedNameAndUserId as Mock).mockResolvedValueOnce({
        id: 'existing-1',
        name: 'run2-alpha',
      });

      await expect(create(userId, { name: 'RUN2-Alpha', type: TagType.FILE }, adapters)).rejects.toThrow(
        'you already have a tag named "run2-alpha"'
      );
      expect(mockFileTagRepo.create).not.toHaveBeenCalled();
    });

    it('looks the collision up under the caller id, not globally', async () => {
      await create(userId, { name: 'Test Tag', type: TagType.FILE }, adapters);

      expect(mockFileTagRepo.findByFoldedNameAndUserId).toHaveBeenCalledWith('Test Tag', userId);
    });

    it('allows a name that only shares a prefix with an existing tag', async () => {
      (mockFileTagRepo.create as Mock).mockResolvedValueOnce({ id: 'new-1', name: 'run2-alphabet' });

      await expect(create(userId, { name: 'run2-alphabet', type: TagType.FILE }, adapters)).resolves.toBeTruthy();
    });

    // A 4xx, not the 500 the raw driver error used to produce: errorHandler reads statusCode off an
    // HTTPError and finds none on a MongoServerError.
    it('turns the unique-index duplicate into a client error rather than letting it escape', async () => {
      (mockFileTagRepo.create as Mock).mockRejectedValueOnce(
        Object.assign(new Error('E11000 duplicate key error'), { code: 11000 })
      );

      const attempt = create(userId, { name: 'run2-alpha', type: TagType.FILE }, adapters);
      await expect(attempt).rejects.toThrow('you already have a tag named "run2-alpha"');
      await expect(attempt).rejects.toMatchObject({ statusCode: 400 });
    });

    // The loser must be told the winner's casing, not its own submission - otherwise a racing
    // `RUN2-Alpha` is told it already has a tag named `RUN2-Alpha`, which reads as nonsense.
    it('names the document that won the race, not the losing submission', async () => {
      (mockFileTagRepo.findByFoldedNameAndUserId as Mock)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'winner-1', name: 'run2-alpha' });
      (mockFileTagRepo.create as Mock).mockRejectedValueOnce(
        Object.assign(new Error('E11000 duplicate key error'), { code: 11000 })
      );

      await expect(create(userId, { name: 'RUN2-Alpha', type: TagType.FILE }, adapters)).rejects.toThrow(
        'you already have a tag named "run2-alpha"'
      );
    });

    it('falls back to the submitted name when the winner cannot be re-read', async () => {
      (mockFileTagRepo.create as Mock).mockRejectedValueOnce(
        Object.assign(new Error('E11000 duplicate key error'), { code: 11000 })
      );

      await expect(create(userId, { name: 'RUN2-Alpha', type: TagType.FILE }, adapters)).rejects.toThrow(
        'you already have a tag named "RUN2-Alpha"'
      );
    });

    it('does not swallow an unrelated write failure', async () => {
      (mockFileTagRepo.create as Mock).mockRejectedValueOnce(new Error('connection reset'));

      await expect(create(userId, { name: 'run2-alpha', type: TagType.FILE }, adapters)).rejects.toThrow(
        'connection reset'
      );
    });
  });

  describe('name normalization', () => {
    it('stores the trimmed name and checks the trimmed name for collisions', async () => {
      (mockFileTagRepo.create as Mock).mockResolvedValueOnce({ id: 'new-1' });

      await create(userId, { name: '  Padded Tag  ', type: TagType.FILE }, adapters);

      expect(mockFileTagRepo.findByFoldedNameAndUserId).toHaveBeenCalledWith('Padded Tag', userId);
      expect(mockFileTagRepo.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Padded Tag' }));
    });

    it('rejects a name that is only whitespace', async () => {
      await expect(create(userId, { name: '   ', type: TagType.FILE }, adapters)).rejects.toThrow();
      expect(mockFileTagRepo.create).not.toHaveBeenCalled();
    });
  });

  // Parity with update and remove, which both refuse one: lake membership IS that string on the
  // file, so a hand-made document under the namespace is not an ordinary tag.
  describe('data lake membership tags', () => {
    it.each(['datalake:acme', 'DATALAKE:acme'])('refuses to create %s', async name => {
      await expect(create(userId, { name, type: TagType.FILE }, adapters)).rejects.toThrow(
        'a data lake membership tag cannot be created here'
      );
      expect(mockFileTagRepo.create).not.toHaveBeenCalled();
    });

    it('allows a name that merely starts with the word', async () => {
      (mockFileTagRepo.create as Mock).mockResolvedValueOnce({ id: 'new-1' });

      await expect(create(userId, { name: 'datalakes-todo', type: TagType.FILE }, adapters)).resolves.toBeTruthy();
    });
  });
});
