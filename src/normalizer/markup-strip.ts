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

/** HTML inline tags glue words together; every other element separates them. */
const INLINE_TAGS: ReadonlySet<string> = new Set([
  'b', 'i', 'u', 'em', 'strong', 'span', 'font', 'a', 'sub', 'sup', 'small', 'big',
]);
const MAX_TAG_NAME = 32;

/** Lower-cased element name right after `<` or `</` (empty for `<!…`, `<?…`, stray `<`). */
function tagNameAt(markup: string, lt: number): string {
  let j = markup.charAt(lt + 1) === '/' ? lt + 2 : lt + 1;
  const start = j;
  while (j < markup.length && j - start < MAX_TAG_NAME && /[A-Za-z0-9]/.test(markup.charAt(j))) j += 1;
  return markup.slice(start, j).toLowerCase();
}

/**
 * Markup to plain text in one linear pass (every search moves strictly forward). CDATA content is
 * kept, comments and `script`/`style` bodies are dropped, inline tags join words, other tags
 * separate them, and a `<` with no closing `>` is kept as literal text.
 */
export function stripMarkup(markup: string, joinInline = true): string {
  const lower = markup.toLowerCase();
  const out: string[] = [];
  let i = 0;
  while (i < markup.length) {
    const lt = markup.indexOf('<', i);
    if (lt < 0) {
      out.push(markup.slice(i));
      break;
    }
    out.push(markup.slice(i, lt));
    if (markup.startsWith('<![CDATA[', lt)) {
      const end = markup.indexOf(']]>', lt + 9);
      out.push(end < 0 ? markup.slice(lt + 9) : markup.slice(lt + 9, end));
      i = end < 0 ? markup.length : end + 3;
      continue;
    }
    if (markup.startsWith('<!--', lt)) {
      const end = markup.indexOf('-->', lt + 4);
      if (end >= 0) {
        out.push(' ');
        i = end + 3;
        continue;
      }
    }
    const gt = markup.indexOf('>', lt + 1);
    if (gt < 0) {
      out.push(markup.slice(lt));
      break;
    }
    const name = tagNameAt(markup, lt);
    const isClosing = markup.charAt(lt + 1) === '/';
    if (!isClosing && (name === 'script' || name === 'style')) {
      const close = lower.indexOf(`</${name}`, gt + 1);
      const closeEnd = close < 0 ? -1 : markup.indexOf('>', close);
      out.push(' ');
      i = closeEnd < 0 ? markup.length : closeEnd + 1; // unterminated script/style: drop the rest
      continue;
    }
    out.push(joinInline && INLINE_TAGS.has(name) ? '' : ' ');
    i = gt + 1;
  }
  return collapseWhitespace(decodeEntities(out.join('')));
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
