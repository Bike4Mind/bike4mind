import { Session } from '@bike4mind/database/auth';
import { redactSessionsForClient } from '@bike4mind/common';
import { accessibleBy } from '@casl/mongoose';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';

const handler = baseApi().get(
  asyncHandler(async (req, res) => {
    const userId = req.user?.id;
    if (!req.ability?.can('export', Session)) {
      return res.status(403).send({ message: 'Forbidden' });
    }

    const notebooks = await Session.find({ userId, ...accessibleBy(req.ability, 'export').ofType(Session) });

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename=notebooks.json');
    // Strip server-owned fields (e.g. systemPromptText) from the exported sessions
    return res.send(JSON.stringify(redactSessionsForClient(notebooks), null, 2));
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
