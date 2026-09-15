import { baseApi } from '@server/middlewares/baseApi';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { BadRequestError, ForbiddenError, NotFoundError } from '@server/utils/errors';
import { subscriberRepository, registrationInviteRepository } from '@bike4mind/database';
import { generateCode } from '@server/managers/regInviteManager';
import { RegInviteStatusType, requireEnv } from '@bike4mind/common';
import { EmailEvents } from '@server/utils/eventBus';
import { getLogoUrl, buildEmailLogoImg } from '@server/utils/mailer/emailHelpers';
import { z } from 'zod';

const generateInviteSchema = z.object({
  subscriberId: z.string().min(1, 'Subscriber ID is required'),
  email: z.email('Valid email is required'),
  firstName: z.string().min(1, 'First name is required'),
  lastName: z.string().min(1, 'Last name is required'),
  startingCredits: z.number().min(0, 'Starting credits must be non-negative').prefault(500),
  startingStorage: z.number().min(0, 'Starting storage must be non-negative').prefault(1000),
  emailBody: z.string().optional(),
  unlimitedUse: z.boolean().optional().prefault(false),
  expiresAt: z.string().optional(),
});

const handler = baseApi().post(
  asyncHandler<{}, unknown, z.infer<typeof generateInviteSchema>>(async (req, res) => {
    if (!req.user?.isAdmin) {
      throw new ForbiddenError('Admin access required');
    }

    const validatedData = generateInviteSchema.parse(req.body);
    const {
      subscriberId,
      email,
      firstName,
      lastName,
      startingCredits,
      startingStorage,
      emailBody,
      unlimitedUse,
      expiresAt,
    } = validatedData;

    const subscriber = await subscriberRepository.findById(subscriberId);
    if (!subscriber) {
      throw new NotFoundError('Subscriber not found');
    }

    if (subscriber.inviteGenerated) {
      throw new BadRequestError('Invite code already generated for this subscriber');
    }

    const existingInvite = await registrationInviteRepository.findOne({ email });
    if (existingInvite) {
      throw new BadRequestError('An invite code already exists for this email address');
    }

    const inviteCode = generateCode();

    const expiresAtDate = expiresAt ? new Date(expiresAt) : undefined;
    if (expiresAtDate && Number.isNaN(expiresAtDate.getTime())) {
      throw new BadRequestError('Invalid expiration date');
    }

    try {
      const registrationInvite = await registrationInviteRepository.create({
        userId: req.user.id, // Admin who created the invite
        email: email,
        code: inviteCode,
        status: RegInviteStatusType.open,
        unlimitedUse,
        ...(expiresAtDate ? { expiresAt: expiresAtDate } : {}),
        usageHistory: [],
        // Credits/storage are recorded here for reference; applied when the user registers
        title: `Invite for ${firstName} ${lastName}`,
        description: `Generated from subscriber request. Credits: ${startingCredits}, Storage: ${startingStorage}MB`,
      });

      await subscriberRepository.markInviteGenerated(
        subscriberId,
        inviteCode,
        req.user.id,
        startingCredits,
        startingStorage
      );

      const brand = process.env.APP_NAME || '';
      const logoUrl = getLogoUrl();
      const registrationLink = `${requireEnv('APP_URL', process.env.APP_URL)}/register?code=${inviteCode}`;

      const defaultEmailBody = `Hi ${firstName},

Thank you for your interest${brand ? ` in ${brand}` : ''}! We're excited to welcome you to our platform.

Your account will be set up with:
• ${startingCredits.toLocaleString()} credits to get you started
• ${startingStorage} MB of storage space

Use your invite code below to complete your registration and start exploring our AI-powered tools.

Welcome aboard!

${brand ? `The ${brand} Team` : 'The Team'}`;

      const finalEmailBody = `
        <!DOCTYPE html>
        <html>
        <head>
          <style>
            body {
              font-family: Arial, sans-serif;
              line-height: 1.6;
              color: #333333;
              max-width: 600px;
              margin: 0 auto;
              padding: 20px;
            }
            .header {
              text-align: center;
              margin-bottom: 30px;
            }
            .logo {
              max-width: 200px;
              height: auto;
            }
            .invite-code {
              background-color: #f5f5f5;
              border: 2px dashed #007bff;
              padding: 20px;
              text-align: center;
              margin: 20px 0;
              border-radius: 8px;
            }
            .code {
              font-size: 24px;
              font-weight: bold;
              color: #007bff;
              letter-spacing: 2px;
            }
            .cta-button {
              display: inline-block;
              background-color: #007bff;
              color: white;
              padding: 15px 30px;
              text-decoration: none;
              border-radius: 8px;
              font-weight: bold;
              margin: 20px 0;
            }
            .benefits {
              background-color: #f8f9fa;
              padding: 20px;
              border-radius: 8px;
              margin: 20px 0;
            }
            .benefit-item {
              margin: 10px 0;
              padding-left: 20px;
              position: relative;
            }
            .benefit-item::before {
              content: "✓";
              position: absolute;
              left: 0;
              color: #28a745;
              font-weight: bold;
            }
          </style>
        </head>
        <body>
          <div class="header">
            ${buildEmailLogoImg(brand, logoUrl)}
          </div>

          <div>
            ${(emailBody || defaultEmailBody).replace(/\n/g, '<br/>')}
          </div>

          <div class="invite-code">
            <p><strong>Your Invite Code:</strong></p>
            <div class="code">${inviteCode}</div>
          </div>

          <div style="text-align: center;">
            <a href="${registrationLink}" class="cta-button">Complete Your Registration</a>
          </div>

          <div class="benefits">
            <h3>What's included in your account:</h3>
            <div class="benefit-item">${startingCredits.toLocaleString()} AI processing credits</div>
            <div class="benefit-item">${startingStorage} MB of secure storage</div>
            <div class="benefit-item">Access to cutting-edge AI tools</div>
            <div class="benefit-item">Community support and resources</div>
          </div>

          <p style="margin-top: 30px; font-size: 14px; color: #666;">
            If you have any questions, feel free to reach out to our support team. We're here to help!
          </p>
        </body>
        </html>
      `;

      await EmailEvents.Send.publish({
        to: email,
        subject: `Welcome${brand ? ` to ${brand}` : ''}! Your invite code is ready`,
        body: finalEmailBody,
      });

      return res.status(201).json({
        success: true,
        message: `Invite code generated and sent to ${email}`,
        inviteCode,
        registrationInvite: {
          id: registrationInvite.id,
          code: inviteCode,
          email,
          status: registrationInvite.status,
          unlimitedUse: registrationInvite.unlimitedUse,
          expiresAt: registrationInvite.expiresAt,
        },
      });
    } catch (error) {
      console.error('Error generating invite for subscriber:', error);

      // Registration invite was created before the failure - remove it
      try {
        const failedInvite = await registrationInviteRepository.findOne({ code: inviteCode });
        if (failedInvite) {
          await registrationInviteRepository.deleteByIds([failedInvite.id]);
        }
      } catch (cleanupError) {
        console.error('Error cleaning up failed invite:', cleanupError);
      }

      throw error;
    }
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
