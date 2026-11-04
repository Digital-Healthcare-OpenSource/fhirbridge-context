/**
 * HIPAA Safe Harbor geographic rule for ZIP codes.
 *
 * 45 CFR 164.514(b)(2)(i)(B): the first three digits of a ZIP code may be kept only if the
 * geographic unit formed by all ZIP codes sharing those digits contains more than 20,000
 * people (2000 Census data); otherwise the code must be changed to 000.
 *
 * These 17 ZIP3 areas are the ones at or below that population threshold (HHS guidance,
 * derived from the 2000 Census).
 */
export const RESTRICTED_ZIP3: ReadonlySet<string> = new Set([
  '036',
  '059',
  '063',
  '102',
  '203',
  '556',
  '692',
  '790',
  '821',
  '823',
  '830',
  '831',
  '878',
  '879',
  '884',
  '890',
  '893',
]);

export interface GeneralizedZip {
  /** `"00000"` for restricted areas / unrecognised formats, otherwise `"<ZIP3>XX"`. */
  value: string;
  /** True when the output is `"00000"`. */
  restricted: boolean;
}

const US_ZIP_RE = /^(\d{3})\d{2}(?:-?\d{4})?$/;

export function isRestrictedZip3(zip3: string): boolean {
  return RESTRICTED_ZIP3.has(zip3);
}

/**
 * Apply the Safe Harbor ZIP rule. 5- and 9-digit US ZIP codes keep their first three digits
 * (`"02138"` -> `"021XX"`) unless the area is restricted (-> `"00000"`). Any other postal
 * code format cannot be mapped to a ZIP3 area, so it is fully suppressed (`"00000"`).
 */
export function generalizeZip(zip: string): GeneralizedZip {
  const m = US_ZIP_RE.exec(zip.trim());
  const zip3 = m?.[1];
  if (zip3 === undefined || RESTRICTED_ZIP3.has(zip3)) return { value: '00000', restricted: true };
  return { value: `${zip3}XX`, restricted: false };
}
