import { IAdminSettingsRepository, IUserDocument, IUserRepository } from '@bike4mind/common';
import { NotFoundError, UnauthorizedError, secureParameters } from '@bike4mind/utils';
import { z } from 'zod';

const adminDeleteUserSchema = z.object({
  id: z.string(),
});

export type AdminDeleteUserParameters = z.infer<typeof adminDeleteUserSchema>;

interface AdminDeleteUserAdapters {
  db: {
    users: IUserRepository;
    adminSettings: IAdminSettingsRepository;
  };
  notify: {
    send: (message: string) => Promise<void>;
  };
  mailer: {
    sendDeleteUserEmail: (sendTo: string[], user: IUserDocument, admin: IUserDocument) => Promise<void>;
  };
}

export const adminDeleteUser = async (
  adminId: string,
  parameters: AdminDeleteUserParameters,
  { db, notify, mailer }: AdminDeleteUserAdapters
) => {
  const { id } = secureParameters(parameters, adminDeleteUserSchema);

  const admin = await db.users.findById(adminId);
  if (!admin?.isAdmin) throw new UnauthorizedError('You are not authorized to delete users');

  const user = await db.users.findById(id);
  if (!user) throw new NotFoundError(`User ${id} not found`);

  await db.users.delete(id);

  const [enableSlackNotification, enableEmailNotification] = await db.adminSettings.findBySettingNames([
    'EnableUserDeletionSlackNotification',
    'EnableUserDeletionEmailNotification',
  ]);

  if (enableSlackNotification) {
    await notify.send(`Admin user: ${adminId} User deleted: *${user.name}* *${user.email}*`);
  }

  if (enableEmailNotification) {
    const feedbackSettings = await db.adminSettings.findAllByTag('feedbackEmail');
    const feedbackEmails = feedbackSettings.map(setting => setting.settingValue);
    await mailer.sendDeleteUserEmail(feedbackEmails, user, admin);
  }

  return user;
};
