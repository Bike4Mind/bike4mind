import { baseApi } from '@server/middlewares/baseApi';
import { memoryLedgerRepository, memoryPrincipalKeyRepository, mementoRepository } from '@bike4mind/database';
import { createKeyProvider } from '@bike4mind/server-utils/memory/factCipher';
import { exportPrincipalMemory } from '@bike4mind/server-utils/memory/exportPrincipalMemory';

export default baseApi({ auth: 'jwtOnly' }).get(async (req, res) => {
  const ownerUserId = req.user?.id;
  if (!ownerUserId) return res.status(401).json({ error: 'Authentication required' });
  if (req.query.kind !== 'user') return res.status(400).json({ error: 'Only user memory exports are supported.' });
  if (req.query.id !== ownerUserId) return res.status(403).json({ error: 'You can only export your own user memory.' });
  const exported = await exportPrincipalMemory({
    principal: { kind: 'user', id: ownerUserId },
    ownerUserId,
    ledger: memoryLedgerRepository,
    keys: createKeyProvider(memoryPrincipalKeyRepository),
    mementos: mementoRepository,
  });
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json(exported);
});
