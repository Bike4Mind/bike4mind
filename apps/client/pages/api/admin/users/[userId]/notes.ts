import { adminApi } from '@server/middlewares/adminApi';
import { listAdminUserNotes, writeAdminUserNote } from '@server/users/adminUserNotes';

const handler = adminApi({
  auth: 'jwtOnly',
  adminPermissions: { GET: 'support:read', POST: 'users:moderate', PATCH: 'users:moderate' },
})
  .get(async (req, res) => res.json(await listAdminUserNotes(req)))
  .post(async (req, res) => res.status(201).json(await writeAdminUserNote(req)))
  .patch(async (req, res) => res.json(await writeAdminUserNote(req)));

export const config = { api: { externalResolver: true, bodyParser: { sizeLimit: '16kb' } } };
export default handler;
