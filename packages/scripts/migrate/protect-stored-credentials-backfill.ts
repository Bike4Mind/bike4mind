import { z } from 'zod';
import { createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { ApiKey, McpServer, SlackDevWorkspace, User, SecretRotation } from '@bike4mind/database';
import { decryptAtRest, encryptAtRest, isEncrypted, isSecretsAtRestConfigured } from '@bike4mind/utils/security';
import { resolveMasterKey, rewrapLegacyDek } from '@bike4mind/server-utils/memory/factCipher';

const slackFields = [
  'slackClientSecret',
  'slackOAuthSigningSecret',
  'slackVerificationToken',
  'appConfigurationToken',
] as const;

function decryptStored(value: string): string {
  const plaintext = decryptAtRest(value);
  if (value && !plaintext) throw new Error('Stored credential cannot be decrypted; migration remains pending');
  return plaintext;
}

export async function protectStoredCredentials(): Promise<void> {
  if (!isSecretsAtRestConfigured()) throw new Error('Configure SECRET_ENCRYPTION_KEY before credential migration');
  const masterKey = resolveMasterKey();
  if (!masterKey) throw new Error('Configure MEMORY_KEY_SECRET before memory key migration');

  for await (const row of ApiKey.collection.find({})) {
    if (!row.apiKey || row.apiKey.startsWith('v2:')) continue;
    const context = JSON.stringify(['ApiKey', row.userId, String(row._id), 'apiKey']);
    await ApiKey.collection.updateOne(
      { _id: row._id, apiKey: row.apiKey },
      { $set: { apiKey: encryptAtRest(decryptStored(row.apiKey), context) } }
    );
  }
  for await (const row of McpServer.collection.find({})) {
    const variables = z
      .array(z.object({ key: z.string(), value: z.string() }).passthrough())
      .parse(row.envVariables ?? []);
    if (!variables.some(variable => variable.value && !variable.value.startsWith('v2:'))) continue;
    const envVariables = variables.map(variable => ({
      ...variable,
      value: variable.value.startsWith('v2:')
        ? variable.value
        : encryptAtRest(
            decryptStored(variable.value),
            JSON.stringify(['mcp', row.userId, String(row._id), variable.key])
          ),
    }));
    await McpServer.collection.updateOne({ _id: row._id, envVariables: row.envVariables }, { $set: { envVariables } });
  }
  for await (const row of SlackDevWorkspace.collection.find({})) {
    const update: Record<string, string> = {};
    for (const field of slackFields) {
      const value = row[field];
      if (value && !isEncrypted(value)) update[field] = encryptAtRest(value);
    }
    if (Object.keys(update).length) {
      const unchanged = Object.fromEntries(
        Object.keys(update).map(field => [field, row[field as (typeof slackFields)[number]]])
      );
      await SlackDevWorkspace.collection.updateOne({ _id: row._id, ...unchanged }, { $set: update });
    }
  }
  for await (const row of User.collection.find({ 'securityQuestions.0': { $exists: true } })) {
    const questions = z
      .array(z.object({ question: z.string(), answer: z.string() }))
      .parse(row.securityQuestions ?? []);
    if (questions.every(question => /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(question.answer))) continue;
    const securityQuestions = await Promise.all(
      questions.map(async question => ({
        question: question.question,
        answer: /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(question.answer)
          ? question.answer
          : await bcrypt.hash(question.answer, 12),
      }))
    );
    await User.collection.updateOne(
      { _id: row._id, securityQuestions: row.securityQuestions },
      { $set: { securityQuestions } }
    );
  }
  for await (const row of SecretRotation.collection.find({ previousKey: { $exists: true } })) {
    if (!row.previousKey) continue;
    const plaintext = decryptStored(row.previousKey);
    const capturedKeyFingerprint = createHash('sha256').update(plaintext).digest('hex');
    const expired = new Date(row.rotatedAt).getTime() <= Date.now() - 24 * 60 * 60 * 1000;
    await SecretRotation.collection.updateOne(
      { _id: row._id, previousKey: row.previousKey },
      {
        $set: {
          capturedKeyFingerprint,
          ...(!expired
            ? { previousKey: isEncrypted(row.previousKey) ? row.previousKey : encryptAtRest(plaintext) }
            : {}),
        },
        ...(expired ? { $unset: { previousKey: '' } } : {}),
      }
    );
  }
  const keys = mongoose.connection.collection<{ dek?: string }>('memoryprincipalkeys');
  for await (const row of keys.find({ dek: { $exists: true } })) {
    if (!row.dek || row.dek.startsWith('enc:')) continue;
    const wrapped = rewrapLegacyDek(row.dek, masterKey);
    await keys.updateOne({ _id: row._id, dek: row.dek }, { $set: { dek: wrapped } });
  }
}
