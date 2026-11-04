import { baseApi } from '@server/middlewares/baseApi';
import { bulkDeleteFilesForUser } from '@server/files/bulkDeleteFilesForUser';
import { Request } from 'express';
import { z } from 'zod';
import { FILES_WRITE_SCOPES } from '@server/files/fileScopes';
const BulkDeleteFilesSchema = z.object({
  fileIds: z.array(z.string()).min(1, 'At least one file ID is required'),
});

type BulkDeleteFilesRequest = z.infer<typeof BulkDeleteFilesSchema>;

const handler = baseApi({ requiredScopes: FILES_WRITE_SCOPES })
  /**
   * Bulk delete files by IDs
   */
  .delete(async (req: Request<{}, {}, BulkDeleteFilesRequest>, res) => {
    const { fileIds } = BulkDeleteFilesSchema.parse(req.body);

    const results = await bulkDeleteFilesForUser(req, fileIds);

    const parts: string[] = [];
    if (results.deleted.length > 0) parts.push(`Deleted ${results.deleted.length} file(s)`);
    if (results.unshared.length > 0) parts.push(`Removed ${results.unshared.length} shared file(s) from your library`);
    if (results.notFound.length > 0) parts.push(`${results.notFound.length} file(s) not found`);
    if (results.failed.length > 0) parts.push(`Failed to process ${results.failed.length} file(s)`);
    // Every id lands in exactly one bucket above and the schema requires at least one id, so
    // `parts` is never empty.
    const message = parts.join(', ');

    return res.json({
      message,
      results,
    });
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
