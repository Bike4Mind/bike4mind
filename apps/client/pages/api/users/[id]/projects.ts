import { projectRepository, userRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { ForbiddenError } from '@server/utils/errors';

const handler = baseApi().get(async (req, res) => {
  const userId = req.query.id as string;

  // findAllAccessible returns the target user's owned + shared-to-them projects,
  // so only the user themselves or an admin may list them. A profile-scoped
  // response for cross-user views (public "Joined Projects") is a tracked follow-up.
  if (userId !== req.user.id && !req.user.isAdmin) {
    throw new ForbiddenError("Not authorized to view this user's projects");
  }

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
