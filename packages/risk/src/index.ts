export interface RiskDecision { decision: "ALLOW" | "REVIEW" | "BLOCK"; reasons: readonly string[]; }
