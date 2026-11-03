import type { INetworkMeta } from '@bike4mind/common';
import { JA4_PATTERN } from '@bike4mind/common';

/**
 * The INetworkMeta fields as Mongoose paths, shared by User.signupMeta and AuthEvent. The
 * `satisfies` makes a field added to INetworkMeta fail to compile here instead of being silently
 * dropped by one of the two schemas.
 */
export const NETWORK_META_FIELDS = {
  ip: { type: String, default: null },
  userAgent: { type: String, default: null },
  asn: { type: Number, default: null },
  asnOrg: { type: String, default: null },
  country: { type: String, default: null },
  isDatacenter: { type: Boolean, default: null },
  ja4: {
    type: String,
    default: null,
    maxlength: 36,
    validate: (value: string | null) => value === null || JA4_PATTERN.test(value),
  },
  wafAnonIp: { type: Boolean, default: null },
  wafBotSignal: { type: Boolean, default: null },
} satisfies Record<keyof INetworkMeta, unknown>;
