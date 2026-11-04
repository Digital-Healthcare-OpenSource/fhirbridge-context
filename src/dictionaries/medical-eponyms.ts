/**
 * Medical allowlist: eponyms, devices, specialties, abbreviations and drug names that must
 * never be treated as a person's name by the clinical text scrubber.
 *
 * Matching is case-insensitive and tolerant of possessives ("Parkinson's") and hyphenated
 * compounds ("Swan-Ganz").
 */

/** Terms derived from people's surnames. They can ALSO be real surnames ("Dr. Wilson"). */
export const EPONYM_SURNAMES: readonly string[] = [
  'Foley', 'Swan', 'Ganz', 'Swan-Ganz', 'Broviac', 'Hickman', 'Whipple', 'Parkinson', 'Hodgkin',
  'Non-Hodgkin', 'Graves', 'Hashimoto', 'Crohn', 'Addison', 'Cushing', 'Wilson', 'Bell', 'Charcot',
  'Babinski', 'Glasgow', 'Apgar', 'Ringer', 'Alzheimer', 'Huntington', 'Down', 'Tourette',
  'Guillain-Barré', 'Guillain', 'Barré', 'Kawasaki', 'Raynaud', 'Sjögren', 'Bowman', 'Doppler',
  'Holter', 'Pap', 'Gram', 'Kaposi', 'Burkitt', 'Wernicke', 'Korsakoff', 'Barrett',
  'Wolff-Parkinson-White', 'Epley', 'Heimlich', 'Trendelenburg', 'Fowler', 'Mallory-Weiss',
  'Stevens-Johnson', 'Marfan', 'Paget', 'Hirschsprung', 'Meniere', 'Ménière', 'Bartholin',
  'Achilles', 'Foley’s', 'Cheyne-Stokes', 'Duchenne', 'Asperger', 'Behçet',
  'Brudzinski', 'Kernig', 'Romberg', 'Homans', 'McBurney', 'Valsalva', 'Heparin-Hock',
  'Hartmann', 'Billroth', 'Nissen', 'Roux-en-Y', 'Seldinger', 'Swan-Ganz', 'Tinel', 'Phalen',
  'Lhermitte', 'Horner', 'Argyll', 'Argyll-Robertson', 'Peyronie', 'Dupuytren', 'Colles',
  'Bankart', 'Lachman', 'McMurray', 'Apley', 'Graefe', 'Snellen', 'Rinne',
  'Dix-Hallpike', 'Hallpike', 'Mantoux', 'Wilms', 'Gleason', 'Breslow', 
  'Child-Pugh', 'Pugh', 'Framingham', 'Charlson', 'Karnofsky', 'Braden', 'Waterlow',
  'Mini-Cog', 'Rockall', 'Killip', 'Ranson', 'Apache', 'Sjogren', 
  'Paget-Schroetter', 'Legg-Calvé-Perthes', 'Osgood-Schlatter', 
  'Hurler', 'Tay-Sachs', 'Gaucher', 'Fabry', 'Pompe', 'Niemann-Pick', 'Klinefelter',
  'Noonan', 'Patau', 'Angelman', 'Prader-Willi', 'Rett', 'Bartter',
  'Gitelman', 'Sheehan', 'Dressler', 'Takotsubo', 'Brugada', 'Eisenmenger',
  'Fontan', 'Blalock-Taussig', 'Ebstein', 'Tetralogy', 'Wegener', 'Takayasu', 'Churg-Strauss',
  'Henoch-Schönlein', 'Goodpasture', 'Alport', 'Fanconi', 'Bence-Jones', 'Waldenström',
  'Reed-Sternberg', 'Ewing’s', 'Looser', 'Lugol', 'Hartmann’s', 'Ringer’s',
];

/** Devices, specialties, units and clinical abbreviations (not surname-derived). */
export const MEDICAL_TERMS: readonly string[] = [
  'Aline', 'A-line', 'Cardiology', 'Oncology', 'Neurology', 'Nephrology', 'Urology', 'Radiology',
  'Pathology', 'Psychiatry', 'Pediatrics', 'Paediatrics', 'Geriatrics', 'Gynecology', 'Obstetrics',
  'Orthopedics', 'Orthopaedics', 'Dermatology', 'Endocrinology', 'Gastroenterology', 'Hematology',
  'Haematology', 'Rheumatology', 'Pulmonology', 'Ophthalmology', 'Otolaryngology', 'ENT',
  'Anesthesiology', 'Anaesthesiology', 'Surgery', 'Neurosurgery', 'Hospitalist', 'Podiatry',
  'Immunology', 'Infectious', 'Palliative', 'Hospice', 'Rehabilitation', 'Physiotherapy',
  'ICU', 'NICU', 'PICU', 'CCU', 'ED', 'ER', 'OR', 'PACU', 'MICU', 'SICU', 'CICU', 'HDU', 'ICU/CCU',
  'MRI', 'CT', 'PET', 'EKG', 'ECG', 'EEG', 'EMG', 'CBC', 'BMP', 'CMP', 'LFT', 'TSH', 'INR', 'PT',
  'PTT', 'HbA1c', 'COPD', 'CHF', 'CAD', 'DM', 'HTN', 'CKD', 'ESRD', 'AKI', 'DVT', 'PE', 'MI', 'CVA',
  'TIA', 'GERD', 'UTI', 'URI', 'BPH', 'HIV', 'AIDS', 'TB', 'COVID', 'COVID-19', 'ARDS', 'SIRS',
  'CPAP', 'BiPAP', 'PEEP', 'PICC', 'CVC', 'NG', 'PEG', 'TPN', 'IV', 'IM', 'PO', 'PRN', 'BID', 'TID',
  'QID', 'QD', 'HPI', 'ROS', 'PMH', 'SOAP', 'DNR', 'DNI', 'NPO', 'STAT', 'SpO2', 'FiO2',
  'Catheter', 'Stent', 'Pacemaker', 'Defibrillator', 'Ventilator', 'Intubation', 'Tracheostomy',
  'Lactated', 'Normal', 'Saline', 'Dextrose', 'Ringers', 'Lymphoma', 'Leukemia', 'Melanoma',
  'Sarcoma', 'Carcinoma', 'Mellitus', 'Diabetes', 'Hypertension', 'Syndrome', 'Disease',
  'Sepsis', 'Pneumonia', 'Asthma', 'Epilepsy', 'Migraine', 'Dementia', 'Anemia', 'Arthritis',
  'Hepatitis', 'Cirrhosis', 'Pancreatitis', 'Appendicitis', 'Cholecystitis', 'Colitis',
  'Staphylococcus', 'Streptococcus', 'Escherichia', 'Clostridium', 'Pseudomonas', 'Klebsiella',
  'Candida', 'Aspergillus', 'Helicobacter', 'MRSA', 'VRE',
];

/** Common generic (and a few brand) drug names. */
export const COMMON_DRUG_NAMES: readonly string[] = [
  'Perindopril', 'Lisinopril', 'Metformin', 'Enalapril', 'Ramipril', 'Captopril', 'Benazepril',
  'Quinapril', 'Fosinopril', 'Losartan', 'Valsartan', 'Candesartan', 'Irbesartan', 'Olmesartan',
  'Telmisartan', 'Amlodipine', 'Nifedipine', 'Felodipine', 'Diltiazem', 'Verapamil', 'Metoprolol',
  'Atenolol', 'Bisoprolol', 'Carvedilol', 'Propranolol', 'Nebivolol', 'Labetalol', 'Hydrochlorothiazide',
  'Chlorthalidone', 'Indapamide', 'Furosemide', 'Torsemide', 'Bumetanide', 'Spironolactone',
  'Eplerenone', 'Amiloride', 'Triamterene', 'Clonidine', 'Hydralazine', 'Minoxidil', 'Doxazosin',
  'Prazosin', 'Terazosin', 'Atorvastatin', 'Simvastatin', 'Rosuvastatin', 'Pravastatin', 'Lovastatin',
  'Pitavastatin', 'Ezetimibe', 'Fenofibrate', 'Gemfibrozil', 'Niacin', 'Aspirin', 'Clopidogrel',
  'Ticagrelor', 'Prasugrel', 'Warfarin', 'Heparin', 'Enoxaparin', 'Dalteparin', 'Apixaban',
  'Rivaroxaban', 'Dabigatran', 'Edoxaban', 'Digoxin', 'Amiodarone', 'Sotalol', 'Flecainide',
  'Propafenone', 'Dofetilide', 'Nitroglycerin', 'Isosorbide', 'Ranolazine', 'Ivabradine',
  'Sacubitril', 'Insulin', 'Glipizide', 'Glyburide', 'Glimepiride', 'Pioglitazone', 'Sitagliptin',
  'Linagliptin', 'Saxagliptin', 'Empagliflozin', 'Dapagliflozin', 'Canagliflozin', 'Liraglutide',
  'Semaglutide', 'Dulaglutide', 'Exenatide', 'Acarbose', 'Levothyroxine', 'Liothyronine',
  'Methimazole', 'Propylthiouracil', 'Prednisone', 'Prednisolone', 'Methylprednisolone',
  'Dexamethasone', 'Hydrocortisone', 'Fludrocortisone', 'Budesonide', 'Fluticasone', 'Albuterol',
  'Salbutamol', 'Salmeterol', 'Formoterol', 'Tiotropium', 'Ipratropium', 'Montelukast',
  'Theophylline', 'Cetirizine', 'Loratadine', 'Fexofenadine', 'Diphenhydramine', 'Hydroxyzine',
  'Omeprazole', 'Esomeprazole', 'Pantoprazole', 'Lansoprazole', 'Rabeprazole', 'Famotidine',
  'Ranitidine', 'Sucralfate', 'Ondansetron', 'Metoclopramide', 'Promethazine', 'Prochlorperazine',
  'Loperamide', 'Bisacodyl', 'Senna', 'Docusate', 'Lactulose', 'Polyethylene', 'Mesalamine',
  'Sulfasalazine', 'Azathioprine', 'Mercaptopurine', 'Methotrexate', 'Hydroxychloroquine',
  'Leflunomide', 'Adalimumab', 'Etanercept', 'Infliximab', 'Rituximab', 'Tacrolimus',
  'Cyclosporine', 'Mycophenolate', 'Sirolimus', 'Allopurinol', 'Febuxostat', 'Colchicine',
  'Ibuprofen', 'Naproxen', 'Diclofenac', 'Celecoxib', 'Meloxicam', 'Indomethacin', 'Ketorolac',
  'Acetaminophen', 'Paracetamol', 'Tramadol', 'Codeine', 'Morphine', 'Oxycodone', 'Hydrocodone',
  'Hydromorphone', 'Fentanyl', 'Methadone', 'Buprenorphine', 'Naloxone', 'Naltrexone', 'Gabapentin',
  'Pregabalin', 'Carbamazepine', 'Oxcarbazepine', 'Phenytoin', 'Valproate', 'Lamotrigine',
  'Levetiracetam', 'Topiramate', 'Lacosamide', 'Phenobarbital', 'Lorazepam', 'Diazepam',
  'Alprazolam', 'Clonazepam', 'Midazolam', 'Zolpidem', 'Temazepam', 'Melatonin', 'Sertraline',
  'Fluoxetine', 'Paroxetine', 'Citalopram', 'Escitalopram', 'Venlafaxine', 'Duloxetine',
  'Bupropion', 'Mirtazapine', 'Trazodone', 'Amitriptyline', 'Nortriptyline', 'Lithium',
  'Quetiapine', 'Olanzapine', 'Risperidone', 'Aripiprazole', 'Haloperidol', 'Clozapine',
  'Ziprasidone', 'Donepezil', 'Memantine', 'Rivastigmine', 'Levodopa', 'Carbidopa', 'Pramipexole',
  'Ropinirole', 'Rasagiline', 'Selegiline', 'Amantadine', 'Baclofen', 'Cyclobenzaprine',
  'Tizanidine', 'Methocarbamol', 'Sumatriptan', 'Rizatriptan', 'Amoxicillin', 'Ampicillin',
  'Penicillin', 'Piperacillin', 'Cephalexin', 'Cefazolin', 'Ceftriaxone', 'Cefepime', 'Cefuroxime',
  'Azithromycin', 'Clarithromycin', 'Erythromycin', 'Doxycycline', 'Minocycline', 'Ciprofloxacin',
  'Levofloxacin', 'Moxifloxacin', 'Gentamicin', 'Vancomycin', 'Linezolid', 'Clindamycin',
  'Metronidazole', 'Trimethoprim', 'Sulfamethoxazole', 'Nitrofurantoin', 'Meropenem', 'Imipenem',
  'Fluconazole', 'Voriconazole', 'Nystatin', 'Acyclovir', 'Valacyclovir', 'Oseltamivir',
  'Isoniazid', 'Rifampin', 'Ethambutol', 'Pyrazinamide', 'Tamsulosin', 'Finasteride', 'Oxybutynin',
  'Solifenacin', 'Sildenafil', 'Tadalafil', 'Estradiol', 'Progesterone', 'Medroxyprogesterone',
  'Tamoxifen', 'Anastrozole', 'Letrozole', 'Testosterone', 'Alendronate', 'Risedronate',
  'Raloxifene', 'Calcitriol', 'Cholecalciferol', 'Folic', 'Cyanocobalamin', 'Ferrous', 'Potassium',
  'Tylenol', 'Advil', 'Motrin', 'Lipitor', 'Coumadin', 'Lasix', 'Glucophage', 'Zestril', 'Norvasc',
];

const EPONYM_FOLLOWERS: ReadonlySet<string> = new Set([
  'disease', 'syndrome', 'lymphoma', 'lymphomas', 'catheter', 'line', 'lines', 'tube', 'score',
  'scale', 'solution', 'procedure', 'maneuver', 'manoeuvre', 'sign', 'reflex', 'test', 'smear',
  'stain', 'cell', 'cells', 'disorder', 'palsy', 'thyroiditis', 'coma', 'esophagus', 'oesophagus',
  'joint', 'monitor', 'ultrasound', 'sarcoma', 'tumor', 'tumour', 'triad', 'position', 'point',
  'law', 'canal', 'anemia', 'anaemia', 'cardiomyopathy', 'neuralgia', 'neuropathy', 'ophthalmopathy',
  'encephalopathy', 'psychosis', 'disorders', 'diseases', 'syndromes', 'index', 'criteria', 'class',
  'classification', 'grade', 'stage', 'repair', 'bypass', 'shunt', 'valve', 'block', 'fracture',
  'contracture', 'deformity', 'node', 'nodule', 'ulcer', 'colitis', 'ileitis', 'crisis', 'phenomenon',
  'induced', 'positive', 'negative', 'catheters', 'lactate', 'lactated',
]);

/** Lowercase, strip diacritics, edge punctuation and a possessive suffix. */
export function normalizeTerm(word: string): string {
  return word
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .replace(/['’]s$/u, '');
}

function toSet(lists: readonly (readonly string[])[]): Set<string> {
  const out = new Set<string>();
  for (const list of lists) {
    for (const term of list) {
      const n = normalizeTerm(term);
      if (n) out.add(n);
      for (const part of n.split(/[\s-]+/)) {
        if (part.length >= 4 && n.includes(' ')) out.add(part);
      }
    }
  }
  return out;
}

const SURNAME_SET = toSet([EPONYM_SURNAMES]);
const DRUG_SET = toSet([COMMON_DRUG_NAMES]);
const ALL_SET = toSet([EPONYM_SURNAMES, MEDICAL_TERMS, COMMON_DRUG_NAMES]);

/** Every allowlisted spelling (eponyms + devices + specialties + drugs). */
export const MEDICAL_EPONYMS: readonly string[] = [...EPONYM_SURNAMES, ...MEDICAL_TERMS];

function matches(set: ReadonlySet<string>, word: string): boolean {
  const n = normalizeTerm(word);
  if (!n) return false;
  if (set.has(n)) return true;
  return n.includes('-') && n.split('-').every((p) => set.has(p));
}

/** True for any eponym, device, specialty, abbreviation or drug name. */
export function isMedicalTerm(word: string): boolean {
  return matches(ALL_SET, word);
}

/** True for surname-derived eponyms that may also be a real person's surname. */
export function isEponymSurname(word: string): boolean {
  return matches(SURNAME_SET, word);
}

export function isDrugName(word: string): boolean {
  return matches(DRUG_SET, word);
}

/** True if `next` is a word that typically follows an eponym ("Wilson disease", "Foley catheter"). */
export function isEponymFollower(next: string | undefined): boolean {
  return next !== undefined && EPONYM_FOLLOWERS.has(normalizeTerm(next));
}
