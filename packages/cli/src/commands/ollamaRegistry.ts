/**
 * Reads an Ollama registry manifest before a pull: total download size and the license texts the model ships
 * with, so `b4m models pull <name>` can show both and ask before anything downloads.
 */

import { createHash } from 'crypto';
import { z } from 'zod';

export const OLLAMA_REGISTRY = 'https://registry.ollama.ai';
/** Hosts a pull ref may name for Ollama's registry; `ollama.com` names resolve against the same registry. */
export const OLLAMA_REGISTRY_HOSTS: ReadonlySet<string> = new Set(['registry.ollama.ai', 'ollama.com']);

const MANIFEST_ACCEPT = 'application/vnd.docker.distribution.manifest.v2+json';
const LICENSE_LAYER = 'application/vnd.ollama.image.license';
const MAX_LICENSE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const NAME_PART_RE = /^[A-Za-z0-9][\w.-]{0,127}$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

const manifestSchema = z.object({
  layers: z.array(
    z.object({ mediaType: z.string(), digest: z.string().regex(DIGEST_RE), size: z.number().nonnegative() })
  ),
});

export interface OllamaModelName {
  namespace: string;
  model: string;
  tag: string;
  /** The model's page on ollama.com. */
  page: string;
}

export interface OllamaManifestInfo {
  /** `sha256:<hex>` of the manifest as the registry served it. */
  digest: string;
  /** Every layer's digest, in manifest order. */
  layers: string[];
  sizeBytes: number;
  /** One text per license layer; '' when a layer is too large to read. */
  licenses: string[];
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** `[namespace/]model[:tag]`, without a registry host. */
export function parseOllamaName(name: string): OllamaModelName {
  const parts = name.split('/');
  if (parts.length > 2) throw new Error(`Not an Ollama model name: ${name}`);
  const [namespace, rest] = parts.length === 2 ? parts : ['library', parts[0]];
  const colon = rest.indexOf(':');
  const model = colon === -1 ? rest : rest.slice(0, colon);
  const tag = colon === -1 ? 'latest' : rest.slice(colon + 1);
  if (![namespace, model, tag].every(part => NAME_PART_RE.test(part)))
    throw new Error(`Not an Ollama model name: ${name}`);
  const page =
    namespace === 'library' ? `https://ollama.com/library/${model}` : `https://ollama.com/${namespace}/${model}`;
  return { namespace, model, tag, page };
}

export async function readOllamaManifest(
  name: string,
  signal: AbortSignal,
  fetchImpl: FetchLike = fetch
): Promise<OllamaManifestInfo> {
  const { namespace, model, tag } = parseOllamaName(name);
  const base = `${OLLAMA_REGISTRY}/v2/${namespace}/${model}`;
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]);
  const response = await fetchImpl(`${base}/manifests/${tag}`, {
    headers: { accept: MANIFEST_ACCEPT },
    signal: requestSignal,
  });
  if (response.status === 404) throw new Error(`The Ollama registry has no model named ${name}.`);
  if (!response.ok) throw new Error(`The Ollama registry answered ${response.status} for ${name}.`);
  const body = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(body);
  } catch {
    // An unparseable body fails the schema check below.
  }
  const parsed = manifestSchema.safeParse(json);
  if (!parsed.success) throw new Error(`The Ollama registry sent an unreadable manifest for ${name}.`);
  const { layers } = parsed.data;
  const licenseLayers = layers.filter(layer => layer.mediaType === LICENSE_LAYER);
  const licenses = await Promise.all(
    licenseLayers
      .filter((layer, index) => licenseLayers.findIndex(other => other.digest === layer.digest) === index)
      .map(async layer => {
        if (layer.size > MAX_LICENSE_BYTES) return '';
        const blob = await fetchImpl(`${base}/blobs/${layer.digest}`, { signal: requestSignal });
        if (!blob.ok) throw new Error(`The Ollama registry answered ${blob.status} for ${name}'s license.`);
        return (await blob.text()).slice(0, MAX_LICENSE_BYTES);
      })
  );
  return {
    digest: `sha256:${createHash('sha256').update(body).digest('hex')}`,
    layers: layers.map(layer => layer.digest),
    sizeBytes: layers.reduce((sum, layer) => sum + layer.size, 0),
    licenses,
  };
}

/** Whitespace, markdown emphasis and quote style do not change a license's words. */
function normalize(text: string): string {
  return text
    .replace(/[*"\u{201c}\u{201d}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const APACHE_END = 'END OF TERMS AND CONDITIONS';
// SHA-256 of normalize() over https://www.apache.org/licenses/LICENSE-2.0.txt up to and including APACHE_END.
const APACHE_TERMS_SHA256 = '208c068632b160d0955a8259f36f232f5bd61792d051af42f9942706efe4ddae';
const COPYRIGHT_PLACEHOLDER = 'Copyright [yyyy] [name of copyright owner]';
const APACHE_APPENDIX =
  'APPENDIX: How to apply the Apache License to your work. To apply the Apache License to your work, attach the ' +
  'following boilerplate notice, with the fields enclosed by brackets [] replaced with your own identifying ' +
  "information. (Don't include the brackets!) The text should be enclosed in the appropriate comment syntax for " +
  'the file format. We also recommend that a file or class name and description of purpose be included on the ' +
  'same printed page as the copyright notice for easier identification within third-party archives. ' +
  `${COPYRIGHT_PLACEHOLDER} Licensed under the Apache License, Version 2.0 (the License); you may not use this ` +
  'file except in compliance with the License. You may obtain a copy of the License at ' +
  'http://www.apache.org/licenses/LICENSE-2.0 Unless required by applicable law or agreed to in writing, software ' +
  'distributed under the License is distributed on an AS IS BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, ' +
  'either express or implied. See the License for the specific language governing permissions and limitations ' +
  'under the License.';
const MIT_START = 'Permission is hereby granted';
const MIT_BODY =
  'Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated ' +
  'documentation files (the Software), to deal in the Software without restriction, including without limitation ' +
  'the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and ' +
  'to permit persons to whom the Software is furnished to do so, subject to the following conditions: The above ' +
  'copyright notice and this permission notice shall be included in all copies or substantial portions of the ' +
  'Software. THE SOFTWARE IS PROVIDED AS IS, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT ' +
  'LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT ' +
  'SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION ' +
  'OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER ' +
  'DEALINGS IN THE SOFTWARE.';

const COPYRIGHT_RE = /^copyright\s+(?:\(c\)\s*|\u{a9}\s*)?(?:\d{4}(?:\s*-\s*\d{4})?,?\s*)*(.{1,100})$/iu;
// The holder slot of a copyright line must read as a name, so it cannot smuggle in extra terms.
const NOT_A_NAME =
  /\b(?:may|must|shall|not|only|use[ds]?|using|commercial|prohibited|licen[cs]e[ds]?|permission|agree\w*|restrict\w*|terms?)\b|\.\s+\S/i;

function isCopyrightLine(line: string): boolean {
  const holder = COPYRIGHT_RE.exec(line.trim())?.[1].replace(/\s*All rights reserved\.?$/i, '');
  // The extra-terms check below only recognizes English; unfamiliar holder text must ask for acceptance.
  return holder !== undefined && /^[\x20-\x7e]+$/.test(holder) && !NOT_A_NAME.test(holder);
}

function isApache(text: string): boolean {
  const end = text.indexOf(APACHE_END);
  if (end === -1) return false;
  const terms = normalize(text.slice(0, end + APACHE_END.length));
  if (createHash('sha256').update(terms).digest('hex') !== APACHE_TERMS_SHA256) return false;
  const appendix = text.slice(end + APACHE_END.length);
  if (normalize(appendix) === '') return true;
  const copyright = /^[ \t]*(Copyright\b.*)$/im.exec(appendix);
  if (!copyright || !isCopyrightLine(copyright[1])) return false;
  return normalize(appendix.replace(copyright[0], COPYRIGHT_PLACEHOLDER)) === APACHE_APPENDIX;
}

/** The MIT body, preceded only by a title, copyright lines and a name that those copyright lines carry. */
function isMit(text: string): boolean {
  const start = text.indexOf(MIT_START);
  if (start === -1 || normalize(text.slice(start)) !== MIT_BODY) return false;
  const preamble = text
    .slice(0, start)
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  const words = (line: string) => line.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const holderWords = new Set(preamble.filter(isCopyrightLine).flatMap(words));
  return (
    preamble.length <= 6 &&
    preamble.every(
      line =>
        /^(?:the )?mit license(?: \(mit\))?$/i.test(line) ||
        isCopyrightLine(line) ||
        (/^[\x20-\x7e]+$/.test(line) && words(line).length > 0 && words(line).every(word => holderWords.has(word)))
    )
  );
}

function titleOf(text: string): string {
  const line = text
    .split('\n')
    .map(entry =>
      entry
        .replace(/[*#]/g, '')
        .replace(/\s+/g, ' ')
        .replace(/^[\s=_-]+|[\s=_-]+$/g, '')
    )
    .find(Boolean);
  return line ? line.slice(0, 80) : 'license text not shown';
}

/**
 * Permissive only when every license text is the Apache-2.0 or MIT template, allowing nothing beyond the copyright
 * and name lines the templates have; any other text, or a template with added terms, is restricted.
 */
export function classifyLicenses(texts: string[]): { title: string; permissive: boolean } {
  const unique = [...new Set(texts)];
  const matched = unique.map(text => (isApache(text) ? 'Apache-2.0' : isMit(text) ? 'MIT' : null));
  const titles = [...new Set(unique.map((text, index) => matched[index] ?? titleOf(text)))];
  return {
    title: titles.length > 0 ? titles.join(' + ') : 'none declared',
    permissive: unique.length > 0 && matched.every(Boolean),
  };
}
