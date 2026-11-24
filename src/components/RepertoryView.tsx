import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  deleteDoc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import {
  ArrowLeftRight,
  BookOpen,
  BookmarkPlus,
  Check,
  Edit3,
  History,
  Loader2,
  Plus,
  Scale,
  Search,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { auth, handleFirestoreError, OperationType } from '../firebase';
import { useLanguage } from '../i18n/LanguageContext';
import { REPERTORY_CHAPTER_LABELS_I18N } from '../i18n/translations';
import {
  compareHomeopathicRemedies,
  runRepertoryQuickSearch,
  type QuickSearchResponse,
  type QuickSearchSuggestion,
  type RemedyComparisonResponse,
  type RemedySeverityGrade,
} from '../lib/repertoryApi';
import {
  ACCENT_THEME_PALETTES,
  tenantRepertoryCol,
  tenantRepertoryDoc,
} from '../lib/tenantPaths';
import {
  COMMON_REMEDIES,
  FIELD_LIMITS,
  REPERTORY_CHAPTERS,
  type ClinicTenant,
  type RepertoryChapter,
  type RepertoryEntry,
} from '../types/clinic';

interface ClassicRubricSeed {
  chapter: RepertoryChapter;
  rubric: string;
  primaryRemedy: string;
  remedies: string[];
  modalities: string;
  symptomNotes: string;
}

interface RecentSymptomSearch {
  query: string;
  searchedAt: string;
  suggestionCount: number;
}

const RECENT_SEARCHES_STORAGE_KEY = 'materia_medica_repertory_recent_searches';
const MAX_RECENT_SEARCHES = 8;
const QUICK_SEARCH_DEBOUNCE_MS = 700;
const QUICK_SEARCH_MIN_CHARS = 4;
const LOCAL_SEARCH_DEBOUNCE_MS = 220;

function loadRecentSearches(): RecentSymptomSearch[] {
  try {
    const raw = window.localStorage.getItem(RECENT_SEARCHES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is RecentSymptomSearch =>
          Boolean(item) &&
          typeof item === 'object' &&
          !Array.isArray(item) &&
          typeof (item as RecentSymptomSearch).query === 'string' &&
          (item as RecentSymptomSearch).query.trim().length > 0 &&
          typeof (item as RecentSymptomSearch).searchedAt === 'string' &&
          !Number.isNaN(new Date((item as RecentSymptomSearch).searchedAt).getTime())
      )
      .map((item) => ({
        query: item.query.trim(),
        searchedAt: item.searchedAt,
        suggestionCount:
          typeof item.suggestionCount === 'number' && Number.isFinite(item.suggestionCount)
            ? Math.max(0, Math.round(item.suggestionCount))
            : 0,
      }))
      .slice(0, MAX_RECENT_SEARCHES);
  } catch {
    return [];
  }
}

function saveRecentSearches(items: RecentSymptomSearch[]): void {
  try {
    window.localStorage.setItem(RECENT_SEARCHES_STORAGE_KEY, JSON.stringify(items));
  } catch {
    // Ignore storage quota / privacy mode errors
  }
}

const STARTER_RUBRICS: ClassicRubricSeed[] = [
  {
    chapter: 'Mind',
    rubric: 'Anxiety about health with midnight restlessness (1–2 AM)',
    primaryRemedy: 'Arsenicum album',
    remedies: ['Arsenicum album', 'Phosphorus', 'Kali arsenicosum', 'Aconitum napellus'],
    modalities: '< 1–2 AM, cold air, being alone; > warm drinks, elevated head, company',
    symptomNotes:
      'Fastidious, fearful of incurable illness, moves from bed to chair despite exhaustion, sips small quantities of warm water frequently.',
  },
  {
    chapter: 'Head & Vertigo',
    rubric: 'Throbbing right-sided migraine, better firm pressure and dark room',
    primaryRemedy: 'Belladonna',
    remedies: ['Belladonna', 'Sanguinaria canadensis', 'Bryonia alba', 'Glonoinum'],
    modalities: '< light, noise, jarring, afternoon 3 PM; > dark quiet room, pressure',
    symptomNotes:
      'Sudden violent onset with flushed face, dilated pupils, hot head with cold extremities.',
  },
  {
    chapter: 'Respiratory',
    rubric: 'Dry barking cough worse warm room and evening, better open cool air',
    primaryRemedy: 'Pulsatilla nigricans',
    remedies: ['Pulsatilla nigricans', 'Bryonia alba', 'Drosera rotundifolia', 'Spongia tosta'],
    modalities: '< warm stuffy room, lying down evening; > open cool air, gentle motion',
    symptomNotes:
      'Dry cough at night turning loose with thick bland yellow-green expectoration in the morning; thirstless patient.',
  },
  {
    chapter: 'Gastrointestinal',
    rubric: 'Bloating and fullness after a few bites, worse 4–8 PM',
    primaryRemedy: 'Lycopodium clavatum',
    remedies: ['Lycopodium clavatum', 'Carbo vegetabilis', 'Nux vomica', 'Cinchona officinalis'],
    modalities: '< 4–8 PM, tight waistband, cold food; > warm drinks, loosening clothing',
    symptomNotes:
      'Immediate satiety with loud rumbling flatus in lower abdomen; strong craving for sweets and warm food.',
  },
  {
    chapter: 'Skin',
    rubric: 'Dry, burning eczema itching intensely from warmth of bed',
    primaryRemedy: 'Sulphur',
    remedies: ['Sulphur', 'Graphites', 'Rhus toxicodendron', 'Mezereum'],
    modalities: '< warmth of bed, bathing, wool clothing; > dry cool air, scratching until burning',
    symptomNotes:
      'Voluptuous itching followed by burning soreness after scratching; red orifices and aversion to washing.',
  },
  {
    chapter: 'Musculoskeletal',
    rubric: 'Joint stiffness worse initial motion, relieved by continued walking',
    primaryRemedy: 'Rhus toxicodendron',
    remedies: ['Rhus toxicodendron', 'Bryonia alba', 'Ruta graveolens', 'Calcarea fluorica'],
    modalities: '< first motion, damp cold weather, rest; > continued motion, warm dry heat',
    symptomNotes:
      'Rusty-gate stiffness pattern; patient must constantly shift position in bed at night.',
  },
  {
    chapter: 'Sleep & Dreams',
    rubric: 'Waking around 3 AM with mental racing over business and duties',
    primaryRemedy: 'Nux vomica',
    remedies: ['Nux vomica', 'Kali carbonicum', 'Sulphur', 'Sepia officinalis'],
    modalities: '< 3–4 AM, stimulants, mental overwork; > short nap, warmth',
    symptomNotes:
      'Overworked, irritable constitution; falls back asleep just before dawn and wakes unrefreshed.',
  },
  {
    chapter: 'Generalities',
    rubric: 'Chilly constitution with profuse head sweat during sleep and slow dentition',
    primaryRemedy: 'Calcarea carbonica',
    remedies: ['Calcarea carbonica', 'Silicea', 'Baryta carbonica', 'Tuberculinum'],
    modalities: '< cold damp weather, exertion, ascending stairs; > dry warm climate',
    symptomNotes:
      'Cold clammy feet, sour perspiration, craving for boiled eggs and indigestible things.',
  },
];

function normalizeRemedyList(primary: string, extraInput: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  const add = (name: string) => {
    const clean = name.trim().slice(0, FIELD_LIMITS.remedyNameMax);
    if (!clean) return;
    const key = clean.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(clean);
    }
  };

  add(primary);
  for (const part of extraInput.split(',')) {
    if (result.length >= 20) break;
    add(part);
  }
  return result;
}

interface RepertoryViewProps {
  clinic: ClinicTenant;
  isSuperAdmin: boolean;
}

export function RepertoryView({ clinic, isSuperAdmin }: RepertoryViewProps) {
  const { language, t } = useLanguage();
  const palette = ACCENT_THEME_PALETTES[clinic.accentColor] || ACCENT_THEME_PALETTES.teal;
  const chapterLabels = REPERTORY_CHAPTER_LABELS_I18N[language];
  const [entries, setEntries] = useState<RepertoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState('');
  const [chapterFilter, setChapterFilter] = useState<'all' | RepertoryChapter>('all');
  const [remedyFilter, setRemedyFilter] = useState<string>('');

  const [showModal, setShowModal] = useState(false);
  const [editingEntry, setEditingEntry] = useState<RepertoryEntry | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [seeding, setSeeding] = useState(false);

  // Quick Search (AI) State
  const [quickQuery, setQuickQuery] = useState('');
  const [lastQuickQuery, setLastQuickQuery] = useState('');
  const [quickSearching, setQuickSearching] = useState(false);
  const [pendingQuickDebounce, setPendingQuickDebounce] = useState(false);
  const [quickResult, setQuickResult] = useState<QuickSearchResponse | null>(null);
  const [quickError, setQuickError] = useState<string | null>(null);
  const [savingSuggestionKey, setSavingSuggestionKey] = useState<string | null>(null);
  const [recentSearches, setRecentSearches] = useState<RecentSymptomSearch[]>(() =>
    loadRecentSearches()
  );
  const quickSearchAbortRef = useRef<AbortController | null>(null);
  const quickDebounceTimerRef = useRef<number | null>(null);
  const skipNextQuickDebounceRef = useRef(false);
  const executeQuickSearchRef = useRef<(overrideQuery?: string) => Promise<void>>(async () => {});

  // Side-by-Side Remedy Comparison (AI) State
  const [compareSelectA, setCompareSelectA] = useState('');
  const [compareCustomA, setCompareCustomA] = useState('');
  const [compareSelectB, setCompareSelectB] = useState('');
  const [compareCustomB, setCompareCustomB] = useState('');
  const [compareContext, setCompareContext] = useState('');
  const [comparing, setComparing] = useState(false);
  const [compareResult, setCompareResult] = useState<RemedyComparisonResponse | null>(null);
  const [compareError, setCompareError] = useState<string | null>(null);
  const compareAbortRef = useRef<AbortController | null>(null);

  // Modal Form State
  const [chapter, setChapter] = useState<RepertoryChapter>('Mind');
  const [rubric, setRubric] = useState('');
  const [primaryRemedy, setPrimaryRemedy] = useState('');
  const [otherRemediesInput, setOtherRemediesInput] = useState('');
  const [modalities, setModalities] = useState('');
  const [symptomNotes, setSymptomNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    const userUid = auth.currentUser?.uid || '';
    const repPath = `clinics/${clinic.id}/repertory_entries`;
    const source = isSuperAdmin
      ? tenantRepertoryCol(clinic.id)
      : query(
          tenantRepertoryCol(clinic.id),
          where('clinicAccessUids', 'array-contains', userUid)
        );

    const unsub = onSnapshot(
      source,
      (snapshot) => {
        const rows = snapshot.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<RepertoryEntry, 'id'>),
        }));
        rows.sort((a, b) => (b.updatedAt?.toMillis?.() ?? 0) - (a.updatedAt?.toMillis?.() ?? 0));
        setEntries(rows);
        setLoading(false);
      },
      (error) => {
        handleFirestoreError(error, OperationType.LIST, repPath);
      }
    );
    return () => unsub();
  }, [clinic.id, isSuperAdmin]);

  useEffect(() => {
    return () => {
      if (quickDebounceTimerRef.current !== null) {
        window.clearTimeout(quickDebounceTimerRef.current);
      }
      quickSearchAbortRef.current?.abort();
      compareAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!searchQuery.trim()) {
      setDebouncedSearchQuery('');
      return;
    }
    const timer = window.setTimeout(() => {
      setDebouncedSearchQuery(searchQuery);
    }, LOCAL_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [searchQuery]);

  const filteredEntries = useMemo(() => {
    const q = debouncedSearchQuery.trim().toLowerCase();
    const remQ = remedyFilter.trim().toLowerCase();

    return entries.filter((entry) => {
      if (chapterFilter !== 'all' && entry.chapter !== chapterFilter) return false;
      if (
        remQ &&
        !entry.remedies.some((r) => r.toLowerCase() === remQ) &&
        entry.primaryRemedy.toLowerCase() !== remQ
      ) {
        return false;
      }
      if (!q) return true;
      const localizedChapter = (chapterLabels[entry.chapter] || '').toLowerCase();
      return (
        entry.rubric.toLowerCase().includes(q) ||
        entry.primaryRemedy.toLowerCase().includes(q) ||
        entry.remedies.some((r) => r.toLowerCase().includes(q)) ||
        (entry.modalities || '').toLowerCase().includes(q) ||
        (entry.symptomNotes || '').toLowerCase().includes(q) ||
        entry.chapter.toLowerCase().includes(q) ||
        localizedChapter.includes(q)
      );
    });
  }, [entries, debouncedSearchQuery, chapterFilter, remedyFilter, chapterLabels]);

  const uniqueRemediesCount = useMemo(() => {
    const set = new Set<string>();
    entries.forEach((e) => e.remedies.forEach((r) => set.add(r.toLowerCase())));
    return set.size;
  }, [entries]);

  const remedyMentionStats = useMemo(() => {
    const total = new Map<string, number>();
    const primary = new Map<string, number>();
    const filtered = new Map<string, number>();

    entries.forEach((entry) => {
      const seenInEntry = new Set<string>();
      const primaryKey = entry.primaryRemedy.trim().toLowerCase();
      if (primaryKey) {
        primary.set(primaryKey, (primary.get(primaryKey) ?? 0) + 1);
      }
      for (const rem of entry.remedies) {
        const key = rem.trim().toLowerCase();
        if (!key || seenInEntry.has(key)) continue;
        seenInEntry.add(key);
        total.set(key, (total.get(key) ?? 0) + 1);
      }
    });

    filteredEntries.forEach((entry) => {
      const seenInEntry = new Set<string>();
      for (const rem of entry.remedies) {
        const key = rem.trim().toLowerCase();
        if (!key || seenInEntry.has(key)) continue;
        seenInEntry.add(key);
        filtered.set(key, (filtered.get(key) ?? 0) + 1);
      }
    });

    return { total, primary, filtered };
  }, [entries, filteredEntries]);

  const getSavedRemedySeverity = (
    remedyName: string,
    isPrimaryInEntry: boolean
  ): { grade: RemedySeverityGrade; mentions: number; label: string } => {
    const key = remedyName.trim().toLowerCase();
    const mentions = remedyMentionStats.total.get(key) ?? 1;
    const filteredMentions = remedyMentionStats.filtered.get(key) ?? 0;
    const hasSearch = debouncedSearchQuery.trim().length > 0;

    let grade: RemedySeverityGrade = 1;
    if (
      mentions >= 3 ||
      (isPrimaryInEntry && mentions >= 2) ||
      (hasSearch && isPrimaryInEntry && filteredMentions >= 2)
    ) {
      grade = 3;
    } else if (isPrimaryInEntry || mentions === 2 || (hasSearch && filteredMentions >= 2)) {
      grade = 2;
    }

    const gradeName =
      grade === 3
        ? t('High affinity / Frequent (Grade 3)', 'উচ্চ প্রাবল্য / বহুবার উল্লিখিত (গ্রেড ৩)')
        : grade === 2
          ? t('Moderate / Primary rubric remedy (Grade 2)', 'মাঝারি / প্রধান রুব্রিক রেমেডি (গ্রেড ২)')
          : t('Mild / Single mention (Grade 1)', 'স্বল্প / একক উল্লেখ (গ্রেড ১)');

    const mentionNote = t(
      `${mentions} rubric mention${mentions === 1 ? '' : 's'}`,
      `${mentions}টি রুব্রিকে উল্লেখ`
    );

    return {
      grade,
      mentions,
      label: `${gradeName} · ${mentionNote}`,
    };
  };

  const getQuickRemedySeverity = (
    suggestion: QuickSearchSuggestion,
    remedyName: string,
    isPrimary: boolean
  ): { grade: RemedySeverityGrade; mentions: number; label: string } => {
    const key = remedyName.trim().toLowerCase();
    const mentions = remedyMentionStats.total.get(key) ?? 0;
    const rawGrade = isPrimary
      ? suggestion.primaryGrade ?? 3
      : suggestion.remedyGrades?.[key] ?? 2;

    const grade: RemedySeverityGrade =
      rawGrade >= 3 || mentions >= 3 ? 3 : rawGrade === 2 || mentions === 2 ? 2 : 1;

    const gradeName =
      grade === 3
        ? t('High potency / Keynote (Grade 3)', 'উচ্চ প্রাবল্য / মূল লক্ষণ (গ্রেড ৩)')
        : grade === 2
          ? t('Moderate affinity (Grade 2)', 'মাঝারি প্রাবল্য (গ্রেড ২)')
          : t('Mild / Supporting (Grade 1)', 'স্বল্প / সহায়ক (গ্রেড ১)');

    const clinicNote =
      mentions > 0
        ? ` · ${t(`${mentions} saved in clinic`, `ক্লিনিকে ${mentions}টি সংরক্ষিত`)}`
        : '';

    return {
      grade,
      mentions,
      label: `${gradeName}${clinicNote}`,
    };
  };

  const severityDotClass = (grade: RemedySeverityGrade): string =>
    grade === 3 ? 'bg-rose-600' : grade === 2 ? 'bg-amber-500' : 'bg-teal-600';

  const availableRemedies = useMemo(() => {
    const map = new Map<string, string>();
    const addRemedy = (name: string) => {
      const clean = name.trim();
      if (!clean) return;
      const key = clean.toLowerCase();
      if (!map.has(key)) {
        map.set(key, clean);
      }
    };

    COMMON_REMEDIES.forEach(addRemedy);
    entries.forEach((entry) => {
      addRemedy(entry.primaryRemedy);
      entry.remedies.forEach(addRemedy);
    });

    return Array.from(map.values()).sort((a, b) => a.localeCompare(b));
  }, [entries]);

  const matchedClinicEntries = useMemo(() => {
    const savedIds = Array.isArray(quickResult?.matchedSavedEntryIds)
      ? quickResult.matchedSavedEntryIds
      : [];
    if (savedIds.length === 0) return [];
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    return savedIds
      .map((id) => byId.get(id))
      .filter((entry): entry is RepertoryEntry => Boolean(entry));
  }, [entries, quickResult]);

  const getSuggestionKey = (suggestion: QuickSearchSuggestion): string =>
    `${(suggestion.primaryRemedy || '').toLowerCase()}::${(suggestion.rubric || '').toLowerCase()}`;

  const isSuggestionSaved = (suggestion: QuickSearchSuggestion): boolean =>
    entries.some(
      (entry) =>
        (entry.primaryRemedy || '').toLowerCase() === (suggestion.primaryRemedy || '').toLowerCase() &&
        (entry.rubric || '').toLowerCase() === (suggestion.rubric || '').toLowerCase()
    );

  const formatSearchError = (error: unknown, fallback: string): string => {
    if (error instanceof SyntaxError) {
      return t(
        'Received an unreadable response from the search service. Please try again.',
        'অনুসন্ধান সেবা থেকে অস্পষ্ট উত্তর পাওয়া গেছে। অনুগ্রহ করে আবার চেষ্টা করুন।'
      );
    }
    if (error instanceof Error) {
      const msg = error.message || '';
      const lower = msg.toLowerCase();
      if (
        lower.includes('unexpected token') ||
        lower.includes('not valid json') ||
        lower.includes('json.parse')
      ) {
        return t(
          'Received an unreadable response from the search service. Please try again.',
          'অনুসন্ধান সেবা থেকে অস্পষ্ট উত্তর পাওয়া গেছে। অনুগ্রহ করে আবার চেষ্টা করুন।'
        );
      }
      return msg || fallback;
    }
    return fallback;
  };

  const recordRecentSearch = (queryText: string, suggestionCount: number) => {
    const clean = queryText.trim();
    if (!clean) return;
    setRecentSearches((prev) => {
      const next: RecentSymptomSearch[] = [
        {
          query: clean,
          searchedAt: new Date().toISOString(),
          suggestionCount,
        },
        ...prev.filter((item) => item.query.toLowerCase() !== clean.toLowerCase()),
      ].slice(0, MAX_RECENT_SEARCHES);
      saveRecentSearches(next);
      return next;
    });
  };

  const removeRecentSearch = (queryText: string) => {
    setRecentSearches((prev) => {
      const next = prev.filter((item) => item.query.toLowerCase() !== queryText.toLowerCase());
      saveRecentSearches(next);
      return next;
    });
  };

  const clearRecentSearches = () => {
    setRecentSearches([]);
    saveRecentSearches([]);
  };

  const clearQuickDebounceTimer = () => {
    if (quickDebounceTimerRef.current !== null) {
      window.clearTimeout(quickDebounceTimerRef.current);
      quickDebounceTimerRef.current = null;
    }
    setPendingQuickDebounce(false);
  };

  const cancelQuickSearch = () => {
    clearQuickDebounceTimer();
    if (quickSearchAbortRef.current) {
      quickSearchAbortRef.current.abort();
      quickSearchAbortRef.current = null;
    }
    setQuickSearching(false);
  };

  const executeQuickSearch = async (overrideQuery?: string) => {
    clearQuickDebounceTimer();
    const target = (overrideQuery ?? quickQuery).trim();
    if (!target) {
      setQuickError(
        t(
          'Enter symptom keywords or a colloquial description to search.',
          'খুঁজতে লক্ষণের বিবরণ বা মূল শব্দ লিখুন।'
        )
      );
      return;
    }
    if (overrideQuery !== undefined) {
      skipNextQuickDebounceRef.current = true;
      setQuickQuery(overrideQuery);
    }

    quickSearchAbortRef.current?.abort();
    const controller = new AbortController();
    quickSearchAbortRef.current = controller;

    setQuickError(null);
    setQuickSearching(true);
    try {
      const rawResponse = await runRepertoryQuickSearch(target, entries, language, controller.signal);
      if (quickSearchAbortRef.current !== controller) return;

      const safeSuggestions = Array.isArray(rawResponse?.suggestions)
        ? rawResponse.suggestions
        : [];
      const safeMatchedIds = Array.isArray(rawResponse?.matchedSavedEntryIds)
        ? rawResponse.matchedSavedEntryIds
        : [];
      const safeResponse: QuickSearchResponse = {
        interpretedSymptoms:
          typeof rawResponse?.interpretedSymptoms === 'string' &&
          rawResponse.interpretedSymptoms.trim()
            ? rawResponse.interpretedSymptoms.trim()
            : target,
        matchedSavedEntryIds: safeMatchedIds,
        suggestions: safeSuggestions,
      };
      setQuickResult(safeResponse);
      setLastQuickQuery(target);
      recordRecentSearch(target, safeSuggestions.length + safeMatchedIds.length);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return;
      }
      if (quickSearchAbortRef.current !== controller) return;
      setQuickError(
        formatSearchError(
          error,
          t('Unable to complete Quick Search.', 'কুইক সার্চ সম্পন্ন করা যায়নি।')
        )
      );
    } finally {
      if (quickSearchAbortRef.current === controller) {
        quickSearchAbortRef.current = null;
        setQuickSearching(false);
      }
    }
  };

  executeQuickSearchRef.current = executeQuickSearch;

  useEffect(() => {
    clearQuickDebounceTimer();

    if (skipNextQuickDebounceRef.current) {
      skipNextQuickDebounceRef.current = false;
      return;
    }

    const trimmed = quickQuery.trim();
    if (
      trimmed.length < QUICK_SEARCH_MIN_CHARS ||
      trimmed.toLowerCase() === lastQuickQuery.trim().toLowerCase()
    ) {
      return;
    }

    setPendingQuickDebounce(true);
    quickDebounceTimerRef.current = window.setTimeout(() => {
      quickDebounceTimerRef.current = null;
      setPendingQuickDebounce(false);
      void executeQuickSearchRef.current(trimmed);
    }, QUICK_SEARCH_DEBOUNCE_MS);

    return () => {
      if (quickDebounceTimerRef.current !== null) {
        window.clearTimeout(quickDebounceTimerRef.current);
        quickDebounceTimerRef.current = null;
      }
    };
  }, [quickQuery, lastQuickQuery]);

  const handleQuickSearchSubmit = (e: FormEvent) => {
    e.preventDefault();
    clearQuickDebounceTimer();
    void executeQuickSearch();
  };

  const clearQuickSearch = () => {
    skipNextQuickDebounceRef.current = true;
    cancelQuickSearch();
    setQuickQuery('');
    setLastQuickQuery('');
    setQuickResult(null);
    setQuickError(null);
  };

  const resolvedRemedyA =
    compareSelectA === '__custom__' ? compareCustomA.trim() : compareSelectA.trim();
  const resolvedRemedyB =
    compareSelectB === '__custom__' ? compareCustomB.trim() : compareSelectB.trim();

  const cancelRemedyComparison = () => {
    if (compareAbortRef.current) {
      compareAbortRef.current.abort();
      compareAbortRef.current = null;
    }
    setComparing(false);
  };

  const executeRemedyComparison = async (
    overrideA?: string,
    overrideB?: string,
    overrideContext?: string
  ) => {
    const remA = (overrideA ?? resolvedRemedyA).trim();
    const remB = (overrideB ?? resolvedRemedyB).trim();
    const ctx = (overrideContext ?? compareContext).trim();

    if (overrideA !== undefined) {
      if (availableRemedies.some((r) => r.toLowerCase() === overrideA.toLowerCase())) {
        setCompareSelectA(overrideA);
        setCompareCustomA('');
      } else {
        setCompareSelectA('__custom__');
        setCompareCustomA(overrideA);
      }
    }
    if (overrideB !== undefined) {
      if (availableRemedies.some((r) => r.toLowerCase() === overrideB.toLowerCase())) {
        setCompareSelectB(overrideB);
        setCompareCustomB('');
      } else {
        setCompareSelectB('__custom__');
        setCompareCustomB(overrideB);
      }
    }

    if (!remA || !remB) {
      setCompareError(
        t(
          'Select or enter two remedies to generate a comparison table.',
          'তুলনা টেবিল তৈরি করতে দুটি রেমেডি নির্বাচন বা লিখুন।'
        )
      );
      return;
    }
    if (remA.toLowerCase() === remB.toLowerCase()) {
      setCompareError(
        t(
          'Please choose two different remedies to compare.',
          'তুলনার জন্য দুটি ভিন্ন রেমেডি নির্বাচন করুন।'
        )
      );
      return;
    }

    compareAbortRef.current?.abort();
    const controller = new AbortController();
    compareAbortRef.current = controller;

    setCompareError(null);
    setComparing(true);
    try {
      const response = await compareHomeopathicRemedies(
        remA,
        remB,
        ctx,
        language,
        controller.signal
      );
      if (compareAbortRef.current !== controller) return;
      setCompareResult({
        remedyA: response.remedyA || remA,
        remedyB: response.remedyB || remB,
        differentiationSummary: response.differentiationSummary || '',
        rows: Array.isArray(response.rows) ? response.rows : [],
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return;
      }
      if (compareAbortRef.current !== controller) return;
      setCompareError(
        formatSearchError(
          error,
          t('Unable to generate remedy comparison.', 'রেমেডি তুলনা তৈরি করা যায়নি।')
        )
      );
    } finally {
      if (compareAbortRef.current === controller) {
        compareAbortRef.current = null;
        setComparing(false);
      }
    }
  };

  const handleCompareSubmit = (e: FormEvent) => {
    e.preventDefault();
    void executeRemedyComparison();
  };

  const handleSwapRemedies = () => {
    setCompareSelectA(compareSelectB);
    setCompareCustomA(compareCustomB);
    setCompareSelectB(compareSelectA);
    setCompareCustomB(compareCustomA);
  };

  const clearComparison = () => {
    cancelRemedyComparison();
    setCompareSelectA('');
    setCompareCustomA('');
    setCompareSelectB('');
    setCompareCustomB('');
    setCompareContext('');
    setCompareResult(null);
    setCompareError(null);
  };

  const handleSaveSuggestionToRepertory = async (suggestion: QuickSearchSuggestion) => {
    const uid = auth.currentUser?.uid;
    if (!uid) {
      setQuickError(
        t('Admin sign-in is required to save rubrics.', 'রুব্রিক সংরক্ষণে অ্যাডমিন সাইন-ইন প্রয়োজন।')
      );
      return;
    }

    const suggestionKey = getSuggestionKey(suggestion);
    const entryId = `rep_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const safeChapter = REPERTORY_CHAPTERS.includes(suggestion.chapter)
      ? suggestion.chapter
      : 'Generalities';
    const cleanPrimary = suggestion.primaryRemedy.trim().slice(0, FIELD_LIMITS.remedyNameMax);
    const cleanRubric = suggestion.rubric.trim().slice(0, FIELD_LIMITS.rubricMax);
    const remedies = normalizeRemedyList(cleanPrimary, suggestion.differentialRemedies.join(', '));

    const payload: Record<string, unknown> = {
      clinicId: clinic.id,
      clinicAccessEmails: clinic.accessEmails,
      clinicAccessUids: clinic.authorizedUids || [],
      chapter: safeChapter,
      rubric: cleanRubric,
      primaryRemedy: cleanPrimary,
      remedies,
      createdBy: uid,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };

    if (suggestion.modalities.trim()) {
      payload.modalities = suggestion.modalities.trim().slice(0, FIELD_LIMITS.modalitiesMax);
    }
    if (suggestion.rationale.trim()) {
      payload.symptomNotes = suggestion.rationale.trim().slice(0, FIELD_LIMITS.symptomNotesMax);
    }

    setSavingSuggestionKey(suggestionKey);
    try {
      await setDoc(tenantRepertoryDoc(clinic.id, entryId), payload);
    } catch (error) {
      if (error instanceof Error && error.message.includes('Missing or insufficient permissions')) {
        handleFirestoreError(
          error,
          OperationType.CREATE,
          `clinics/${clinic.id}/repertory_entries/${entryId}`
        );
      }
      setQuickError(error instanceof Error ? error.message : 'Unable to save suggested rubric.');
    } finally {
      setSavingSuggestionKey(null);
    }
  };

  const openPrefilledModal = (suggestion: QuickSearchSuggestion) => {
    setEditingEntry(null);
    setChapter(
      REPERTORY_CHAPTERS.includes(suggestion.chapter) ? suggestion.chapter : 'Generalities'
    );
    setRubric(suggestion.rubric.slice(0, FIELD_LIMITS.rubricMax));
    setPrimaryRemedy(suggestion.primaryRemedy.slice(0, FIELD_LIMITS.remedyNameMax));
    setOtherRemediesInput(suggestion.differentialRemedies.join(', '));
    setModalities(suggestion.modalities.slice(0, FIELD_LIMITS.modalitiesMax));
    setSymptomNotes(suggestion.rationale.slice(0, FIELD_LIMITS.symptomNotesMax));
    setFormError(null);
    setShowModal(true);
  };

  const openCreateModal = () => {
    setEditingEntry(null);
    setChapter(chapterFilter === 'all' ? 'Mind' : chapterFilter);
    setRubric('');
    setPrimaryRemedy('');
    setOtherRemediesInput('');
    setModalities('');
    setSymptomNotes('');
    setFormError(null);
    setShowModal(true);
  };

  const openEditModal = (entry: RepertoryEntry) => {
    setEditingEntry(entry);
    setChapter(entry.chapter);
    setRubric(entry.rubric);
    setPrimaryRemedy(entry.primaryRemedy);
    const secondary = entry.remedies.filter(
      (r) => r.toLowerCase() !== entry.primaryRemedy.toLowerCase()
    );
    setOtherRemediesInput(secondary.join(', '));
    setModalities(entry.modalities || '');
    setSymptomNotes(entry.symptomNotes || '');
    setFormError(null);
    setShowModal(true);
  };

  const handleSaveEntry = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);

    const trimmedRubric = rubric.trim();
    const trimmedPrimary = primaryRemedy.trim();
    if (!trimmedRubric) {
      setFormError(t('Symptom rubric is required.', 'লক্ষণ রুব্রিক আবশ্যক।'));
      return;
    }
    if (!trimmedPrimary) {
      setFormError(t('Primary remedy is required.', 'প্রধান রেমেডি আবশ্যক।'));
      return;
    }

    const uid = auth.currentUser?.uid;
    if (!uid) {
      setFormError(
        t('Admin session expired. Please sign in again.', 'অ্যাডমিন সেশন শেষ হয়েছে। আবার সাইন ইন করুন।')
      );
      return;
    }

    const remedies = normalizeRemedyList(trimmedPrimary, otherRemediesInput);
    const entryId =
      editingEntry?.id || `rep_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const path = `clinics/${clinic.id}/repertory_entries/${entryId}`;

    setSubmitting(true);
    try {
      const payload: Record<string, unknown> = {
        chapter,
        rubric: trimmedRubric.slice(0, FIELD_LIMITS.rubricMax),
        primaryRemedy: trimmedPrimary.slice(0, FIELD_LIMITS.remedyNameMax),
        remedies,
        updatedAt: serverTimestamp(),
      };

      if (modalities.trim()) {
        payload.modalities = modalities.trim().slice(0, FIELD_LIMITS.modalitiesMax);
      }
      if (symptomNotes.trim()) {
        payload.symptomNotes = symptomNotes.trim().slice(0, FIELD_LIMITS.symptomNotesMax);
      }

      if (editingEntry) {
        await updateDoc(tenantRepertoryDoc(clinic.id, entryId), payload);
      } else {
        payload.clinicId = clinic.id;
        payload.clinicAccessEmails = clinic.accessEmails;
        payload.clinicAccessUids = clinic.authorizedUids || [];
        payload.createdBy = uid;
        payload.createdAt = serverTimestamp();
        await setDoc(tenantRepertoryDoc(clinic.id, entryId), payload);
      }

      setShowModal(false);
    } catch (error) {
      if (error instanceof Error && error.message.includes('Missing or insufficient permissions')) {
        handleFirestoreError(
          error,
          editingEntry ? OperationType.UPDATE : OperationType.CREATE,
          path
        );
      }
      setFormError(error instanceof Error ? error.message : 'Unable to save repertory rubric.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteEntry = async (entryId: string) => {
    try {
      await deleteDoc(tenantRepertoryDoc(clinic.id, entryId));
      setConfirmDeleteId(null);
    } catch (error) {
      handleFirestoreError(
        error,
        OperationType.DELETE,
        `clinics/${clinic.id}/repertory_entries/${entryId}`
      );
    }
  };

  const handleSeedStarterRubrics = async () => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    setSeeding(true);
    const seeds = STARTER_RUBRICS;
    try {
      for (const seed of seeds) {
        const entryId = `rep_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
        await setDoc(tenantRepertoryDoc(clinic.id, entryId), {
          clinicId: clinic.id,
          clinicAccessEmails: clinic.accessEmails,
          clinicAccessUids: clinic.authorizedUids || [],
          chapter: seed.chapter,
          rubric: seed.rubric.slice(0, FIELD_LIMITS.rubricMax),
          primaryRemedy: seed.primaryRemedy.slice(0, FIELD_LIMITS.remedyNameMax),
          remedies: seed.remedies.slice(0, 20),
          modalities: seed.modalities.slice(0, FIELD_LIMITS.modalitiesMax),
          symptomNotes: seed.symptomNotes.slice(0, FIELD_LIMITS.symptomNotesMax),
          createdBy: uid,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, `clinics/${clinic.id}/repertory_entries`);
    } finally {
      setSeeding(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-semibold text-slate-900 tracking-tight">
            {t('Clinical Repertory', 'ক্লিনিক্যাল রেপার্টরি')}
          </h1>
          <p className="text-sm text-slate-500 mt-0.5 tabular-nums">
            {entries.length} {t('symptom rubrics', 'টি লক্ষণ রুব্রিক')} · {uniqueRemediesCount}{' '}
            {t('indexed remedies', 'টি তালিকাভুক্ত রেমেডি')} ·{' '}
            {t('Quick chairside reference', 'চেম্বারে দ্রুত রেফারেন্স')}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          {entries.length === 0 && !loading && (
            <button
              type="button"
              disabled={seeding}
              onClick={handleSeedStarterRubrics}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
            >
              <Sparkles className="w-3.5 h-3.5 text-teal-700" />
              {seeding
                ? t('Loading Classic Rubrics...', 'ক্লাসিক রুব্রিক লোড হচ্ছে...')
                : t('Load Classic Rubrics', 'ক্লাসিক রুব্রিক লোড করুন')}
            </button>
          )}
          <button
            type="button"
            onClick={openCreateModal}
            className={`inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg transition-colors cursor-pointer whitespace-nowrap ${palette.primaryBtn}`}
          >
            <Plus className="w-3.5 h-3.5" />
            {t('Add Symptom Rubric', 'লক্ষণ রুব্রিক যোগ করুন')}
          </button>
        </div>
      </div>

      {/* AI Quick Search */}
      <section
        aria-label={t('Intelligent Symptom Quick Search', 'বুদ্ধিমত্তাসম্পন্ন লক্ষণ কুইক সার্চ')}
        className="bg-white border border-slate-200 rounded-xl p-5 space-y-4"
      >
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-teal-700 shrink-0" />
              <h2 className="font-display text-sm font-semibold text-slate-900">
                {t('Quick Search', 'কুইক সার্চ')}
              </h2>
            </div>
            <p className="text-xs text-slate-500 mt-0.5">
              {t(
                'Describe symptoms in everyday language to surface classical rubrics, modalities, and differential remedies even without exact repertory wording.',
                'সঠিক রেপার্টরি পরিভাষা ছাড়াই সাধারণ ভাষায় লক্ষণ লিখে প্রাসঙ্গিক রুব্রিক, হ্রাস-বৃদ্ধি ও উপযুক্ত রেমেডি খুঁজুন।'
              )}
            </p>
          </div>

          {(quickResult || quickQuery || quickError) && (
            <button
              type="button"
              onClick={clearQuickSearch}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 cursor-pointer whitespace-nowrap shrink-0"
            >
              <X className="w-3.5 h-3.5" />
              {t('Clear Quick Search', 'কুইক সার্চ মুছুন')}
            </button>
          )}
        </div>

        <form onSubmit={handleQuickSearchSubmit} className="flex flex-col sm:flex-row gap-2.5">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              maxLength={400}
              value={quickQuery}
              onChange={(e) => {
                skipNextQuickDebounceRef.current = false;
                setQuickQuery(e.target.value);
              }}
              placeholder={t(
                'e.g. wakes at 3am worrying about work, or burning itchy rash worse under blankets...',
                'যেমন: রাত ৩টায় কাজের চিন্তায় ঘুম ভেঙে যায়, অথবা গরম কম্বলে চুলকানি বাড়ে...'
              )}
              className="w-full pl-9 pr-3 py-2.5 text-sm bg-slate-50 border border-slate-300 rounded-lg focus:outline-none focus:bg-white focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
            />
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="submit"
              disabled={quickSearching || !quickQuery.trim()}
              className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 text-xs font-medium text-white bg-teal-700 rounded-lg hover:bg-teal-800 disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              {quickSearching ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  {t('Matching Remedies...', 'রেমেডি খোঁজা হচ্ছে...')}
                </>
              ) : (
                <>
                  <Sparkles className="w-3.5 h-3.5" />
                  {t('Find Remedies', 'রেমেডি খুঁজুন')}
                </>
              )}
            </button>
            {quickSearching && (
              <button
                type="button"
                onClick={cancelQuickSearch}
                className="inline-flex items-center justify-center gap-1 px-3 py-2.5 text-xs font-medium text-slate-700 bg-slate-100 border border-slate-300 rounded-lg hover:bg-slate-200 transition-colors cursor-pointer whitespace-nowrap shrink-0"
              >
                <X className="w-3.5 h-3.5" />
                {t('Cancel', 'বাতিল')}
              </button>
            )}
          </div>
        </form>

        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-slate-500">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>{t('Try keywords:', 'নমুনা লক্ষণ:')}</span>
          {(language === 'bn'
            ? [
                'রাত ৩টায় কাজের দুশ্চিন্তায় ঘুম ভেঙে যায়',
                'দপদপ করা মাথাব্যথা অন্ধকার ঘরে আরাম',
                'কয়েক গ্রাস খেলেই বিকেলে পেট ফাঁপে',
              ]
            : [
                'wakes 3am worrying about deadlines',
                'pounding headache better in dark room',
                'bloating after few bites evening',
              ]
          ).map((sample, idx) => (
            <span key={sample} className="inline-flex items-center gap-3">
              <button
                type="button"
                onClick={() => void executeQuickSearch(sample)}
                className="text-teal-800 hover:underline cursor-pointer text-left"
              >
                &ldquo;{sample}&rdquo;
              </button>
              {idx < 2 && (
                <span className="text-slate-300" aria-hidden="true">
                  ·
                </span>
              )}
            </span>
          ))}
          </div>
          {pendingQuickDebounce && !quickSearching && (
            <span className="text-[11px] text-teal-800 font-medium">
              {t(
                'Searching automatically once you pause typing...',
                'টাইপ থামলে স্বয়ংক্রিয়ভাবে খুঁজবে...'
              )}
            </span>
          )}
        </div>

        {/* Local Storage-Backed Recent Symptom Searches */}
        <div className="pt-3 border-t border-slate-100 space-y-2.5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-1.5 text-xs font-medium text-slate-700">
              <History className="w-3.5 h-3.5 text-slate-500 shrink-0" />
              <span>{t('Recent Searches', 'সাম্প্রতিক অনুসন্ধান')}</span>
              {recentSearches.length > 0 && (
                <span className="font-mono text-[11px] text-slate-400 tabular-nums">
                  ({recentSearches.length})
                </span>
              )}
            </div>
            {recentSearches.length > 0 && (
              <button
                type="button"
                onClick={clearRecentSearches}
                className="text-xs text-slate-500 hover:text-slate-900 cursor-pointer whitespace-nowrap"
              >
                {t('Clear history', 'ইতিহাস মুছুন')}
              </button>
            )}
          </div>

          {recentSearches.length === 0 ? (
            <p className="text-xs text-slate-400">
              {t(
                'Previous symptom queries will appear here automatically for quick chairside recall.',
                'পূর্ববর্তী লক্ষণ অনুসন্ধানগুলো দ্রুত পুনরায় দেখার জন্য এখানে স্বয়ংক্রিয়ভাবে সংরক্ষিত থাকবে।'
              )}
            </p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {recentSearches.map((item) => (
                <div
                  key={item.query}
                  className="flex items-center justify-between gap-2 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg hover:border-teal-700/40 transition-colors"
                >
                  <button
                    type="button"
                    onClick={() => void executeQuickSearch(item.query)}
                    className="min-w-0 flex-1 text-left cursor-pointer"
                  >
                    <p className="text-xs font-medium text-slate-800 hover:text-teal-800 truncate">
                      {item.query}
                    </p>
                    <p className="text-[11px] text-slate-500 tabular-nums mt-0.5">
                      {item.suggestionCount}{' '}
                      {t(
                        `match${item.suggestionCount === 1 ? '' : 'es'}`,
                        'টি মিল'
                      )}{' '}
                      ·{' '}
                      {new Date(item.searchedAt).toLocaleDateString(
                        language === 'bn' ? 'bn-BD' : 'en-US',
                        { month: 'short', day: 'numeric' }
                      )}
                    </p>
                  </button>
                  <button
                    type="button"
                    onClick={() => removeRecentSearch(item.query)}
                    aria-label={t(
                      `Remove "${item.query}" from recent searches`,
                      `"${item.query}" সাম্প্রতিক তালিকা থেকে সরান`
                    )}
                    className="p-1 text-slate-400 hover:text-red-700 rounded hover:bg-white transition-colors cursor-pointer shrink-0"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {quickError && (
          <div
            role="alert"
            className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-800"
          >
            {quickError}
          </div>
        )}

        {quickResult && (
          <div className="pt-4 border-t border-slate-200 space-y-5">
            <div className="flex flex-col sm:flex-row sm:items-baseline justify-between gap-2">
              <div className="space-y-0.5">
                <p className="text-xs font-medium text-slate-500">
                  {t(
                    `Clinical Interpretation for "${lastQuickQuery}"`,
                    `"${lastQuickQuery}"-এর ক্লিনিক্যাল ব্যাখ্যা`
                  )}
                </p>
                <p className="text-sm text-slate-900 font-medium">
                  {quickResult.interpretedSymptoms}
                </p>
              </div>
              <p className="text-xs text-slate-500 tabular-nums shrink-0">
                {matchedClinicEntries.length}{' '}
                {t(
                  `saved match${matchedClinicEntries.length === 1 ? '' : 'es'}`,
                  'টি সংরক্ষিত মিল'
                )}{' '}
                · {quickResult.suggestions.length}{' '}
                {t(
                  `repertory suggestion${quickResult.suggestions.length === 1 ? '' : 's'}`,
                  'টি রেপার্টরি পরামর্শ'
                )}
              </p>
            </div>

            {matchedClinicEntries.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  {t('Matching Saved Clinic Rubrics', 'সংরক্ষিত ক্লিনিক রুব্রিকের সাথে মিল')}
                </h3>
                <div className="divide-y divide-slate-200 border border-slate-200 rounded-lg bg-slate-50/70">
                  {matchedClinicEntries.map((entry) => {
                    const primarySeverity = getSavedRemedySeverity(entry.primaryRemedy, true);
                    return (
                      <div
                        key={entry.id}
                        className="px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2"
                      >
                        <div className="min-w-0">
                          <p className="text-xs text-slate-500 flex flex-wrap items-center gap-x-1.5">
                            <span>{chapterLabels[entry.chapter]}</span>
                            <span aria-hidden="true">·</span>
                            <span
                              title={primarySeverity.label}
                              className="inline-flex items-center gap-1.5 font-medium text-teal-800"
                            >
                              <span
                                aria-hidden="true"
                                className={`inline-block w-2 h-2 rounded-full shrink-0 ${severityDotClass(
                                  primarySeverity.grade
                                )}`}
                              />
                              <span>{entry.primaryRemedy}</span>
                              {primarySeverity.mentions > 1 && (
                                <span className="font-mono text-[10px] text-slate-500 tabular-nums">
                                  ×{primarySeverity.mentions}
                                </span>
                              )}
                            </span>
                          </p>
                          <p className="text-sm font-medium text-slate-900 truncate">{entry.rubric}</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => setRemedyFilter(entry.primaryRemedy)}
                          className="text-xs font-medium text-teal-800 hover:underline cursor-pointer whitespace-nowrap shrink-0 text-left"
                        >
                          {t(`Filter by ${entry.primaryRemedy}`, `${entry.primaryRemedy} ফিল্টার`)}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {Array.isArray(quickResult.suggestions) && quickResult.suggestions.length > 0 && (
              <div className="space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    {t(
                      'Suggested Materia Medica & Repertory Matches',
                      'প্রস্তাবিত মেটেরিয়া মেডিকা ও রেপার্টরি মিল'
                    )}
                  </h3>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
                    <span className="inline-flex items-center gap-1.5">
                      <span className="inline-block w-2 h-2 rounded-full bg-rose-600" aria-hidden="true" />
                      {t('High (Grade 3)', 'উচ্চ (গ্রেড ৩)')}
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <span className="inline-block w-2 h-2 rounded-full bg-amber-500" aria-hidden="true" />
                      {t('Moderate (Grade 2)', 'মাঝারি (গ্রেড ২)')}
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <span className="inline-block w-2 h-2 rounded-full bg-teal-600" aria-hidden="true" />
                      {t('Mild (Grade 1)', 'স্বল্প (গ্রেড ১)')}
                    </span>
                  </div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {quickResult.suggestions.map((suggestion) => {
                    const key = getSuggestionKey(suggestion);
                    const alreadySaved = isSuggestionSaved(suggestion);
                    const isSaving = savingSuggestionKey === key;
                    const primarySeverity = getQuickRemedySeverity(
                      suggestion,
                      suggestion.primaryRemedy,
                      true
                    );

                    return (
                      <article
                        key={key}
                        className="border border-slate-200 rounded-lg p-4 bg-slate-50/50 flex flex-col justify-between gap-3"
                      >
                        <div className="space-y-2">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <p className="text-xs text-slate-500 flex flex-wrap items-center gap-x-1.5">
                                <span>{chapterLabels[suggestion.chapter] || suggestion.chapter}</span>
                                <span aria-hidden="true">·</span>
                                <button
                                  type="button"
                                  onClick={() => setRemedyFilter(suggestion.primaryRemedy)}
                                  className="inline-flex items-center gap-1.5 font-semibold text-teal-800 hover:underline cursor-pointer"
                                  title={primarySeverity.label}
                                >
                                  <span
                                    aria-hidden="true"
                                    className={`inline-block w-2 h-2 rounded-full shrink-0 ${severityDotClass(
                                      primarySeverity.grade
                                    )}`}
                                  />
                                  <span>{suggestion.primaryRemedy}</span>
                                </button>
                              </p>
                              <h4 className="font-display text-sm font-semibold text-slate-900 mt-0.5 leading-snug">
                                {suggestion.rubric}
                              </h4>
                            </div>

                            {alreadySaved ? (
                              <span className="inline-flex items-center gap-1 text-xs font-medium text-teal-800 shrink-0 whitespace-nowrap">
                                <Check className="w-3.5 h-3.5" />
                                {t('Saved', 'সংরক্ষিত')}
                              </span>
                            ) : (
                              <div className="flex items-center gap-2 shrink-0">
                                <button
                                  type="button"
                                  disabled={isSaving}
                                  onClick={() => void handleSaveSuggestionToRepertory(suggestion)}
                                  className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-teal-800 bg-white border border-slate-300 rounded-md hover:bg-slate-50 disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
                                >
                                  <BookmarkPlus className="w-3.5 h-3.5" />
                                  {isSaving
                                    ? t('Saving...', 'সংরক্ষণ হচ্ছে...')
                                    : t('Save', 'সংরক্ষণ')}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => openPrefilledModal(suggestion)}
                                  className="text-xs font-medium text-slate-600 hover:text-slate-900 cursor-pointer whitespace-nowrap"
                                  title={t(
                                    'Edit before saving to repertory',
                                    'সংরক্ষণের আগে সম্পাদনা করুন'
                                  )}
                                >
                                  {t('Edit', 'সম্পাদনা')}
                                </button>
                              </div>
                            )}
                          </div>

                          {suggestion.modalities && (
                            <p className="text-xs text-slate-600 leading-relaxed">
                              <span className="font-medium text-slate-700">
                                {t('Modalities:', 'হ্রাস-বৃদ্ধি:')}
                              </span>{' '}
                              {suggestion.modalities}
                            </p>
                          )}

                          {suggestion.rationale && (
                            <p className="text-xs text-slate-600 leading-relaxed">
                              {suggestion.rationale}
                            </p>
                          )}
                        </div>

                        {Array.isArray(suggestion.differentialRemedies) &&
                          suggestion.differentialRemedies.length > 0 && (
                          <div className="pt-2.5 border-t border-slate-200/80 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                            <span className="text-slate-500">
                              {t('Differentials:', 'সহযোগী রেমেডি:')}
                            </span>
                            {suggestion.differentialRemedies.map((rem, idx) => {
                              const diffSeverity = getQuickRemedySeverity(suggestion, rem, false);
                              return (
                                <span key={rem} className="inline-flex items-center">
                                  <button
                                    type="button"
                                    onClick={() => setRemedyFilter(rem)}
                                    title={diffSeverity.label}
                                    className="inline-flex items-center gap-1.5 text-slate-700 hover:text-teal-800 hover:underline cursor-pointer"
                                  >
                                    <span
                                      aria-hidden="true"
                                      className={`inline-block w-2 h-2 rounded-full shrink-0 ${severityDotClass(
                                        diffSeverity.grade
                                      )}`}
                                    />
                                    <span>{rem}</span>
                                  </button>
                                  {idx < suggestion.differentialRemedies.length - 1 && (
                                    <span className="text-slate-300 ml-2" aria-hidden="true">
                                      ·
                                    </span>
                                  )}
                                </span>
                              );
                            })}
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Side-by-Side Remedy Comparison Tool */}
      <section
        aria-label={t('Remedy Side-by-Side Comparison', 'পাশাপাশি রেমেডি তুলনা')}
        className="bg-white border border-slate-200 rounded-xl p-5 space-y-4"
      >
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <div className="flex items-center gap-2">
              <Scale className="w-4 h-4 text-teal-700 shrink-0" />
              <h2 className="font-display text-sm font-semibold text-slate-900">
                {t('Remedy Differentiation Table', 'রেমেডি পার্থক্য নির্ণয় টেবিল')}
              </h2>
            </div>
            <p className="text-xs text-slate-500 mt-0.5">
              {t(
                'Select two remedies to generate a structured side-by-side Materia Medica comparison highlighting clinical differences.',
                'দুটি রেমেডি নির্বাচন করে তাদের ক্লিনিক্যাল পার্থক্যসহ পাশাপাশি মেটেরিয়া মেডিকা তুলনা টেবিল তৈরি করুন।'
              )}
            </p>
          </div>

          {(compareResult || compareError || compareSelectA || compareSelectB || compareContext) && (
            <button
              type="button"
              onClick={clearComparison}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-600 hover:text-slate-900 cursor-pointer whitespace-nowrap shrink-0"
            >
              <X className="w-3.5 h-3.5" />
              {t('Clear Comparison', 'তুলনা মুছুন')}
            </button>
          )}
        </div>

        <form onSubmit={handleCompareSubmit} className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr] gap-2.5 items-start">
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-slate-700">
                {t('First Remedy', 'প্রথম রেমেডি')}
              </label>
              <select
                value={compareSelectA}
                onChange={(e) => setCompareSelectA(e.target.value)}
                aria-label={t('First remedy to compare', 'তুলনার প্রথম রেমেডি')}
                className="w-full px-3 py-2 text-sm bg-slate-50 border border-slate-300 rounded-lg focus:outline-none focus:bg-white focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
              >
                <option value="">{t('Select first remedy...', 'প্রথম রেমেডি নির্বাচন করুন...')}</option>
                {availableRemedies.map((rem) => (
                  <option key={rem} value={rem}>
                    {rem}
                  </option>
                ))}
                <option value="__custom__">
                  {t('Other remedy (type name)...', 'অন্য রেমেডি (নাম লিখুন)...')}
                </option>
              </select>
              {compareSelectA === '__custom__' && (
                <input
                  type="text"
                  maxLength={FIELD_LIMITS.remedyNameMax}
                  value={compareCustomA}
                  onChange={(e) => setCompareCustomA(e.target.value)}
                  placeholder={t(
                    'Enter classical remedy name (e.g. Gelsemium)',
                    'রেমেডির নাম লিখুন (যেমন: Gelsemium)'
                  )}
                  className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                />
              )}
            </div>

            <div className="flex md:pt-6 justify-center">
              <button
                type="button"
                onClick={handleSwapRemedies}
                aria-label={t('Swap remedies', 'রেমেডি অদলবদল')}
                title={t('Swap remedies', 'রেমেডি অদলবদল')}
                className="p-2 text-slate-500 hover:text-slate-900 bg-slate-50 border border-slate-200 rounded-lg hover:bg-slate-100 transition-colors cursor-pointer"
              >
                <ArrowLeftRight className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-slate-700">
                {t('Second Remedy', 'দ্বিতীয় রেমেডি')}
              </label>
              <select
                value={compareSelectB}
                onChange={(e) => setCompareSelectB(e.target.value)}
                aria-label={t('Second remedy to compare', 'তুলনার দ্বিতীয় রেমেডি')}
                className="w-full px-3 py-2 text-sm bg-slate-50 border border-slate-300 rounded-lg focus:outline-none focus:bg-white focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
              >
                <option value="">{t('Select second remedy...', 'দ্বিতীয় রেমেডি নির্বাচন করুন...')}</option>
                {availableRemedies.map((rem) => (
                  <option key={rem} value={rem}>
                    {rem}
                  </option>
                ))}
                <option value="__custom__">
                  {t('Other remedy (type name)...', 'অন্য রেমেডি (নাম লিখুন)...')}
                </option>
              </select>
              {compareSelectB === '__custom__' && (
                <input
                  type="text"
                  maxLength={FIELD_LIMITS.remedyNameMax}
                  value={compareCustomB}
                  onChange={(e) => setCompareCustomB(e.target.value)}
                  placeholder={t(
                    'Enter classical remedy name (e.g. Ignatia)',
                    'রেমেডির নাম লিখুন (যেমন: Ignatia)'
                  )}
                  className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                />
              )}
            </div>
          </div>

          <div className="flex flex-col sm:flex-row gap-2.5">
            <input
              type="text"
              maxLength={300}
              value={compareContext}
              onChange={(e) => setCompareContext(e.target.value)}
              placeholder={t(
                'Optional clinical focus (e.g. joint stiffness, sleeplessness, dry cough)...',
                'ঐচ্ছিক লক্ষণ কেন্দ্র (যেমন: গিঁটের ব্যথা, অনিদ্রা, শুষ্ক কাশি)...'
              )}
              className="flex-1 px-3 py-2 text-xs bg-slate-50 border border-slate-300 rounded-lg focus:outline-none focus:bg-white focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
            />
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="submit"
                disabled={comparing || !resolvedRemedyA || !resolvedRemedyB}
                className="inline-flex items-center justify-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-teal-700 rounded-lg hover:bg-teal-800 disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap shrink-0"
              >
                {comparing ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    {t('Comparing Remedies...', 'তুলনা তৈরি হচ্ছে...')}
                  </>
                ) : (
                  <>
                    <Scale className="w-3.5 h-3.5" />
                    {t('Compare Side by Side', 'পাশাপাশি তুলনা করুন')}
                  </>
                )}
              </button>
              {comparing && (
                <button
                  type="button"
                  onClick={cancelRemedyComparison}
                  className="inline-flex items-center justify-center gap-1 px-3 py-2 text-xs font-medium text-slate-700 bg-slate-100 border border-slate-300 rounded-lg hover:bg-slate-200 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                >
                  <X className="w-3.5 h-3.5" />
                  {t('Cancel', 'বাতিল')}
                </button>
              )}
            </div>
          </div>
        </form>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
          <span>{t('Classic pairs:', 'ক্লাসিক জোড়া:')}</span>
          {[
            ['Arsenicum album', 'Phosphorus'],
            ['Bryonia alba', 'Rhus toxicodendron'],
            ['Pulsatilla nigricans', 'Sepia officinalis'],
          ].map(([pairA, pairB], idx) => (
            <span key={`${pairA}-${pairB}`} className="inline-flex items-center gap-3">
              <button
                type="button"
                onClick={() => void executeRemedyComparison(pairA, pairB)}
                className="text-teal-800 hover:underline cursor-pointer"
              >
                {pairA} vs {pairB}
              </button>
              {idx < 2 && (
                <span className="text-slate-300" aria-hidden="true">
                  ·
                </span>
              )}
            </span>
          ))}
        </div>

        {compareError && (
          <div
            role="alert"
            className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-800"
          >
            {compareError}
          </div>
        )}

        {compareResult && (
          <div className="pt-4 border-t border-slate-200 space-y-4">
            <div className="space-y-1">
              <p className="text-xs font-medium text-slate-500">
                {t('Clinical Dividing Line:', 'মূল ক্লিনিক্যাল পার্থক্য:')} {compareResult.remedyA} vs{' '}
                {compareResult.remedyB}
              </p>
              <p className="text-sm text-slate-900 leading-relaxed">
                {compareResult.differentiationSummary}
              </p>
            </div>

            <div className="overflow-x-auto border border-slate-200 rounded-lg">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200">
                    <th className="py-3 px-4 text-xs font-semibold uppercase tracking-wide text-slate-500 w-52">
                      {t('Clinical Dimension', 'ক্লিনিক্যাল দিক')}
                    </th>
                    <th className="py-3 px-4 text-xs font-semibold text-teal-900">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-display text-sm">{compareResult.remedyA}</span>
                        <button
                          type="button"
                          onClick={() => setRemedyFilter(compareResult.remedyA)}
                          className="text-[11px] font-medium text-teal-800 hover:underline cursor-pointer whitespace-nowrap shrink-0"
                        >
                          {t('Filter rubrics', 'রুব্রিক ফিল্টার')}
                        </button>
                      </div>
                    </th>
                    <th className="py-3 px-4 text-xs font-semibold text-teal-900 border-l border-slate-200">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-display text-sm">{compareResult.remedyB}</span>
                        <button
                          type="button"
                          onClick={() => setRemedyFilter(compareResult.remedyB)}
                          className="text-[11px] font-medium text-teal-800 hover:underline cursor-pointer whitespace-nowrap shrink-0"
                        >
                          {t('Filter rubrics', 'রুব্রিক ফিল্টার')}
                        </button>
                      </div>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 text-xs">
                  {compareResult.rows.map((row) => (
                    <tr key={row.dimension} className="align-top bg-white">
                      <td className="py-3.5 px-4 bg-slate-50/50 border-r border-slate-200">
                        <p className="font-semibold text-slate-900">{row.dimension}</p>
                        {row.keyContrast && (
                          <p className="text-[11px] text-teal-800 mt-1 leading-snug">
                            {t('Contrast:', 'পার্থক্য:')} {row.keyContrast}
                          </p>
                        )}
                      </td>
                      <td className="py-3.5 px-4 text-slate-700 leading-relaxed">
                        {row.remedyAValue}
                      </td>
                      <td className="py-3.5 px-4 text-slate-700 leading-relaxed border-l border-slate-200">
                        {row.remedyBValue}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      {/* Local Search & Chapter Filters */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="relative flex-1 min-w-[240px]">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t(
                'Search symptom rubric, remedy (e.g. Arsenicum), modality, or keynote...',
                'সংরক্ষিত রুব্রিক, রেমেডি (যেমন Arsenicum), হ্রাস-বৃদ্ধি বা নোট খুঁজুন...'
              )}
              className="w-full pl-9 pr-3 py-2 text-xs bg-slate-50 border border-slate-300 rounded-lg focus:outline-none focus:bg-white focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
            />
          </div>

          {remedyFilter && (
            <button
              type="button"
              onClick={() => setRemedyFilter('')}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-teal-900 bg-teal-50 border border-teal-200 rounded-lg hover:bg-teal-100 transition-colors cursor-pointer whitespace-nowrap"
            >
              <span>
                {t('Remedy filter:', 'রেমেডি ফিল্টার:')} {remedyFilter}
              </span>
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg">
          <button
            type="button"
            onClick={() => setChapterFilter('all')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
              chapterFilter === 'all'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            {t('All Chapters', 'সকল অধ্যায়')}
          </button>
          {REPERTORY_CHAPTERS.map((chap) => (
            <button
              key={chap}
              type="button"
              onClick={() => setChapterFilter(chap)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                chapterFilter === chap
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {chapterLabels[chap]}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-[11px] text-slate-500">
          <span>
            {t(
              'Severity dots reflect repertory prominence & mention frequency across saved rubrics:',
              'তীব্রতার ডটগুলো সংরক্ষিত রুব্রিকে রেমেডির প্রাধান্য ও উল্লেখের সংখ্যা নির্দেশ করে:'
            )}
          </span>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block w-2 h-2 rounded-full bg-rose-600" aria-hidden="true" />
              {t('High (≥3× / Primary 2×+)', 'উচ্চ (≥৩ বার / প্রধান ২×+)')}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block w-2 h-2 rounded-full bg-amber-500" aria-hidden="true" />
              {t('Moderate (Primary / 2×)', 'মাঝারি (প্রধান / ২ বার)')}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block w-2 h-2 rounded-full bg-teal-600" aria-hidden="true" />
              {t('Mild (1× mention)', 'স্বল্প (১ বার)')}
            </span>
          </div>
        </div>
      </div>

      {/* Results List */}
      {loading ? (
        <div className="bg-white border border-slate-200 rounded-xl p-8 space-y-3">
          <div className="h-5 bg-slate-100 rounded w-1/3" />
          <div className="h-14 bg-slate-100 rounded" />
          <div className="h-14 bg-slate-100 rounded" />
        </div>
      ) : filteredEntries.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-12 text-center">
          <BookOpen className="w-7 h-7 text-slate-400 mx-auto mb-3" />
          <h2 className="font-display text-base font-semibold text-slate-900">
            {entries.length === 0
              ? t('Your clinical repertory is empty', 'আপনার ক্লিনিক্যাল রেপার্টরি এখনো খালি')
              : t('No matching symptom rubrics found', 'মিল থাকা কোনো লক্ষণ রুব্রিক পাওয়া যায়নি')}
          </h2>
          <p className="text-xs text-slate-500 mt-1 mb-6 max-w-md mx-auto">
            {entries.length === 0
              ? t(
                  'Store common homeopathic symptom rubrics, modalities, and indicated remedies for fast consultation lookup—or load 8 classic starter rubrics.',
                  'দ্রুত ক্লিনিক্যাল রেফারেন্সের জন্য সাধারণ লক্ষণ রুব্রিক, হ্রাস-বৃদ্ধি ও রেমেডি সংরক্ষণ করুন—অথবা ৮টি ক্লাসিক রুব্রিক লোড করুন।'
                )
              : t(
                  'Try adjusting your search keywords, clearing the remedy filter, or selecting All Chapters.',
                  'অনুসন্ধান শব্দ পরিবর্তন করুন, রেমেডি ফিল্টার মুছুন অথবা সকল অধ্যায় নির্বাচন করুন।'
                )}
          </p>
          {entries.length === 0 && (
            <div className="flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                disabled={seeding}
                onClick={handleSeedStarterRubrics}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer"
              >
                <Sparkles className="w-3.5 h-3.5 text-teal-700" />
                {seeding
                  ? t('Loading...', 'লোড হচ্ছে...')
                  : t('Load Classic Rubrics', 'ক্লাসিক রুব্রিক লোড করুন')}
              </button>
              <button
                type="button"
                onClick={openCreateModal}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-teal-700 rounded-lg hover:bg-teal-800 transition-colors cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                {t('Add First Rubric', 'প্রথম রুব্রিক যোগ করুন')}
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {filteredEntries.map((entry) => {
            const isDeleting = confirmDeleteId === entry.id;
            return (
              <article
                key={entry.id}
                className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between gap-4"
              >
                <div className="space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      {(() => {
                        const primarySeverity = getSavedRemedySeverity(entry.primaryRemedy, true);
                        return (
                          <p className="text-xs text-slate-500 mb-1 tabular-nums flex flex-wrap items-center gap-x-1.5">
                            <span>{chapterLabels[entry.chapter]}</span>
                            <span aria-hidden="true">·</span>
                            <span
                              title={primarySeverity.label}
                              className="inline-flex items-center gap-1.5 font-medium text-teal-800"
                            >
                              <span
                                aria-hidden="true"
                                className={`inline-block w-2 h-2 rounded-full shrink-0 ${severityDotClass(
                                  primarySeverity.grade
                                )}`}
                              />
                              <span>{entry.primaryRemedy}</span>
                            </span>
                          </p>
                        );
                      })()}
                      <h3 className="font-display text-base font-semibold text-slate-900 leading-snug">
                        {entry.rubric}
                      </h3>
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => openEditModal(entry)}
                        aria-label={t('Edit rubric', 'রুব্রিক সম্পাদনা')}
                        className="p-1.5 text-slate-400 hover:text-slate-900 rounded-lg hover:bg-slate-100 transition-colors cursor-pointer"
                      >
                        <Edit3 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(isDeleting ? null : entry.id)}
                        aria-label={t('Delete rubric', 'রুব্রিক মুছুন')}
                        className="p-1.5 text-slate-400 hover:text-red-700 rounded-lg hover:bg-slate-100 transition-colors cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>

                  {isDeleting && (
                    <div className="p-2.5 bg-red-50 border border-red-200 rounded-lg flex items-center justify-between gap-2 text-xs">
                      <span className="text-red-900">
                        {t('Remove this rubric from repertory?', 'রেপার্টরি থেকে এই রুব্রিকটি মুছবেন?')}
                      </span>
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => handleDeleteEntry(entry.id)}
                          className="px-2.5 py-1 text-xs font-medium text-white bg-red-700 rounded hover:bg-red-800 cursor-pointer"
                        >
                          {t('Delete', 'মুছুন')}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(null)}
                          className="px-2 py-1 text-xs text-slate-700 hover:text-slate-900 cursor-pointer"
                        >
                          {t('Cancel', 'বাতিল')}
                        </button>
                      </div>
                    </div>
                  )}

                  {entry.modalities && (
                    <p className="text-xs text-slate-600 leading-relaxed">
                      <span className="font-medium text-slate-700">
                        {t('Modalities:', 'হ্রাস-বৃদ্ধি:')}
                      </span>{' '}
                      {entry.modalities}
                    </p>
                  )}

                  {entry.symptomNotes && (
                    <p className="text-xs text-slate-600 leading-relaxed">
                      {entry.symptomNotes}
                    </p>
                  )}
                </div>

                <div className="pt-3 border-t border-slate-100 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                  <span className="text-slate-500">{t('Remedies:', 'রেমেডি:')}</span>
                  {entry.remedies.map((rem, idx) => {
                    const isPrimary = rem.toLowerCase() === entry.primaryRemedy.toLowerCase();
                    const severity = getSavedRemedySeverity(rem, isPrimary);
                    return (
                      <span key={rem} className="inline-flex items-center">
                        <button
                          type="button"
                          onClick={() =>
                            setRemedyFilter((prev) =>
                              prev.toLowerCase() === rem.toLowerCase() ? '' : rem
                            )
                          }
                          title={`${severity.label} — ${t(
                            'Click to filter repertory by this remedy',
                            'এই রেমেডি দিয়ে ফিল্টার করতে ক্লিক করুন'
                          )}`}
                          className={`inline-flex items-center gap-1.5 hover:underline cursor-pointer ${
                            isPrimary ? 'font-semibold text-teal-800' : 'text-slate-700'
                          }`}
                        >
                          <span
                            aria-hidden="true"
                            className={`inline-block w-2 h-2 rounded-full shrink-0 ${severityDotClass(
                              severity.grade
                            )}`}
                          />
                          <span>{rem}</span>
                          {severity.mentions > 1 && (
                            <span className="font-mono text-[10px] text-slate-400 tabular-nums">
                              ×{severity.mentions}
                            </span>
                          )}
                        </button>
                        {idx < entry.remedies.length - 1 && (
                          <span className="text-slate-300 ml-2" aria-hidden="true">
                            ·
                          </span>
                        )}
                      </span>
                    );
                  })}
                </div>
              </article>
            );
          })}
        </div>
      )}

      {/* Add / Edit Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white border border-slate-200 rounded-xl w-full max-w-xl my-8 overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
              <h2 className="font-display text-lg font-semibold text-slate-900">
                {editingEntry
                  ? t('Edit Symptom Rubric', 'লক্ষণ রুব্রিক সম্পাদনা')
                  : t('Add Repertory Rubric', 'রেপার্টরি রুব্রিক যোগ করুন')}
              </h2>
              <button
                type="button"
                onClick={() => setShowModal(false)}
                aria-label={t('Close modal', 'বন্ধ করুন')}
                className="p-2 text-slate-500 hover:text-slate-900 rounded-lg hover:bg-slate-100 transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveEntry} className="p-6 space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">
                    {t('Repertory Chapter *', 'রেপার্টরি অধ্যায় *')}
                  </label>
                  <select
                    value={chapter}
                    onChange={(e) => setChapter(e.target.value as RepertoryChapter)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                  >
                    {REPERTORY_CHAPTERS.map((chap) => (
                      <option key={chap} value={chap}>
                        {chapterLabels[chap]}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">
                    {t('Primary Indicated Remedy *', 'প্রধান নির্দেশিত রেমেডি *')}
                  </label>
                  <input
                    type="text"
                    required
                    list="repertory-remedies"
                    maxLength={FIELD_LIMITS.remedyNameMax}
                    value={primaryRemedy}
                    onChange={(e) => setPrimaryRemedy(e.target.value)}
                    placeholder="e.g. Arsenicum album"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                  />
                  <datalist id="repertory-remedies">
                    {COMMON_REMEDIES.map((rem) => (
                      <option key={rem} value={rem} />
                    ))}
                  </datalist>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  {t('Symptom Rubric *', 'লক্ষণ রুব্রিক *')}
                </label>
                <input
                  type="text"
                  required
                  maxLength={FIELD_LIMITS.rubricMax}
                  value={rubric}
                  onChange={(e) => setRubric(e.target.value)}
                  placeholder={t(
                    'e.g. Burning neuralgic pain, worse cold air, better warm applications',
                    'যেমন: জ্বালাকর স্নায়বিক ব্যথা, ঠান্ডা বাতাসে বাড়ে, গরমে উপশম'
                  )}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  {t(
                    'Differential Remedies (Comma-separated, up to 19 additional)',
                    'সহযোগী/বিকল্প রেমেডি (কমা দিয়ে আলাদা করুন, সর্বোচ্চ ১৯টি)'
                  )}
                </label>
                <input
                  type="text"
                  value={otherRemediesInput}
                  onChange={(e) => setOtherRemediesInput(e.target.value)}
                  placeholder="e.g. Phosphorus, Rhus toxicodendron, Magnesia phosphorica"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  {t('Modalities (< Worse / > Better)', 'হ্রাস-বৃদ্ধি (< বৃদ্ধি / > উপশম)')}
                </label>
                <input
                  type="text"
                  maxLength={FIELD_LIMITS.modalitiesMax}
                  value={modalities}
                  onChange={(e) => setModalities(e.target.value)}
                  placeholder={t(
                    'e.g. < midnight, cold drafts; > warmth, gentle motion',
                    'যেমন: < মধ্যরাত, ঠান্ডা বাতাস; > উষ্ণতা, হালকা নড়াচড়া'
                  )}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  {t('Keynote & Differentiation Notes', 'মূল লক্ষণ ও পার্থক্য নোট')}
                </label>
                <textarea
                  rows={3}
                  maxLength={FIELD_LIMITS.symptomNotesMax}
                  value={symptomNotes}
                  onChange={(e) => setSymptomNotes(e.target.value)}
                  placeholder={t(
                    'Concomitant symptoms, thermal state, or clinical pearls for distinguishing remedies...',
                    'সহগামী লক্ষণ, তাপমাত্রা প্রবণতা বা রেমেডি পৃথক করার ক্লিনিক্যাল নোট...'
                  )}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700"
                />
              </div>

              {formError && (
                <p className="text-xs text-red-700 font-medium" role="alert">
                  {formError}
                </p>
              )}

              <div className="pt-4 border-t border-slate-200 flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors cursor-pointer whitespace-nowrap"
                >
                  {t('Cancel', 'বাতিল')}
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-5 py-2 text-sm font-medium text-white bg-teal-700 rounded-lg hover:bg-teal-800 disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
                >
                  {submitting
                    ? t('Saving...', 'সংরক্ষণ হচ্ছে...')
                    : editingEntry
                      ? t('Save Changes', 'পরিবর্তন সংরক্ষণ')
                      : t('Add Rubric', 'রুব্রিক যোগ করুন')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
