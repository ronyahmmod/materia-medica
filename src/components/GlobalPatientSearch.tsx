import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { getDocs, query, where } from 'firebase/firestore';
import { ArrowRight, Loader2, MapPin, Search, User, X } from 'lucide-react';
import { useLanguage } from '../i18n/LanguageContext';
import { PATIENT_TYPE_LABELS_I18N, STATUS_LABELS_I18N } from '../i18n/translations';
import { tenantPatientsCol } from '../lib/tenantPaths';
import type { ClinicTenant, Patient, PatientStatus } from '../types/clinic';

interface GlobalPatientSearchProps {
  clinics: ClinicTenant[];
  activeClinic: ClinicTenant | null;
  activeClinicPatients: Patient[];
  isSuperAdmin: boolean;
  currentUserUid: string;
  onSelectPatient: (clinicId: string, patientId: string) => void;
  onViewAllInRegistry: (clinicId: string, queryText: string) => void;
}

interface SearchResultItem {
  clinicId: string;
  clinicName: string;
  patient: Patient;
  score: number;
}

const STATUS_TEXT_CLASS: Record<PatientStatus, string> = {
  active: 'text-emerald-700',
  'follow-up': 'text-amber-700',
  archived: 'text-slate-500',
};

const CACHE_TTL_MS = 60_000;

export function GlobalPatientSearch({
  clinics,
  activeClinic,
  activeClinicPatients,
  isSuperAdmin,
  currentUserUid,
  onSelectPatient,
  onViewAllInRegistry,
}: GlobalPatientSearchProps) {
  const { language, t } = useLanguage();
  const statusLabels = STATUS_LABELS_I18N[language];
  const patientTypeLabels = PATIENT_TYPE_LABELS_I18N[language];

  const [queryText, setQueryText] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [loadingOtherClinics, setLoadingOtherClinics] = useState(false);
  const [otherClinicsPatients, setOtherClinicsPatients] = useState<
    Record<string, Patient[]>
  >({});

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const lastFetchedAtRef = useRef<number>(0);
  const lastUidRef = useRef<string>(currentUserUid);

  // Reset multi-clinic search cache when user changes
  useEffect(() => {
    if (lastUidRef.current !== currentUserUid) {
      lastUidRef.current = currentUserUid;
      lastFetchedAtRef.current = 0;
      setOtherClinicsPatients({});
      setQueryText('');
      setIsOpen(false);
    }
  }, [currentUserUid]);

  // Global keyboard shortcut: Cmd/Ctrl + K or "/" outside inputs
  useEffect(() => {
    const handleGlobalKeyDown = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
        setIsOpen(true);
        return;
      }
      if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const target = e.target as HTMLElement | null;
        const tag = target?.tagName?.toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable) {
          return;
        }
        e.preventDefault();
        inputRef.current?.focus();
        setIsOpen(true);
      }
    };

    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    if (!isOpen) return;
    const handleOutsideClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [isOpen]);

  // Lazily fetch patient directories for other accessible clinics when searching across >1 clinic
  useEffect(() => {
    if (!isOpen && queryText.trim().length === 0) return;
    const otherClinics = clinics.filter((c) => {
      if (c.id === activeClinic?.id) return false;
      if (!isSuperAdmin && c.subscriptionStatus === 'suspended') return false;
      return true;
    });
    if (otherClinics.length === 0) return;
    if (Date.now() - lastFetchedAtRef.current < CACHE_TTL_MS) return;

    let cancelled = false;
    setLoadingOtherClinics(true);

    Promise.all(
      otherClinics.slice(0, 20).map(async (clinic) => {
        try {
          const source = isSuperAdmin
            ? tenantPatientsCol(clinic.id)
            : query(
                tenantPatientsCol(clinic.id),
                where('clinicAccessUids', 'array-contains', currentUserUid)
              );
          const snap = await getDocs(source);
          const rows = snap.docs
            .map((d) => ({
              id: d.id,
              ...(d.data() as Omit<Patient, 'id'>),
            }))
            .filter((p) => !p.isDeleted);
          return [clinic.id, rows] as const;
        } catch {
          return [clinic.id, [] as Patient[]] as const;
        }
      })
    )
      .then((entries) => {
        if (cancelled) return;
        const map: Record<string, Patient[]> = {};
        for (const [cid, rows] of entries) {
          map[cid] = rows;
        }
        lastFetchedAtRef.current = Date.now();
        setOtherClinicsPatients(map);
      })
      .finally(() => {
        if (!cancelled) setLoadingOtherClinics(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activeClinic?.id, clinics, currentUserUid, isOpen, isSuperAdmin, queryText]);

  const clinicMap = useMemo(() => {
    const map = new Map<string, ClinicTenant>();
    for (const c of clinics) {
      map.set(c.id, c);
    }
    return map;
  }, [clinics]);

  const trimmedQuery = queryText.trim();

  const { matches, totalMatchCount, addressMatchCount } = useMemo(() => {
    const q = trimmedQuery.toLowerCase();
    const pool: Array<{ clinicId: string; clinicName: string; patient: Patient }> = [];
    const seen = new Set<string>();

    if (activeClinic) {
      for (const pat of activeClinicPatients) {
        if (pat.isDeleted) continue;
        const key = `${activeClinic.id}:${pat.id}`;
        seen.add(key);
        pool.push({ clinicId: activeClinic.id, clinicName: activeClinic.clinicName, patient: pat });
      }
    }

    for (const [cid, list] of Object.entries(otherClinicsPatients)) {
      const clinicObj = clinicMap.get(cid);
      if (!clinicObj) continue;
      for (const pat of list) {
        if (pat.isDeleted) continue;
        const key = `${cid}:${pat.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pool.push({ clinicId: cid, clinicName: clinicObj.clinicName, patient: pat });
      }
    }

    if (!q) {
      // When focused with empty query, surface most recent patients in active clinic
      const recent = pool.slice(0, 6).map((entry, idx) => ({
        ...entry,
        score: 100 - idx,
      }));
      return { matches: recent, totalMatchCount: pool.length, addressMatchCount: 0 };
    }

    const scored: SearchResultItem[] = [];
    let addrMatches = 0;

    for (const entry of pool) {
      const p = entry.patient;
      const nameLower = p.fullName.toLowerCase();
      const caseLower = p.caseNumber.toLowerCase();
      const phoneLower = p.phone.toLowerCase();
      const addressLower = (p.address || '').toLowerCase();
      const complaintLower = p.chiefComplaint.toLowerCase();
      const remedyLower = (p.lastRemedy || '').toLowerCase();
      const emailLower = (p.email || '').toLowerCase();
      const notesLower = (p.constitutionNotes || '').toLowerCase();
      const ownerLower = (p.ownerOrGuardianName || '').toLowerCase();
      const breedLower = (p.animalSpeciesOrBreed || '').toLowerCase();
      const typeLower = (p.patientType || 'human').toLowerCase();

      const hasAddressMatch = Boolean(addressLower) && addressLower.includes(q);
      if (hasAddressMatch) {
        addrMatches += 1;
      }

      let score = 0;
      if (caseLower === q || nameLower === q) score = 100;
      else if (nameLower.startsWith(q) || caseLower.startsWith(q)) score = 80;
      else if (phoneLower.includes(q)) score = 65;
      else if (nameLower.includes(q) || caseLower.includes(q) || ownerLower.includes(q)) score = 60;
      else if (hasAddressMatch) score = 55;
      else if (remedyLower.includes(q)) score = 45;
      else if (complaintLower.includes(q) || breedLower.includes(q) || typeLower.includes(q)) score = 35;
      else if (emailLower.includes(q) || notesLower.includes(q)) score = 20;

      if (score > 0) {
        // Slightly prioritize currently active clinic on ties
        if (activeClinic && entry.clinicId === activeClinic.id) {
          score += 5;
        }
        scored.push({ ...entry, score });
      }
    }

    scored.sort((a, b) => b.score - a.score || a.patient.fullName.localeCompare(b.patient.fullName));
    return {
      matches: scored.slice(0, 12),
      totalMatchCount: scored.length,
      addressMatchCount: addrMatches,
    };
  }, [activeClinic, activeClinicPatients, clinicMap, otherClinicsPatients, trimmedQuery]);

  useEffect(() => {
    setHighlightedIndex(0);
  }, [trimmedQuery, matches.length]);

  const handleChoose = (item: SearchResultItem) => {
    setIsOpen(false);
    setQueryText('');
    onSelectPatient(item.clinicId, item.patient.id);
  };

  const handleInputKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setIsOpen(false);
      inputRef.current?.blur();
      return;
    }
    if (!isOpen) {
      if (e.key === 'ArrowDown') {
        setIsOpen(true);
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (matches.length > 0) {
        setHighlightedIndex((prev) => (prev + 1) % matches.length);
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (matches.length > 0) {
        setHighlightedIndex((prev) => (prev - 1 + matches.length) % matches.length);
      }
    } else if (e.key === 'Enter') {
      if (matches.length > 0) {
        e.preventDefault();
        const chosen = matches[highlightedIndex] || matches[0];
        if (chosen) handleChoose(chosen);
      }
    }
  };

  const showClinicBadge = clinics.length > 1;
  const hasAnyPatientsAvailable = activeClinicPatients.length > 0 || Object.values(otherClinicsPatients).some((arr) => arr.length > 0);

  return (
    <div ref={containerRef} className="relative flex-1 max-w-md min-w-0">
      <div className="relative flex items-center">
        <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 pointer-events-none" />
        <input
          ref={inputRef}
          type="search"
          role="combobox"
          aria-expanded={isOpen}
          aria-autocomplete="list"
          aria-label={t('Global patient search', 'সব রোগীর মধ্যে অনুসন্ধান')}
          value={queryText}
          onFocus={() => setIsOpen(true)}
          onChange={(e) => {
            setQueryText(e.target.value);
            setIsOpen(true);
          }}
          onKeyDown={handleInputKeyDown}
          placeholder={t(
            'Search all patients (name, case #, phone, address, remedy)...',
            'রোগী খুঁজুন (নাম, কেস নং, ফোন, ঠিকানা, ওষুধ)...'
          )}
          className="w-full pl-8 pr-8 sm:pr-14 py-1.5 text-xs bg-slate-50 border border-slate-300 rounded-lg text-slate-900 placeholder:text-slate-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-teal-700/20 focus:border-teal-700 transition-colors"
        />

        <div className="absolute right-2 flex items-center gap-1">
          {loadingOtherClinics && (
            <Loader2 className="w-3 h-3 text-slate-400 animate-spin" />
          )}
          {queryText ? (
            <button
              type="button"
              onClick={() => {
                setQueryText('');
                inputRef.current?.focus();
              }}
              aria-label={t('Clear search', 'অনুসন্ধান মুছুন')}
              className="p-0.5 text-slate-400 hover:text-slate-700 rounded cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          ) : (
            <kbd className="hidden sm:inline-block px-1.5 py-0.5 text-[10px] font-mono text-slate-400 bg-white border border-slate-200 rounded">
              Ctrl K
            </kbd>
          )}
        </div>
      </div>

      {isOpen && (
        <div
          role="listbox"
          aria-label={t('Matching patient records', 'মিলে যাওয়া রোগীর তালিকা')}
          className="fixed left-3 right-3 top-[4.25rem] sm:absolute sm:left-0 sm:right-0 sm:top-auto sm:mt-1.5 bg-white border border-slate-200 rounded-xl shadow-xl z-50 overflow-hidden"
        >
          <div className="px-3 py-2 border-b border-slate-100 bg-slate-50/70 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-slate-700 tabular-nums">
                {trimmedQuery
                  ? t(
                      `${totalMatchCount} matching patient${totalMatchCount === 1 ? '' : 's'}`,
                      `মোট ${totalMatchCount} জন রোগী পাওয়া গেছে`
                    )
                  : t('Quick Jump — Recent Patients', 'দ্রুত খুলুন — সাম্প্রতিক রোগী')}
              </span>
              {trimmedQuery && addressMatchCount > 0 && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-teal-50 border border-teal-200 text-teal-800 font-medium text-[10px] tabular-nums">
                  <MapPin className="w-3 h-3 shrink-0" />
                  {t(
                    `${addressMatchCount} at this address`,
                    `এই ঠিকানায় ${addressMatchCount} জন`
                  )}
                </span>
              )}
            </div>
            {showClinicBadge && (
              <span className="text-[10px] text-slate-400">
                {t('All accessible clinics', 'সব ক্লিনিক জুড়ে')}
              </span>
            )}
          </div>

          {!hasAnyPatientsAvailable && !loadingOtherClinics ? (
            <div className="p-5 text-center text-xs text-slate-500">
              {t(
                'No patient records found in your workspace yet.',
                'আপনার ওয়ার্কস্পেসে এখনো কোনো রোগীর রেকর্ড নেই।'
              )}
            </div>
          ) : matches.length === 0 ? (
            <div className="p-5 text-center text-xs text-slate-500">
              {t(
                `No patients matched "${trimmedQuery}".`,
                `"${trimmedQuery}"-এর সাথে কোনো রোগীর রেকর্ড মেলেনি।`
              )}
            </div>
          ) : (
            <div className="max-h-80 overflow-y-auto divide-y divide-slate-100">
              {matches.map((item, idx) => {
                const isActiveItem = idx === highlightedIndex;
                const p = item.patient;
                return (
                  <button
                    key={`${item.clinicId}:${p.id}`}
                    type="button"
                    role="option"
                    aria-selected={isActiveItem}
                    onMouseEnter={() => setHighlightedIndex(idx)}
                    onClick={() => handleChoose(item)}
                    className={`w-full text-left px-3.5 py-2.5 flex items-start justify-between gap-3 transition-colors cursor-pointer ${
                      isActiveItem ? 'bg-teal-50/70' : 'hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-start gap-2.5 min-w-0">
                      <User className="w-4 h-4 text-slate-400 mt-0.5 shrink-0" />
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                          <span className="text-xs font-semibold text-slate-900 truncate">
                            {p.fullName}
                          </span>
                          {p.patientType && p.patientType !== 'Human' && (
                            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200">
                              {patientTypeLabels[p.patientType]}
                            </span>
                          )}
                          <span className="font-mono text-[11px] text-slate-500 tabular-nums">
                            {p.caseNumber}
                          </span>
                          <span className={`text-[11px] font-medium ${STATUS_TEXT_CLASS[p.status]}`}>
                            {statusLabels[p.status]}
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-500 truncate mt-0.5">
                          <span className="tabular-nums">{p.phone}</span>
                          {p.ownerOrGuardianName ? ` · ${p.ownerOrGuardianName}` : ''}
                          {p.lastRemedy ? ` · ${p.lastRemedy}` : ''}
                          {p.chiefComplaint ? ` · ${p.chiefComplaint}` : ''}
                        </p>
                        {p.address && (
                          <p className="text-[10px] text-slate-500 truncate mt-0.5 flex items-center gap-1">
                            <MapPin className="w-3 h-3 text-slate-400 shrink-0" />
                            <span className="truncate">{p.address}</span>
                          </p>
                        )}
                        {showClinicBadge && (
                          <p className="text-[10px] text-teal-800 font-medium mt-0.5 truncate">
                            {item.clinicName}
                          </p>
                        )}
                      </div>
                    </div>
                    <ArrowRight className="w-3.5 h-3.5 text-slate-400 mt-1 shrink-0" />
                  </button>
                );
              })}
            </div>
          )}

          {trimmedQuery && activeClinic && totalMatchCount > 0 && (
            <button
              type="button"
              onClick={() => {
                setIsOpen(false);
                setQueryText('');
                onViewAllInRegistry(activeClinic.id, trimmedQuery);
              }}
              className="w-full px-3.5 py-2 border-t border-slate-200 bg-slate-50/90 hover:bg-slate-100 text-[11px] font-medium text-teal-800 flex items-center justify-between cursor-pointer transition-colors"
            >
              <span>
                {t(
                  `Filter "${trimmedQuery}" in Patient Registry`,
                  `রোগী তালিকায় "${trimmedQuery}" দেখুন`
                )}
              </span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
