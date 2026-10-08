// Trust Score v1 (ADR-059): constants shared by the worker (which computes the
// scores) and the web app (which shows them and explains the method).

export const TRUST_SCORE_VERSION = 1;

/** Weights of the components for organisations on CHERR.IO (sum 1). */
export const TRUST_WEIGHTS = { rating: 0.3, success: 0.25, milestones: 0.2, evidence: 0.15, verification: 0.1 } as const;
export type TrustComponent = keyof typeof TRUST_WEIGHTS;
export const TRUST_COMPONENTS = Object.keys(TRUST_WEIGHTS) as TrustComponent[];

/** Imported organisations (not on CHERR.IO): 20 + 20 × completeness, so 20–40. */
export const IMPORTED_SCORE_BASE = 20;
export const IMPORTED_SCORE_SPAN = 20;
export const COMPLETENESS_CHECKS = ["active", "website", "description", "figures", "recentFiling"] as const;
