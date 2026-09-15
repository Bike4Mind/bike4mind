import { User } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { Request } from 'express';

const handler = baseApi().get<Request<{}, unknown, unknown, { email: string }>>(async (req, res) => {
  const email = req.query.email;

  // Return only the minimal identity fields the share dialog consumes. Echoing
  // the full User document to any signed-in caller would leak every persisted
  // field (organization, settings, etc.) and enable email-existence enumeration.
  const user = await User.findOne({ email }).select('name email');

  return res.json(user ? { id: user.id, name: user.name, email: user.email } : null);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
