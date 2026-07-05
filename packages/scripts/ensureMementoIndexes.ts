import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { Memento } from '@bike4mind/database';

// Load env vars when running locally
dotenv.config();

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI env var is required');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log('Connected to Mongo. Ensuring memento indexes...');

  await Memento.createIndexes();
  console.log('✅ Memento indexes ensured.');

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Index creation failed:', err);
  process.exit(1);
});
