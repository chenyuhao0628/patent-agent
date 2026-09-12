import type { Case, RemoteProcess } from './workflow.ts';

export type OfficialDeadlineSource = 'cpc' | 'official-document';
export type DeadlineProvenance = 'official' | 'baseland' | 'internal' | 'local' | 'missing';

export const DEADLINE_HEADER = '办理期限';
export const DEADLINE_LABELS = {
  official: '官方期限',
  baseland: '贝思兰德期限',
  internal: '内部期限',
  local: '自设日期',
  missing: '未提供',
} as const;
export const MS_PER_DAY = 86_400_000;

export type ProcessDeadlineInput = {
  name?: string;
  procCode?: string;
  officialDeadline?: string;
  officialDeadlineSource?: OfficialDeadlineSource | string;
  baselandDeadline?: string;
  internalDeadline?: string;
  deadline?: string;
};

export type ProcessDeadlineFacts = {
  officialDeadline?: string;
  officialDeadlineSource?: OfficialDeadlineSource;
  baselandDeadline?: string;
  internalDeadline?: string;
  deadline: string;
};

export type DeadlineView = {
  raw: string | null;
  ordinal: number | null;
  source: DeadlineProvenance;
  label: string;
  display: string;
};

const emptyFacts = (): ProcessDeadlineFacts => ({ deadline: '' });

export function isInitialApplication(process?: ProcessDeadlineInput): boolean {
  return process?.procCode === '105' || /提出申请/.test(process?.name ?? '');
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

/** Sanitize a calendar date. Trim first; invalid civil dates and the ambiguous generic deadline field are rejected. */
export function calendarDate(value: unknown): string {
  const raw = clean(value).trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return '';
  const year = Number(raw.slice(0, 4)), month = Number(raw.slice(5, 7)), day = Number(raw.slice(8, 10));
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return '';
  if (year < 1900 || year > 2200) return '';
  return raw;
}

export function localDayOrdinal(now: Date = new Date()): number {
  return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / MS_PER_DAY;
}

export function parseCalendarDay(value: string | null | undefined): number | null {
  const raw = calendarDate(value);
  if (!raw) return null;
  return Date.UTC(Number(raw.slice(0, 4)), Number(raw.slice(5, 7)) - 1, Number(raw.slice(8, 10))) / MS_PER_DAY;
}

export function formatCalendarDay(value: string): string {
  return value.slice(0, 10).replaceAll('-', '.');
}

function hasField(input: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function provenanceToken(input?: ProcessDeadlineInput): string {
  if (!input || !hasField(input, 'officialDeadlineSource')) return '';
  return typeof input.officialDeadlineSource === 'string' ? input.officialDeadlineSource.trim() : '';
}

function genuineOfficial(input?: ProcessDeadlineInput): { value: string; source: OfficialDeadlineSource } | undefined {
  if (!input) return undefined;
  const source = provenanceToken(input);
  if (source !== 'cpc' && source !== 'official-document') return undefined;
  const value = calendarDate(input.officialDeadline);
  if (!value) return undefined;
  return { value, source };
}

function touchedBaseland(input: ProcessDeadlineInput): boolean {
  return hasField(input, 'baselandDeadline') || (!provenanceToken(input) && hasField(input, 'officialDeadline'));
}

/** v023 officialDeadline with missing provenance was Baseland CaseProcLegalDate. Unknown supplied sources are not Baseland. Never use generic deadline. Internal applies only to the initial application. */
export function migrateProcessDeadlines(input: ProcessDeadlineInput): ProcessDeadlineFacts {
  const official = genuineOfficial(input);
  let baseland = calendarDate(input.baselandDeadline);
  if (!hasField(input, 'baselandDeadline') && !provenanceToken(input) && hasField(input, 'officialDeadline')) {
    baseland = calendarDate(input.officialDeadline);
  }
  const internal = calendarDate(input.internalDeadline);
  const officialDeadline = official?.value;
  return {
    officialDeadline,
    officialDeadlineSource: officialDeadline ? official?.source : undefined,
    baselandDeadline: baseland || undefined,
    internalDeadline: internal || undefined,
    deadline: isInitialApplication(input) ? internal : officialDeadline || baseland || '',
  };
}

/** Refresh Baseland values on the same process while keeping a genuine official date. */
export function mergeProcessDeadlines(previous: ProcessDeadlineInput | undefined, incoming: ProcessDeadlineInput): ProcessDeadlineFacts {
  const inc = migrateProcessDeadlines(incoming);
  const prev = previous ? migrateProcessDeadlines(previous) : emptyFacts();
  const officialDeadline = inc.officialDeadline || prev.officialDeadline;
  const officialDeadlineSource = inc.officialDeadline ? inc.officialDeadlineSource : officialDeadline ? prev.officialDeadlineSource : undefined;
  const baselandDeadline = touchedBaseland(incoming) ? inc.baselandDeadline : inc.baselandDeadline || prev.baselandDeadline;
  const internalDeadline = hasField(incoming, 'internalDeadline') ? inc.internalDeadline : inc.internalDeadline || prev.internalDeadline;
  return {
    officialDeadline,
    officialDeadlineSource,
    baselandDeadline,
    internalDeadline,
    deadline: isInitialApplication({...previous,...incoming}) ? internalDeadline || '' : officialDeadline || baselandDeadline || '',
  };
}

function keepOptionalField<K extends 'currentFlow' | 'needSendOfficial'>(merged: RemoteProcess, previous: RemoteProcess | undefined, incoming: RemoteProcess, key: K) {
  if (!Object.prototype.hasOwnProperty.call(incoming, key) && previous && Object.prototype.hasOwnProperty.call(previous, key)) {
    merged[key] = previous[key];
  }
}

export function mergeRemoteProcess(previous: RemoteProcess | undefined, incoming: RemoteProcess): RemoteProcess {
  const merged: RemoteProcess = { ...incoming, ...mergeProcessDeadlines(previous, incoming) };
  keepOptionalField(merged, previous, incoming, 'currentFlow');
  keepOptionalField(merged, previous, incoming, 'needSendOfficial');
  for (const key of ['flowRemark', 'officeNote', 'procNote', 'procCode'] as const) {
    if (!Object.prototype.hasOwnProperty.call(incoming, key) && previous?.[key] !== undefined) merged[key] = previous[key];
  }
  return merged;
}

export function currentRemoteProcess(c: Case): RemoteProcess | undefined {
  const processId = c.current?.processId;
  if (!processId) return undefined;
  return (c.remote?.processes ?? []).find(process => process.id === processId);
}

export function processDeadlineView(process: ProcessDeadlineInput | undefined): DeadlineView {
  if (!process) {
    return { raw: null, ordinal: null, source: 'missing', label: DEADLINE_HEADER, display: DEADLINE_LABELS.missing };
  }
  const facts = migrateProcessDeadlines(process);
  if (isInitialApplication(process)) {
    const raw = facts.internalDeadline || null;
    return { raw, ordinal: parseCalendarDay(raw), source: 'internal', label: DEADLINE_LABELS.internal, display: raw ? formatCalendarDay(raw) : DEADLINE_LABELS.missing };
  }
  if (facts.officialDeadline) {
    return {
      raw: facts.officialDeadline,
      ordinal: parseCalendarDay(facts.officialDeadline),
      source: 'official',
      label: DEADLINE_LABELS.official,
      display: formatCalendarDay(facts.officialDeadline),
    };
  }
  if (facts.baselandDeadline) {
    return {
      raw: facts.baselandDeadline,
      ordinal: parseCalendarDay(facts.baselandDeadline),
      source: 'baseland',
      label: DEADLINE_LABELS.baseland,
      display: formatCalendarDay(facts.baselandDeadline),
    };
  }
  return { raw: null, ordinal: null, source: 'missing', label: DEADLINE_HEADER, display: DEADLINE_LABELS.missing };
}

export function deadlineView(c: Case): DeadlineView {
  if (c.source === 'baseland') return processDeadlineView(currentRemoteProcess(c));
  const ordinal = parseCalendarDay(c.deadline);
  if (ordinal === null) {
    return { raw: null, ordinal: null, source: 'local', label: DEADLINE_LABELS.local, display: '—' };
  }
  const raw = calendarDate(c.deadline);
  return { raw, ordinal, source: 'local', label: DEADLINE_LABELS.local, display: formatCalendarDay(raw) };
}

export function deadlineFieldLabel(c: Case): string {
  if (c.source === 'local') return DEADLINE_LABELS.local;
  const due = deadlineView(c);
  return due.ordinal === null ? DEADLINE_HEADER : due.label;
}

export function deadlineFieldValue(c: Case): string {
  const due = deadlineView(c);
  if (due.ordinal === null || due.display === '—') return DEADLINE_LABELS.missing;
  return due.display;
}

export function applyCaseDeadline(c: Case): void {
  if (c.source !== 'baseland') return;
  c.deadline = deadlineView(c).raw ?? '';
}

export function effectiveDeadlineRaw(process: ProcessDeadlineInput | undefined): string {
  return processDeadlineView(process).raw ?? '';
}
