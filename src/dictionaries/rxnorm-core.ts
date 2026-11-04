/**
 * Small RxNorm dictionary for common outpatient drugs.
 *
 * Only RxCUIs that are well established are listed; every other ingredient is identified by
 * name alone (no code) rather than guessing a code.
 */

export const RXNORM_SYSTEM = 'http://www.nlm.nih.gov/research/umls/rxnorm';

/** Lowercase brand name → generic ingredient name. */
export const BRAND_TO_INGREDIENT: Readonly<Record<string, string>> = {
  glucophage: 'Metformin',
  glumetza: 'Metformin',
  fortamet: 'Metformin',
  lipitor: 'Atorvastatin',
  crestor: 'Rosuvastatin',
  zocor: 'Simvastatin',
  zestril: 'Lisinopril',
  prinivil: 'Lisinopril',
  norvasc: 'Amlodipine',
  synthroid: 'Levothyroxine',
  levoxyl: 'Levothyroxine',
  lasix: 'Furosemide',
  demadex: 'Torsemide',
  coumadin: 'Warfarin',
  jantoven: 'Warfarin',
  eliquis: 'Apixaban',
  xarelto: 'Rivaroxaban',
  plavix: 'Clopidogrel',
  brilinta: 'Ticagrelor',
  spiriva: 'Tiotropium',
  ditropan: 'Oxybutynin',
  cozaar: 'Losartan',
  diovan: 'Valsartan',
  lopressor: 'Metoprolol',
  toprol: 'Metoprolol',
  tenormin: 'Atenolol',
  prilosec: 'Omeprazole',
  nexium: 'Esomeprazole',
  protonix: 'Pantoprazole',
  neurontin: 'Gabapentin',
  zoloft: 'Sertraline',
  lexapro: 'Escitalopram',
  prozac: 'Fluoxetine',
  ventolin: 'Albuterol',
  proair: 'Albuterol',
  advil: 'Ibuprofen',
  motrin: 'Ibuprofen',
  tylenol: 'Acetaminophen',
  lantus: 'Insulin Glargine',
  januvia: 'Sitagliptin',
  jardiance: 'Empagliflozin',
  deltasone: 'Prednisone',
  zyrtec: 'Cetirizine',
  singulair: 'Montelukast',
  xanax: 'Alprazolam',
  ativan: 'Lorazepam',
  flomax: 'Tamsulosin',
  aldactone: 'Spironolactone',
};

/** Lowercase ingredient name → ingredient-level RxCUI (only where confident). */
export const INGREDIENT_RXCUI: Readonly<Record<string, string>> = {
  metformin: '6809',
  atorvastatin: '83367',
  simvastatin: '36567',
  lisinopril: '29046',
  amlodipine: '17767',
  levothyroxine: '10582',
  furosemide: '4603',
  torsemide: '38413',
  warfarin: '11289',
  apixaban: '1364430',
  rivaroxaban: '1114195',
  clopidogrel: '32968',
  ticagrelor: '1116632',
  tiotropium: '69120',
  losartan: '52175',
  omeprazole: '7646',
  gabapentin: '25480',
  sertraline: '36437',
  albuterol: '435',
  ibuprofen: '5640',
  acetaminophen: '161',
  prednisone: '8640',
};

/** Ingredients known by name only (no code asserted). */
const NAME_ONLY_INGREDIENTS: readonly string[] = [
  'rosuvastatin', 'oxybutynin', 'valsartan', 'metoprolol', 'atenolol', 'esomeprazole',
  'pantoprazole', 'escitalopram', 'fluoxetine', 'insulin glargine', 'sitagliptin',
  'empagliflozin', 'cetirizine', 'montelukast', 'alprazolam', 'lorazepam', 'tamsulosin',
  'spironolactone', 'hydrochlorothiazide', 'carvedilol', 'pravastatin', 'aspirin',
];

/** `"<ingredient> <strength>"` (lowercase) → clinical-drug RxCUI. */
export const PRODUCT_RXCUI: Readonly<Record<string, string>> = {
  'metformin 500 mg': '861007',
};

/**
 * Codes seen mislabeled in synthetic datasets (Synthea / HAPI) or otherwise well known:
 * RxCUI → the ingredient that code really denotes.
 */
export const KNOWN_CODE_DISPLAY_CONFLICTS: Readonly<Record<string, string>> = {
  '1116634': 'ticagrelor',
  '198369': 'torsemide',
  '861007': 'metformin',
  '6809': 'metformin',
};

const KNOWN_INGREDIENTS: ReadonlySet<string> = new Set([
  ...Object.keys(INGREDIENT_RXCUI),
  ...NAME_ONLY_INGREDIENTS,
]);

const WORD_RE = /[a-z][a-z-]*/g;

export interface IngredientMatch {
  ingredient: string;
  /** Brand that was matched, if the text used a trade name. */
  brand?: string;
}

/** Find the first brand or ingredient word in free text. */
export function findIngredient(text: string): IngredientMatch | undefined {
  const lower = text.toLowerCase();
  for (const word of lower.match(WORD_RE) ?? []) {
    const generic = BRAND_TO_INGREDIENT[word];
    if (generic) return { ingredient: generic, brand: word };
    if (KNOWN_INGREDIENTS.has(word)) return { ingredient: capitalize(word) };
  }
  return undefined;
}

export function ingredientRxcui(ingredient: string): string | undefined {
  return INGREDIENT_RXCUI[ingredient.toLowerCase()];
}

export function productRxcui(ingredient: string, strength: string | undefined): string | undefined {
  if (!strength) return undefined;
  return PRODUCT_RXCUI[`${ingredient} ${strength}`.toLowerCase()];
}

/** True if `text` names the ingredient, or one of its brands. */
export function textNamesIngredient(text: string, ingredient: string): boolean {
  const lower = text.toLowerCase();
  const target = ingredient.toLowerCase();
  if (lower.includes(target)) return true;
  return Object.entries(BRAND_TO_INGREDIENT).some(
    ([brand, generic]) => generic.toLowerCase() === target && lower.includes(brand),
  );
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}
