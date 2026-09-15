import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { listFiles } from './listFiles';
import {
  createMockProjectRepository,
  createMockFabFileRepository,
  createMockUserRepository,
} from '../__tests__/utils/testUtils';
import { IFabFileRepository, IProjectRepository, IUserDocument, IUserRepository } from '@bike4mind/common';
import { BaseStorage } from '@bike4mind/utils';

// listFiles must never mint (or return) a working GET URL for an uploaded image
// that isn't clean yet - mirrors the fabFileService/get.ts gate.
describe('projectService - listFiles', () => {
  const userId = 'user-123';
  const projectId = 'project-123';

  let mockProjectRepo: IProjectRepository;
  let mockFabFileRepo: IFabFileRepository;
  let mockUserRepo: IUserRepository;
  let mockStorage: BaseStorage;

  beforeEach(() => {
    mockProjectRepo = createMockProjectRepository();
    mockFabFileRepo = createMockFabFileRepository();
    mockUserRepo = createMockUserRepository();
    mockStorage = {
      getSignedUrl: vi.fn().mockResolvedValue('https://signed.example.com/fresh-url'),
    } as unknown as BaseStorage;

    (mockUserRepo.findById as Mock).mockResolvedValue({ id: userId } as IUserDocument);
    (mockProjectRepo.shareable.findAccessibleById as Mock).mockResolvedValue({
      id: projectId,
      fileIds: ['file-blocked', 'file-pending', 'file-clean-image', 'file-non-image'],
    });
    (mockFabFileRepo.update as Mock).mockResolvedValue(undefined);
  });

  const adapters = () => ({
    db: {
      projects: mockProjectRepo,
      files: mockFabFileRepo,
      users: mockUserRepo,
    },
    storage: mockStorage,
  });

  it('withholds fileUrl for a blocked image and does not call getSignedUrl for it', async () => {
    (mockFabFileRepo.findAllByIds as Mock).mockResolvedValue([
      {
        id: 'file-blocked',
        filePath: 'fab-files/blocked.png',
        mimeType: 'image/png',
        moderationStatus: 'blocked',
        fileUrl: undefined,
        fileUrlExpireAt: undefined,
      },
    ]);

    const result = await listFiles(userId, { projectId }, adapters());

    expect(result).toHaveLength(1);
    expect(result[0].fileUrl).toBeUndefined();
    expect(result[0].fileUrlExpireAt).toBeUndefined();
    expect(mockStorage.getSignedUrl).not.toHaveBeenCalled();
    expect(mockFabFileRepo.update).not.toHaveBeenCalled();
  });

  it('withholds fileUrl for a pending (undefined moderationStatus) image', async () => {
    (mockFabFileRepo.findAllByIds as Mock).mockResolvedValue([
      {
        id: 'file-pending',
        filePath: 'fab-files/pending.png',
        mimeType: 'image/png',
        moderationStatus: 'pending',
      },
    ]);

    const result = await listFiles(userId, { projectId }, adapters());

    expect(result[0].fileUrl).toBeUndefined();
    expect(mockStorage.getSignedUrl).not.toHaveBeenCalled();
    expect(mockFabFileRepo.update).not.toHaveBeenCalled();
  });

  it('generates and persists a real URL for a clean image', async () => {
    (mockFabFileRepo.findAllByIds as Mock).mockResolvedValue([
      {
        id: 'file-clean-image',
        filePath: 'fab-files/clean.png',
        mimeType: 'image/png',
        moderationStatus: 'clean',
      },
    ]);

    const result = await listFiles(userId, { projectId }, adapters());

    expect(result[0].fileUrl).toBe('https://signed.example.com/fresh-url');
    expect(mockStorage.getSignedUrl).toHaveBeenCalledWith('fab-files/clean.png', 'get', { expiresIn: 3600 });
    expect(mockFabFileRepo.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'file-clean-image', fileUrl: 'https://signed.example.com/fresh-url' })
    );
  });

  // isImageServeable gates on moderationStatus alone now (no mimeType
  // special-case) - a non-image with an unset/pending moderationStatus is held exactly
  // like an image, since the declared mimeType is client-controlled and only corrected by
  // the async S3-event scan.
  it('withholds fileUrl for a non-image file that has not cleared moderation (undefined moderationStatus)', async () => {
    (mockFabFileRepo.findAllByIds as Mock).mockResolvedValue([
      {
        id: 'file-non-image',
        filePath: 'fab-files/doc.pdf',
        mimeType: 'application/pdf',
        moderationStatus: undefined,
      },
    ]);

    const result = await listFiles(userId, { projectId }, adapters());

    expect(result[0].fileUrl).toBeUndefined();
    expect(mockStorage.getSignedUrl).not.toHaveBeenCalled();
  });

  it('generates a real URL for a non-image file once moderationStatus is clean', async () => {
    (mockFabFileRepo.findAllByIds as Mock).mockResolvedValue([
      {
        id: 'file-non-image',
        filePath: 'fab-files/doc.pdf',
        mimeType: 'application/pdf',
        moderationStatus: 'clean',
      },
    ]);

    const result = await listFiles(userId, { projectId }, adapters());

    expect(result[0].fileUrl).toBe('https://signed.example.com/fresh-url');
    expect(mockStorage.getSignedUrl).toHaveBeenCalledWith('fab-files/doc.pdf', 'get', { expiresIn: 3600 });
  });
});
