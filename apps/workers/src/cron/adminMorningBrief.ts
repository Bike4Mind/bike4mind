import { connectDB } from '@bike4mind/database';
import { Config } from '@bike4mind/server-utils/utils/config';
import { Resource } from 'sst';
import { morningBriefDeps, runMorningBrief } from '@server/admin/morningBrief';

export async function handler(event: { time?: string }) {
  if (process.env.ADMIN_MORNING_BRIEF_ENABLED !== 'true') return { status: 'disabled' };
  const now = new Date(event.time ?? '');
  if (!Number.isFinite(now.getTime())) throw new Error('Scheduled event time is required');
  const environment = Resource.App.stage;
  await connectDB(Config.MONGODB_URI.replace('%STAGE%', environment));
  return {
    status: await runMorningBrief(
      {
        enabled: true,
        environment,
        appUrl: process.env.APP_URL ?? '',
        now,
      },
      morningBriefDeps
    ),
  };
}
