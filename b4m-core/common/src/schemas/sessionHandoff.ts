import { z } from 'zod';

export const HandoffDeviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  platform: z.enum(['web', 'desktop', 'ios', 'android']),
  available: z.boolean(),
});
export type HandoffDevice = z.infer<typeof HandoffDeviceSchema>;
export const HandoffDevicesResponseSchema = z.object({ devices: z.array(HandoffDeviceSchema) });
export const SessionHandoffRequestSchema = z
  .object({
    deviceId: z.string().min(1).max(256),
    sessionId: z.string().regex(/^[a-fA-F0-9]{24}$/),
  })
  .strict();
export const SessionHandoffResponseSchema = z.object({ status: z.literal('sent') });
export const SessionHandoffAction = z.object({
  action: z.literal('session_handoff'),
  sessionId: z.string().regex(/^[a-fA-F0-9]{24}$/),
});
export const LiveHandoffRegistrationSchema = z.object({
  platform: z.enum(['web', 'desktop']),
  name: z.string().trim().min(1).max(80),
});
