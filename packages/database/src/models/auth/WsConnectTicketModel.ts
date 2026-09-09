import mongoose, { Model, Schema, model } from 'mongoose';

const ModelName = 'WsConnectTicket';

/**
 * One-time, short-TTL ticket that authenticates a single web WebSocket
 * `$connect` handshake. Minted by an authed REST endpoint and consumed
 * (burned) at connect, it keeps the long-lived session JWT out of the WS
 * URL query string - which would otherwise be written to every proxy/CDN/
 * access log on the path and be replayable until the JWT expired.
 *
 * `tokenVersion` is captured from the minting session's JWT so the connect
 * handler can re-run the same tokenVersion kill-switch the JWT path enforces.
 */
export interface IWsConnectTicketDoc {
  _id: string;
  /** CSPRNG-random opaque ticket presented as `?ticket=<t>` at `$connect`. */
  ticket: string;
  userId: string;
  /** tokenVersion of the minting JWT; null-safe normalizes to 0 like the JWT path. */
  tokenVersion: number;
  /** Set once on consume; prevents replay. */
  used: boolean;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

interface IWsConnectTicketModel extends Model<IWsConnectTicketDoc> {}

const WsConnectTicketSchema = new Schema<IWsConnectTicketDoc>(
  {
    ticket: { type: String, required: true, unique: true },
    userId: { type: String, required: true },
    tokenVersion: { type: Number, required: true, default: 0 },
    used: { type: Boolean, required: true, default: false },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

// TTL safety net - Mongo sweeps expired tickets even if nothing consumes them.
WsConnectTicketSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const WsConnectTicket: IWsConnectTicketModel =
  (mongoose.models[ModelName] as IWsConnectTicketModel) ||
  model<IWsConnectTicketDoc, IWsConnectTicketModel>(ModelName, WsConnectTicketSchema);

export const wsConnectTicketRepository = {
  async create(doc: Omit<IWsConnectTicketDoc, '_id' | 'used' | 'createdAt' | 'updatedAt'>) {
    const created = await WsConnectTicket.create(doc);
    return created.toObject();
  },

  /**
   * Atomically burn a ticket: returns the row exactly once, `null` on replay
   * (already used), expiry, or an unknown ticket. The `used: false` +
   * `expiresAt` guards live in the query so two concurrent connects race on
   * the single update - only one wins.
   */
  async consume(ticket: string): Promise<IWsConnectTicketDoc | null> {
    return WsConnectTicket.findOneAndUpdate(
      { ticket, used: false, expiresAt: { $gt: new Date() } },
      { $set: { used: true } },
      { new: true }
    ).lean();
  },
};
