import {
  IAdminSettingsRepository,
  IFabFileDocument,
  IUserDocument,
  IOrganizationDocument,
  KnowledgeType,
  SupportedFabFileMimeTypes,
  isSupportedFabFileMimeType,
} from '@bike4mind/common';
import {
  BadRequestError,
  checkStorageLimitForFile,
  getFileExtension,
  getMimeTypeByExtension,
  getSettingsMap,
  getSettingsValue,
  secureParameters,
} from '@bike4mind/utils';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';

export const createFabFileSchema = z.object({
  fileName: z.string(),
  mimeType: z.string(),
  fileSize: z.number(),
  type: z.enum(KnowledgeType),
  content: z.union([z.string(), z.instanceof(Buffer)]).optional(),
  organizationId: z.string().optional(),
  /**
   * Content type of the file
   * @example 'text/markdown'
   * @example 'application/pdf'
   * @example 'application/octet-stream' for binary files
   */
  contentType: z.string().optional(),
  public: z.boolean().optional(),
  prefix: z.string().optional(),
  system: z.boolean().optional(),
  tags: z.array(z.object({ name: z.string(), strength: z.number() })).optional(),
  systemPriority: z.number().optional(),
  sessionId: z.string().optional(),
  contentHash: z.string().optional(),
  batchId: z.string().optional(),
  relativePath: z.string().optional(),
});

type CreateFabFileParameters = z.infer<typeof createFabFileSchema>;

export interface CreateFabFileAdapters {
  db: {
    fabFiles: {
      create: (data: Omit<IFabFileDocument, 'id'>) => Promise<IFabFileDocument>;
    };
    adminSettings: Pick<IAdminSettingsRepository, 'findAll' | 'findBySettingNames'>;
    users: {
      findById: (id: string) => Promise<IUserDocument | null>;
    };
    organizations?: {
      findById: (id: string) => Promise<IOrganizationDocument | null>;
    };
  };
  storage: {
    generateSignedUrl: (path: string, expireInSeconds: number, type?: 'get' | 'put') => Promise<string>;
    upload: (
      path: string,
      content: string | Buffer,
      options?: { ContentType?: string; ContentLength?: number }
    ) => Promise<string>;
  };
}

const DEFAULT_MAX_FILE_SIZE = 20;
const DEFAULT_EXPIRE_IN_SECONDS = 3600 * 24 * 5; // 5 days

export const createFabFile = async (
  userId: string,
  parameters: CreateFabFileParameters,
  { db, storage }: CreateFabFileAdapters
) => {
  const params = secureParameters(parameters, createFabFileSchema);
  const user = await db.users.findById(userId);
  if (!user) throw new BadRequestError('User not found');

  const ext = getFileExtension(params.fileName);
  let mimeType = params.mimeType || getMimeTypeByExtension(ext);

  // Only assume plain text for genuinely extension-less files (e.g. LICENSE,
  // Dockerfile). A file that HAS an extension but doesn't resolve to a
  // supported type must be rejected below - never silently coerced to
  // text/plain, which let unsupported binaries like .exe through.
  if (!mimeType && !ext) {
    mimeType = SupportedFabFileMimeTypes.TXT_PLAIN;
  }

  if (!isSupportedFabFileMimeType(mimeType)) {
    throw new BadRequestError(`File type ${mimeType || (ext ? `.${ext}` : 'unknown')} is not supported`);
  }

  let filePath = params.prefix ? `${params.prefix}/` : '';
  filePath += `${uuidv4()}${ext ? `.${ext}` : '.txt'}`; // Ensure file has an extension for storage

  const maxFileSize = getSettingsValue('MaxFileSize', await getSettingsMap(db), DEFAULT_MAX_FILE_SIZE) * 1024 * 1024;

  if (params.fileSize >= maxFileSize) throw new BadRequestError('File size exceeds maximum file size');

  // Check storage limit - use organization limit if organizationId is provided
  await checkStorageLimitForFile(user, params.fileSize, params.organizationId, db.organizations?.findById);

  const buildData: Omit<IFabFileDocument, 'id'> = {
    userId,
    ...params,
    mimeType,
    filePath,
    users: [],
    groups: [],
    isGlobalRead: false,
    isGlobalWrite: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  if (params.content) {
    await storage.upload(filePath, params.content, {
      ContentType: params.contentType,
      ContentLength: params.fileSize,
    });
    // This is server-side ingestion with the bytes already in hand,
    // so historically we minted a working GET url immediately. For an image, that url is
    // servable before the async S3 objectCreated scan has had a chance to run, i.e. before
    // moderationStatus (schema default 'pending') can be trusted - isImageServeable() fails
    // closed on 'pending'/'blocked'. So for images we leave fileUrl unset here; the scan sets
    // moderationStatus to 'clean'/'blocked', and a url is only ever minted on read once clean
    // (see fabFileService/get.ts generateSignedUrl). Non-image content is unaffected.
    if (!mimeType.startsWith('image/')) {
      buildData.fileUrl = await storage.generateSignedUrl(filePath, DEFAULT_EXPIRE_IN_SECONDS, 'get');
      buildData.fileUrlExpireAt = new Date(Date.now() + DEFAULT_EXPIRE_IN_SECONDS * 1000);
    }
  } else {
    buildData.presignedUrl = await storage.generateSignedUrl(filePath, 600, 'put');
  }

  const result = await db.fabFiles.create(buildData);

  return result;
};
