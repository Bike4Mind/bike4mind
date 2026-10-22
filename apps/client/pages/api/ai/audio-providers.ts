/**
 * GET /api/ai/audio-providers - the speech and sound-effect providers this caller can use right now.
 *
 * Unversioned and unpublished: it only decides whether Studio shows its Speech and Sound effects tabs, so API keys
 * never need it (jwtOnly).
 */
import { baseApi } from '@server/middlewares/baseApi';
import { listUsableAudioProviders } from '@server/utils/listUsableAudioProviders';

const handler = baseApi({ auth: 'jwtOnly' }).get(async (req, res) =>
  res.json(await listUsableAudioProviders(req.user!.id))
);

export default handler;
