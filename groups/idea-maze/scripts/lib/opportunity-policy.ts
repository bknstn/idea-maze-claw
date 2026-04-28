export const AUTO_APPROVE_MIN_BUCKET = 9;

export type OpportunityDisposition = "ignore" | "auto_approve";

export interface OpportunityPolicy {
  bucket: number;
  disposition: OpportunityDisposition;
}

export function getOpportunityScoreBucket(score: number): number {
  const normalized = Number.isFinite(score) ? score : 0;
  return Math.max(0, Math.min(10, Math.floor(normalized)));
}

export function classifyOpportunityScore(score: number): OpportunityPolicy {
  const bucket = getOpportunityScoreBucket(score);
  if (bucket >= AUTO_APPROVE_MIN_BUCKET) {
    return { bucket, disposition: "auto_approve" };
  }
  return { bucket, disposition: "ignore" };
}
