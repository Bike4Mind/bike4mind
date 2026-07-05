import { FeedbackModel, User } from '@bike4mind/database';
import { FeedbackEvents, FeedbackStatus, IOrganizationDocument, PromptMetaZodSchema } from '@bike4mind/common';
import { logEvent } from '@server/utils/analyticsLog';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { adminSettingsRepository } from '@bike4mind/database';
import { baseApi } from '@server/middlewares/baseApi';
import { NotFoundError } from '@server/utils/errors';
import { EmailEvents } from '@server/utils/eventBus';
import { postFeedbackToSlack } from '@server/integrations/slack/slack';
import sanitizeHtml from 'sanitize-html';
import { z } from 'zod';

const CreateFeedbackRequestSchema = z.object({
  userId: z.string(),
  content: z.string(),
  tags: z.array(z.string()),
  username: z.string(),
  userEmail: z.string(),
  type: z.string().optional(),
  promptMeta: PromptMetaZodSchema.optional(),
});

const handler = baseApi()
  .get(async (req, res) => {
    if (!req.ability) {
      throw new Error('Ability not found');
    }

    if (!req.ability.can('read', FeedbackModel)) {
      throw new Error('Permission denied');
    }

    const feedback = await FeedbackModel.find();

    if (!feedback) {
      throw new NotFoundError('Feedback not found');
    }

    return res.json(feedback);
  })
  .post(async (req, res) => {
    const newFeedbackData = CreateFeedbackRequestSchema.parse(req.body);
    const authenticated = req.isAuthenticated();
    if (authenticated) {
      console.log('Authenticated');
    }

    const { userId, content, tags, username, userEmail, promptMeta, type } = newFeedbackData;

    console.log('newFeedbackData', newFeedbackData);

    const existingUser = await User.findOne({ email: userEmail }).populate('organizationId');

    const organization = (existingUser?.organizationId as unknown as IOrganizationDocument)?.name || 'Unknown';

    const newFeedback = new FeedbackModel({
      userId: req.isAuthenticated() ? req.user.id : userId,
      content,
      tags,
      status: FeedbackStatus.New,
      username: req.isAuthenticated() ? req.user.username : username,
      userEmail: req.isAuthenticated() ? req.user.email : userEmail,
      organization: organization,
      promptMeta: promptMeta,
      type,
    });
    await newFeedback.save();

    const settings = await getSettingsMap({ adminSettings: adminSettingsRepository });

    if (authenticated)
      await logEvent(
        { userId, type: FeedbackEvents.CREATE_FEEDBACK, metadata: { id: newFeedback.id, content } },
        { ability: req.ability }
      );

    // Send feedback to Slack if enabled
    if (getSettingsValue('EnableFeedBackToSlack', settings)) {
      console.log('Sending feedback to Slack is enabled');
      await postFeedbackToSlack(
        type || 'CS',
        organization,
        username,
        userEmail,
        userId,
        content,
        promptMeta ? JSON.stringify(promptMeta) : 'No prompt meta'
      );
    }

    // Find all of the settings that have a tag 'feedbackEmail'
    const feedbackEmails = (getSettingsValue('FeedbackReceiveEmail', settings) || '').split(',').filter(Boolean);

    console.log(`Sending feedback to all of these folks: ${feedbackEmails}`);

    // Send Feedback to Email
    if (getSettingsValue('EnableFeedBackToEmail', settings) && feedbackEmails.length > 0) {
      console.log('Sending feedback to email is enabled');
      const sanitizedContent = sanitizeHtml(content);
      const sanitizedUsername = sanitizeHtml(username);
      const sanitizedUserEmail = sanitizeHtml(userEmail);
      const sanitizedType = type ? sanitizeHtml(type) : '';
      const sanitizedTags = tags ? tags.map(tag => sanitizeHtml(tag)) : [];
      const sanitizedPromptMeta = promptMeta ? sanitizeHtml(JSON.stringify(promptMeta, null, 2)) : '';

      await Promise.all(
        feedbackEmails.map((email: string) =>
          EmailEvents.Send.publish({
            to: email,
            subject: 'New Feedback Received',
            body: `
              <!DOCTYPE html>
              <html lang="en" xmlns="http://www.w3.org/1999/xhtml">
              <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>New Feedback Submission</title>
                <style>
                  @import url('https://fonts.googleapis.com/css2?family=Roboto:wght@400;700&display=swap');
                  body {
                    margin: 0;
                    padding: 0;
                    background-color: #f5f7fa;
                    font-family: 'Roboto', sans-serif;
                    color: #333;
                  }
                  .container {
                    width: 100%;
                    max-width: 600px;
                    margin: 30px auto;
                    background-color: #ffffff;
                    border-radius: 8px;
                    overflow: hidden;
                    box-shadow: 0 2px 5px rgba(0, 0, 0, 0.15);
                  }
                  .header {
                    background-color: #007bff;
                    color: #ffffff;
                    text-align: center;
                    padding: 30px 20px;
                  }
                  .header h1 {
                    margin: 0;
                    font-size: 28px;
                  }
                  .content {
                    padding: 30px 20px;
                  }
                  .content h2 {
                    font-size: 22px;
                    margin-bottom: 20px;
                  }
                  .content p {
                    font-size: 16px;
                    line-height: 1.6;
                    margin-bottom: 15px;
                  }
                  .info {
                    background-color: #f1f1f1;
                    padding: 20px;
                    border-radius: 5px;
                    margin-bottom: 20px;
                  }
                  .info p {
                    margin: 5px 0;
                  }
                  .tags {
                    margin-top: 10px;
                  }
                  .tag {
                    display: inline-block;
                    background: #28a745;
                    color: #fff;
                    padding: 5px 10px;
                    border-radius: 15px;
                    font-size: 12px;
                    margin: 5px 5px 0 0;
                  }
                  .footer {
                    text-align: center;
                    padding: 20px;
                    background-color: #e9ecef;
                    font-size: 14px;
                    color: #6c757d;
                  }
                  @media (max-width: 600px) {
                    .content h2 {
                      font-size: 20px;
                    }
                    .header h1 {
                      font-size: 24px;
                    }
                  }
                </style>
              </head>
              <body>
                <div class="container">
                  <div class="header">
                    <h1>You've Got Feedback from ${sanitizedUsername}</h1>
                  </div>
                  <div class="content">
                    <h2>New Feedback Submission</h2>
                    <div class="info">
                      <p><strong>From:</strong> ${sanitizedUsername} (ID: ${userId})</p>
                      <p><strong>Email:</strong> ${sanitizedUserEmail}</p>
                      ${sanitizedType ? `<p><strong>Type:</strong> ${sanitizedType}</p>` : ''}
                    </div>
                    <p><strong>Message:</strong></p>
                    <p>${sanitizedContent}</p>
                    ${
                      sanitizedTags.length
                        ? `<div class="tags">
                            <strong>Tags:</strong>
                            ${sanitizedTags.map(tag => `<span class="tag">${tag}</span>`).join('')}
                          </div>`
                        : ''
                    }
                    ${
                      promptMeta
                        ? `<div class="info">
                            <p><strong>Prompt Meta:</strong></p>
                            <pre style="white-space: pre-wrap; word-wrap: break-word;">${sanitizedPromptMeta}</pre>
                          </div>`
                        : ''
                    }
                  </div>
                  <div class="footer">
                    <p>This is an automated email from [Your Company]. Please do not reply directly to this message.</p>
                  </div>
                </div>
              </body>
              </html>
              `,
          })
        )
      );
    }

    return res.status(201).send(newFeedback);
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
