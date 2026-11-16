import type { EvidenceCitation, ReviewAssessment, ReviewDecision } from "../../src/types.ts";

/** Synthetic reviewer fixture; this does not assert that a real model has judged the task. */
export function assessmentFor(evidence: Pick<EvidenceCitation, "toolCallId" | "excerpt">[]): ReviewAssessment {
  const citations = evidence.map(({ toolCallId, excerpt }) => ({ toolCallId, excerpt }));
  return {
    complexity: { nontrivial: true, dimensions: [{ kind: "dependent-steps", rationale: "The observed diagnostic result determines the recovery procedure, which is checked independently.", evidence: citations }] },
    value: { transferable: true, nonObvious: true, addsKnowledge: true, rationale: "A bounded recovery decision rule and its verification can be reused for equivalent failures beyond this fixture.", evidence: citations },
  };
}

export function withAssessment<T extends ReviewDecision>(decision: T): T {
  if (decision.action !== "skip") decision.assessment = assessmentFor(decision.evidence ?? []);
  return decision;
}
