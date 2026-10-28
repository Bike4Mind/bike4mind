import { baseApi } from '@server/middlewares/baseApi';
import { runNoCardUnlock } from '@server/noCardUnlock/runNoCardUnlock';

const handler = baseApi({ auth: 'jwtOnly' }).post(async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  return res.status(200).json(await runNoCardUnlock('work_email_verified', req.user.id));
});

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
