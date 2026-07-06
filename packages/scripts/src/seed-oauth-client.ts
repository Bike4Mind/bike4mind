/**
 * seed-oauth-client.ts
 *
 * Registers an OAuth client in B4M's MongoDB.
 * Run once per product to get a client_id + client_secret.
 *
 * Usage (from repo root):
 *   MONGODB_URI=<uri> CLIENT_NAME=VibesWire REDIRECT_URIS="https://..." \
 *     npx tsx packages/scripts/src/seed-oauth-client.ts
 */

import crypto from 'crypto';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const OAuthClientSchema = new mongoose.Schema(
  {
    clientId: { type: String, required: true, unique: true },
    clientSecretHash: { type: String, required: true },
    name: { type: String, required: true },
    redirectUris: [{ type: String }],
    allowedScopes: { type: [String], default: ['openid', 'email', 'profile'] },
    pkceRequired: { type: Boolean, default: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

const OAuthClient = mongoose.model('OAuthClient', OAuthClientSchema);

async function main() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) throw new Error('MONGODB_URI env var required');

  const clientName = process.env.CLIENT_NAME;
  if (!clientName) throw new Error('CLIENT_NAME env var required (e.g. "VibesWire")');

  const redirectUrisRaw = process.env.REDIRECT_URIS;
  if (!redirectUrisRaw) throw new Error('REDIRECT_URIS env var required (comma-separated)');
  const redirectUris = redirectUrisRaw.split(',').map(u => u.trim());

  await mongoose.connect(mongoUri);

  const existing = await OAuthClient.findOne({ name: clientName });
  if (existing) {
    console.log(`\nClient "${clientName}" already exists:`);
    console.log('  client_id:', existing.clientId);
    console.log('\nDelete it manually if you want to re-seed.\n');
    await mongoose.disconnect();
    process.exit(0);
  }

  const clientId = `b4m_${clientName.toLowerCase().replace(/\s+/g, '_')}_${crypto.randomBytes(4).toString('hex')}`;
  const clientSecret = crypto.randomBytes(32).toString('base64url');
  const clientSecretHash = await bcrypt.hash(clientSecret, 10);

  await OAuthClient.create({
    clientId,
    clientSecretHash,
    name: clientName,
    redirectUris,
    allowedScopes: ['openid', 'email', 'profile'],
    pkceRequired: true,
    isActive: true,
  });

  console.log('\n✅ OAuth client registered!\n');
  console.log('  client_id    :', clientId);
  console.log('  client_secret:', clientSecret);
  console.log(`\nSet these SST secrets in ${clientName}:`);
  console.log(`  sst secret set B4mOAuthClientId "${clientId}"`);
  console.log(`  sst secret set B4mOAuthClientSecret "${clientSecret}"`);
  console.log('\n⚠️  The client_secret will NOT be shown again.\n');

  await mongoose.disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
