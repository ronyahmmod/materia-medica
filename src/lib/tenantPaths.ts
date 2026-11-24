import {
  collection,
  doc,
  getDocs,
  serverTimestamp,
  writeBatch,
} from 'firebase/firestore';
import { db } from '../firebase';
import {
  CLINIC_SLUG_REGEX,
  type ClinicAccentTheme,
  type ClinicTenant,
  type PlatformHostingConfig,
} from '../types/clinic';

export const SUPER_ADMIN_EMAIL = 'rony.jib@gmail.com';
export const DEFAULT_PLATFORM_CONFIG_ID = 'hosting';

let currentActiveClinicHeaderId: string | null = null;

export function setActiveClinicHeaderId(clinicId: string | null): void {
  currentActiveClinicHeaderId = clinicId;
}

export function getActiveClinicHeaderId(): string | null {
  return currentActiveClinicHeaderId;
}

export function buildApiUrl(apiPath: string): string {
  const rawBase = (import.meta.env.VITE_API_BASE_URL || '').trim().replace(/\/+$/, '');
  const normalizedPath = apiPath.startsWith('/') ? apiPath : `/${apiPath}`;
  if (!rawBase) return normalizedPath;
  return `${rawBase}${normalizedPath}`;
}

export interface AccentThemePalette {
  primaryBtn: string;
  navActive: string;
  navIconActive: string;
  accentText: string;
  softPanel: string;
  ringSelected: string;
  barFill: string;
  swatchHex: string;
}

export const ACCENT_THEME_PALETTES: Record<ClinicAccentTheme, AccentThemePalette> = {
  teal: {
    primaryBtn: 'bg-teal-700 hover:bg-teal-800 text-white',
    navActive: 'bg-teal-50 text-teal-900',
    navIconActive: 'text-teal-700',
    accentText: 'text-teal-800',
    softPanel: 'text-teal-800 bg-teal-50 border-teal-200 hover:bg-teal-100',
    ringSelected: 'border-teal-700 ring-1 ring-teal-700/20',
    barFill: 'bg-teal-700',
    swatchHex: 'bg-teal-700',
  },
  indigo: {
    primaryBtn: 'bg-indigo-700 hover:bg-indigo-800 text-white',
    navActive: 'bg-indigo-50 text-indigo-900',
    navIconActive: 'text-indigo-700',
    accentText: 'text-indigo-800',
    softPanel: 'text-indigo-800 bg-indigo-50 border-indigo-200 hover:bg-indigo-100',
    ringSelected: 'border-indigo-700 ring-1 ring-indigo-700/20',
    barFill: 'bg-indigo-700',
    swatchHex: 'bg-indigo-700',
  },
  emerald: {
    primaryBtn: 'bg-emerald-700 hover:bg-emerald-800 text-white',
    navActive: 'bg-emerald-50 text-emerald-900',
    navIconActive: 'text-emerald-700',
    accentText: 'text-emerald-800',
    softPanel: 'text-emerald-800 bg-emerald-50 border-emerald-200 hover:bg-emerald-100',
    ringSelected: 'border-emerald-700 ring-1 ring-emerald-700/20',
    barFill: 'bg-emerald-700',
    swatchHex: 'bg-emerald-700',
  },
  slate: {
    primaryBtn: 'bg-slate-900 hover:bg-slate-800 text-white',
    navActive: 'bg-slate-200/80 text-slate-900',
    navIconActive: 'text-slate-800',
    accentText: 'text-slate-800',
    softPanel: 'text-slate-800 bg-slate-100 border-slate-300 hover:bg-slate-200',
    ringSelected: 'border-slate-900 ring-1 ring-slate-900/20',
    barFill: 'bg-slate-800',
    swatchHex: 'bg-slate-800',
  },
};

export const RESERVED_CLINIC_SLUGS = new Set([
  'api',
  'src',
  'assets',
  'public',
  'c',
  'admin',
  'login',
  'logout',
  'health',
  'static',
]);

const VERBOSE_SLUG_WORDS = new Set([
  'classical',
  'homeopathic',
  'homoeopathic',
  'research',
  'center',
  'centre',
  'international',
  'foundation',
  'modern',
  'digital',
  'and',
  'the',
  'of',
]);

export function sanitizeClinicSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

export function suggestShortClinicSlug(clinicName: string): string {
  const full = sanitizeClinicSlug(clinicName);
  if (!full) return '';

  const rawWords = full.split('-').filter(Boolean);
  const conciseWords = rawWords.filter((w) => !VERBOSE_SLUG_WORDS.has(w));
  const candidateWords = conciseWords.length > 0 ? conciseWords : rawWords;

  let short = '';
  for (const word of candidateWords) {
    const next = short ? `${short}-${word}` : word;
    if (next.length > 24 && short.length >= 3) break;
    short = next;
    if (short.split('-').length >= 3) break;
  }

  const clean = short.slice(0, 24).replace(/-+$/g, '');
  if (clean.length >= 2 && !RESERVED_CLINIC_SLUGS.has(clean)) {
    return clean;
  }
  return full.slice(0, 24).replace(/-+$/g, '');
}

export function isValidClinicSlug(slug: string): boolean {
  return (
    slug.length >= 2 &&
    slug.length <= 64 &&
    CLINIC_SLUG_REGEX.test(slug) &&
    !RESERVED_CLINIC_SLUGS.has(slug)
  );
}

export function buildClinicAccessEmails(ownerEmail: string, extraRaw?: string): string[] {
  const seen = new Set<string>();
  const add = (val: string) => {
    const clean = val.trim().toLowerCase();
    if (clean && clean.includes('@') && clean.length <= 160 && !seen.has(clean)) {
      seen.add(clean);
    }
  };
  add(ownerEmail);
  if (extraRaw) {
    for (const part of extraRaw.split(/[,;\n]+/)) {
      if (seen.size >= 10) break;
      add(part);
    }
  }
  return Array.from(seen).slice(0, 10);
}

export function extractClinicSlugFromLocation(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const url = new URL(window.location.href);

    // 1. Query param support: /?c=<slug> or /?clinic=<slug>
    const paramSlug = url.searchParams.get('c') || url.searchParams.get('clinic');
    if (paramSlug) {
      const clean = sanitizeClinicSlug(paramSlug);
      return isValidClinicSlug(clean) ? clean : null;
    }

    // 2. Legacy prefixed path support: /c/<slug>
    const prefixedMatch = url.pathname.match(/^\/c\/([a-zA-Z0-9-]+)\/?$/);
    if (prefixedMatch?.[1]) {
      const clean = sanitizeClinicSlug(prefixedMatch[1]);
      return isValidClinicSlug(clean) ? clean : null;
    }

    // 3. Clean short root path: /<slug>
    const rootMatch = url.pathname.match(/^\/([a-zA-Z0-9-]+)\/?$/);
    if (rootMatch?.[1]) {
      const clean = sanitizeClinicSlug(rootMatch[1]);
      return isValidClinicSlug(clean) ? clean : null;
    }
  } catch {
    return null;
  }
  return null;
}

export function buildShortClinicPath(slug: string): string {
  const clean = sanitizeClinicSlug(slug);
  return `/${clean || slug}`;
}

export function isPrivateDevPreviewUrl(url?: string): boolean {
  return /^https?:\/\/ais-dev-/i.test((url || '').trim());
}

export function sanitizeShareBaseUrl(configuredBaseUrl?: string): string {
  const configured = (configuredBaseUrl || '').trim().replace(/\/+$/, '');
  const windowOrigin =
    typeof window !== 'undefined' ? window.location.origin.trim().replace(/\/+$/, '') : '';

  if (configured && !isPrivateDevPreviewUrl(configured)) {
    return configured;
  }
  if (windowOrigin && !isPrivateDevPreviewUrl(windowOrigin)) {
    return windowOrigin;
  }
  const candidate = configured || windowOrigin;
  return candidate.replace(/^https?:\/\/ais-dev-/i, 'https://ais-pre-');
}

export function buildClinicShareUrl(slug: string, configuredBaseUrl?: string): string {
  const base = sanitizeShareBaseUrl(configuredBaseUrl);
  const cleanSlug = sanitizeClinicSlug(slug) || slug;
  return `${base}/${encodeURIComponent(cleanSlug)}`;
}

export function formatReadableClinicUrl(slug: string, configuredBaseUrl?: string): string {
  return buildClinicShareUrl(slug, configuredBaseUrl).replace(/^https?:\/\//i, '');
}

// Firestore tenant path builders
export function tenantPatientsCol(clinicId: string) {
  return collection(db, 'clinics', clinicId, 'patients');
}

export function tenantPatientDoc(clinicId: string, patientId: string) {
  return doc(db, 'clinics', clinicId, 'patients', patientId);
}

export function tenantConsultationsCol(clinicId: string, patientId: string) {
  return collection(db, 'clinics', clinicId, 'patients', patientId, 'consultations');
}

export function tenantConsultationDoc(clinicId: string, patientId: string, consultationId: string) {
  return doc(db, 'clinics', clinicId, 'patients', patientId, 'consultations', consultationId);
}

export function tenantPhotosCol(clinicId: string, patientId: string) {
  return collection(db, 'clinics', clinicId, 'patients', patientId, 'photos');
}

export function tenantPhotoDoc(clinicId: string, patientId: string, photoId: string) {
  return doc(db, 'clinics', clinicId, 'patients', patientId, 'photos', photoId);
}

export function tenantNotesCol(clinicId: string, patientId: string) {
  return collection(db, 'clinics', clinicId, 'patients', patientId, 'clinical_notes');
}

export function tenantNoteDoc(clinicId: string, patientId: string, noteId: string) {
  return doc(db, 'clinics', clinicId, 'patients', patientId, 'clinical_notes', noteId);
}

export function tenantFeesCol(clinicId: string) {
  return collection(db, 'clinics', clinicId, 'fee_records');
}

export function tenantFeeDoc(clinicId: string, feeId: string) {
  return doc(db, 'clinics', clinicId, 'fee_records', feeId);
}

export function tenantRepertoryCol(clinicId: string) {
  return collection(db, 'clinics', clinicId, 'repertory_entries');
}

export function tenantRepertoryDoc(clinicId: string, entryId: string) {
  return doc(db, 'clinics', clinicId, 'repertory_entries', entryId);
}

export function buildDefaultPlatformConfig(uid: string): Omit<PlatformHostingConfig, 'id' | 'updatedAt'> & { updatedAt: ReturnType<typeof serverTimestamp> } {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const publicOrigin = isPrivateDevPreviewUrl(origin) ? '' : origin;
  return {
    platformName: 'Materia Medica SaaS',
    supportEmail: SUPER_ADMIN_EMAIL,
    defaultHostingProvider: 'Cloud Run / Render Free Tier',
    defaultRegion: 'asia-southeast1',
    publicBaseUrl: publicOrigin,
    freeTierSummary:
      'Starter Free Tier: Spark Firestore daily free quota, client-side WebP photo compression, and up to 50 patients / 100 MB per clinic.',
    maintenanceNotice: '',
    updatedBy: uid,
    updatedAt: serverTimestamp(),
  };
}

export function buildUniqueIdList(uids: string[]): string[] {
  const seen = new Set<string>();
  for (const raw of uids) {
    const clean = raw.trim();
    if (clean && /^[a-zA-Z0-9_-]{1,128}$/.test(clean) && !seen.has(clean)) {
      seen.add(clean);
      if (seen.size >= 10) break;
    }
  }
  return Array.from(seen);
}

export async function syncTenantAccessListsAcrossDocs(
  clinicId: string,
  nextAccessEmails: string[],
  nextAuthorizedUids: string[]
): Promise<void> {
  const docRefsToUpdate: Array<ReturnType<typeof doc>> = [];

  const patientsSnap = await getDocs(tenantPatientsCol(clinicId));
  for (const patDoc of patientsSnap.docs) {
    docRefsToUpdate.push(patDoc.ref);
    const [consSnap, photosSnap, notesSnap] = await Promise.all([
      getDocs(tenantConsultationsCol(clinicId, patDoc.id)),
      getDocs(tenantPhotosCol(clinicId, patDoc.id)),
      getDocs(tenantNotesCol(clinicId, patDoc.id)),
    ]);
    for (const c of consSnap.docs) docRefsToUpdate.push(c.ref);
    for (const p of photosSnap.docs) docRefsToUpdate.push(p.ref);
    for (const n of notesSnap.docs) docRefsToUpdate.push(n.ref);
  }

  const [feesSnap, repSnap] = await Promise.all([
    getDocs(tenantFeesCol(clinicId)),
    getDocs(tenantRepertoryCol(clinicId)),
  ]);
  for (const f of feesSnap.docs) docRefsToUpdate.push(f.ref);
  for (const r of repSnap.docs) docRefsToUpdate.push(r.ref);

  const CHUNK_SIZE = 400;
  for (let i = 0; i < docRefsToUpdate.length; i += CHUNK_SIZE) {
    const chunk = docRefsToUpdate.slice(i, i + CHUNK_SIZE);
    const batch = writeBatch(db);
    for (const ref of chunk) {
      batch.update(ref, {
        clinicAccessEmails: nextAccessEmails,
        clinicAccessUids: nextAuthorizedUids,
      });
    }
    await batch.commit();
  }
}

export function isSameStringList(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((val, idx) => val === sortedB[idx]);
}

export function buildPublicProfilePayload(
  clinicId: string,
  data: Pick<
    ClinicTenant,
    | 'slug'
    | 'clinicName'
    | 'practitionerName'
    | 'tagline'
    | 'accentColor'
    | 'planTier'
    | 'subscriptionStatus'
  >
) {
  const payload: Record<string, unknown> = {
    clinicId,
    slug: data.slug,
    clinicName: data.clinicName,
    practitionerName: data.practitionerName,
    accentColor: data.accentColor,
    planTier: data.planTier,
    subscriptionStatus: data.subscriptionStatus,
    updatedAt: serverTimestamp(),
  };
  if (data.tagline && data.tagline.trim()) {
    payload.tagline = data.tagline.trim();
  }
  return payload;
}
