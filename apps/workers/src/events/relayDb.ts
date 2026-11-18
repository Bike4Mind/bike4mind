import { connectDB } from '@bike4mind/db-core';
import { Logger } from '@bike4mind/observability';
import { Resource } from 'sst';

/** Connects the alarm relay to MongoDB with every timeout capped, so a slow database cannot hold an alarm back. */
export function connectRelayDb(timeoutMs: number): Promise<unknown> {
  return connectDB(Resource.MONGODB_URI.value.replace('%STAGE%', Resource.App.stage), new Logger(), {
    serverSelectionTimeoutMS: timeoutMs,
    connectTimeoutMS: timeoutMs,
    socketTimeoutMS: timeoutMs,
    timeoutMS: timeoutMs,
    bufferCommands: false,
  });
}
