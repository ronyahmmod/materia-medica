import type { Timestamp } from 'firebase/firestore';

export type PatientStatus = 'active' | 'follow-up' | 'archived';
export type ThermalState = 'Chilly' | 'Hot' | 'Ambithermal' | 'Unspecified';
export type GenderOption = 'Female' | 'Male' | 'Other';
export type PhotoCategory = 'portrait' | 'symptom' | 'tongue' | 'skin' | 'prescription';
export type PlanTier = 'free' | 'growth' | 'clinic_pro';
export type RepertoryChapter =
  | 'Mind'
  | 'Head & Vertigo'
  | 'Respiratory'
  | 'Gastrointestinal'
  | 'Skin'
  | 'Musculoskeletal'
  | 'Sleep & Dreams'
  | 'Generalities';

export const REPERTORY_CHAPTERS: RepertoryChapter[] = [
  'Mind',
  'Head & Vertigo',
  'Respiratory',
  'Gastrointestinal',
  'Skin',
  'Musculoskeletal',
  'Sleep & Dreams',
  'Generalities',
];

export type ClinicalNoteFocus =
  | 'Constitution'
  | 'Mental State'
  | 'Miasm & History'
  | 'General Observation';

export const CLINICAL_NOTE_FOCUS_AREAS: ClinicalNoteFocus[] = [
  'Constitution',
  'Mental State',
  'Miasm & History',
  'General Observation',
];

export interface Patient {
  id: string;
  caseNumber: string;
  fullName: string;
  age: number;
  gender: GenderOption;
  phone: string;
  email?: string;
  address?: string;
  chiefComplaint: string;
  thermalState?: ThermalState;
  constitutionNotes?: string;
  allergies?: string;
  portraitUrl?: string;
  portraitPhotoId?: string;
  status: PatientStatus;
  lastVisitDate?: string;
  nextFollowUpDate?: string;
  lastRemedy?: string;
  createdBy: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface Consultation {
  id: string;
  patientId: string;
  visitDate: string;
  presentingSymptoms: string;
  mentalGenerals?: string;
  physicalGenerals?: string;
  modalitiesWorse?: string;
  modalitiesBetter?: string;
  remedyName: string;
  potency: string;
  dosage: string;
  clinicalNotes?: string;
  nextFollowUpDate?: string;
  photoIds?: string[];
  createdBy: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface PatientPhoto {
  id: string;
  patientId: string;
  fileName: string;
  url: string;
  mimeType: 'image/webp' | 'image/jpeg' | 'image/png';
  sizeBytes: number;
  category: PhotoCategory;
  caption?: string;
  consultationId?: string;
  uploadedBy: string;
  createdAt: Timestamp;
}

export interface ClinicSettings {
  id: string;
  clinicName: string;
  practitionerName: string;
  planTier: PlanTier;
  patientLimit: number;
  storageLimitMb: number;
  hostingProvider?: string;
  notes?: string;
  updatedBy: string;
  updatedAt: Timestamp;
}

export interface RepertoryEntry {
  id: string;
  chapter: RepertoryChapter;
  rubric: string;
  primaryRemedy: string;
  remedies: string[];
  modalities?: string;
  symptomNotes?: string;
  createdBy: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface ClinicalNote {
  id: string;
  patientId: string;
  observedDate: string;
  focusArea: ClinicalNoteFocus;
  content: string;
  createdBy: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface PlanDefinition {
  tier: PlanTier;
  name: string;
  audience: string;
  monthlyPriceLabel: string;
  patientLimit: number;
  storageLimitMb: number;
  databaseTier: string;
  photoStorageTier: string;
  backupPolicy: string;
}

export const PLAN_CATALOG: Record<PlanTier, PlanDefinition> = {
  free: {
    tier: 'free',
    name: 'Starter Free Tier',
    audience: 'For solo homeopaths starting out',
    monthlyPriceLabel: '$0 / month',
    patientLimit: 50,
    storageLimitMb: 100,
    databaseTier: 'Firestore Spark (Free Daily Quota)',
    photoStorageTier: 'Compressed Local Express Storage (100 MB)',
    backupPolicy: 'Manual JSON Case Export',
  },
  growth: {
    tier: 'growth',
    name: 'Growth Practice',
    audience: 'For busy single-doctor clinics',
    monthlyPriceLabel: '$19 / month',
    patientLimit: 500,
    storageLimitMb: 5120,
    databaseTier: 'Firestore Blaze Pay-As-You-Go',
    photoStorageTier: 'Managed Object Bucket (5 GB)',
    backupPolicy: 'Daily Encrypted Cloud Snapshot',
  },
  clinic_pro: {
    tier: 'clinic_pro',
    name: 'Clinic Pro',
    audience: 'For multi-practitioner practices',
    monthlyPriceLabel: '$49 / month',
    patientLimit: 10000,
    storageLimitMb: 51200,
    databaseTier: 'Dedicated High-Throughput Firestore',
    photoStorageTier: 'Managed CDN & Object Bucket (50 GB)',
    backupPolicy: 'Hourly Point-in-Time Recovery',
  },
};

export const FIELD_LIMITS = {
  caseNumberMax: 32,
  fullNameMax: 120,
  phoneMax: 32,
  emailMax: 160,
  addressMax: 300,
  chiefComplaintMax: 500,
  constitutionNotesMax: 2000,
  allergiesMax: 500,
  presentingSymptomsMax: 2000,
  generalsMax: 1500,
  modalitiesMax: 500,
  remedyNameMax: 160,
  potencyMax: 32,
  dosageMax: 200,
  clinicalNotesMax: 2000,
  captionMax: 300,
  rubricMax: 240,
  symptomNotesMax: 1500,
  clinicalObservationMax: 4000,
} as const;

export const CASE_NUMBER_REGEX = /^[a-zA-Z0-9_-]+$/;

export const COMMON_REMEDIES = [
  'Arsenicum album',
  'Pulsatilla nigricans',
  'Nux vomica',
  'Sulphur',
  'Lycopodium clavatum',
  'Sepia officinalis',
  'Calcarea carbonica',
  'Phosphorus',
  'Ignatia amara',
  'Belladonna',
  'Natrum muriaticum',
  'Apis mellifica',
  'Silicea',
  'Rhus toxicodendron',
  'Bryonia alba',
  'Hepar sulphuris',
  'Graphites',
  'Thuja occidentalis',
  'Lachesis mutus',
  'Arnica montana',
];

export const POTENCY_OPTIONS = [
  '6C',
  '12C',
  '30C',
  '200C',
  '1M',
  '10M',
  '50M',
  'LM1',
  'LM2',
  'LM3',
  'Q (Mother Tincture)',
];
