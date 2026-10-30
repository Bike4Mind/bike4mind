import { z } from 'zod';
import { createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { ApiKey, McpServer, SlackDevWorkspace, User, SecretRotation } from '@bike4mind/database';
import {
  apiKeySecretContext,
  decryptAtRest,
  encryptAtRest,
  isContextBound,
  isEncrypted,
  isSecretsAtRestConfigured,
  mcpEnvSecretContext,
} from '@bike4mind/utils/security';
import { resolveMasterKey, rewrapLegacyDek } from '@bike4mind/server-utils/memory/factCipher';

const slackFields = [
  'slackClientSecret',
  'slackOAuthSigningSecret',
  'slackVerificationToken',
  'appConfigurationToken',
] as const;

/**
 * A row this run could not convert. Rows are independent, so one bad value must not stop the
 * rest of the backfill (the later phases convert different collections, and a rerun would die on
 * the same row); the run reports them all at the end instead.
 */
interface BackfillFailure {
  collection: string;
  id: string;
  field: string;
}

function decryptStored(value: string, failures: BackfillFailure[], where: BackfillFailure): string | null {
  const plaintext = decryptAtRest(value);
  if (value && !plaintext) {
    failures.push(where);
    return null;
  }
  return plaintext;
}

function reportFailures(failures: BackfillFailure[]): void {
  if (failures.length === 0) return;
  const rows = failures.map(failure => `  ${failure.collection}/${failure.id}.${failure.field}`).join('\n');
  throw new Error(
    `Stored credentials remain pending in ${failures.length} value(s); migration is incomplete:\n${rows}`
  );
}

export async function protectStoredCredentials(): Promise<void> {
  if (!isSecretsAtRestConfigured()) throw new Error('Configure SECRET_ENCRYPTION_KEY before credential migration');
  const masterKey = resolveMasterKey();
  if (!masterKey) throw new Error('Configure MEMORY_KEY_SECRET before memory key migration');
  const failures: BackfillFailure[] = [];

  for await (const row of ApiKey.collection.find({})) {
    if (!row.apiKey || isContextBound(row.apiKey)) continue;
    const context = apiKeySecretContext(row.userId, String(row._id));
    const plaintext = decryptStored(row.apiKey, failures, {
      collection: 'ApiKey',
      id: String(row._id),
      field: 'apiKey',
    });
    if (plaintext === null) continue;
    await ApiKey.collection.updateOne(
      { _id: row._id, apiKey: row.apiKey },
      { $set: { apiKey: encryptAtRest(plaintext, context) } }
    );
  }
  for await (const row of McpServer.collection.find({})) {
    const variables = z
      .array(z.object({ key: z.string(), value: z.string() }).passthrough())
      .parse(row.envVariables ?? []);
    if (!variables.some(variable => variable.value && !isContextBound(variable.value))) continue;
    const envVariables = variables.map(variable => {
      if (isContextBound(variable.value)) return variable;
      const plaintext = decryptStored(variable.value, failures, {
        collection: 'McpServer',
        id: String(row._id),
        field: variable.key,
      });
      if (plaintext === null) return variable;
      return {
        ...variable,
        value: encryptAtRest(plaintext, mcpEnvSecretContext(row.userId, String(row._id), variable.key)),
      };
    });
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
    const plaintext = decryptStored(row.previousKey, failures, {
      collection: 'SecretRotation',
      id: String(row._id),
      field: 'previousKey',
    });
    if (plaintext === null) continue;
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

  reportFailures(failures);
}
