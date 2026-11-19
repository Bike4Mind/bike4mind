import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { Logger } from '@bike4mind/observability';
import { Resource } from 'sst';
import type { TestEmailResult } from './index';
import type { MailTransportKind } from './transport';

/** The payload the email-send worker answers with a test send instead of treating it as an event. */
export interface MailTestRequest {
  mailTest: { to: string };
}

export interface LiveTestEmailResult extends TestEmailResult {
  /** The transport that ran the test; absent when the request never reached one. */
  transport?: MailTransportKind;
}

export const isMailTestRequest = (event: unknown): event is MailTestRequest => {
  const to = (event as Partial<MailTestRequest> | null)?.mailTest?.to;
  return typeof to === 'string';
};

// Read through a Record view: sst-env.d.ts learns a new key of the Linkable only on the next deploy.
function emailSendFunctionName(): string | undefined {
  try {
    return (Resource as unknown as { lambdaFunctionNames?: Record<string, string | undefined> }).lambdaFunctionNames
      ?.emailSend;
  } catch {
    return undefined;
  }
}

/**
 * Sends the System Health test email on the transport that delivers this deployment's mail and
 * returns that transport's own answer. On a hosted stage only the email-send worker holds the
 * transport, so the worker is invoked and waited on (infra/web.ts grants the invoke); self-host
 * sends over SMTP in this process.
 */
export async function sendLiveTestEmail(to: string): Promise<LiveTestEmailResult> {
  if (process.env.B4M_SELF_HOST === 'true') {
    const { default: mailer } = await import('./index');
    return { ...(await mailer.sendTestEmail(to)), transport: mailer.transport.kind };
  }

  const functionName = emailSendFunctionName();
  if (!functionName) {
    return { success: false, error: 'The email worker is not linked to this deployment.' };
  }

  const request: MailTestRequest = { mailTest: { to } };
  const response = await new LambdaClient({}).send(
    new InvokeCommand({
      FunctionName: functionName,
      InvocationType: 'RequestResponse',
      Payload: Buffer.from(JSON.stringify(request)),
    })
  );
  const payload: unknown = response.Payload ? JSON.parse(Buffer.from(response.Payload).toString('utf8')) : undefined;

  if (response.FunctionError) {
    // The raw worker error can name AWS resources, so it stays in the logs and the admin gets the kind.
    const errorMessage = (payload as { errorMessage?: unknown } | undefined)?.errorMessage;
    Logger.error(
      `Live test email: the email worker failed (${response.FunctionError}): ${typeof errorMessage === 'string' ? errorMessage : 'no message'}`
    );
    return {
      success: false,
      error: `The email worker failed (${response.FunctionError}). Check the email worker logs for details.`,
    };
  }
  if (typeof (payload as { success?: unknown } | undefined)?.success !== 'boolean') {
    return { success: false, error: 'The email worker returned no test result.' };
  }
  return payload as LiveTestEmailResult;
}
