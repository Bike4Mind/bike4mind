import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { userService } from '@bike4mind/services';
import { z } from 'zod';

const replaySchema = z
  .object({
    policy: userService.signupRiskPolicySchema,
    samples: z
      .array(
        z
          .object({
            cohort: z.enum(['suspected', 'legitimate']),
            signupCredits: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
            signals: z.partialRecord(
              z.enum(userService.SIGNUP_RISK_SIGNALS),
              z.union([z.boolean(), z.number().finite(), z.null()])
            ),
          })
          .strict()
      )
      .min(1)
      .max(100_000),
  })
  .strict();

const emptyCounts = () => ({ samples: 0, full: 0, reduced: 0, review: 0, missingObservations: 0 });
const USAGE =
  'Usage: replaySignupRisk.ts <private-input.json>\nInput: enabled policy and samples with cohort, signupCredits, signals. Outputs aggregate counts only.';

/** Reads private observations without querying production or writing user data. Returns aggregates only. */
export function replaySignupRisk(input: unknown) {
  const parsed = replaySchema.safeParse(input);
  if (!parsed.success) throw new Error('Invalid replay input: expected a policy and labeled signup observations');
  const { policy, samples } = parsed.data;
  if (!policy.enabled) throw new Error('Replay requires an enabled policy');
  const cohorts = { suspected: emptyCounts(), legitimate: emptyCounts() };
  for (const sample of samples) {
    const decision = userService.evaluateSignupRisk(policy, sample.signals, sample.signupCredits);
    const counts = cohorts[sample.cohort];
    counts.samples += 1;
    counts[decision.band] += 1;
    if (decision.missing.length > 0) counts.missingObservations += 1;
  }
  return cohorts;
}

async function main() {
  const inputPath = process.argv[2];
  if (inputPath === '--help' || inputPath === '-h') {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (!inputPath || process.argv.length !== 3) throw new Error('Missing private input path');
  const input: unknown = JSON.parse(await readFile(inputPath, 'utf8'));
  process.stdout.write(`${JSON.stringify(replaySignupRisk(input), null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error(`Signup risk replay failed: check the private input file and policy\n${USAGE}`);
    process.exitCode = 1;
  });
}
