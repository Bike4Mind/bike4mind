import * as os from 'os';
import * as path from 'path';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { createTempFile, zipFiles } from '@server/utils/files';
import { accessibleBy } from '@casl/mongoose';
import * as fs from 'fs';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@bike4mind/server-utils/utils/errors';
import { getContentFromFabfile } from '@client/app/utils/fabFileUtils';
import { FabFile } from '@bike4mind/database';
import { isImageServeable } from '@bike4mind/common';
import { FILES_READ_SCOPES } from '@server/files/fileScopes';

const handler = baseApi({ requiredScopes: FILES_READ_SCOPES }).get(
  asyncHandler(async (req, res) => {
    if (!req.ability) throw new ForbiddenError('Unauthorized');
    const exportable = accessibleBy(req.ability, 'export').ofType(FabFile);
    const knowledges = await FabFile.find(exportable);
    const files: string[] = [];
    let tempDir: string | undefined;

    try {
      tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'knowledges-'));
      const outputZipPath = path.join(tempDir, 'knowledges.zip');
      let index = 0;

      for (const knowledge of knowledges) {
        // Never bundle a held (pending scan) or blocked uploaded image into the
        // export zip - non-images and clean images are unaffected.
        if (!isImageServeable(knowledge)) continue;

        const content = await getContentFromFabfile({
          fileUrl: knowledge.fileUrl,
          mimeType: knowledge.mimeType,
        });
        const file = await createTempFile(`${index++}_${knowledge.fileName}`, content as string, tempDir);
        files.push(file);
      }

      await zipFiles(files, outputZipPath);

      // Read the zip into memory so the temp files can be removed immediately
      // after the response; the archives are small (a few knowledge files).
      const zipBuffer = await fs.promises.readFile(outputZipPath);

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="knowledges.zip"');
      res.status(200).send(zipBuffer);
    } finally {
      if (tempDir) {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
      }
    }
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
