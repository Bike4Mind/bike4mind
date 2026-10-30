import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { ScopeEndpointList, groupScopeEndpoints } from './ScopeEndpointList';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderList = (endpoints: string[]) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <ScopeEndpointList scope="datalake:read" endpoints={endpoints} />
    </CssVarsProvider>
  );

describe('groupScopeEndpoints', () => {
  it('groups by resource, keeping the v1 surface apart, and sorts groups and entries by path', () => {
    expect(
      groupScopeEndpoints([
        'GET /api/data-lakes/:id',
        'GET /api/v1/data-lakes',
        'GET|PUT /api/data-lakes',
        'Example run and problem reads',
      ])
    ).toEqual([
      { prefix: '/api/data-lakes', endpoints: ['GET|PUT /api/data-lakes', 'GET /api/data-lakes/:id'] },
      { prefix: '/api/v1/data-lakes', endpoints: ['GET /api/v1/data-lakes'] },
      { prefix: 'Example run and problem reads', endpoints: ['Example run and problem reads'] },
    ]);
  });
});

describe('ScopeEndpointList', () => {
  it('summarises each resource on one line and expands to every route', () => {
    renderList(['GET /api/data-lakes', 'GET /api/data-lakes/:id', 'GET /api/v1/data-lakes']);
    const summary = screen.getByTestId('api-keys-scope-endpoints-datalake:read');
    expect(summary).toHaveTextContent('/api/data-lakes/* (2 routes), GET /api/v1/data-lakes');
    expect(screen.queryByTestId('api-keys-scope-endpoints-datalake:read-list')).toBeNull();

    fireEvent.click(screen.getByTestId('api-keys-scope-endpoints-datalake:read-toggle-btn'));
    const items = screen.getByTestId('api-keys-scope-endpoints-datalake:read-list').querySelectorAll('li');
    expect([...items].map(li => li.textContent)).toEqual([
      'GET /api/data-lakes',
      'GET /api/data-lakes/:id',
      'GET /api/v1/data-lakes',
    ]);
  });

  it('offers no toggle when every resource holds a single route', () => {
    renderList(['GET /api/v1/me', 'GET /api/v1/credits']);
    expect(screen.getByTestId('api-keys-scope-endpoints-datalake:read')).toHaveTextContent(
      'GET /api/v1/credits, GET /api/v1/me'
    );
    expect(screen.queryByTestId('api-keys-scope-endpoints-datalake:read-toggle-btn')).toBeNull();
  });

  it('renders nothing for a scope with no endpoints', () => {
    renderList([]);
    expect(screen.queryByTestId('api-keys-scope-endpoints-datalake:read')).toBeNull();
  });
});
