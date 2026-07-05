import { Request, Response } from 'express';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { ForbiddenError, BadRequestError } from '@server/utils/errors';
import { securityScanScheduleRepository, SecurityScanType } from '@bike4mind/database';
import { resolveStage } from '@server/security/resolveStage';
import { calculateNextRunTime } from '@server/utils/scheduleCalculator';
import { logAuditEvent, AdminConfigAuditEvents } from '@server/utils/auditLog';
import { z } from 'zod';

// Production schedule: Every Sunday at 2:00 AM UTC
const FIXED_DAY_OF_WEEK = 0; // Sunday
const FIXED_TIME_OF_DAY = '02:00'; // 2:00 AM UTC

/** Supported security scan types. */
const ScanTypeSchema = z.enum(['web', 'code', 'packages', 'secrets', 'cloud', 'waf']);

/** POST body: only the enabled flag is toggleable; the schedule is fixed. */
const UpdateScheduleSchema = z.object({
  enabled: z.boolean(),
});

/** Validate stage name to prevent injection; alphanumeric and hyphens only. */
function validateStageName(stage: string): void {
  const stagePattern = /^[a-z0-9-]+$/i;
  if (!stagePattern.test(stage)) {
    throw new BadRequestError('Invalid stage value. Only alphanumeric characters and hyphens are allowed.');
  }
}

/**
 * GET /api/admin/security-scan-schedule/[scanType]
 *
 * Retrieve the current schedule configuration for a specific scan type.
 * Returns the schedule if it exists, or default values if not configured.
 *
 * @param scanType - Type of security scan (web, code, packages, secrets, cloud)
 * @returns Schedule configuration including enabled status and next run time
 */
const handler = baseApi()
  .use(
    rateLimit({
      limit: 30, // 30 requests per minute per user
      windowMs: 60 * 1000,
    })
  )
  .get(async (req: Request, res: Response) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Admin access required');
    }

    let scanType: SecurityScanType;
    try {
      scanType = ScanTypeSchema.parse(req.query.scanType);
    } catch (error) {
      throw new BadRequestError('Invalid scan type. Must be one of: web, code, packages, secrets, cloud, waf');
    }

    const stage = resolveStage();
    validateStageName(stage);

    const schedule = await securityScanScheduleRepository.findByStageAndScanType(stage, scanType);

    if (!schedule) {
      return res.status(200).json({
        enabled: false,
        dayOfWeek: FIXED_DAY_OF_WEEK,
        timeOfDay: FIXED_TIME_OF_DAY,
        nextRunAt: null,
        lastRunAt: null,
        stage,
        scanType,
      });
    }

    return res.status(200).json(schedule);
  })
  /**
   * POST /api/admin/security-scan-schedule/[scanType]
   *
   * Enable or disable automated weekly scans for a specific scan type.
   * When enabling, automatically calculates the next run time (next Sunday at 2AM UTC).
   *
   * @param scanType - Type of security scan
   * @param body.enabled - Whether to enable or disable the schedule
   * @returns Success response with updated schedule
   */
  .post(async (req: Request, res: Response) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Admin access required');
    }

    let scanType: SecurityScanType;
    try {
      scanType = ScanTypeSchema.parse(req.query.scanType);
    } catch (error) {
      throw new BadRequestError('Invalid scan type. Must be one of: web, code, packages, secrets, cloud, waf');
    }

    let validatedData: z.infer<typeof UpdateScheduleSchema>;
    try {
      validatedData = UpdateScheduleSchema.parse(req.body);
    } catch (error) {
      if (error instanceof z.ZodError) {
        const errorMessages = error.issues
          .map(e => {
            const field = e.path.join('.');
            return field ? `${field}: ${e.message}` : e.message;
          })
          .join('; ');
        throw new BadRequestError(errorMessages);
      }
      throw new BadRequestError('Invalid request body');
    }

    const { enabled } = validatedData;

    const stage = resolveStage();
    validateStageName(stage);

    const nextRunAt = enabled ? calculateNextRunTime(FIXED_DAY_OF_WEEK, FIXED_TIME_OF_DAY) : null;

    try {
      const existing = await securityScanScheduleRepository.findByStageAndScanType(stage, scanType);

      if (existing) {
        // Use id property (available via toJSON virtuals)
        const scheduleId = existing.id;
        await securityScanScheduleRepository.updateById(scheduleId, {
          enabled,
          nextRunAt: nextRunAt ?? undefined,
        });

        await logAuditEvent({
          userId: req.user.id,
          action: enabled
            ? AdminConfigAuditEvents.SECURITY_SCAN_SCHEDULE_ENABLED
            : AdminConfigAuditEvents.SECURITY_SCAN_SCHEDULE_DISABLED,
          metadata: {
            scanType,
            stage,
            nextRunAt: nextRunAt?.toISOString() || null,
            previouslyEnabled: existing.enabled,
            scheduleId,
          },
        });
      } else {
        await securityScanScheduleRepository.create({
          stage,
          scanType,
          enabled,
          dayOfWeek: FIXED_DAY_OF_WEEK,
          timeOfDay: FIXED_TIME_OF_DAY,
          nextRunAt: nextRunAt ?? undefined,
          lastRunAt: undefined,
          createdBy: req.user.id,
        });

        await logAuditEvent({
          userId: req.user.id,
          action: AdminConfigAuditEvents.SECURITY_SCAN_SCHEDULE_ENABLED,
          metadata: {
            scanType,
            stage,
            nextRunAt: nextRunAt?.toISOString() || null,
            newSchedule: true,
          },
        });
      }

      return res.status(200).json({
        success: true,
        enabled,
        nextRunAt,
        message: enabled
          ? `Weekly ${scanType} scan scheduled for every Sunday at 2:00 AM UTC`
          : `Weekly ${scanType} scan disabled`,
      });
    } catch (error) {
      console.error('Failed to update security scan schedule', {
        scanType,
        stage,
        enabled,
        error: error instanceof Error ? error.message : error,
      });

      // Don't expose internal error details
      throw new BadRequestError('Failed to update scan schedule. Please try again.');
    }
  });

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
