import { accessibleBy } from '@casl/mongoose';
import { baseApi } from '@server/middlewares/baseApi';
import { User } from '@bike4mind/database';
import { Request } from 'express';

const handler = baseApi().get<Request>(async (req, res) => {
  try {
    const query = accessibleBy(req.ability!, 'read').ofType(User);

    const tagsAggregation = await User.aggregate([
      { $match: query },
      { $unwind: '$tags' },
      { $group: { _id: '$tags', count: { $sum: 1 } } },
      { $sort: { count: -1, _id: 1 } },
      { $project: { tag: '$_id', count: 1, _id: 0 } },
    ]);

    const tags = tagsAggregation.map(item => item.tag);

    return res.json({ tags });
  } catch (error) {
    console.error('Error fetching user tags:', error);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
