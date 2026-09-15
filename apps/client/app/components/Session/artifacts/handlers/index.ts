/**
 * Barrel import that registers all artifact type handlers; import once to
 * populate the registry.
 *
 * Chess is NOT registered here - it bypasses the registry and is rendered
 * directly by ReplyContainer for instant streaming display.
 */
import './react';
import './html';
import './svg';
import './mermaid';
import './recharts';
import './code';
import './lattice';
import './python';
import './blogDraft';
