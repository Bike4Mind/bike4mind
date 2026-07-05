import { projectRepository, userRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';

const handler = baseApi().get(async (req, res) => {
  const userId = req.query.id as string;
  const user = await userRepository.findById(userId);

  if (!user) {
    return res.status(200).json([]);
  }

  // All projects the user has access to including own projects
  const projects = await projectRepository.shareable.findAllAccessible(user);
  return res.status(200).json(projects || []);
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
