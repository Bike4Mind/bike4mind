import { type MigrationFile } from './index';
import { CounterLog } from '@bike4mind/database';

const counterNameMapping = {
  login: 'User Login',
  logout: 'User Logout',
  register: 'User Registration',
  landPasswordReset: 'Password Reset Landed',
  passwordResetTokenExpired: 'Password Reset Token Expired',
  passwordReset: 'Password Reset Requested',
  deleteNotebook: 'Session Deleted',
  createNotebook: 'Session Created',
  deleteAllNotebooks: 'All Sessions Deleted',
  aiGenerateImage: 'AI Image Generated',
  notebookSummarization: 'Notebook Summarization Completed',
  heardPrompt: 'Prompt Heard',
  model: 'Model Started',
  autoNamedSession: 'Auto-Named Session Started',
  createImage: 'Image Generation Completed',
  deleteApiKey: 'API Key Deleted',
  setApiKey: 'API Key Set Active',
  createApiKey: 'API Key Created',
  deleteAppFile: 'App File Deleted',
  createAppFile: 'App File Created',
  updateAppFileTags: 'App File Tags Updated',
  createInvite: 'Invite Created',
  deleteInvite: 'Invite Deleted',
  deleteElabsVoice: 'Elabs Voice Deleted',
  setActiveElabsVoice: 'Active Elabs Voice Set',
  createElabsVoice: 'Elabs Voice Created',
  deleteFeedback: 'Feedback Deleted',
  updateFeedback: 'Feedback Updated',
  createFeedback: 'Feedback Created',
  feedbackSent: 'Feedback Sent',
  updateFile: 'File Updated',
  deleteFile: 'File Deleted',
  addFile: 'File Created',
  createFileUrl: 'File URL Created',
  generateFilePresignedUrl: 'File Presigned URL Generated',
  deleteAllFiles: 'All Files Deleted',
  deleteInbox: 'Inbox Deleted',
  createInbox: 'Inbox Created',
  readInbox: 'Inbox Read',
  createRegInvite: 'Registration Invite Created',
  deleteRegInvite: 'Registration Invite Deleted',
  sendReferral: 'Referral Sent',
  updateRegInvite: 'Registration Invite Updated',
  moreCreditsClicked: 'More Credits Button Clicked',
  subscribeClicked: 'Subscribe Button Clicked',
  viewModal: 'Modal Viewed',
  agreeModal: 'Modal Agreed To',
  viewBanner: 'Banner Viewed',
  downloadFailed: 'Download Failed',
};

const migration: MigrationFile = {
  id: 20241211100000,
  name: 'rename counter names in counterlogs',

  up: async () => {
    await updateCounterNames(counterNameMapping);
  },

  down: async () => {
    const reverseMapping = Object.entries(counterNameMapping).reduce(
      (acc, [key, value]) => {
        acc[value] = key;
        return acc;
      },
      {} as Record<string, string>
    );

    await updateCounterNames(reverseMapping, true);
  },
};

const updateCounterNames = async (mapping: Record<string, string>, isReverse: boolean = false) => {
  try {
    for (const [fromName, toName] of Object.entries(mapping)) {
      const oldName = isReverse ? toName : fromName;
      const newName = isReverse ? fromName : toName;

      const result = await CounterLog.updateMany({ counterName: oldName }, { $set: { counterName: newName } }).exec();

      console.log(
        `${result.modifiedCount} counterlogs had their counterName ${isReverse ? 'reverted' : 'renamed'} from '${oldName}' to '${newName}'`
      );
    }
  } catch (error) {
    console.error('Error updating counter names:', error);
    throw error;
  }
};

export default migration;
