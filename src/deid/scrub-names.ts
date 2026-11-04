/**
 * Name pass of the free-text scrubber.
 *
 * Order: (1) names registered for the record owner (+ providers, place terms, discoveries from a
 * previous pass), (2) names of the OTHER patients in the graph, tokenized with their own tokens,
 * (3) cue-discovered names ("wife Karen", "Dr. Wilson"), swept again over the rest of the text.
 * See name-matcher.ts for the matching rules and scrub-name-cues.ts for the cues.
 */
import { cueNames } from './scrub-name-cues.js';
import { matcherFor, sweepNames, type NameEntry } from './name-matcher.js';
import type { Run } from './scrub-types.js';

export { foldWithMap } from './name-folding.js';

/** Shield tokens already issued so name sweeps cannot touch them. */
const TOKEN_RE = /\[[A-Z_]+_\d+\]/g;

/** "Torres, Michael" swept part-by-part would read "[PATIENT_1], [PATIENT_1]": collapse. */
const collapseRepeats = (t: string): string => t.replace(/(\[[A-Z_]+_\d+\])(?:,?\s+\1)+/g, '$1');

export function scrubNames(text: string, run: Run): string {
  const shieldTokens = (t: string): string => t.replace(TOKEN_RE, (m) => run.shield.hold(m));
  let out = shieldTokens(text);
  if (run.ctx.knownNames?.length) out = sweepNames(out, matcherFor(run, run.ctx.knownNames, 'regex'), run);
  if (run.ctx.otherNames?.length) {
    out = sweepNames(shieldTokens(collapseRepeats(out)), matcherFor(run, run.ctx.otherNames, 'words'), run);
  }
  const found: NameEntry[] = [];
  return collapseRepeats(cueNames(shieldTokens(collapseRepeats(out)), run, found));
}
