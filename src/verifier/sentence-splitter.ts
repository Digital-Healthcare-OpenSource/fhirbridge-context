/**
 * Sentence segmentation for LLM output: handles bullets/ordinals, line breaks, `e.g.`/`Dr.`
 * and decimals (`7.8`), and re-attaches citation-only fragments (`. [Observation/x]`) to the
 * sentence they belong to.
 */

const LIST_MARKER_RE = /^\s*(?:#{1,6}\s+|[-*•>]+\s+|\d{1,3}[.)]\s+)/;
const ABBREVIATION_TAIL_RE = /(?:^|[^A-Za-z])(?:e\.g|i\.e|dr|mr|mrs|ms|vs|etc|approx|inc|st|no|fig)$/i;
const ANCHOR_RE = /\[[A-Z][A-Za-z]+\/[A-Za-z0-9\-.]{1,64}\]/g;

function splitLine(line: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  for (const m of line.matchAll(/[.!?]+(?=\s+\S)/g)) {
    const end = m.index + m[0].length;
    const before = line.slice(start, m.index);
    const next = line.slice(end).trimStart().charAt(0);
    if (m[0] === '.' && ABBREVIATION_TAIL_RE.test(before)) continue;
    if (/[a-z]/.test(next)) continue;
    sentences.push(line.slice(start, end).trim());
    start = end;
  }
  const rest = line.slice(start).trim();
  if (rest !== '') sentences.push(rest);
  return sentences;
}

/** True when the fragment holds nothing but citation anchors and punctuation. */
function isAnchorOnly(fragment: string): boolean {
  return fragment.match(ANCHOR_RE) !== null && fragment.replace(ANCHOR_RE, '').replace(/[\s.,;:()]/g, '') === '';
}

export function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(LIST_MARKER_RE, '').trim();
    if (line === '') continue;
    for (const sentence of splitLine(line)) {
      const previous = out[out.length - 1];
      if (previous !== undefined && isAnchorOnly(sentence)) out[out.length - 1] = `${previous} ${sentence}`;
      else out.push(sentence);
    }
  }
  return out;
}
