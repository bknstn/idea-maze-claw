export const MANUAL_REVIEW_MIN_BUCKET = 7;
export const AUTO_APPROVE_MIN_BUCKET = 9;

export type OpportunityDisposition = "ignore" | "manual_review" | "auto_approve";

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
  if (bucket >= MANUAL_REVIEW_MIN_BUCKET) {
    return { bucket, disposition: "manual_review" };
  }
  return { bucket, disposition: "ignore" };
}
