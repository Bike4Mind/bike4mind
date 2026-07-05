import * as os from 'os';
import * as path from 'path';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { createTempFile, zipFiles } from '@server/utils/files';
import { accessibleBy } from '@casl/mongoose';
import * as fs from 'fs';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@server/utils/errors';
import { getContentFromFabfile } from '@client/app/utils/fabFileUtils';
import { FabFile } from '@bike4mind/database';
import { isImageServeable } from '@bike4mind/common';

const handler = baseApi().get(
  asyncHandler(async (req, res) => {
    if (!req.ability) throw new ForbiddenError('Unauthorized');
    const exportable = accessibleBy(req.ability, 'export').ofType(FabFile);
    const knowledges = await FabFile.find(exportable);
    const files: string[] = [];
    const outputZipPath = path.join(os.tmpdir(), 'knowledges.zip');

    try {
      for (const knowledge of knowledges) {
        // Never bundle a held (pending scan) or blocked uploaded image into the
        // export zip - non-images and clean images are unaffected.
        if (!isImageServeable(knowledge)) continue;

        const content = await getContentFromFabfile({
          fileUrl: knowledge.fileUrl,
          mimeType: knowledge.mimeType,
        });
        const file = await createTempFile(
          `${Math.floor(Math.random() * 10000)}_${knowledge.fileName}`,
          content as string
        );
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
      // Clean up temp inputs + output zip on both the success and error paths.
      for (const file of files) {
        fs.rmSync(file, { force: true });
      }
      fs.rmSync(outputZipPath, { force: true });
    }
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
