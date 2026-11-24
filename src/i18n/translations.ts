import type {
  BillingCycle,
  ClinicAccentTheme,
  ClinicalNoteFocus,
  DiseasePatientScope,
  FeeCategory,
  GenderOption,
  PatientStatus,
  PatientType,
  PhotoCategory,
  PlanTier,
  RemedyRuleTiming,
  RepertoryChapter,
  SubscriptionStatus,
  ThermalState,
} from '../types/clinic';

export type AppLanguage = 'en' | 'bn';

export const REMEDY_TIMING_LABELS_I18N: Record<AppLanguage, Record<RemedyRuleTiming, string>> = {
  en: {
    general: 'Homeopathic (Schedule at Visit)',
    morning: '1st Remedy (Morning)',
    afternoon: '2nd Remedy (Afternoon)',
    'companion-morning': '1st Companion Remedy',
    'companion-afternoon': '2nd Companion Remedy',
    biochemic: 'Biochemic',
  },
  bn: {
    general: 'হোমিওপ্যাথিক (ভিজিটে সময় ঠিক হবে)',
    morning: '১ম ঔষধ (সকালে)',
    afternoon: '২য় ঔষধ (বিকালে)',
    'companion-morning': '১ম সহায়ক ঔষধ',
    'companion-afternoon': '২য় সহায়ক ঔষধ',
    biochemic: 'বায়োকেমিক',
  },
};

export const PATIENT_TYPE_LABELS_I18N: Record<AppLanguage, Record<PatientType, string>> = {
  en: {
    Human: 'Human',
    Cow: 'Cow / Cattle',
    Goat: 'Goat',
    'Other Animal': 'Other Animal',
  },
  bn: {
    Human: 'মানুষ (Human)',
    Cow: 'গরু (Cow)',
    Goat: 'ছাগল (Goat)',
    'Other Animal': 'অন্যান্য প্রাণী',
  },
};

export const DISEASE_SCOPE_LABELS_I18N: Record<AppLanguage, Record<DiseasePatientScope, string>> = {
  en: {
    All: 'Human & Veterinary',
    Human: 'Human Only',
    Veterinary: 'Veterinary (Cow / Goat)',
  },
  bn: {
    All: 'মানুষ ও পশু উভয়',
    Human: 'শুধুমাত্র মানুষ',
    Veterinary: 'পশুচিকিৎসা (গরু / ছাগল)',
  },
};

export const STATUS_LABELS_I18N: Record<AppLanguage, Record<PatientStatus, string>> = {
  en: {
    active: 'Active',
    'follow-up': 'Follow-up Due',
    archived: 'Archived',
  },
  bn: {
    active: 'সক্রিয়',
    'follow-up': 'ফলো-আপ বাকি',
    archived: 'আর্কাইভড',
  },
};

export const SUBSCRIPTION_STATUS_LABELS_I18N: Record<
  AppLanguage,
  Record<SubscriptionStatus, string>
> = {
  en: {
    active: 'Active',
    trial: 'Trial',
    suspended: 'Suspended',
  },
  bn: {
    active: 'সক্রিয়',
    trial: 'ট্রায়াল',
    suspended: 'স্থগিত (Suspended)',
  },
};

export const BILLING_CYCLE_LABELS_I18N: Record<AppLanguage, Record<BillingCycle, string>> = {
  en: {
    free: 'Free Tier',
    monthly: 'Monthly',
    yearly: 'Yearly',
  },
  bn: {
    free: 'ফ্রি টিয়ার',
    monthly: 'মাসিক',
    yearly: 'বার্ষিক',
  },
};

export const ACCENT_THEME_LABELS_I18N: Record<AppLanguage, Record<ClinicAccentTheme, string>> = {
  en: {
    teal: 'Apothecary Teal',
    indigo: 'Clinical Indigo',
    emerald: 'Botanical Emerald',
    slate: 'Executive Slate',
  },
  bn: {
    teal: 'অ্যাপোথেকারি টিল',
    indigo: 'ক্লিনিক্যাল ইন্ডিগো',
    emerald: 'বোটানিক্যাল এমারেল্ড',
    slate: 'এক্সিকিউটিভ স্লেট',
  },
};

export const GENDER_LABELS_I18N: Record<AppLanguage, Record<GenderOption, string>> = {
  en: {
    Female: 'Female',
    Male: 'Male',
    Other: 'Other',
  },
  bn: {
    Female: 'মহিলা',
    Male: 'পুরুষ',
    Other: 'অন্যান্য',
  },
};

export const THERMAL_LABELS_I18N: Record<AppLanguage, Record<ThermalState, string>> = {
  en: {
    Unspecified: 'Unspecified',
    Chilly: 'Chilly',
    Hot: 'Hot',
    Ambithermal: 'Ambithermal',
  },
  bn: {
    Unspecified: 'অনির্ধারিত',
    Chilly: 'শীতকাতর (Chilly)',
    Hot: 'গ্রীষ্মকাতর (Hot)',
    Ambithermal: 'উভয়তাপীয়',
  },
};

export const PHOTO_CATEGORY_LABELS_I18N: Record<AppLanguage, Record<PhotoCategory, string>> = {
  en: {
    portrait: 'Patient Portrait',
    symptom: 'Symptom / Lesion',
    tongue: 'Tongue / Nail',
    skin: 'Skin',
    prescription: 'Prescription / Lab',
  },
  bn: {
    portrait: 'রোগীর ছবি',
    symptom: 'লক্ষণ / ক্ষত',
    tongue: 'জিহ্বা / নখ',
    skin: 'ত্বক / চর্মরোগ',
    prescription: 'প্রেসক্রিপশন / রিপোর্ট',
  },
};

export const REPERTORY_CHAPTER_LABELS_I18N: Record<AppLanguage, Record<RepertoryChapter, string>> = {
  en: {
    Mind: 'Mind',
    'Head & Vertigo': 'Head & Vertigo',
    Respiratory: 'Respiratory',
    Gastrointestinal: 'Gastrointestinal',
    Skin: 'Skin',
    Musculoskeletal: 'Musculoskeletal',
    'Sleep & Dreams': 'Sleep & Dreams',
    Generalities: 'Generalities',
  },
  bn: {
    Mind: 'মন (Mind)',
    'Head & Vertigo': 'মাথা ও ঘূর্ণিরোগ',
    Respiratory: 'শ্বাসতন্ত্র',
    Gastrointestinal: 'পরিপাকতন্ত্র',
    Skin: 'ত্বক',
    Musculoskeletal: 'অস্থি ও পেশি',
    'Sleep & Dreams': 'ঘুম ও স্বপ্ন',
    Generalities: 'সার্বদৈহিক (Generalities)',
  },
};

export const NOTE_FOCUS_LABELS_I18N: Record<AppLanguage, Record<ClinicalNoteFocus, string>> = {
  en: {
    Constitution: 'Constitution',
    'Mental State': 'Mental State',
    'Miasm & History': 'Miasm & History',
    'General Observation': 'General Observation',
  },
  bn: {
    Constitution: 'ধাতু ও প্রকৃতি (Constitution)',
    'Mental State': 'মানসিক অবস্থা',
    'Miasm & History': 'মায়াজম ও পূর্ব-ইতিহাস',
    'General Observation': 'সাধারণ পর্যবেক্ষণ',
  },
};

export const FEE_CATEGORY_LABELS_I18N: Record<AppLanguage, Record<FeeCategory, string>> = {
  en: {
    consultation: 'Consultation Fee',
    medicine: 'Remedy / Medicine',
    'follow-up': 'Follow-up Visit',
    'due-settlement': 'Due Settlement',
    other: 'Other Clinic Fee',
  },
  bn: {
    consultation: 'কনসাল্টেশন ফি',
    medicine: 'ওষুধ / রেমেডি',
    'follow-up': 'ফলো-আপ ভিজিট',
    'due-settlement': 'বকেয়া পরিশোধ',
    other: 'অন্যান্য ক্লিনিক ফি',
  },
};

export const PLAN_LABELS_I18N: Record<
  AppLanguage,
  Record<
    PlanTier,
    {
      name: string;
      audience: string;
      monthlyPriceLabel: string;
      databaseTier: string;
      photoStorageTier: string;
      backupPolicy: string;
    }
  >
> = {
  en: {
    free: {
      name: 'Starter Free Tier',
      audience: 'For solo homeopaths starting out',
      monthlyPriceLabel: '$0 / month',
      databaseTier: 'Firestore Spark (Free Daily Quota)',
      photoStorageTier: 'Compressed Local Express Storage (100 MB)',
      backupPolicy: 'Manual JSON Case Export',
    },
    growth: {
      name: 'Growth Practice',
      audience: 'For busy single-doctor clinics',
      monthlyPriceLabel: '$19 / month',
      databaseTier: 'Firestore Blaze Pay-As-You-Go',
      photoStorageTier: 'Managed Object Bucket (5 GB)',
      backupPolicy: 'Daily Encrypted Cloud Snapshot',
    },
    clinic_pro: {
      name: 'Clinic Pro',
      audience: 'For multi-practitioner practices',
      monthlyPriceLabel: '$49 / month',
      databaseTier: 'Dedicated High-Throughput Firestore',
      photoStorageTier: 'Managed CDN & Object Bucket (50 GB)',
      backupPolicy: 'Hourly Point-in-Time Recovery',
    },
  },
  bn: {
    free: {
      name: 'স্টার্টার ফ্রি টিয়ার',
      audience: 'একক হোমিওপ্যাথিক চিকিৎসকের শুরুর জন্য',
      monthlyPriceLabel: '$০ / মাস',
      databaseTier: 'ফায়ারস্টোর স্পার্ক (ফ্রি দৈনিক কোটা)',
      photoStorageTier: 'কম্প্রেসড লোকাল এক্সপ্রেস স্টোরেজ (১০০ MB)',
      backupPolicy: 'ম্যানুয়াল JSON কেস এক্সপোর্ট',
    },
    growth: {
      name: 'গ্রোথ প্র্যাকটিস',
      audience: 'ব্যস্ত একক-ডাক্তার চেম্বারের জন্য',
      monthlyPriceLabel: '$১৯ / মাস',
      databaseTier: 'ফায়ারস্টোর ব্লেজ পে-অ্যাজ-ইউ-গো',
      photoStorageTier: 'ম্যানেজড অবজেক্ট বাকেট (৫ GB)',
      backupPolicy: 'দৈনিক এনক্রিপ্টেড ক্লাউড স্ন্যাপশট',
    },
    clinic_pro: {
      name: 'ক্লিনিক প্রো',
      audience: 'একাধিক চিকিৎসকের ক্লিনিকের জন্য',
      monthlyPriceLabel: '$৪৯ / মাস',
      databaseTier: 'ডেডিকেটেড হাই-থ্রুপুট ফায়ারস্টোর',
      photoStorageTier: 'ম্যানেজড CDN ও অবজেক্ট বাকেট (৫০ GB)',
      backupPolicy: 'ঘণ্টায় ঘণ্টায় পয়েন্ট-ইন-টাইম রিকভারি',
    },
  },
};
