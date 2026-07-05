import { Logger } from '@bike4mind/observability';
import fs, { unlinkSync } from 'fs';
import yauzl from 'yauzl';
import { S3Storage } from '@bike4mind/utils';
import { ImportHistoryAdapters } from './types';
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
) => {
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

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      Logger.globalInstance.log(`Processing batch ${i + 1}/${batches.length} (${batch.length} conversations)`);

      await db.withTransaction(async () => {
        await Promise.all(batch.map(item => processConversationItem(userId, db, item)));
      });

      if (onProgress) {
        const processedCount = (i + 1) * BATCH_SIZE;
        const totalCount = conversationsJson.length;
        const progress = Math.min(Math.round((processedCount / totalCount) * 100), 100);
        const currentStep = `Processing conversations: ${Math.min(processedCount, totalCount)}/${totalCount}`;
        await onProgress(progress, currentStep, Math.min(processedCount, totalCount), totalCount);
      }
    }
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

export const extractFileFromZip = (zipFile: string, filename: string): Promise<string> => {
  return new Promise(resolve =>
    yauzl.open(zipFile, { lazyEntries: true }, (err, zip) => {
      if (err) throw err;
      zip.readEntry();
      zip.on('entry', entry => {
        if (entry.fileName !== filename) {
          zip.readEntry();
          return;
        }
        // Read the conversations.json file into a string, call resolve() when done
        zip.openReadStream(entry, (err, readStream) => {
          if (err) throw err;
          let data = '';
          readStream.on('data', (chunk: string) => (data += chunk));
          readStream.on('end', () => resolve(data));
        });
      });
    })
  );
};
