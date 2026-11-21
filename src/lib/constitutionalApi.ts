import { auth } from '../firebase';
import type { ClinicalNote, Consultation, Patient } from '../types/clinic';

export type ConstitutionalThemeCategory =
  | 'Mental & Emotional'
  | 'Thermal & Physical'
  | 'Miasmatic Tendency'
  | 'Modality & Rhythm';

export type ConstitutionalConfidence = 'high' | 'moderate' | 'emerging';

export interface ConstitutionalTheme {
  theme: string;
  category: ConstitutionalThemeCategory;
  confidence: ConstitutionalConfidence;
  supportingEvidence: string;
  keyTendencies: string[];
  candidateRemedies: string[];
}

export interface ConstitutionalMapResponse {
  overallSummary: string;
  constitutionalThemes: ConstitutionalTheme[];
  recommendedQuestions: string[];
}

export async function mapPatientConstitutionalThemes(
  patient: Patient,
  clinicalNotes: ClinicalNote[],
  consultations: Consultation[],
  includeConsultations: boolean,
  language: 'en' | 'bn' = 'en'
): Promise<ConstitutionalMapResponse> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('Admin sign-in is required.');
  }

  const token = await user.getIdToken();

  const response = await fetch('/api/patients/constitutional-map', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      patientContext: {
        age: patient.age,
        gender: patient.gender,
        chiefComplaint: patient.chiefComplaint,
        thermalState: patient.thermalState || 'Unspecified',
        constitutionNotes: patient.constitutionNotes || '',
        allergies: patient.allergies || '',
      },
      clinicalNotes: clinicalNotes.slice(0, 40).map((note) => ({
        observedDate: note.observedDate,
        focusArea: note.focusArea,
        content: note.content,
      })),
      consultationNotes: includeConsultations
        ? consultations.slice(0, 15).map((con) => ({
            visitDate: con.visitDate,
            remedyName: con.remedyName,
            presentingSymptoms: con.presentingSymptoms,
            mentalGenerals: con.mentalGenerals || '',
            physicalGenerals: con.physicalGenerals || '',
            modalitiesWorse: con.modalitiesWorse || '',
            modalitiesBetter: con.modalitiesBetter || '',
            clinicalNotes: con.clinicalNotes || '',
          }))
        : [],
      language,
    }),
  });

  const rawText = await response.text();
  const trimmed = rawText.trim();
  let parsed: unknown = null;
  if (trimmed) {
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      if (trimmed.startsWith('<')) {
        throw new Error(
          `Clinical analysis service returned an unexpected HTML page (HTTP ${response.status}). Please refresh and try again.`
        );
      }
      throw new Error('Unable to analyze constitutional themes right now.');
    }
  }

  if (!response.ok) {
    const errMsg =
      parsed && typeof parsed === 'object' && 'error' in parsed && typeof (parsed as { error?: unknown }).error === 'string'
        ? (parsed as { error: string }).error
        : 'Unable to analyze constitutional themes right now.';
    throw new Error(errMsg);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Unable to analyze constitutional themes right now.');
  }

  return parsed as ConstitutionalMapResponse;
}
