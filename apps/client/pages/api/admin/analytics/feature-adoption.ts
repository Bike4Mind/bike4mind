import { featureAdoptionQuerySchema } from '@client/app/utils/featureAdoption';
import { adminApi } from '@server/middlewares/adminApi';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import {
  FeatureAdoptionCapacityError,
  FeatureAdoptionQueryError,
  getFeatureAdoption,
} from '@server/analytics/featureAdoption';

export default adminApi({ auth: 'jwtOnly', adminPermissions: { GET: 'support:read' } })
  .use(rateLimit({ limit: 30, windowMs: 60_000, bucket: 'admin-feature-adoption' }))
  .get(async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    const parsed = featureAdoptionQuerySchema.safeParse(req.query);
    if (!parsed.success)
      return res.status(400).json({ message: parsed.error.issues[0]?.message ?? 'Invalid adoption query.' });
    try {
      return res.json(await getFeatureAdoption(parsed.data));
    } catch (error) {
      if (error instanceof FeatureAdoptionQueryError) return res.status(400).json({ message: error.message });
      if (error instanceof FeatureAdoptionCapacityError) return res.status(422).json({ message: error.message });
      throw error;
    }
  });

export const config = { api: { externalResolver: true } };
