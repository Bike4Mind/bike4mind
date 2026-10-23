import { readFileSync } from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Card, Radio, RadioGroup, Sheet, Stack } from '@mui/joy';
import { CssVarsProvider } from '@mui/joy/styles';
import { test, expect } from '@playwright/test';

const stylesheet = readFileSync(path.resolve(__dirname, '../app/globals.css'), 'utf8');

// Native radio selection needs no hydration. Real Joy markup and browser hit testing are
// essential here: dispatching a click on the input in jsdom bypasses the CSS regression.
const markup = renderToStaticMarkup(
  <CssVarsProvider>
    <Stack spacing={3} sx={{ p: 3, width: 400 }}>
      <RadioGroup name="visibility" defaultValue="public" sx={{ gap: 1 }}>
        {['public', 'organization', 'unlisted'].map(value => (
          <Card key={value} data-testid={`visibility-${value}`} sx={{ p: 2, minHeight: 80 }}>
            <Radio
              value={value}
              label={value}
              overlay
              disableIcon
              slotProps={{ input: { 'data-testid': `visibility-${value}-input` } }}
            />
          </Card>
        ))}
      </RadioGroup>
      <RadioGroup name="credits" defaultValue="medium" sx={{ gap: 1 }}>
        {['small', 'medium', 'large'].map(value => (
          <Sheet key={value} data-testid={`credits-${value}`} sx={{ position: 'relative', p: 2.5, minHeight: 80 }}>
            <Radio
              value={value}
              label={`${value} credit package`}
              overlay
              disableIcon
              slotProps={{ input: { 'data-testid': `credits-${value}-input` } }}
            />
          </Sheet>
        ))}
      </RadioGroup>
      <RadioGroup name="ordinary" defaultValue="first">
        <Radio value="first" label="First option" />
        <Radio
          value="second"
          label="Select this option by its label"
          slotProps={{
            input: { 'data-testid': 'ordinary-second-input' },
            label: { 'data-testid': 'ordinary-second-label' },
          }}
        />
      </RadioGroup>
    </Stack>
  </CssVarsProvider>
);

test.beforeEach(async ({ page }) => {
  await page.setContent(markup);
  await page.addStyleTag({ content: stylesheet });
});

test('visibility cards select when clicking outside the radio input corner', async ({ page }) => {
  for (const value of ['organization', 'unlisted', 'public']) {
    await page.getByTestId(`visibility-${value}`).click({ position: { x: 250, y: 60 } });
    await expect(page.getByTestId(`visibility-${value}-input`)).toBeChecked();
  }
});

test('credit-package cards select when clicking outside the radio input corner', async ({ page }) => {
  for (const value of ['small', 'large', 'medium']) {
    await page.getByTestId(`credits-${value}`).click({ position: { x: 250, y: 60 } });
    await expect(page.getByTestId(`credits-${value}-input`)).toBeChecked();
  }
});

test('ordinary radio labels select their radio', async ({ page }) => {
  await page.getByTestId('ordinary-second-label').scrollIntoViewIfNeeded();
  const label = await page.getByTestId('ordinary-second-label').boundingBox();
  if (!label) throw new Error('The ordinary radio label is not visible');
  // Joy's transparent input covers the label, so the mouse must hit the topmost element.
  await page.mouse.click(label.x + label.width / 2, label.y + label.height / 2);
  await expect(page.getByTestId('ordinary-second-input')).toBeChecked();
});
