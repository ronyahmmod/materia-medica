import type { Timestamp } from 'firebase/firestore';

export type PatientStatus = 'active' | 'follow-up' | 'archived';
export type PatientType = 'Human' | 'Cow' | 'Goat' | 'Other Animal';
export type DiseasePatientScope = 'All' | 'Human' | 'Veterinary';
export type ThermalState = 'Chilly' | 'Hot' | 'Ambithermal' | 'Unspecified';
export type GenderOption = 'Female' | 'Male' | 'Other';
export type PhotoCategory = 'portrait' | 'symptom' | 'tongue' | 'skin' | 'prescription';
export type PlanTier = 'free' | 'growth' | 'clinic_pro';
export type SubscriptionStatus = 'active' | 'trial' | 'suspended';
export type BillingCycle = 'free' | 'monthly' | 'yearly';
export type CurrencySymbol = '৳' | '$' | '₹' | '€' | '£';
export type ClinicAccentTheme = 'teal' | 'indigo' | 'emerald' | 'slate';

export const PATIENT_TYPES: PatientType[] = ['Human', 'Cow', 'Goat', 'Other Animal'];
export const DISEASE_PATIENT_SCOPES: DiseasePatientScope[] = ['All', 'Human', 'Veterinary'];
export const CURRENCY_OPTIONS: CurrencySymbol[] = ['৳', '$', '₹', '€', '£'];
export const ACCENT_THEME_OPTIONS: ClinicAccentTheme[] = ['teal', 'indigo', 'emerald', 'slate'];
export const SUBSCRIPTION_STATUS_OPTIONS: SubscriptionStatus[] = ['active', 'trial', 'suspended'];
export const BILLING_CYCLE_OPTIONS: BillingCycle[] = ['free', 'monthly', 'yearly'];

export type RemedyRuleTiming =
  | 'general'
  | 'biochemic'
  | 'morning'
  | 'afternoon'
  | 'companion-morning'
  | 'companion-afternoon';

export const DISEASE_ENTRY_RULE_TYPES: RemedyRuleTiming[] = ['general', 'biochemic'];

export const SYMPTOM_RULE_TIMINGS: RemedyRuleTiming[] = [
  'general',
  'biochemic',
  'morning',
  'afternoon',
  'companion-morning',
  'companion-afternoon',
];

export const CLINICAL_DISPENSING_PRESETS = {
  globules: ['৩০ বড়ি', '৪০ বড়ি', '30 globules', '40 globules'],
  ounces: ['১৫ আউন্স', '৩০ আউন্স', '1 oz', '2 oz'],
  phials: ['১ ফাইল', '২ ফাইল', '1 phial', '2 phials'],
} as const;

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

export type FeeCategory =
  | 'consultation'
  | 'medicine'
  | 'follow-up'
  | 'due-settlement'
  | 'other';

export const FEE_CATEGORIES: FeeCategory[] = [
  'consultation',
  'medicine',
  'follow-up',
  'due-settlement',
  'other',
];

export interface ClinicTenant {
  id: string;
  slug: string;
  clinicName: string;
  practitionerName: string;
  ownerEmail: string;
  accessEmails: string[];
  authorizedUids: string[];
  tagline?: string;
  phone?: string;
  address?: string;
  currencySymbol: CurrencySymbol;
  accentColor: ClinicAccentTheme;
  planTier: PlanTier;
  subscriptionStatus: SubscriptionStatus;
  patientLimit: number;
  storageLimitMb: number;
  hostingProvider?: string;
  monthlyFeeAmount: number;
  billingCycle: BillingCycle;
  subscriptionNotes?: string;
  createdBy: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface ClinicPublicProfile {
  clinicId: string;
  slug: string;
  clinicName: string;
  practitionerName: string;
  tagline?: string;
  accentColor: ClinicAccentTheme;
  planTier: PlanTier;
  subscriptionStatus: SubscriptionStatus;
  updatedAt: Timestamp;
}

export interface PlatformHostingConfig {
  id: string;
  platformName: string;
  supportEmail: string;
  defaultHostingProvider: string;
  defaultRegion: string;
  publicBaseUrl?: string;
  freeTierSummary?: string;
  maintenanceNotice?: string;
  updatedBy: string;
  updatedAt: Timestamp;
}

export interface SoftDeleteMetadata {
  isDeleted?: boolean;
  deletedAt?: string;
  deletedBy?: string;
  restoredAt?: string;
}

export interface Patient extends SoftDeleteMetadata {
  id: string;
  clinicId?: string;
  clinicAccessEmails?: string[];
  clinicAccessUids?: string[];
  patientType?: PatientType;
  animalSpeciesOrBreed?: string;
  ownerOrGuardianName?: string;
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

export interface Consultation extends SoftDeleteMetadata {
  id: string;
  clinicId?: string;
  clinicAccessEmails?: string[];
  clinicAccessUids?: string[];
  patientId: string;
  visitDate: string;
  diseaseName?: string;
  presentingSymptoms: string;
  mentalGenerals?: string;
  physicalGenerals?: string;
  modalitiesWorse?: string;
  modalitiesBetter?: string;
  firstRemedyMorning?: string;
  firstRemedyCompanion?: string;
  firstRemedyPotency?: string;
  secondRemedyAfternoon?: string;
  secondRemedyCompanion?: string;
  secondRemedyPotency?: string;
  globulesDose?: string;
  ounceAmount?: string;
  phialCount?: string;
  extraPotency?: string;
  biochemicMedicine?: string;
  remedyName: string;
  potency?: string;
  dosage: string;
  clinicalNotes?: string;
  nextFollowUpDate?: string;
  photoIds?: string[];
  createdBy: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface PatientPhoto extends SoftDeleteMetadata {
  id: string;
  clinicId?: string;
  clinicAccessEmails?: string[];
  clinicAccessUids?: string[];
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

export interface RepertoryEntry extends SoftDeleteMetadata {
  id: string;
  clinicId?: string;
  clinicAccessEmails?: string[];
  clinicAccessUids?: string[];
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

export interface DiseaseSymptomRule {
  id: string;
  symptom: string;
  remedyName: string;
  potency?: string;
  doseOrUnit?: string;
  timing: RemedyRuleTiming;
  notes?: string;
}

export interface DiseaseRemedyEntry extends SoftDeleteMetadata {
  id: string;
  clinicId?: string;
  clinicAccessEmails?: string[];
  clinicAccessUids?: string[];
  patientScope: DiseasePatientScope;
  diseaseName: string;
  symptoms: string;
  symptomRules?: DiseaseSymptomRule[];
  firstRemedyMorning: string;
  firstRemedyPotency?: string;
  secondRemedyAfternoon?: string;
  secondRemedyPotency?: string;
  dosageInstructions?: string;
  clinicalNotes?: string;
  createdBy: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface ClinicalNote extends SoftDeleteMetadata {
  id: string;
  clinicId?: string;
  clinicAccessEmails?: string[];
  clinicAccessUids?: string[];
  patientId: string;
  observedDate: string;
  focusArea: ClinicalNoteFocus;
  content: string;
  createdBy: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface FeeRecord extends SoftDeleteMetadata {
  id: string;
  clinicId?: string;
  clinicAccessEmails?: string[];
  clinicAccessUids?: string[];
  patientId: string;
  patientName: string;
  caseNumber: string;
  consultationId?: string;
  collectedDate: string;
  feeType: FeeCategory;
  feeAmount: number;
  discountAmount: number;
  netAmount: number;
  cashPaid: number;
  dueAmount: number;
  notes?: string;
  createdBy: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface PlanDefinition {
  tier: PlanTier;
  name: string;
  audience: string;
  monthlyPriceLabel: string;
  monthlyPriceUsd: number;
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
    monthlyPriceUsd: 0,
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
    monthlyPriceUsd: 19,
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
    monthlyPriceUsd: 49,
    patientLimit: 10000,
    storageLimitMb: 51200,
    databaseTier: 'Dedicated High-Throughput Firestore',
    photoStorageTier: 'Managed CDN & Object Bucket (50 GB)',
    backupPolicy: 'Hourly Point-in-Time Recovery',
  },
};

export const FIELD_LIMITS = {
  slugMax: 64,
  clinicNameMax: 160,
  practitionerNameMax: 120,
  taglineMax: 240,
  hostingProviderMax: 120,
  subscriptionNotesMax: 500,
  platformNameMax: 120,
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
  feeNotesMax: 500,
  feeMaxAmount: 1000000,
  animalBreedMax: 120,
  ownerNameMax: 120,
  diseaseNameMax: 160,
  diseaseSymptomsMax: 2000,
  dispensingUnitMax: 40,
  ruleSymptomMax: 500,
  ruleUnitMax: 64,
  ruleNotesMax: 300,
} as const;

export const CASE_NUMBER_REGEX = /^[a-zA-Z0-9_-]+$/;
export const CLINIC_SLUG_REGEX = /^[a-z0-9-]+$/;

export const COMMON_REMEDIES = [
  'Aconitum napellus',
  'Aesculus hippocastanum',
  'Allium cepa',
  'Aloe socotrina',
  'Alumina',
  'Antimonium crudum',
  'Antimonium tartaricum',
  'Apis mellifica',
  'Argentum nitricum',
  'Arnica montana',
  'Arsenicum album',
  'Aurum metallicum',
  'Baptisia tinctoria',
  'Baryta carbonica',
  'Belladonna',
  'Bellis perennis',
  'Berberis vulgaris',
  'Borax',
  'Bryonia alba',
  'Cactus grandiflorus',
  'Calcarea carbonica',
  'Calcarea fluorica',
  'Calcarea phosphorica',
  'Calcarea sulphurica',
  'Calendula officinalis',
  'Camphora',
  'Cantharis',
  'Carbo animalis',
  'Carbo vegetabilis',
  'Caulophyllum',
  'Causticum',
  'Chamomilla',
  'Chelidonium majus',
  'China officinalis (Cinchona)',
  'Cicuta virosa',
  'Cina',
  'Cocculus indicus',
  'Coffea cruda',
  'Colchicum autumnale',
  'Colocynthis (Colocynth)',
  'Conium maculatum',
  'Crataegus oxyacantha',
  'Croton tiglium',
  'Cuprum metallicum',
  'Digitalis purpurea',
  'Dioscorea villosa',
  'Drosera rotundifolia',
  'Dulcamara',
  'Echinacea angustifolia',
  'Eupatorium perfoliatum',
  'Euphrasia officinalis',
  'Ferrum metallicum',
  'Ferrum phosphoricum',
  'Gelsemium sempervirens',
  'Glonoinum',
  'Graphites',
  'Hamamelis virginiana',
  'Helleborus niger',
  'Hepar sulphuris',
  'Hydrastis canadensis',
  'Hyoscyamus niger',
  'Hypericum perforatum',
  'Ignatia amara',
  'Iodum',
  'Ipecacuanha',
  'Iris versicolor',
  'Kali arsenicosum',
  'Kali bichromicum',
  'Kali bromatum',
  'Kali carbonicum',
  'Kali iodatum',
  'Kali muriaticum',
  'Kali phosphoricum',
  'Kali sulphuricum',
  'Kreosotum',
  'Lac caninum',
  'Lachesis mutus',
  'Ledum palustre',
  'Lilium tigrinum',
  'Lycopodium clavatum',
  'Magnesia carbonica',
  'Magnesia phosphorica',
  'Medorrhinum',
  'Mercurius corrosivus',
  'Mercurius solubilis',
  'Mezereum',
  'Millefolium',
  'Natrum carbonicum',
  'Natrum muriaticum',
  'Natrum phosphoricum',
  'Natrum sulphuricum',
  'Nitricum acidum',
  'Nux moschata',
  'Nux vomica',
  'Opium',
  'Petroleum',
  'Phosphoricum acidum',
  'Phosphorus',
  'Phytolacca decandra',
  'Picricum acidum',
  'Platina',
  'Plumbum metallicum',
  'Podophyllum peltatum',
  'Psorinum',
  'Pulsatilla nigricans',
  'Pyrogenium',
  'Rhododendron',
  'Rhus toxicodendron',
  'Rumex crispus',
  'Ruta graveolens',
  'Sabal serrulata',
  'Sabina',
  'Sanguinaria canadensis',
  'Sarsaparilla',
  'Secale cornutum',
  'Selenium',
  'Sepia officinalis',
  'Silicea',
  'Spigelia anthelmia',
  'Spongia tosta',
  'Stannum metallicum',
  'Staphysagria',
  'Stramonium',
  'Sulphur',
  'Sulphuricum acidum',
  'Symphytum officinale',
  'Syphilinum',
  'Tabacum',
  'Tarentula hispana',
  'Tellurium',
  'Thuja occidentalis',
  'Tuberculinum',
  'Urtica urens',
  'Veratrum album',
  'Viburnum opulus',
  'Zincum metallicum',
];

export const POTENCY_OPTIONS = [
  '3X',
  '6X',
  '12X',
  '30X',
  '200X',
  '3C',
  '6C',
  '12C',
  '30C',
  '200C',
  '1M',
  '10M',
  '50M',
  'CM',
  'LM1',
  'LM2',
  'LM3',
  'LM4',
  'LM5',
  'LM6',
  'Q (Mother Tincture)',
];
