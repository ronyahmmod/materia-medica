import {
  COMMON_REMEDIES,
  POTENCY_OPTIONS,
  type DiseaseRemedyEntry,
  type DiseaseSymptomRule,
  type RemedyRuleTiming,
} from '../types/clinic';

export interface RemedyCatalogItem {
  name: string;
  potencies: string[];
  savedCount: number;
}

export function createEmptyDiseaseRule(
  timing: RemedyRuleTiming = 'general',
  symptom = ''
): DiseaseSymptomRule {
  return {
    id: `rule_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`,
    symptom,
    remedyName: '',
    potency: '',
    doseOrUnit: '',
    timing,
    notes: '',
  };
}

export function deriveRulesFromDiseaseEntry(
  entry: DiseaseRemedyEntry
): DiseaseSymptomRule[] {
  if (entry.symptomRules && entry.symptomRules.length > 0) {
    return entry.symptomRules.map((r) => ({
      id: r.id || `rule_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`,
      symptom: r.symptom || '',
      remedyName: r.remedyName || '',
      potency: r.potency || '',
      doseOrUnit: r.doseOrUnit || '',
      timing: r.timing || 'general',
      notes: r.notes || '',
    }));
  }

  const rules: DiseaseSymptomRule[] = [
    {
      id: `rule_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`,
      symptom: entry.symptoms || entry.diseaseName,
      remedyName: entry.firstRemedyMorning || '',
      potency: entry.firstRemedyPotency || '',
      doseOrUnit: '',
      timing: 'general',
      notes: '',
    },
  ];

  if (entry.secondRemedyAfternoon?.trim()) {
    rules.push({
      id: `rule_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`,
      symptom: entry.symptoms || entry.diseaseName,
      remedyName: entry.secondRemedyAfternoon.trim(),
      potency: entry.secondRemedyPotency?.trim() || '',
      doseOrUnit: '',
      timing: 'general',
      notes: '',
    });
  }
  return rules;
}

const BIOCHEMIC_DEFAULTS = new Set([
  'calcarea fluorica',
  'calcarea phosphorica',
  'calcarea sulphurica',
  'ferrum phosphoricum',
  'kali muriaticum',
  'kali phosphoricum',
  'kali sulphuricum',
  'magnesia phosphorica',
  'natrum muriaticum',
  'natrum phosphoricum',
  'natrum sulphuricum',
  'silicea',
]);

export function buildRemedyAndPotencyCatalog(
  entries: DiseaseRemedyEntry[],
  extraRules: DiseaseSymptomRule[] = []
): {
  remedyCatalog: RemedyCatalogItem[];
  potencyCatalog: string[];
} {
  const remedyMap = new Map<string, RemedyCatalogItem>();
  const potencySet = new Set<string>(POTENCY_OPTIONS);

  const recordPair = (rawName: string, rawPotency?: string, isSaved = false) => {
    const name = rawName.trim();
    if (!name) return;
    const key = name.toLowerCase();
    const pot = (rawPotency || '').trim();
    if (pot) potencySet.add(pot);

    let item = remedyMap.get(key);
    if (!item) {
      item = { name, potencies: [], savedCount: 0 };
      remedyMap.set(key, item);
    }
    if (isSaved) item.savedCount += 1;
    if (pot && !item.potencies.some((p) => p.toLowerCase() === pot.toLowerCase())) {
      item.potencies.push(pot);
    }
  };

  for (const entry of entries) {
    const rules = deriveRulesFromDiseaseEntry(entry);
    for (const r of rules) {
      recordPair(r.remedyName, r.potency, true);
    }
  }

  for (const r of extraRules) {
    recordPair(r.remedyName, r.potency, false);
  }

  for (const rem of COMMON_REMEDIES) {
    const key = rem.toLowerCase();
    if (!remedyMap.has(key)) {
      const defaultPotencies = BIOCHEMIC_DEFAULTS.has(key)
        ? ['6X', '12X', '30C']
        : ['30C', '200C', '1M'];
      remedyMap.set(key, { name: rem, potencies: defaultPotencies, savedCount: 0 });
    } else {
      const existing = remedyMap.get(key)!;
      if (existing.potencies.length === 0) {
        existing.potencies = BIOCHEMIC_DEFAULTS.has(key)
          ? ['6X', '12X', '30C']
          : ['30C', '200C', '1M'];
      }
    }
  }

  const sortedRemedies = Array.from(remedyMap.values()).sort(
    (a, b) => b.savedCount - a.savedCount || a.name.localeCompare(b.name)
  );

  return {
    remedyCatalog: sortedRemedies,
    potencyCatalog: Array.from(potencySet),
  };
}
