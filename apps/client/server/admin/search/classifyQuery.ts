import { isIP } from 'node:net';

export function classifyAdminQuery(query: string) {
  if (/^b4m_live_[a-f0-9]{3,7}$/.test(query)) return 'keyPrefix';
  if (isIP(query)) return 'ip';
  if (/^[a-f0-9]{24}$/i.test(query)) return 'id';
  // SHA-256 hex sent to LLM providers as metadata.user_id / safety_identifier.
  if (/^[a-f0-9]{64}$/i.test(query)) return 'providerEndUserId';
  if (/^cus_[a-zA-Z0-9]+$/.test(query)) return 'stripe';
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(query)) return 'email';
  return 'name';
}
