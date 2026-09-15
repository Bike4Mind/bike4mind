import { baseApi } from '@client/server/middlewares/baseApi';
import { agentOpsSettingsRepository } from '@bike4mind/database';
import { AgentOpsSettings } from '@bike4mind/database';
import { ForbiddenError } from '@bike4mind/utils';

const handler = baseApi().post(async (req, res) => {
  if (!req.user!.isAdmin) {
    throw new ForbiddenError('Admin access required');
  }

  try {
    const settings = await agentOpsSettingsRepository.getSettings();

    if (!settings) {
      return res.json({
        success: false,
        message: 'No AgentOps settings found',
      });
    }

    // Get the MongoDB document directly to repair it
    const settingsDoc = await AgentOpsSettings.findById(settings.id);

    if (!settingsDoc) {
      return res.json({
        success: false,
        message: 'Settings document not found',
      });
    }

    const repairsMade: string[] = [];

    // Fix any versions with null version numbers
    if (settingsDoc.versions && settingsDoc.versions.length > 0) {
      settingsDoc.versions.forEach((version: any, index: number) => {
        if (version.versionNumber === null || version.versionNumber === undefined) {
          version.versionNumber = index + 1;
          repairsMade.push(`Fixed version ${index + 1} number`);
        }
      });

      // If no version is active, activate the first one
      const hasActiveVersion = settingsDoc.versions.some((v: any) => v.isActive);
      if (!hasActiveVersion && settingsDoc.versions.length > 0) {
        settingsDoc.versions[0].isActive = true;
        settingsDoc.currentVersionNumber = settingsDoc.versions[0].versionNumber;
        repairsMade.push('Activated first version');
      }
    }

    await settingsDoc.save();

    res.json({
      success: true,
      message: 'Database repaired successfully',
      repairsMade,
      settings: settingsDoc.toJSON(),
    });
  } catch (error) {
    console.error('Error repairing AgentOps settings:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to repair AgentOps settings',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default handler;
