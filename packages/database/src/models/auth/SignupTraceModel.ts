import mongoose, { Document, Model, model, Schema } from 'mongoose';

/**
 * A deleted account's recent signup, kept so the per-network signup counts (apps/client
 * server/auth/signupNetworkLimits.ts) still see it once purgeDeletedUserData has removed the
 * account's AuthEvent rows. Holds no raw IP: the IP and IPv4 /24 are keyed HMACs, and the account
 * id is hashed too, so a trace only says "some account signed up from this network then".
 */
export interface ISignupTraceDocument extends Document {
  /** Hash of the deleted account id: dedups a re-run purge and counts accounts, not rows. */
  accountHash: string;
  /** The original signup time; the count windows and the TTL both run from it. */
  signedUpAt: Date;
  ipHash: string | null;
  prefixHash: string | null;
  asn: number | null;
}

export type SignupTraceInput = Pick<
  ISignupTraceDocument,
  'accountHash' | 'signedUpAt' | 'ipHash' | 'prefixHash' | 'asn'
>;

type SignupTraceCounts = { ipSignups: number | null; prefixSignups: number | null; asnSignups: number | null };

/**
 * Two days: the longest count window is 24h, plus slack. A count anchored further back than this
 * (the risk collector replaying an old signupMeta) no longer sees deleted accounts.
 */
export const SIGNUP_TRACE_RETENTION_SECONDS = 2 * 24 * 60 * 60;

const SignupTraceSchema = new Schema<ISignupTraceDocument>(
  {
    accountHash: { type: String, required: true },
    signedUpAt: { type: Date, required: true },
    ipHash: { type: String, default: null },
    prefixHash: { type: String, default: null },
    asn: { type: Number, default: null },
  },
  { versionKey: false }
);

SignupTraceSchema.index({ accountHash: 1, signedUpAt: 1 }, { unique: true });
SignupTraceSchema.index({ signedUpAt: 1 }, { expireAfterSeconds: SIGNUP_TRACE_RETENTION_SECONDS });
SignupTraceSchema.index({ ipHash: 1, signedUpAt: 1 });
SignupTraceSchema.index({ prefixHash: 1, signedUpAt: 1 });
SignupTraceSchema.index({ asn: 1, signedUpAt: 1 });

export const SignupTraceModel: Model<ISignupTraceDocument> =
  (mongoose.models.SignupTrace as unknown as Model<ISignupTraceDocument>) ??
  model<ISignupTraceDocument>('SignupTrace', SignupTraceSchema);

class SignupTraceRepository {
  async retain(traces: SignupTraceInput[]): Promise<void> {
    if (traces.length === 0) return;
    await SignupTraceModel.bulkWrite(
      traces.map(trace => ({
        updateOne: {
          filter: { accountHash: trace.accountHash, signedUpAt: trace.signedUpAt },
          update: { $setOnInsert: trace },
          upsert: true,
        },
      }))
    );
  }

  /**
   * Distinct deleted accounts per network in [since, until), mirroring
   * AuthEventRepository.recentDistinctSignups: a null hash/asn is not counted (null), and a
   * truncated scan is unknown (null), never a low count.
   */
  async recentDistinctSignups(input: {
    since: Date;
    until: Date;
    ipHash: string | null;
    prefixHash: string | null;
    asn: number | null;
    maxRows: number;
  }): Promise<SignupTraceCounts> {
    const { since, until, maxRows } = input;
    const count = async (network: Record<string, unknown>): Promise<number | null> => {
      const rows = await SignupTraceModel.find({ ...network, signedUpAt: { $gte: since, $lt: until } })
        .select({ accountHash: 1, _id: 0 })
        .limit(maxRows + 1)
        .maxTimeMS(2000)
        .lean();
      if (rows.length > maxRows) return null;
      return new Set(rows.map(row => row.accountHash)).size;
    };
    const [ipSignups, prefixSignups, asnSignups] = await Promise.all([
      input.ipHash ? count({ ipHash: input.ipHash }) : null,
      input.prefixHash ? count({ prefixHash: input.prefixHash }) : null,
      Number.isSafeInteger(input.asn) && input.asn !== null && input.asn > 0 ? count({ asn: input.asn }) : null,
    ]);
    return { ipSignups, prefixSignups, asnSignups };
  }
}

export const signupTraceRepository = new SignupTraceRepository();
