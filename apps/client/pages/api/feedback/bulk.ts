import { adminApi } from '@server/middlewares/adminApi';
import { feedbackBulk } from '@server/feedback/bulk';

const handler = adminApi({ auth: 'jwtOnly', adminPermissions: { POST: 'users:moderate' } }).post(async (req, res) => {
  return res.json(await feedbackBulk(req));
});

export const config = { api: { externalResolver: true, bodyParser: { sizeLimit: '32kb' } } };
export default handler;
