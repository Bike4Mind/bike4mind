/** Match the canonical spelling used by ObjectId-backed telemetry writers; preserve other identifiers. */
export const normalizeTelemetryUserId = (userId: string): string =>
  /^[a-f0-9]{24}$/i.test(userId) ? userId.toLowerCase() : userId;
