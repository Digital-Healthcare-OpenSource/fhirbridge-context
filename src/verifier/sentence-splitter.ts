/**
 * Sentence segmentation for LLM output: handles bullets/ordinals, line breaks, `e.g.`/`Dr.`
 * and decimals (`7.8`), and re-attaches citation-only fragments (`. [Observation/x]`) to the
 * sentence they belong to.
 */

const LIST_MARKER_RE = /^\s*(?:#{1,6}\s+|[-*•>]+\s+|\d{1,3}[.)]\s+)/;
const ABBREVIATION_TAIL_RE = /(?:^|[^A-Za-z])(?:e\.g|i\.e|dr|mr|mrs|ms|vs|etc|approx|inc|st|no|fig)$/i;
const ANCHOR_RE = /\[[A-Z][A-Za-z]+\/[A-Za-z0-9\-.]{1,64}\]/g;

const isTerminator = (ch: string): boolean => ch === '.' || ch === '!' || ch === '?';
const isSpace = (ch: string): boolean => ch !== '' && /\s/.test(ch);

/**
 * Candidate sentence ends: a run of `.!?` followed by whitespace and then a non-space character.
 * A single forward scan (each character is visited a bounded number of times), instead of a
 * regex with a lookahead that is re-tried inside long runs of punctuation or whitespace.
 */
function* terminatorRuns(line: string): Generator<{ index: number; end: number; run: string }> {
  let i = 0;
  while (i < line.length) {
    if (!isTerminator(line.charAt(i))) {
      i += 1;
      continue;
    }
    const index = i;
    while (i < line.length && isTerminator(line.charAt(i))) i += 1;
    const end = i;
    let k = end;
    while (k < line.length && isSpace(line.charAt(k))) k += 1;
    if (k > end && k < line.length) yield { index, end, run: line.slice(index, end) };
    i = k;
  }
}

function splitLine(line: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  for (const m of terminatorRuns(line)) {
    const before = line.slice(start, m.index);
    const next = line.slice(m.end).trimStart().charAt(0);
    if (m.run === '.' && ABBREVIATION_TAIL_RE.test(before)) continue;
    if (/[a-z]/.test(next)) continue;
    sentences.push(line.slice(start, m.end).trim());
    start = m.end;
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
