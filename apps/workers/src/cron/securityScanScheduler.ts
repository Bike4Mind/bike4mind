/**
 * Security Scan Scheduler Cron Job
 *
 * Runs every hour to check for scheduled security scans that are due to run.
 * Triggers GitHub Actions workflows for web, code, packages, and secrets scans.
 * Runs cloud scans directly via Lambda function.
 *
 * Schedule: Every hour (rate(1 hour))
 * Enabled: production, dev
 */

import { Context } from 'aws-lambda';
import { Logger } from '@bike4mind/observability';
import { connectDB } from '@bike4mind/database';
import { Resource } from 'sst';
import { securityScanScheduleRepository, SecurityScanType } from '@bike4mind/database';
import { getCooldownStatus } from '@server/security/cooldown';
import {
  triggerGitHubWorkflow,
  getTargetUrlForStage,
  getWorkflowIdForScanType,
} from '@server/integrations/github/githubWorkflowTrigger';
import { handler as runCloudScan } from '@server/security/cloudScan';
import { handler as runWafScan } from '@server/security/wafScan';
import { calculateNextRunTime } from '@server/utils/scheduleCalculator';
import { logAuditEvent, AdminConfigAuditEvents } from '@server/utils/auditLog';

interface ScanResult {
  scanType: SecurityScanType;
  stage: string;
  success: boolean;
  skipped: boolean;
  skipReason?: string;
  error?: string;
}

// Scan types whose dashboard tabs are currently hidden (HIDDEN_TABS in SecurityDashboard.tsx).
// Schedules for these types remain in the DB but are skipped at dispatch time so they
// don't fire GitHub workflows while the tabs are disabled.
const SUSPENDED_SCAN_TYPES = new Set<SecurityScanType>(['code', 'packages', 'secrets']);

async function triggerScan(scanType: SecurityScanType, stage: string, logger: Logger): Promise<void> {
  switch (scanType) {
    case 'web': {
      const targetUrl = getTargetUrlForStage(stage);
      const workflowId = getWorkflowIdForScanType(scanType);

      if (!workflowId) {
        throw new Error('No workflow configured for web scans');
      }

      await triggerGitHubWorkflow({
        workflowId,
        inputs: {
          reason: 'scheduled-weekly',
          target: targetUrl,
          stage,
        },
      });

      logger.info('Triggered web security scan', { stage, targetUrl, workflowId });
      break;
    }

    case 'code': {
      const workflowId = getWorkflowIdForScanType(scanType);

      if (!workflowId) {
        throw new Error('No workflow configured for code scans');
      }

      await triggerGitHubWorkflow({
        workflowId,
        inputs: {
          reason: 'scheduled-weekly',
          stage,
        },
      });

      logger.info('Triggered code security scan', { stage, workflowId });
      break;
    }

    case 'packages': {
      const workflowId = getWorkflowIdForScanType(scanType);

      if (!workflowId) {
        throw new Error('No workflow configured for packages scans');
      }

      await triggerGitHubWorkflow({
        workflowId,
        inputs: {
          reason: 'scheduled-weekly',
          stage,
        },
      });

      logger.info('Triggered packages security scan', { stage, workflowId });
      break;
    }

    case 'secrets': {
      const workflowId = getWorkflowIdForScanType(scanType);

      if (!workflowId) {
        throw new Error('No workflow configured for secrets scans');
      }

      await triggerGitHubWorkflow({
        workflowId,
        inputs: {
          reason: 'scheduled-weekly',
          stage,
        },
      });

      logger.info('Triggered secrets security scan', { stage, workflowId });
      break;
    }

    case 'cloud': {
      // Cloud scans run directly in Lambda, not via GitHub workflow
      await runCloudScan();
      logger.info('Triggered cloud security scan', { stage });
      break;
    }

    case 'waf': {
      // WAF scans run directly in Lambda, not via GitHub workflow
      await runWafScan();
      logger.info('Triggered WAF security scan', { stage });
      break;
    }

    default: {
      const exhaustiveCheck: never = scanType;
      throw new Error(`Unsupported scan type: ${exhaustiveCheck}`);
    }
  }
}

export const handler = async (event: unknown, context: Context) => {
  const logger = new Logger().withMetadata({
    requestId: context.awsRequestId,
    functionName: context.functionName,
  });
  try {
    logger.info('Security scan scheduler: Starting check for due scans', { event });

    await connectDB(Resource.MONGODB_URI.value.replace('%STAGE%', Resource.App.stage), logger);

    const now = new Date();
    logger.info('Current time', { now: now.toISOString() });

    // Find all enabled schedules where nextRunAt <= now
    const dueScans = await securityScanScheduleRepository.findDueScans(now);

    logger.info(`Found ${dueScans.length} scan(s) due to run`, {
      count: dueScans.length,
      scans: dueScans.map(s => ({
        scanType: s.scanType,
        stage: s.stage,
        nextRunAt: s.nextRunAt,
      })),
    });

    if (dueScans.length === 0) {
      logger.info('No scans due at this time');
      return {
        statusCode: 200,
        body: JSON.stringify({
          message: 'No scans due',
          timestamp: now.toISOString(),
        }),
      };
    }

    const results: ScanResult[] = [];

    for (const schedule of dueScans) {
      const { scanType, stage, lastRunAt } = schedule;

      logger.info(`Processing scheduled scan`, {
        scanType,
        stage,
        scheduleId: schedule.id,
        lastRunAt: lastRunAt?.toISOString(),
        nextRunAt: schedule.nextRunAt?.toISOString(),
      });

      try {
        // Skip scan types whose dashboard tabs are currently hidden
        if (SUSPENDED_SCAN_TYPES.has(scanType)) {
          logger.info(`Scan skipped — scan type suspended while dashboard tab is hidden`, {
            scanType,
            stage,
          });

          // Advance nextRunAt so re-enabling the tab doesn't cause an immediate burst-dispatch
          const nextRunAt = calculateNextRunTime(schedule.dayOfWeek, schedule.timeOfDay);
          await securityScanScheduleRepository.updateById(schedule.id, { nextRunAt });

          await logAuditEvent({
            userId: schedule.createdBy,
            action: AdminConfigAuditEvents.SECURITY_SCAN_SCHEDULE_SKIPPED,
            metadata: {
              scanType,
              stage,
              reason: 'suspended',
              scheduleId: schedule.id,
              nextRunAt: nextRunAt.toISOString(),
            },
          });

          results.push({
            scanType,
            stage,
            success: false,
            skipped: true,
            skipReason: `Scan type '${scanType}' is suspended (dashboard tab hidden)`,
          });

          continue;
        }

        // Check cooldown (24 hours)
        const { canRun, hoursRemaining } = getCooldownStatus(lastRunAt);

        if (!canRun) {
          logger.warn(`Scan skipped due to cooldown`, {
            scanType,
            stage,
            hoursRemaining,
          });

          results.push({
            scanType,
            stage,
            success: false,
            skipped: true,
            skipReason: `Cooldown active (${hoursRemaining} hours remaining)`,
          });

          await logAuditEvent({
            userId: schedule.createdBy,
            action: AdminConfigAuditEvents.SECURITY_SCAN_SCHEDULE_SKIPPED,
            metadata: {
              scanType,
              stage,
              reason: 'cooldown',
              hoursRemaining,
              scheduleId: schedule.id,
            },
          });

          // Still update nextRunAt so we try again next week
          const nextRunAt = calculateNextRunTime(schedule.dayOfWeek, schedule.timeOfDay);
          await securityScanScheduleRepository.updateById(schedule.id, {
            nextRunAt,
          });

          continue;
        }

        await triggerScan(scanType, stage, logger);

        const nextRunAt = calculateNextRunTime(schedule.dayOfWeek, schedule.timeOfDay);
        await securityScanScheduleRepository.updateById(schedule.id, {
          lastRunAt: now,
          nextRunAt,
        });

        logger.info(`Successfully triggered ${scanType} scan`, {
          stage,
          nextRunAt: nextRunAt.toISOString(),
        });

        results.push({
          scanType,
          stage,
          success: true,
          skipped: false,
        });

        await logAuditEvent({
          userId: schedule.createdBy,
          action: AdminConfigAuditEvents.SECURITY_SCAN_SCHEDULE_TRIGGERED,
          metadata: {
            scanType,
            stage,
            nextRunAt: nextRunAt.toISOString(),
            scheduleId: schedule.id,
          },
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        logger.error(`Failed to trigger scheduled scan`, {
          scanType,
          stage,
          error: errorMessage,
          scheduleId: schedule.id,
        });

        results.push({
          scanType,
          stage,
          success: false,
          skipped: false,
          error: errorMessage,
        });

        await logAuditEvent({
          userId: schedule.createdBy,
          action: AdminConfigAuditEvents.SECURITY_SCAN_SCHEDULE_FAILED,
          metadata: {
            scanType,
            stage,
            error: errorMessage,
            scheduleId: schedule.id,
          },
        });

        // Still update nextRunAt so future scans aren't blocked by this failure
        try {
          const nextRunAt = calculateNextRunTime(schedule.dayOfWeek, schedule.timeOfDay);
          await securityScanScheduleRepository.updateById(schedule.id, {
            nextRunAt,
          });

          logger.info(`Updated nextRunAt despite failure`, {
            scanType,
            stage,
            nextRunAt: nextRunAt.toISOString(),
          });
        } catch (updateError) {
          logger.error(`Failed to update nextRunAt after scan failure`, {
            scanType,
            stage,
            updateError: updateError instanceof Error ? updateError.message : String(updateError),
          });
        }
      }
    }

    const successful = results.filter(r => r.success).length;
    const skipped = results.filter(r => r.skipped).length;
    const failed = results.filter(r => !r.success && !r.skipped).length;

    logger.info('Security scan scheduler: Completed', {
      total: results.length,
      successful,
      skipped,
      failed,
      results,
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Security scan scheduler completed',
        timestamp: now.toISOString(),
        summary: {
          total: results.length,
          successful,
          skipped,
          failed,
        },
        results,
      }),
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    logger.error('Security scan scheduler: Fatal error', {
      error: errorMessage,
      stack: error instanceof Error ? error.stack : undefined,
    });

    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Security scan scheduler failed',
        message: errorMessage,
        timestamp: new Date().toISOString(),
      }),
    };
  }
};
