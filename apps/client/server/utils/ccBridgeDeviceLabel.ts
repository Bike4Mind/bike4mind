import { z } from 'zod';

// Restrict characters so device labels stay safely renderable in settings
// UI / audit logs without introducing a separate escaping story. Only a
// literal space is allowed as whitespace (`\s` would admit tab and newline).
export const CcBridgeDeviceLabelSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_ .\-+:]+$/, 'deviceLabel can only contain letters, digits, spaces, or . - + : _');
