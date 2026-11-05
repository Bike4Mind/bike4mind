import { Logger } from '@bike4mind/observability';
import fs, { unlinkSync } from 'fs';
import yauzl from 'yauzl';
import { S3Storage } from '@bike4mind/utils';
import { ImportHistoryAdapters, ImportHistoryResult } from './types';
import axios from 'axios';
import { processOpenaiConversation } from './importOpenaiHistory';
import { processClaudeConversation } from './importClaudeHistory';

export enum ImportSource {
  OPENAI = 'OpenAI',
  CLAUDE = 'Claude',
}

/**
 * Import OpenAI history from a zip file.
 *
 * Given a zip file, extract the conversation history from conversations.json and
 * upsert it into the database in bulk.
 *
 * zipFile may be an S3 URL, HTTP URL, or local file path. S3/HTTP URLs are downloaded
 * to a temporary location before processing; a local path is processed directly.
 */
export const importHistory = async (
  parameters: { userId: string; source: ImportSource; zipFile: string },
  adapters: ImportHistoryAdapters
): Promise<ImportHistoryResult> => {
  const { db, onProgress } = adapters;
  const { userId, source = ImportSource.OPENAI, zipFile } = parameters;
  const user = await db.users.findById(userId);
  if (!user) {
    throw new Error(`User not found: ${userId}`);
  }

  let localZipFile = zipFile;
  if (zipFile.match(/^(https?|s3):\/\//)) {
    localZipFile = await downloadFile(zipFile);
  }

  try {
    const conversationsString = await extractFileFromZip(localZipFile, 'conversations.json');
    const conversationsJson = JSON.parse(conversationsString) as unknown[];
    const processConversationItem =
      source === ImportSource.OPENAI
        ? processOpenaiConversation
        : source === ImportSource.CLAUDE
          ? processClaudeConversation
          : null;
    if (!processConversationItem) {
      throw new Error(`Unsupported source: ${source}`);
    }

    // Process conversations in batches of 50, each batch wrapped in a transaction
    const BATCH_SIZE = 50;
    const batches: unknown[][] = [];

    for (let i = 0; i < conversationsJson.length; i += BATCH_SIZE) {
      batches.push(conversationsJson.slice(i, i + BATCH_SIZE));
    }

    Logger.globalInstance.log(
      `Processing ${conversationsJson.length} conversations in ${batches.length} batches of ${BATCH_SIZE}`
    );

    const totalItems = conversationsJson.length;
    let processedItems = 0;

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      Logger.globalInstance.log(`Processing batch ${i + 1}/${batches.length} (${batch.length} conversations)`);

      await db.withTransaction(async () => {
        await Promise.all(batch.map(item => processConversationItem(userId, db, item)));
      });

      processedItems = Math.min((i + 1) * BATCH_SIZE, totalItems);

      if (onProgress) {
        const progress = Math.min(Math.round((processedItems / totalItems) * 100), 100);
        const currentStep = `Processing conversations: ${processedItems}/${totalItems}`;
        await onProgress(progress, currentStep, processedItems, totalItems);
      }
    }

    return { processedItems, totalItems };
  } finally {
    // Remove the temp file if we downloaded one.
    if (localZipFile !== zipFile) {
      unlinkSync(localZipFile);
    }
  }
};

export const downloadFile = async (url: string): Promise<string> => {
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol === 's3:') {
    const s3 = new S3Storage(parsedUrl.hostname);
    const key = parsedUrl.pathname.slice(1);
    Logger.globalInstance.log(parsedUrl.hostname, key);
    const tempFile = `/tmp/${Date.now()}.zip`;
    const buffer = await s3.getContentAsBuffer(key);
    await fs.promises.writeFile(tempFile, buffer);
    return tempFile;
  } else if (parsedUrl.protocol.match(/^https?/)) {
    const { data } = await axios.get(url, { responseType: 'arraybuffer' });
    const tempFile = `/tmp/${Date.now()}.zip`;
    await fs.promises.writeFile(tempFile, data);
    return tempFile;
  } else {
    throw new Error(`Unsupported protocol: ${parsedUrl.protocol || 'none'}`);
  }
};

/**
 * Read one entry of a zip into a UTF-8 string. Rejects when the file is not a readable zip,
 * when the entry cannot be read, or when the archive ends without the entry, so a bad upload
 * fails its import job instead of leaving it processing.
 */
export const extractFileFromZip = (zipFile: string, filename: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    yauzl.open(zipFile, { lazyEntries: true }, (openErr, zip) => {
      if (openErr || !zip) {
        reject(openErr ?? new Error(`Unable to open archive: ${zipFile}`));
        return;
      }
      let found = false;
      const fail = (err: Error) => {
        zip.close();
        reject(err);
      };
      zip.on('error', fail);
      zip.on('end', () => {
        if (!found) fail(new Error(`${filename} not found in archive`));
      });
      zip.on('entry', (entry: yauzl.Entry) => {
        if (entry.fileName !== filename) {
          zip.readEntry();
          return;
        }
        found = true;
        zip.openReadStream(entry, (streamErr, readStream) => {
          if (streamErr || !readStream) {
            fail(streamErr ?? new Error(`Unable to read ${filename} from archive`));
            return;
          }
          // Collect Buffers and decode once so a multi-byte character split across chunks survives.
          const chunks: Buffer[] = [];
          readStream.on('data', (chunk: Buffer) => chunks.push(chunk));
          readStream.on('error', fail);
          readStream.on('end', () => {
            zip.close();
            resolve(Buffer.concat(chunks).toString('utf8'));
          });
        });
      });
      zip.readEntry();
    });
  });
};
