import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { Box } from '@mui/joy';
import { useCodeBlockActions } from '@client/app/utils/codeBlockActions';

/**
 * The two halves a code-block renderer places for registered actions (see
 * utils/codeBlockActions.ts): the controls go in its header, the outlet under its code.
 * Shared by CodeBlockHeader and CodeArtifactPreviewCard.
 */
export function useCodeBlockActionOutlet() {
  // State rather than a ref, so the controls re-render with the element once it mounts.
  const [outputSlot, setOutputSlot] = useState<HTMLDivElement | null>(null);
  const outlet = (
    <Box ref={setOutputSlot} className="code-block-action-output" data-testid="code-block-action-output" />
  );
  return { outputSlot, outlet };
}

export const CodeBlockActionControls: React.FC<{
  code: string;
  language: string;
  outputSlot: HTMLElement | null;
}> = ({ code, language, outputSlot }) => {
  const actions = useCodeBlockActions(language);
  return (
    <>
      {actions.map(({ id, Control }) => (
        <Control key={id} code={code} language={language} outputSlot={outputSlot} />
      ))}
    </>
  );
};

/** Renders an action's output into the outlet under the code (nothing until it has mounted). */
export const CodeBlockActionOutput: React.FC<{ outputSlot: HTMLElement | null; children: React.ReactNode }> = ({
  outputSlot,
  children,
}) => (outputSlot ? createPortal(children, outputSlot) : null);
