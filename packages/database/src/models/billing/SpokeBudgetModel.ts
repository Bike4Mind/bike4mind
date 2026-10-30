import mongoose, { Schema } from 'mongoose';

export interface SpokeBudgetLimits {
  daily: number;
  monthly: number;
  userDaily: number;
  userMonthly: number;
}

interface Reservation {
  requestId: string;
  userId: string;
  reserved: number;
  charged: number;
  createdAt: Date;
  state: 'reserved' | 'settled';
}

interface Budget {
  _id: string;
  revision: number;
  reservations: Reservation[];
}

const reservationSchema = new Schema<Reservation>(
  {
    requestId: { type: String, required: true },
    userId: { type: String, required: true },
    reserved: { type: Number, required: true },
    charged: { type: Number, required: true },
    createdAt: { type: Date, required: true },
    state: { type: String, enum: ['reserved', 'settled'], required: true },
  },
  { _id: false }
);

const budgetSchema = new Schema<Budget>(
  {
    _id: { type: String, required: true },
    revision: { type: Number, required: true },
    reservations: { type: [reservationSchema], required: true },
  },
  { versionKey: false }
);

export const SpokeBudgetModel =
  (mongoose.models.SpokeBudget as mongoose.Model<Budget> | undefined) ??
  mongoose.model<Budget>('SpokeBudget', budgetSchema);

const MAX_RESERVATIONS = 1024;
const MAX_ATTEMPTS = 16;

function validateId(value: string): void {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_:-]{1,128}$/.test(value)) {
    throw new Error('Invalid budget identifier');
  }
}

function validateAmount(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid budget amount');
}

export type SpokeBudgetAdmission = 'reserved' | 'settled' | 'budget_exceeded' | 'capacity_exceeded';

/** Internal accounting only; callers must bind client/user IDs through authentication and hold wallet credits separately. */
export class SpokeBudgetRepository {
  constructor(private readonly clock: () => Date = () => new Date()) {}

  private async mutate<T>(clientId: string, change: (budget: Budget) => T): Promise<T> {
    validateId(clientId);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const current = await SpokeBudgetModel.findById(clientId).lean().exec();
      const budget: Budget = current ?? { _id: clientId, revision: 0, reservations: [] };
      const result = change(budget);
      if (!Number.isSafeInteger(budget.revision + 1)) throw new Error('Budget revision exhausted');
      budget.revision += 1;
      if (!current) {
        try {
          await SpokeBudgetModel.create(budget);
          return result;
        } catch (error) {
          if (!(error instanceof mongoose.mongo.MongoServerError) || error.code !== 11000) throw error;
        }
      } else {
        const written = await SpokeBudgetModel.replaceOne(
          { _id: clientId, revision: budget.revision - 1 },
          budget
        ).exec();
        if (written.matchedCount === 1) return result;
      }
    }
    throw new Error('Budget contention; retry with the same request identifier');
  }

  async reserve(params: {
    clientId: string;
    userId: string;
    requestId: string;
    amount: number;
    limits: SpokeBudgetLimits;
  }): Promise<SpokeBudgetAdmission> {
    const { clientId, userId, requestId, amount, limits } = params;
    validateId(userId);
    validateId(requestId);
    validateAmount(amount);
    if (amount === 0) throw new Error('Reservation must be positive');
    for (const limit of [limits.daily, limits.monthly, limits.userDaily, limits.userMonthly]) validateAmount(limit);

    return this.mutate(clientId, budget => {
      const prior = budget.reservations.find(row => row.requestId === requestId);
      if (prior) {
        if (prior.userId !== userId || prior.reserved !== amount) throw new Error('Reservation binding mismatch');
        return prior.state;
      }
      // Terminal entries are retained: forgetting one would let a retry reserve and spend again.
      if (budget.reservations.length >= MAX_RESERVATIONS) return 'capacity_exceeded';
      const now = this.clock();
      if (!Number.isFinite(now.getTime())) throw new Error('Invalid budget clock');
      const day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
      const month = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
      const totals = { daily: 0, monthly: 0, userDaily: 0, userMonthly: 0 };
      for (const row of budget.reservations) {
        const cost = row.state === 'reserved' ? row.reserved : row.charged;
        const time = row.createdAt.getTime();
        if (time >= month) {
          totals.monthly += cost;
          if (row.userId === userId) totals.userMonthly += cost;
        }
        if (time >= day) {
          totals.daily += cost;
          if (row.userId === userId) totals.userDaily += cost;
        }
      }
      if (
        amount > limits.daily - totals.daily ||
        amount > limits.monthly - totals.monthly ||
        amount > limits.userDaily - totals.userDaily ||
        amount > limits.userMonthly - totals.userMonthly
      ) {
        return 'budget_exceeded';
      }
      budget.reservations.push({ requestId, userId, reserved: amount, charged: 0, createdAt: now, state: 'reserved' });
      return 'reserved';
    });
  }

  /** Settle actual cost, or zero only after confirming no provider cost; abandoned holds never auto-release. */
  async settle(params: { clientId: string; userId: string; requestId: string; charged: number }): Promise<void> {
    const { clientId, userId, requestId, charged } = params;
    validateId(userId);
    validateId(requestId);
    validateAmount(charged);
    await this.mutate(clientId, budget => {
      const prior = budget.reservations.find(row => row.requestId === requestId);
      if (!prior || prior.userId !== userId) throw new Error('Unknown reservation');
      if (charged > prior.reserved) throw new Error('Settlement exceeds reservation');
      if (prior.state === 'settled' && charged !== prior.charged) throw new Error('Settlement mismatch');
      prior.charged = charged;
      prior.state = 'settled';
    });
  }
}
