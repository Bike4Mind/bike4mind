// TODO: copy of the client package config, duplicated here to avoid a circular
// dependency. Extract into a dedicated config package.

import * as dotenv from 'dotenv';
import { initializeConfig } from '@bike4mind/utils';
import { Resource } from 'sst';

dotenv.config();

const Config = initializeConfig({
  MONGODB_URI: Resource.MONGODB_URI.value,
  SESSION_SECRET: Resource.SESSION_SECRET.value,
  JWT_SECRET: Resource.JWT_SECRET.value,
  SLACK_WEBHOOK_URL: Resource.SLACK_WEBHOOK_URL.value,
  SLACK_ERROR_REPORTING_WEBHOOK_URL: Resource.SLACK_ERROR_REPORTING_WEBHOOK_URL.value,
  GOOGLE_CLIENT_ID: Resource.GOOGLE_CLIENT_ID.value,
  GOOGLE_CLIENT_SECRET: Resource.GOOGLE_CLIENT_SECRET.value,
  GITHUB_CLIENT_ID: Resource.GITHUB_CLIENT_ID.value,
  GITHUB_CLIENT_SECRET: Resource.GITHUB_CLIENT_SECRET.value,
  STRIPE_WEBHOOK_SECRET: Resource.STRIPE_WEBHOOK_SECRET.value,
  STRIPE_SECRET_KEY: Resource.STRIPE_SECRET_KEY.value,
  STRIPE_PUBLISHABLE_KEY: Resource.STRIPE_PUBLISHABLE_KEY.value,
  SUPPORT_EMAIL: Resource.SUPPORT_EMAIL.value,
  MAIL_FROM: Resource.MAIL_FROM.value,
  MAIL_HOST: Resource.MAIL_HOST.value,
  MAIL_PORT: Resource.MAIL_PORT.value,
  MAIL_USERNAME: Resource.MAIL_USERNAME.value,
  MAIL_PASSWORD: Resource.MAIL_PASSWORD.value,
  ANTHROPIC_API_KEY: Resource.ANTHROPIC_API_KEY.value,
  GEMINI_API_KEY: Resource.GEMINI_API_KEY.value,
  OKTA_AUDIENCE: Resource.OKTA_AUDIENCE.value,
  OKTA_CLIENT_ID: Resource.OKTA_CLIENT_ID.value,
  OKTA_CLIENT_SECRET: Resource.OKTA_CLIENT_SECRET.value,
});

const isProduction = () => Resource.App.stage === 'production';
const isDevelopment = () => process.env.IS_LOCAL === 'true' || process.env.NODE_ENV === 'development';

export { Config, isProduction, isDevelopment };
