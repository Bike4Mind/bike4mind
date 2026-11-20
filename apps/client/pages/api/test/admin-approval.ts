import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { isE2EEnabled } from '@bike4mind/server-utils/utils/config';
import { AdminApprovalModel } from '@bike4mind/database';
import { isValidE2eTestSecret } from '@server/auth/e2eTestSecret';
import { Request } from 'express';

interface AdminApprovalTestBody {
  approvalId?: unknown;
  op?: unknown;
}

const E2E_EMAIL_PATTERN = /-e2e@test\.com$/i;

/**
 * Puts a pending approval requested by a test user into a state no API reaches on purpose:
 * `tamper` edits the stored params without their hash, `expire` moves the deadline into the past.
 */
const handler = baseApi({ auth: false }).post(
  asyncHandler(async (req: Request<unknown, unknown, AdminApprovalTestBody>, res) => {
    if (!isE2EEnabled()) {
      return res.status(403).json({ error: 'Test approval edits are only available in development/preview' });
    }
    if (!isValidE2eTestSecret(req.headers['x-e2e-cleanup-secret'])) {
      return res.status(401).json({ error: 'Invalid cleanup secret' });
    }

    const { approvalId, op } = req.body ?? {};
    if (typeof approvalId !== 'string' || !/^[a-f0-9]{24}$/i.test(approvalId) || (op !== 'tamper' && op !== 'expire')) {
      return res.status(400).json({ error: 'approvalId and op (tamper | expire) are required' });
    }

    const approval = await AdminApprovalModel.findOne({ _id: approvalId, status: 'pending' }, 'paramsJson requestedBy')
      .lean<{ paramsJson: string; requestedBy: { email: string } }>()
      .exec();
    if (!approval) return res.status(404).json({ error: 'Pending approval not found' });
    if (!E2E_EMAIL_PATTERN.test(approval.requestedBy.email)) {
      return res.status(400).json({ error: 'Only approvals requested by test users can be edited' });
    }

    const set =
      op === 'tamper' ? { paramsJson: `${approval.paramsJson} ` } : { expiresAt: new Date(Date.now() - 60_000) };
    await AdminApprovalModel.updateOne({ _id: approvalId, status: 'pending' }, { $set: set });
    return res.status(200).json({ approvalId, op });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
