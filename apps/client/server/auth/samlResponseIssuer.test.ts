import { describe, it, expect } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { samlResponseIssuer } from './samlResponseIssuer';

const response = (issuer: string) =>
  `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r1">` +
  `<saml:Issuer> ${issuer} </saml:Issuer>` +
  `<saml:Assertion ID="_a1"><saml:Issuer>https://assertion-issuer.example</saml:Issuer></saml:Assertion>` +
  `</samlp:Response>`;

describe('samlResponseIssuer', () => {
  it("reads the Response's own Issuer from a base64 POST body", () => {
    const body = Buffer.from(response('https://idp.example/metadata')).toString('base64');
    expect(samlResponseIssuer(body)).toBe('https://idp.example/metadata');
  });

  it('reads a deflated HTTP-Redirect response', () => {
    const body = deflateRawSync(Buffer.from(response('https://idp.example/metadata'))).toString('base64');
    expect(samlResponseIssuer(body)).toBe('https://idp.example/metadata');
  });

  it('ignores an Issuer outside the SAML assertion namespace', () => {
    const xml = '<Response><Issuer>https://idp.example/metadata</Issuer></Response>';
    expect(samlResponseIssuer(Buffer.from(xml).toString('base64'))).toBeUndefined();
  });

  it.each([
    ['missing', undefined],
    ['an array (repeated parameter)', ['a', 'b']],
    ['empty', ''],
    ['not base64 XML', 'bm90LXhtbA=='],
    ['malformed XML', Buffer.from('<samlp:Response><saml:Issuer>').toString('base64')],
  ])('returns undefined when the response is %s', (_label, value) => {
    expect(samlResponseIssuer(value)).toBeUndefined();
  });
});
