async function main() {
  const argumentsList = process.argv.slice(2);
  if (argumentsList.includes('--help')) {
    console.log('feedback-notes:scrub [--execute] (default: count remaining legacy inline notes)');
    return;
  }
  if (argumentsList.some(argument => argument !== '--execute')) throw new Error('Unknown feedback note scrub argument');
  const { AdminAuditLogModel, connectDB, mongoose, scrubLegacyFeedbackNotes } = await import('@bike4mind/database');
  const { Config } = await import('@bike4mind/server-utils/utils/config');
  const { Resource } = await import('sst');
  try {
    await connectDB(Config.MONGODB_URI.replace('%STAGE%', Resource.App.stage));
    if (!argumentsList.includes('--execute')) {
      const remaining = await AdminAuditLogModel.countDocuments({
        action: 'feedback.note_added',
        'details.note': { $type: 'string' },
      });
      console.log(`Legacy inline feedback notes remaining: ${remaining}`);
      return;
    }
    let migrated = 0;
    let retired = 0;
    while (true) {
      const result = await scrubLegacyFeedbackNotes();
      migrated += result.migrated;
      retired += result.retired;
      if (result.scanned === 0) break;
    }
    console.log(`Legacy feedback note scrub complete: ${migrated} migrated, ${retired} retired`);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Feedback note scrub failed');
  process.exitCode = 1;
});
