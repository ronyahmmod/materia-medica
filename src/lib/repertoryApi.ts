import { auth } from '../firebase';
import { REPERTORY_CHAPTERS, type RepertoryChapter, type RepertoryEntry } from '../types/clinic';

export type RemedySeverityGrade = 1 | 2 | 3;

export interface QuickSearchSuggestion {
  chapter: RepertoryChapter;
  rubric: string;
  primaryRemedy: string;
  primaryGrade?: RemedySeverityGrade;
  differentialRemedies: string[];
  remedyGrades?: Record<string, RemedySeverityGrade>;
  modalities: string;
  rationale: string;
}

export interface QuickSearchResponse {
  interpretedSymptoms: string;
  matchedSavedEntryIds: string[];
  suggestions: QuickSearchSuggestion[];
}

function normalizeChapterValue(raw: unknown): RepertoryChapter {
  if (typeof raw === 'string') {
    const match = REPERTORY_CHAPTERS.find(
      (chap) => chap.toLowerCase() === raw.trim().toLowerCase()
    );
    if (match) return match;
  }
  return 'Generalities';
}

function normalizeGradeValue(raw: unknown, fallback: RemedySeverityGrade): RemedySeverityGrade {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const rounded = Math.round(raw);
    if (rounded >= 3) return 3;
    if (rounded === 2) return 2;
    if (rounded <= 1) return 1;
  }
  return fallback;
}

function isTokenParseErrorMessage(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes('unexpected token') ||
    lower.includes('not valid json') ||
    lower.includes('unexpected end of json') ||
    lower.includes('json.parse')
  );
}

class HtmlProxyResponseError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function parseApiJsonResponse(
  response: Response,
  fallbackError: string
): Promise<Record<string, unknown>> {
  let rawText = '';
  try {
    rawText = await response.text();
  } catch {
    throw new Error(fallbackError);
  }

  const cleaned = rawText
    .replace(/^\uFEFF/, '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  let parsed: unknown = null;
  if (cleaned) {
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      if (cleaned.startsWith('<')) {
        throw new HtmlProxyResponseError(
          response.status,
          `The clinical search server is restarting or temporarily unavailable (HTTP ${response.status}). Please wait a moment and try again.`
        );
      }
      throw new Error(fallbackError);
    }
  }

  if (!response.ok) {
    const rawErrMsg =
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      typeof (parsed as Record<string, unknown>).error === 'string'
        ? ((parsed as Record<string, unknown>).error as string).trim()
        : '';
    if (rawErrMsg && !isTokenParseErrorMessage(rawErrMsg)) {
      throw new Error(rawErrMsg);
    }
    throw new Error(fallbackError);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(fallbackError);
  }

  return parsed as Record<string, unknown>;
}

function normalizeQuickSearchResponse(
  raw: Record<string, unknown>,
  queryText: string
): QuickSearchResponse {
  const interpretedSymptoms =
    typeof raw.interpretedSymptoms === 'string' && raw.interpretedSymptoms.trim()
      ? raw.interpretedSymptoms.trim()
      : `Clinical repertory matches for "${queryText}"`;

  const matchedSavedEntryIds = Array.isArray(raw.matchedSavedEntryIds)
    ? raw.matchedSavedEntryIds.filter(
        (id): id is string => typeof id === 'string' && id.trim().length > 0
      )
    : [];

  const suggestions: QuickSearchSuggestion[] = Array.isArray(raw.suggestions)
    ? raw.suggestions
        .map((item): QuickSearchSuggestion | null => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
          const rec = item as Record<string, unknown>;
          const rubric = typeof rec.rubric === 'string' ? rec.rubric.trim() : '';
          const primaryRemedy =
            typeof rec.primaryRemedy === 'string' ? rec.primaryRemedy.trim() : '';
          if (!rubric || !primaryRemedy) return null;

          const primaryGrade = normalizeGradeValue(rec.primaryGrade, 3);
          const differentialRemedies = Array.isArray(rec.differentialRemedies)
            ? rec.differentialRemedies
                .filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
                .map((r) => r.trim())
            : [];

          const remedyGrades: Record<string, RemedySeverityGrade> = {
            [primaryRemedy.toLowerCase()]: primaryGrade,
          };
          if (rec.remedyGrades && typeof rec.remedyGrades === 'object' && !Array.isArray(rec.remedyGrades)) {
            for (const [k, v] of Object.entries(rec.remedyGrades as Record<string, unknown>)) {
              const key = k.trim().toLowerCase();
              if (key) {
                remedyGrades[key] = normalizeGradeValue(v, 2);
              }
            }
          }

          return {
            chapter: normalizeChapterValue(rec.chapter),
            rubric,
            primaryRemedy,
            primaryGrade,
            differentialRemedies,
            remedyGrades,
            modalities: typeof rec.modalities === 'string' ? rec.modalities.trim() : '',
            rationale: typeof rec.rationale === 'string' ? rec.rationale.trim() : '',
          };
        })
        .filter((item): item is QuickSearchSuggestion => item !== null)
    : [];

  return {
    interpretedSymptoms,
    matchedSavedEntryIds,
    suggestions,
  };
}

function waitAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  externalSignal?: AbortSignal
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;

  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }

  const timer = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (timedOut) {
      throw new Error(
        'Search request timed out. Please try shorter symptom keywords or retry.'
      );
    }
    throw err;
  } finally {
    window.clearTimeout(timer);
    if (externalSignal) {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }
}

async function fetchApiJsonWithRetry(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fallbackError: string,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  try {
    const response = await fetchWithTimeout(url, init, timeoutMs, signal);
    return await parseApiJsonResponse(response, fallbackError);
  } catch (err) {
    if (err instanceof HtmlProxyResponseError && !signal?.aborted) {
      await waitAbortable(1500, signal);
      const retryResponse = await fetchWithTimeout(url, init, timeoutMs, signal);
      return await parseApiJsonResponse(retryResponse, fallbackError);
    }
    throw err;
  }
}

export async function runRepertoryQuickSearch(
  queryText: string,
  savedEntries: RepertoryEntry[],
  language: 'en' | 'bn' = 'en',
  signal?: AbortSignal
): Promise<QuickSearchResponse> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('Admin sign-in is required.');
  }

  const token = await user.getIdToken();
  const compactEntries = savedEntries.slice(0, 40).map((entry) => ({
    id: entry.id,
    chapter: entry.chapter,
    rubric: entry.rubric,
    primaryRemedy: entry.primaryRemedy,
  }));

  const payload = await fetchApiJsonWithRetry(
    '/api/repertory/quick-search',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        query: queryText,
        savedEntries: compactEntries,
        language,
      }),
    },
    30_000,
    'Unable to run Quick Search right now. Please try again.',
    signal
  );
  return normalizeQuickSearchResponse(payload, queryText);
}

export interface RemedyComparisonRow {
  dimension: string;
  remedyAValue: string;
  remedyBValue: string;
  keyContrast: string;
}

export interface RemedyComparisonResponse {
  remedyA: string;
  remedyB: string;
  differentiationSummary: string;
  rows: RemedyComparisonRow[];
}

export async function compareHomeopathicRemedies(
  remedyA: string,
  remedyB: string,
  clinicalContext?: string,
  language: 'en' | 'bn' = 'en',
  signal?: AbortSignal
): Promise<RemedyComparisonResponse> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('Admin sign-in is required.');
  }

  const token = await user.getIdToken();
  const payload = await fetchApiJsonWithRetry(
    '/api/repertory/compare',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        remedyA,
        remedyB,
        clinicalContext: clinicalContext?.trim() || '',
        language,
      }),
    },
    26_000,
    'Unable to generate remedy comparison right now. Please try again.',
    signal
  );

  const normalizedA =
    typeof payload.remedyA === 'string' && payload.remedyA.trim()
      ? payload.remedyA.trim()
      : remedyA;
  const normalizedB =
    typeof payload.remedyB === 'string' && payload.remedyB.trim()
      ? payload.remedyB.trim()
      : remedyB;
  const differentiationSummary =
    typeof payload.differentiationSummary === 'string' && payload.differentiationSummary.trim()
      ? payload.differentiationSummary.trim()
      : `Clinical differentiation between ${normalizedA} and ${normalizedB}.`;

  const rows: RemedyComparisonRow[] = Array.isArray(payload.rows)
    ? payload.rows
        .map((raw): RemedyComparisonRow | null => {
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
          const r = raw as Record<string, unknown>;
          const dimension = typeof r.dimension === 'string' ? r.dimension.trim() : '';
          const remedyAValue = typeof r.remedyAValue === 'string' ? r.remedyAValue.trim() : '';
          const remedyBValue = typeof r.remedyBValue === 'string' ? r.remedyBValue.trim() : '';
          const keyContrast = typeof r.keyContrast === 'string' ? r.keyContrast.trim() : '';
          if (!dimension || !remedyAValue || !remedyBValue) return null;
          return { dimension, remedyAValue, remedyBValue, keyContrast };
        })
        .filter((item): item is RemedyComparisonRow => item !== null)
    : [];

  if (rows.length === 0) {
    throw new Error('Unable to parse structured comparison rows. Please try again.');
  }

  return {
    remedyA: normalizedA,
    remedyB: normalizedB,
    differentiationSummary,
    rows,
  };
}

export interface NoteRepertorySuggestion {
  chapter: RepertoryChapter;
  rubric: string;
  keyRemedies: string[];
  matchReason: string;
}

export interface NoteRepertorySuggestionResponse {
  suggestions: NoteRepertorySuggestion[];
}

export async function fetchNoteRepertorySuggestions(
  text: string,
  focusArea: string,
  language: 'en' | 'bn' = 'en',
  signal?: AbortSignal
): Promise<NoteRepertorySuggestionResponse> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('Admin sign-in is required.');
  }

  const token = await user.getIdToken();
  const response = await fetch('/api/repertory/note-suggestions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    signal,
    body: JSON.stringify({
      text,
      focusArea,
      language,
    }),
  });

  const payload = await parseApiJsonResponse(
    response,
    'Unable to load repertory symptom suggestions.'
  );

  const suggestions: NoteRepertorySuggestion[] = Array.isArray(payload.suggestions)
    ? payload.suggestions
        .map((raw): NoteRepertorySuggestion | null => {
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
          const rec = raw as Record<string, unknown>;
          const rubric = typeof rec.rubric === 'string' ? rec.rubric.trim() : '';
          if (!rubric) return null;
          const keyRemedies = Array.isArray(rec.keyRemedies)
            ? rec.keyRemedies
                .filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
                .map((r) => r.trim())
            : [];
          const matchReason =
            typeof rec.matchReason === 'string' ? rec.matchReason.trim() : '';
          return {
            chapter: normalizeChapterValue(rec.chapter),
            rubric,
            keyRemedies,
            matchReason,
          };
        })
        .filter((item): item is NoteRepertorySuggestion => item !== null)
    : [];

  return { suggestions };
}




