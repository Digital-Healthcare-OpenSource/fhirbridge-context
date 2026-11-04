/** Markup (HTML/XML) and RTF to plain text. Pure string functions, no I/O. */

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (match, dec, hex, name) => {
    const named = typeof name === 'string' ? NAMED_ENTITIES[name.toLowerCase()] : undefined;
    if (named !== undefined) return named;
    const cp = dec ? Number(dec) : hex ? parseInt(hex, 16) : Number.NaN;
    const valid = Number.isInteger(cp) && cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff);
    return valid ? String.fromCodePoint(cp) : match;
  });
}

export const collapseWhitespace = (text: string): string => text.replace(/\s+/g, ' ').trim();

export function stripMarkup(markup: string, joinInline = true): string {
  const stripped = markup
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[?!][^>]*>/g, ' ')
    // HTML inline tags glue words together; XML elements always separate them.
    .replace(joinInline ? /<\/?(?:b|i|u|em|strong|span|font|a|sub|sup|small|big)\b[^>]*>/gi : /(?!)/g, '')
    .replace(/<[^>]*>/g, ' ');
  return collapseWhitespace(decodeEntities(stripped));
}

const RTF_SKIPPED_DESTINATIONS: ReadonlySet<string> = new Set([
  'fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'header', 'footer', 'object', 'themedata',
  'datastore', 'latentstyles', 'listtable', 'listoverridetable', 'rsidtbl', 'generator',
]);
const RTF_BREAK_WORDS: ReadonlySet<string> = new Set(['par', 'line', 'tab', 'row', 'cell', 'sect', 'page']);

export function stripRtf(rtf: string): string {
  let out = '';
  let skipping = false;
  const stack: boolean[] = [];
  let i = 0;
  let groupStart = false;
  while (i < rtf.length) {
    const ch = rtf.charAt(i);
    const wasGroupStart = groupStart;
    groupStart = false;
    if (ch === '{') {
      stack.push(skipping);
      groupStart = true;
      i += 1;
    } else if (ch === '}') {
      skipping = stack.pop() ?? false;
      i += 1;
    } else if (ch === '\\') {
      const next = rtf.charAt(i + 1);
      if (next === '\\' || next === '{' || next === '}') {
        if (!skipping) out += next;
        i += 2;
      } else if (next === '*') {
        if (wasGroupStart) skipping = true;
        i += 2;
      } else if (next === "'") {
        const code = parseInt(rtf.slice(i + 2, i + 4), 16);
        if (!skipping && Number.isFinite(code)) out += String.fromCharCode(code);
        i += 4;
      } else {
        const word = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(rtf.slice(i, i + 40));
        if (!word) {
          i += 2;
          continue;
        }
        const name = word[1] ?? '';
        if (wasGroupStart && RTF_SKIPPED_DESTINATIONS.has(name)) skipping = true;
        if (!skipping && RTF_BREAK_WORDS.has(name)) out += ' ';
        if (!skipping && name === 'u' && word[2]) {
          const unit = Number(word[2]);
          out += String.fromCharCode(unit < 0 ? unit + 65536 : unit);
          i += word[0].length + 1; // skip the single fallback character
          continue;
        }
        i += word[0].length;
      }
    } else {
      if (!skipping && ch !== '\r' && ch !== '\n') out += ch;
      i += 1;
    }
  }
  return collapseWhitespace(out);
}
