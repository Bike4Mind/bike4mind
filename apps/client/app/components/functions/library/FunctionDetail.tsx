import React from 'react';
import { Link as RouterLink } from '@tanstack/react-router';
import { Alert, Box, CircularProgress, Link, Stack, Typography } from '@mui/joy';
import { CALLABLE_FUNCTION_TRUST_LABEL_TEXT, type ICallableFunctionPublic } from '@bike4mind/common';
import {
  useCallableFunctionDetail,
  useCallableFunctionList,
  useCallableFunctionsEnabled,
  useSharedCallableFunctions,
} from '@client/app/hooks/data/callableFunctions';
import { ContractTable } from '@client/app/components/Knowledge/FunctionContractTable';
import { CallsBlock } from '@client/app/components/Knowledge/PromoteFunctionSection';
import { SharedFunctionCard } from '@client/app/components/integrations/customMcp/SharedFunctionsSection';

const Section = ({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }) => (
  <Stack spacing={0.5} data-testid={testId}>
    <Typography level="title-sm">{title}</Typography>
    {children}
  </Stack>
);

const Spinner = () => (
  <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
    <CircularProgress size="sm" data-testid="function-detail-loading" />
  </Box>
);

function OwnFunctionDetail({ fn }: { fn: ICallableFunctionPublic }) {
  const detail = useCallableFunctionDetail(fn.id);
  const reads = [
    ...fn.dataPins.map(pin => `Data file: ${pin.name}`),
    ...fn.sources.map(source => `Source: ${source.name} (${source.url})`),
  ];
  return (
    <Stack spacing={2} data-testid="function-detail-own">
      <Stack spacing={0.5}>
        <Typography level="h2" sx={{ fontFamily: 'code' }}>
          {fn.slug}
        </Typography>
        <Typography level="body-md">{fn.description}</Typography>
      </Stack>
      {detail.isPending ? (
        <Spinner />
      ) : detail.data ? (
        <>
          <Section title="Inputs">
            <ContractTable schema={detail.data.contract.inputs} testId="function-detail-inputs" />
          </Section>
          <Section title="Outputs">
            <ContractTable schema={detail.data.contract.outputs} testId="function-detail-outputs" />
          </Section>
        </>
      ) : (
        <Alert color="danger" sx={{ alignSelf: 'flex-start' }}>
          Could not load its inputs and outputs.
        </Alert>
      )}
      <Section title="Label" testId="function-detail-label">
        <Typography level="body-sm">
          {fn.trustLabel ? CALLABLE_FUNCTION_TRUST_LABEL_TEXT[fn.trustLabel] : 'None until it is promoted.'}
        </Typography>
      </Section>
      <Section title="Owner">
        <Typography level="body-sm" data-testid="function-detail-owner">
          You
        </Typography>
      </Section>
      <Section title="Data it reads" testId="function-detail-data">
        {reads.length === 0 ? (
          <Typography level="body-sm" textColor="text.secondary">
            None.
          </Typography>
        ) : (
          <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
            {reads.map(line => (
              <Typography component="li" level="body-sm" key={line}>
                {line}
              </Typography>
            ))}
          </Box>
        )}
      </Section>
      <CallsBlock tool={fn} />
      <Link
        component={RouterLink}
        to={`/artifacts/${fn.pin.artifactId}`}
        level="body-sm"
        data-testid="function-detail-artifact-link"
      >
        Open its artifact to edit, test, promote, or share it
      </Link>
    </Stack>
  );
}

/** One function from the library: the owner's full view, or a recipient's review of a shared one. */
export const FunctionDetail: React.FC<{ id: string }> = ({ id }) => {
  const enabled = useCallableFunctionsEnabled();
  const mine = useCallableFunctionList(enabled);
  const shared = useSharedCallableFunctions(enabled);

  if (!enabled) {
    return (
      <Typography level="body-md" textColor="text.tertiary" data-testid="function-detail-off">
        Callable functions are not turned on for your account.
      </Typography>
    );
  }
  const own = mine.data?.find(fn => fn.id === id);
  if (own) return <OwnFunctionDetail fn={own} />;
  const received = shared.data?.find(fn => fn.id === id);
  if (received) {
    return (
      <Stack spacing={1} data-testid="function-detail-shared">
        <SharedFunctionCard key={`${received.id}:${received.reviewHash}`} fn={received} defaultOpen />
      </Stack>
    );
  }
  if (mine.isPending || shared.isPending) return <Spinner />;
  return (
    <Alert color="neutral" sx={{ alignSelf: 'flex-start' }} data-testid="function-detail-not-found">
      This function does not exist, or it is not shared with you.
    </Alert>
  );
};
