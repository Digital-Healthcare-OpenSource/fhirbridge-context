/** Cue patterns that discover person names in free text (Latin, CJK, Hangul, Vietnamese). */
import { ci } from './scrub-patterns.js';

/** Capitalized clinical/structural words that follow a cue but are not names. */
export const STOP_WORDS: ReadonlySet<string> = new Set([
  'dr', 'mr', 'mrs', 'ms', 'miss', 'prof', 'professor', 'a', 'an', 'the', 'and', 'or', 'of', 'with', 'without', 'for', 'to', 'in', 'on', 'at', 'is', 'was',
  'has', 'had', 'have', 'denies', 'reports', 'presents', 'presented', 'complains', 'states', 'history',
  'status', 'name', 'information', 'info', 'education', 'evaluation', 'eval', 'note', 'notes', 'report',
  'summary', 'visit', 'encounter', 'admitted', 'discharged', 'placed', 'seen', 'treated', 'referred',
  'transferred', 'diagnosed', 'noted', 'found', 'underwent', 'received', 'started', 'stopped', 'will',
  'should', 'would', 'could', 'can', 'did', 'does', 'not', 'no', 'yes', 'age', 'sex', 'male', 'female',
  'man', 'woman', 'boy', 'girl', 'child', 'infant', 'adult', 'elderly', 'family', 'chart', 'record',
  'records', 'number', 'id', 'dob', 'mrn', 'zip', 'phone', 'address', 'email', 'today', 'yesterday',
  'tomorrow', 'now', 'currently', 'recently', 'previously', 'follow', 'follows', 'plan', 'assessment',
  'diagnosis', 'procedure', 'medication', 'medications', 'allergies', 'vitals', 'exam', 'examination',
  'complaint', 'chief', 'reason', 'results', 'result', 'lab', 'labs', 'imaging', 'physical', 'therapy',
  'unit', 'floor', 'room', 'bed', 'department', 'hospital', 'clinic', 'center', 'service', 'team',
  'practitioner', 'doctor', 'nurse', 'physician', 'attending', 'resident', 'provider', 'patient',
]);

const NAME_WORD = String.raw`\p{Lu}[\p{L}'’-]{0,40}`;
export const NAME_PAT = String.raw`(?:${NAME_WORD},\s{1,3}${NAME_WORD}(?:\s{1,3}\p{Lu}\.)?|${NAME_WORD}(?:\s{1,3}(?:\p{Lu}\.(?=\s)|${NAME_WORD})){0,2})`;
const NAME_PAT_LONG = String.raw`${NAME_WORD}(?:\s{1,3}${NAME_WORD}){0,3}`;

export const TITLE_CUE_RE = new RegExp(
  String.raw`(?<pre>\b(?<cue>${['Dr', 'Doctor', 'Mrs', 'Mr', 'Ms', 'Miss', 'Professor', 'Prof'].map(ci).join('|')})\b\.?[ \t]{0,3})(?<name>${NAME_PAT})`,
  'gu',
);
const BY_VERBS =
  'note|report|summary|signed|seen|dictated|reviewed|authored|performed|prescribed|referred|examined|entered|cosigned|transcribed|ordered|read|interpreted';
const WEAK_CUES = [
  `${ci('Patient')}(?:\\s{1,3}${ci('Name')})?`,
  ci('Pt'),
  `(?:${BY_VERBS.split('|').map(ci).join('|')})\\s{1,3}(?:${ci('electronically')}\\s{1,3})?${ci('by')}`,
  ...['Attending', 'Provider', 'Physician', 'Author', 'Surgeon', 'Resident', 'Nurse', 'Referring', 'Ordering', 'Signed', 'PCP'].map(ci),
];
export const WEAK_CUE_RE = new RegExp(
  String.raw`(?<pre>\b(?<cue>${WEAK_CUES.join('|')})\b[ \t]{0,3}[:-]?[ \t]{0,3})(?<name>${NAME_PAT})`,
  'gu',
);
const CREDENTIAL = String.raw`(?=,?\s{1,3}(?:M\.?D\.?|D\.?O\.?|R\.?N\.?|N\.?P\.?|PA-C|Ph\.?D\.?|PharmD|DDS|DMD|MBBS|FACS|FACC)(?![\p{L}]))`;
export const CREDENTIAL_NAME_RES: RegExp[] = [
  new RegExp(String.raw`(?<![\p{L}'’-])(?<pre>)(?<name>${NAME_WORD},\s{1,3}${NAME_WORD}(?:\s{1,3}\p{Lu}\.)?)${CREDENTIAL}`, 'gu'),
  new RegExp(String.raw`(?<![\p{L}'’-])(?<pre>)(?<name>${NAME_WORD}(?:\s{1,3}(?:\p{Lu}\.(?=\s)|${NAME_WORD})){0,2})${CREDENTIAL}`, 'gu'),
];

/** Relationship cues: the capitalized words that follow are a PERSON. */
const RELATION_CUES = [
  'wife', 'husband', 'spouse', 'partner', 'son', 'daughter', 'mother', 'father', 'mom', 'dad',
  'brother', 'sister', 'sibling', 'aunt', 'uncle', 'cousin', 'grandson', 'granddaughter',
  'grandmother', 'grandfather', 'neighbor', 'neighbour', 'friend', 'caregiver', 'guardian',
  'fiancé', 'fiancée', 'fiance', 'fiancee', 'niece', 'nephew', 'stepson', 'stepdaughter',
];
export const RELATION_CUE_RE = new RegExp(
  String.raw`(?<pre>(?<![\p{L}])(?<cue>${RELATION_CUES.map(ci).join('|')})(?:['’]s)?(?![\p{L}])[ \t]{0,3}[:,-]?[ \t]{0,3})(?<name>${NAME_PAT})`,
  'gu',
);

/** Vietnamese address-term cues followed by 1-4 capitalized words. */
export const VI_CUE_RE = new RegExp(
  String.raw`(?<pre>(?<![\p{L}])(?<cue>${['bệnh nhân', 'BN', 'anh', 'chị', 'ông', 'bà'].map(ci).join('|')})(?![\p{L}])[ \t.:]{0,3})(?<name>${NAME_PAT_LONG})`,
  'gu',
);

const CJK_CHARS = String.raw`[\p{Script=Han}\p{Script=Katakana}々ー]`;
/** Japanese: patient/name-label cue then a 2-6 char name run. */
export const JA_CUE_RE = new RegExp(String.raw`(?<pre>(?:患者|氏名|氏)[\s:：の　]{0,3})(?<name>${CJK_CHARS}{2,6})`, 'gu');
/** Japanese: name run directly before an honorific. */
export const JA_HONORIFIC_RE = new RegExp(String.raw`(?<pre>)(?<name>${CJK_CHARS}{2,6})(?=様|さん|氏)`, 'gu');
/** Korean: patient cue then a 2-4 syllable name. */
export const KO_CUE_RE = /(?<pre>환자[\s:：]{0,3})(?<name>\p{Script=Hangul}{2,4})/gu;
/** Korean: name directly before an honorific. */
export const KO_HONORIFIC_RE = /(?<pre>)(?<name>\p{Script=Hangul}{2,4})(?=\s?(?:씨|님))/gu;

/** CJK/Hangul words that follow cues/honorifics but are not names. */
const CJK_STOP = [
  '患者', '先生', '医師', '医者', '看護', '家族', '本人', '男性', '女性', '症状', '病歴', '既往', '診断',
  '治療', '状態', '年齢', '様子', '血圧', '体温', '検査', '結果', '入院', '退院', '来院', '主訴', '皆',
  '환자', '선생', '의사', '간호', '보호자', '가족', '본인', '증상', '진단', '병력', '치료', '상태', '나이',
  '검사', '결과', '입원', '퇴원', '여러분', '고객',
];
export const isCjkStopWord = (run: string): boolean => CJK_STOP.some((w) => run.startsWith(w));

export const HAS_CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
