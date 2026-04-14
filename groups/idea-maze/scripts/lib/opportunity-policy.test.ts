import { describe, expect, it } from "vitest";
import { classifyOpportunityScore, getOpportunityScoreBucket } from "./opportunity-policy.ts";

describe("getOpportunityScoreBucket", () => {
  it("floors decimal scores into pipeline buckets", () => {
    expect(getOpportunityScoreBucket(6.99)).toBe(6);
    expect(getOpportunityScoreBucket(7.0)).toBe(7);
    expect(getOpportunityScoreBucket(8.99)).toBe(8);
    expect(getOpportunityScoreBucket(9.01)).toBe(9);
    expect(getOpportunityScoreBucket(10.0)).toBe(10);
  });

  it("clamps invalid values into the supported range", () => {
    expect(getOpportunityScoreBucket(-2)).toBe(0);
    expect(getOpportunityScoreBucket(12.3)).toBe(10);
    expect(getOpportunityScoreBucket(Number.NaN)).toBe(0);
  });
});

describe("classifyOpportunityScore", () => {
  it("ignores score buckets up to 6", () => {
    expect(classifyOpportunityScore(6.99)).toEqual({
      bucket: 6,
      disposition: "ignore",
    });
  });

  it("routes score buckets 7 and 8 to manual review", () => {
    expect(classifyOpportunityScore(7.25)).toEqual({
      bucket: 7,
      disposition: "manual_review",
    });
    expect(classifyOpportunityScore(8.99)).toEqual({
      bucket: 8,
      disposition: "manual_review",
    });
  });

  it("auto-approves score buckets 9 and 10", () => {
    expect(classifyOpportunityScore(9.0)).toEqual({
      bucket: 9,
      disposition: "auto_approve",
    });
    expect(classifyOpportunityScore(10.0)).toEqual({
      bucket: 10,
      disposition: "auto_approve",
    });
  });
});
