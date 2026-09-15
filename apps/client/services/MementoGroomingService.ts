import { MementoTier } from '@bike4mind/common';
import { Memento } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';

export const MEMORY_LIMITS = {
  DEFAULT_MAX_TOTAL_CHARS: 32000,
  WARNING_THRESHOLD: 0.75,
  DANGER_THRESHOLD: 0.9,
};

const TARGET_THRESHOLDS = {
  HOT_TARGET: 0.8, // Target to reduce to 80% after grooming
  HOT_TRIGGER: 0.9, // Trigger grooming when HOT tier reaches 90%
  WARM_TARGET: 0.8, // Target to reduce WARM to 80% after grooming
  WARM_TRIGGER: 0.9, // Trigger grooming when WARM tier reaches 90%
};

export const calculateMementoSize = (memento: any): number => {
  return (memento.summary?.length || 0) + (memento.tags?.join('').length || 0);
};

export const calculateTotalMementoSize = (mementos: any[]): number => {
  return mementos.reduce((total, memento) => total + calculateMementoSize(memento), 0);
};

export const calculateHotMementoSize = (mementos: any[]): number => {
  return mementos
    .filter(m => m.tier === MementoTier.HOT)
    .reduce((total, memento) => total + calculateMementoSize(memento), 0);
};

// Pending groom operations by userId
const pendingGrooms = new Map<string, boolean>();

export class MementoGroomingService {
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Checks if a grooming operation is needed and schedules one if necessary
   */
  async checkAndScheduleGrooming(
    userId: string,
    maxTotalChars: number = MEMORY_LIMITS.DEFAULT_MAX_TOTAL_CHARS,
    forceImmediate: boolean = false
  ): Promise<void> {
    if (!forceImmediate && pendingGrooms.get(userId)) {
      this.logger.info('Grooming already scheduled for user', { userId });
      return;
    }

    try {
      const mementos = await Memento.findByUserId(userId);
      const hotSize = calculateHotMementoSize(mementos);
      const hotUsagePercent = hotSize / maxTotalChars;

      if (hotUsagePercent >= TARGET_THRESHOLDS.HOT_TRIGGER || forceImmediate) {
        this.logger.info('Scheduling memento grooming', {
          userId,
          hotUsagePercent: hotUsagePercent.toFixed(2),
          hotMemorySize: hotSize,
          totalMementos: mementos.length,
          hotMementos: mementos.filter(m => m.tier === MementoTier.HOT).length,
          forceImmediate,
        });

        pendingGrooms.set(userId, true);

        if (forceImmediate) {
          try {
            await this.performGrooming(userId, maxTotalChars);
          } finally {
            pendingGrooms.set(userId, false);
          }
        } else {
          setTimeout(() => {
            this.performGrooming(userId, maxTotalChars)
              .catch(e => this.logger.error('Error during grooming operation', e))
              .finally(() => pendingGrooms.set(userId, false));
          }, 0);
        }
      }
    } catch (error) {
      this.logger.error('Error checking memento grooming needs', error);
      if (forceImmediate) {
        pendingGrooms.set(userId, false);
        throw error; // re-throw for synchronous callers
      }
    }
  }

  /**
   * Force immediate synchronous grooming - used for memory limit enforcement
   */
  async forceImmediateGrooming(
    userId: string,
    maxTotalChars: number = MEMORY_LIMITS.DEFAULT_MAX_TOTAL_CHARS
  ): Promise<void> {
    this.logger.info('Forcing immediate synchronous grooming', { userId });

    pendingGrooms.set(userId, true);

    try {
      await this.performGrooming(userId, maxTotalChars);
      this.logger.info('Immediate grooming completed successfully', { userId });
    } finally {
      pendingGrooms.set(userId, false);
    }
  }

  /**
   * Perform the actual grooming operation
   */
  private async performGrooming(userId: string, maxTotalChars: number): Promise<void> {
    this.logger.info('Starting memento grooming', { userId });

    try {
      await this.groomWarmToCold(userId);
      await this.groomHotToWarm(userId, maxTotalChars);

      this.logger.info('Completed memento grooming operation', { userId });
    } catch (error) {
      this.logger.error('Error during memento grooming', error);
      throw error;
    }
  }

  /**
   * Move the lowest-value WARM mementos to COLD tier
   */
  private async groomWarmToCold(userId: string): Promise<void> {
    const warmMementos = await Memento.find({
      userId,
      tier: MementoTier.WARM,
    }).sort({ weight: 1, lastAccessedAt: 1 }); // lowest weight first, then oldest

    if (warmMementos.length === 0) {
      this.logger.info('No WARM mementos to groom', { userId });
      return;
    }

    // Downgrade ~15% of WARM mementos to COLD
    const targetCount = Math.ceil(warmMementos.length * 0.15);

    if (targetCount === 0) {
      return;
    }

    const memosToDowngrade = warmMementos.slice(0, targetCount);

    this.logger.info('Downgrading WARM mementos to COLD', {
      userId,
      count: memosToDowngrade.length,
      totalWarm: warmMementos.length,
    });

    const downgradeIds = memosToDowngrade.map(m => m._id);
    await Memento.updateMany({ _id: { $in: downgradeIds } }, { $set: { tier: MementoTier.COLD } });
  }

  /**
   * Move HOT mementos to WARM tier until we reach target usage
   */
  private async groomHotToWarm(userId: string, maxTotalChars: number): Promise<void> {
    const hotMementos = await Memento.find({
      userId,
      tier: MementoTier.HOT,
    }).sort({ weight: 1, lastAccessedAt: 1 }); // lowest weight first, then oldest

    if (hotMementos.length === 0) {
      this.logger.info('No HOT mementos to groom', { userId });
      return;
    }

    const currentHotSize = calculateHotMementoSize(hotMementos);
    const targetSize = maxTotalChars * TARGET_THRESHOLDS.HOT_TARGET;

    if (currentHotSize <= targetSize) {
      this.logger.info('HOT tier already below target, no grooming needed', {
        userId,
        currentHotSize,
        targetSize,
      });
      return;
    }

    const sizeToRecover = currentHotSize - targetSize;
    let recoveredSize = 0;
    let downgradedCount = 0;
    const memosToDowngrade: string[] = [];

    for (const memo of hotMementos) {
      if (recoveredSize >= sizeToRecover) {
        break;
      }

      const memoSize = calculateMementoSize(memo);
      recoveredSize += memoSize;
      memosToDowngrade.push(memo._id.toString());
      downgradedCount++;
    }

    this.logger.info('Downgrading HOT mementos to WARM', {
      userId,
      count: downgradedCount,
      recoveredSize,
      targetRecovery: sizeToRecover,
      totalHot: hotMementos.length,
    });

    await Memento.updateMany({ _id: { $in: memosToDowngrade } }, { $set: { tier: MementoTier.WARM } });
  }
}
