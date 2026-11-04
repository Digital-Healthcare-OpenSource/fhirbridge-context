/** Shared types and helpers for the free-text scrubber passes. */
import type { PhiCategory } from '../types/pipeline.js';
import type { SafeHarborVault } from './vault.js';

export type NameCategory = 'PATIENT' | 'PROVIDER' | 'PERSON';

/**
 * How free-text fields are handled: `scrub` pseudonymizes the PHI inside them, `omit` removes
 * them (and every decoded document) so only structured codes and values remain.
 */
export type FreeTextMode = 'scrub' | 'omit';

export interface KnownName {
  /**
   * ADDRESS entries are place terms (city, district, street) swept as whole phrases.
   * IDENTIFIER entries hold one structured identifier value (MRN, phone, email, plan id...) of
   * `idCategory`, swept from free text with digit normalization.
   */
  category: NameCategory | 'ADDRESS' | 'IDENTIFIER';
  variants: string[];
  /** Token category of an IDENTIFIER entry. */
  idCategory?: PhiCategory;
  /** Owner of a PATIENT name (defaults to the scrub context's patientKey). */
  patientKey?: string;
  /**
   * True for names discovered by cue heuristics (not taken from structured data). Only these
   * may be exempted as medical terminology ("Wilson disease"); registered names never are.
   */
  heuristic?: boolean;
}

export interface ScrubContext {
  vault: SafeHarborVault;
  patientKey?: string;
  now?: Date;
  knownNames?: readonly KnownName[];
  /**
   * Names of the OTHER patients in the graph, swept after `knownNames` so a cross-patient mention
   * is tokenized with that patient's own token. One list shared by every patient's context.
   */
  otherNames?: readonly KnownName[];
  dateShiftDays?: number;
  /** Receives every name discovered by a cue heuristic (for a second, consistent sweep). */
  onDiscovered?: (name: KnownName) => void;
}

export interface ScrubResult {
  text: string;
  counts: Partial<Record<PhiCategory, number>>;
  datesShifted: number;
  zip3Restricted: number;
  zip3Generalized: number;
}

/** Private-use delimiters for held (already finished) output. */
export const PH_OPEN = '';
export const PH_CLOSE = '';
const PH_RE = /([a-z]+)/g;

/** Holds finished output out of reach of later regex passes via private-use placeholders. */
export class Shield {
  private readonly items: string[] = [];
  hold(value: string): string {
    let n = this.items.push(value) - 1;
    let code = '';
    do {
      code = String.fromCharCode(97 + (n % 26)) + code;
      n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return `${PH_OPEN}${code}${PH_CLOSE}`;
  }
  restore(text: string): string {
    return text.replace(PH_RE, (_m, code: string) => {
      let n = 0;
      for (const ch of code) n = n * 26 + (ch.charCodeAt(0) - 96);
      return this.items[n - 1] ?? '';
    });
  }
}

export type Acc = Omit<ScrubResult, 'text'>;

export interface Run {
  ctx: ScrubContext;
  acc: Acc;
  shield: Shield;
  now: Date;
  days: number | undefined;
}

export const bump = (acc: Acc, category: PhiCategory): void => {
  acc.counts[category] = (acc.counts[category] ?? 0) + 1;
};
