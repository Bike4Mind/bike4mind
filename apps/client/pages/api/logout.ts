import { baseApi } from '@server/middlewares/baseApi';
import { signOutBrowserSession } from '@server/auth/signOutBrowserSession';

const handler = baseApi().get(async (req, res) => {
  await signOutBrowserSession(req, res);
  return res.status(200).json({ message: 'Logged out' });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
