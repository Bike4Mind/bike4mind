import { baseApi } from '@server/middlewares/baseApi';

const handler = baseApi({ auth: false }).get(async (req, res) => {
  return res.status(200).json({ message: 'pong' });
});

export default handler;
