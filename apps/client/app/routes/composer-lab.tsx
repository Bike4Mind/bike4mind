import { FC, ReactNode, useState } from 'react';
import { Box, Divider, Typography } from '@mui/joy';
import type { SessionContextUsage } from '@client/app/hooks/useSessionContextUsage';
import type { AttachmentFitWarning } from '@client/app/hooks/useAttachmentFitWarning';
import ComposerStatusLine from '@client/app/components/Session/SessionBottom/ComposerStatusLine';
import ContextUsageChip from '@client/app/components/Session/SessionBottom/ContextUsageChip';
import PromptCacheTtlChip from '@client/app/components/Session/SessionBottom/PromptCacheTtlChip';
import PromptCacheExpiryHint from '@client/app/components/Session/SessionBottom/PromptCacheExpiryHint';
import { ModelSwitchCostNotice } from '@client/app/components/Session/SessionBottom/ModelSwitchCostNotice';
import { CreditBalanceChipView } from '@client/app/components/Session/CreditButton';
import { LowCreditsWarning } from '@client/app/components/Session/SessionWarnings';
import type { PromptCacheTtl } from '@bike4mind/common';

/**
 * Every state of the composer's status line and the notes above it, each in isolation with mock
 * props: /composer-lab. Local design work only; nothing here talks to the server.
 */

const usage = (over: Partial<SessionContextUsage> = {}): SessionContextUsage => ({
  actualInputTokens: 9_800,
  inputModelId: 'claude-sonnet-5',
  answeredModelId: 'claude-sonnet-5',
  providerInputTokens: 9_800,
  contextLimit: 200_000,
  safeMaxInputTokens: 180_000,
  utilizationPercentage: 5,
  band: 'normal',
  isApproachingLimit: false,
  overflowDetected: false,
  cachingIneffective: false,
  compactedTurns: 0,
  cacheExpiresAt: null,
  ...over,
});

const attachment: AttachmentFitWarning = {
  fileName: 'quarterly-report.pdf',
  deliveredPercent: 40,
  measured: 'extracted',
  siblingCount: 0,
};

const chatPrices = { credits: { '5m': 240, '1h': 380 } as Record<PromptCacheTtl, number>, basis: 'chat' as const };
const perTokenPrices = {
  credits: { '5m': 120, '1h': 190 } as Record<PromptCacheTtl, number>,
  basis: 'per100k' as const,
};

const Section: FC<{ title: string; children: ReactNode }> = ({ title, children }) => (
  <Box sx={{ mb: 5 }}>
    <Typography level="title-md" sx={{ mb: 1.5 }}>
      {title}
    </Typography>
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>{children}</Box>
  </Box>
);

/** One labelled sample, with the status line drawn at `width` so compact mode can be forced; `tall` leaves room for the floating hint. */
const Sample: FC<{ label: string; width?: number; tall?: boolean; children: ReactNode }> = ({
  label,
  width = 720,
  tall = false,
  children,
}) => (
  <Box sx={{ display: 'flex', alignItems: 'center', gap: 3 }}>
    <Typography level="body-xs" sx={{ width: 260, flexShrink: 0, color: 'text.tertiary' }}>
      {label}
    </Typography>
    <Box
      sx={{
        width,
        // A dashed frame shows the sample's edges.
        pt: tall ? 9 : 1,
        border: '1px dashed',
        borderColor: 'divider',
        borderRadius: '8px',
        backgroundColor: 'background.body',
      }}
    >
      {children}
    </Box>
  </Box>
);

const noop = () => {};

const TtlChip: FC<{
  value?: PromptCacheTtl;
  prices?: typeof chatPrices | null;
  disabled?: boolean;
  canChoose?: boolean;
}> = ({ value = '5m', prices = chatPrices, disabled, canChoose }) => {
  const [ttl, setTtl] = useState<PromptCacheTtl>(value);
  return <PromptCacheTtlChip value={ttl} prices={prices} onChange={setTtl} disabled={disabled} canChoose={canChoose} />;
};

const Anchored: FC<{ children: ReactNode }> = ({ children }) => (
  <Box sx={{ position: 'relative', display: 'flex' }}>{children}</Box>
);

const Line: FC<{ left?: ReactNode; right: ReactNode }> = ({ left, right }) => (
  <ComposerStatusLine left={left} right={right} />
);

const ComposerLabPage: FC = () => {
  const [lowShown, setLowShown] = useState(true);

  return (
    // The app layout clips its content pane, so the page scrolls itself.
    <Box sx={{ height: '100%', overflowY: 'auto', p: 4 }}>
      <Typography level="h3" sx={{ mb: 0.5 }}>
        Composer lab
      </Typography>
      <Typography level="body-sm" sx={{ mb: 4, color: 'text.tertiary' }}>
        Status line chips and notes with mock data. Switch the app theme to check both modes.
      </Typography>

      <Section title="Context chip">
        <Sample label="normal, 5%">
          <Line right={<ContextUsageChip usage={usage()} modelName="Claude Sonnet 5" />} />
        </Sample>
        <Sample label="warning band, 78%">
          <Line
            right={
              <ContextUsageChip
                usage={usage({ utilizationPercentage: 78, band: 'warning', isApproachingLimit: true })}
                modelName="Claude Sonnet 5"
              />
            }
          />
        </Sample>
        <Sample label="danger band, 94%">
          <Line
            right={
              <ContextUsageChip
                usage={usage({ utilizationPercentage: 94, band: 'danger', isApproachingLimit: true })}
                modelName="Claude Sonnet 5"
              />
            }
          />
        </Sample>
        <Sample label="overflow detected">
          <Line
            right={
              <ContextUsageChip
                usage={usage({ utilizationPercentage: 100, band: 'danger', overflowDetected: true })}
                modelName="Claude Sonnet 5"
              />
            }
          />
        </Sample>
        <Sample label="caching ineffective + compaction">
          <Line
            right={
              <ContextUsageChip
                usage={usage({
                  actualInputTokens: 60_000,
                  utilizationPercentage: 33,
                  cachingIneffective: true,
                  compactedTurns: 4,
                })}
                modelName="Claude Sonnet 5"
              />
            }
          />
        </Sample>
        <Sample label="attachment will be cut (red)">
          <Line right={<ContextUsageChip usage={usage()} modelName="Claude Sonnet 5" attachment={attachment} />} />
        </Sample>
        <Sample label="no turn yet, message over limit">
          <Line right={<ContextUsageChip usage={null} modelName="Claude Sonnet 5" inputOverLimit />} />
        </Sample>
      </Section>

      <Section title="Cache TTL chip">
        <Sample label="5 minutes, chat prices">
          <Line right={<TtlChip />} />
        </Sample>
        <Sample label="1 hour, per-100K prices">
          <Line right={<TtlChip value="1h" prices={perTokenPrices} />} />
        </Sample>
        <Sample label="no prices yet (new chat)">
          <Line right={<TtlChip prices={null} />} />
        </Sample>
        <Sample label="disabled while saving">
          <Line right={<TtlChip disabled />} />
        </Sample>
        <Sample label="older Claude: fixed at 5 minutes, no choice">
          <Line right={<TtlChip canChoose={false} />} />
        </Sample>
      </Section>

      <Section title="Expired-cache hint">
        <Sample label="on the TTL chip" tall>
          <Line
            right={
              <>
                <ContextUsageChip usage={usage()} modelName="Claude Sonnet 5" />
                <Anchored>
                  <TtlChip />
                  <PromptCacheExpiryHint credits={940} expiresAt={1} />
                </Anchored>
                <CreditBalanceChipView credits={2_405} lowCreditsThreshold={500} onClick={noop} answersLeft={40} />
              </>
            }
          />
        </Sample>
        <Sample label="large figure" tall>
          <Line
            right={
              <Anchored>
                <TtlChip />
                <PromptCacheExpiryHint credits={1_250_000} expiresAt={1} />
              </Anchored>
            }
          />
        </Sample>
        <Sample label="null credits: hidden" tall>
          <Line
            right={
              <Anchored>
                <TtlChip />
                <PromptCacheExpiryHint credits={null} expiresAt={1} />
              </Anchored>
            }
          />
        </Sample>
      </Section>

      <Section title="Credit balance chip">
        <Sample label="neutral, answers left">
          <Line
            right={
              <CreditBalanceChipView
                credits={2_405}
                lowCreditsThreshold={500}
                onClick={noop}
                answersLeft={40}
                modelName="Claude Sonnet 5"
              />
            }
          />
        </Sample>
        <Sample label="neutral, no answers estimate">
          <Line right={<CreditBalanceChipView credits={2_405} lowCreditsThreshold={500} onClick={noop} />} />
        </Sample>
        <Sample label="low (warning)">
          <Line
            right={<CreditBalanceChipView credits={120} lowCreditsThreshold={500} onClick={noop} answersLeft={2} />}
          />
        </Sample>
        <Sample label="zero (danger)">
          <Line
            right={<CreditBalanceChipView credits={0} lowCreditsThreshold={500} onClick={noop} answersLeft={0} />}
          />
        </Sample>
        <Sample label="someone else pays (info mark)">
          <Line
            right={
              <CreditBalanceChipView
                credits={2_405}
                lowCreditsThreshold={500}
                onClick={noop}
                answersLeft={40}
                payerNote="The notebook owner pays for messages here."
              />
            }
          />
        </Sample>
      </Section>

      <Section title="Whole line">
        <Sample label="wide">
          <Line
            right={
              <>
                <ContextUsageChip usage={usage()} modelName="Claude Sonnet 5" />
                <Anchored>
                  <TtlChip />
                </Anchored>
                <CreditBalanceChipView credits={2_405} lowCreditsThreshold={500} onClick={noop} answersLeft={40} />
              </>
            }
          />
        </Sample>
        <Sample label="narrow (docked panel width, 324px)" width={324} tall>
          <Line
            right={
              <>
                <ContextUsageChip usage={usage()} modelName="Claude Sonnet 5" />
                <Anchored>
                  <TtlChip />
                  <PromptCacheExpiryHint credits={940} expiresAt={1} />
                </Anchored>
                <CreditBalanceChipView credits={2_405} lowCreditsThreshold={500} onClick={noop} answersLeft={40} />
              </>
            }
          />
        </Sample>
        <Sample label="warning + low balance" width={720}>
          <Line
            right={
              <>
                <ContextUsageChip
                  usage={usage({ utilizationPercentage: 78, band: 'warning', isApproachingLimit: true })}
                  modelName="Claude Sonnet 5"
                />
                <Anchored>
                  <TtlChip value="1h" />
                </Anchored>
                <CreditBalanceChipView credits={120} lowCreditsThreshold={500} onClick={noop} answersLeft={2} />
              </>
            }
          />
        </Sample>
      </Section>

      <Divider sx={{ my: 4 }} />

      <Section title="Notes above the line">
        <Sample label="model switch cost (dismissable)">
          <Box sx={{ px: 1, pb: 1 }}>
            <ModelSwitchCostNotice credits={1_200} />
          </Box>
        </Sample>
        <Sample label="low credits warning">
          <Box sx={{ px: 1, pb: 1 }}>
            <LowCreditsWarning show={lowShown} currentCredits={120} onDismiss={() => setLowShown(false)} />
            {!lowShown && (
              <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
                dismissed
              </Typography>
            )}
          </Box>
        </Sample>
      </Section>

      <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
        Not here: NotebookFilesChip, ResearchModeIndicator, MemberCreditBudgetNote and AffordableModelOffer read
        notebook and model stores, so they are checked in a real chat.
      </Typography>
    </Box>
  );
};

export default ComposerLabPage;
