import { baseApi } from '@server/middlewares/baseApi';
import { memoryLedgerRepository, memoryPrincipalKeyRepository } from '@bike4mind/database';
import { listPrincipalLedger } from '@bike4mind/server-utils/memory/ledgerMemoryStore';
import { createKeyProvider } from '@bike4mind/server-utils/memory/factCipher';

export default baseApi().get(async (req, res) => {
  const ownerUserId = req.user?.id;
  if (!ownerUserId) return res.status(401).json({ error: 'Authentication required' });
  if (req.query.kind !== 'user') return res.status(400).json({ error: 'Only user ledger reads are supported.' });
  if (req.query.id !== ownerUserId) return res.status(403).json({ error: 'You can only read your own user ledger.' });
  const events = await listPrincipalLedger({
    ledger: memoryLedgerRepository,
    keys: createKeyProvider(memoryPrincipalKeyRepository),
    principal: { kind: 'user', id: ownerUserId },
    ownerUserId,
  });
  const event = events.find(item => item.hash === req.query.hash);
  if (!event) return res.status(404).json({ error: 'Memory event not found.' });
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({ event });
});
