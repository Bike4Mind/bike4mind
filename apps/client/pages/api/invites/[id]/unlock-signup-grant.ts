import { BadRequestError } from '@bike4mind/utils';
import { baseApi } from '@server/middlewares/baseApi';
import { csrfProtection } from '@server/middlewares/csrfProtection';
import { unlockSignupGrantFromOrgInvite } from '@server/credits/orgInviteUnlock';

const handler = baseApi({ auth: 'jwtOnly' })
  .use(csrfProtection())
  .post(async (req, res) => {
    const id = req.query.id;
    if (typeof id !== 'string' || !id) throw new BadRequestError('Invalid invite ID');
    const result = await unlockSignupGrantFromOrgInvite(req.user.id, id);
    return res.json(result);
  });

export default handler;
