/**
 * Byte → text decoding for text-like attachments: honours BOMs and the `charset` parameter of the
 * content type, and refuses payloads that are not really text (NUL characters, mojibake).
 */

const MAX_REPLACEMENT_RATIO = 0.05;

/** Content-type charset names → TextDecoder labels. Unknown charsets fall back to UTF-8. */
const CHARSETS: Readonly<Record<string, string>> = {
  'utf-8': 'utf-8',
  utf8: 'utf-8',
  'utf-16': 'utf-16le',
  'utf-16le': 'utf-16le',
  ucs2: 'utf-16le',
  'ucs-2': 'utf-16le',
  'utf-16be': 'utf-16be',
  latin1: 'windows-1252',
  'iso-8859-1': 'windows-1252',
  'iso8859-1': 'windows-1252',
  'windows-1252': 'windows-1252',
  cp1252: 'windows-1252',
  'us-ascii': 'utf-8',
  ascii: 'utf-8',
};

function declaredCharset(rawContentType: string): string | undefined {
  const match = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(rawContentType);
  const name = match?.[1]?.toLowerCase();
  return name ? CHARSETS[name] : undefined;
}

function detectBom(bytes: Buffer): { label: string; skip: number } | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { label: 'utf-8', skip: 3 };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return { label: 'utf-16le', skip: 2 };
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return { label: 'utf-16be', skip: 2 };
  return undefined;
}

function decodeWith(label: string, bytes: Buffer): string {
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return bytes.toString('utf8');
  }
}

/**
 * Decode attachment bytes to text, or return `null` when the payload is not text
 * (contains NUL characters or more than 5% U+FFFD after decoding).
 */
export function decodeTextBytes(bytes: Buffer, rawContentType: string): string | null {
  const bom = detectBom(bytes);
  const label = bom?.label ?? declaredCharset(rawContentType) ?? 'utf-8';
  const text = decodeWith(label, bom ? bytes.subarray(bom.skip) : bytes);
  if (text.includes('\u0000')) return null;
  if (text.length > 0) {
    let replacements = 0;
    for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 0xfffd) replacements += 1;
    if (replacements / text.length > MAX_REPLACEMENT_RATIO) return null;
  }
  return text;
}
