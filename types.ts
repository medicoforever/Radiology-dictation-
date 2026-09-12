
export enum AppStatus {
  Idle = 'idle',
  Recording = 'recording',
  Processing = 'processing',
  Success = 'success',
  Error = 'error',
}

export interface IdentifiedError {
  findingIndex: number;
  errorDescription: string;
  severity: 'WARNING' | 'INFO';
}

export interface AudioAssessmentFindingInsight {
  findingIndex: number;
  findingTitleOrExcerpt: string;
  uncertaintyScore: number; // 0 (rock-solid) to 100 (high vocal hesitation/equivocal)
  acousticObservation: string; // e.g. "750ms pre-diagnostic pause with pitch drop prior to 'subtle hypoattenuation'"
  clinicalSignificance: string; // Diagnostic nuance / ambiguity check
  differentialConsiderations: string[]; // Shadow differential counter-checks to prevent tunnel vision
  suggestedChatInquiry: string; // Ready-to-send inquiry for AI Co-pilot
}

export interface AudioAssessmentReport {
  overallConfidenceScore: number; // 0 to 100
  estimatedWpm: number;
  speechClarity: 'Exceptional' | 'Crisp & Clear' | 'Good' | 'Moderate / Background Noise' | 'Muffled';
  pacingEvaluation: string;
  acousticHesitationSummary: string;
  keyShadowDifferentials: string[];
  findingInsights: AudioAssessmentFindingInsight[];
  actionableSummary: string;
  assessedAt: string;
}
