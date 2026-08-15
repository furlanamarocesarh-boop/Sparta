import { DomainError } from "./errors.js";

/**
 * DEMO-PROJECT GATE — the environment half of authorizing a test-only capability.
 *
 * `testdeposit` mints WITHDRAWABLE cash. Until now the only thing standing
 * between it and the real ledger was the `admin: true` claim, so a single
 * mis-issued claim on the production project was enough to create money. An
 * admin claim answers "who is calling"; it cannot answer "which database is
 * about to be written". This module answers the second question, and it is the
 * one that must hold even when the first is compromised.
 *
 * FAIL-CLOSED BY CONSTRUCTION. The gate opens for exactly one shape of input:
 * at least one candidate, all candidates agreeing, and the agreed value carrying
 * the `demo-` prefix. Absent, disagreeing and non-demo inputs are all refusals —
 * "I could not prove this is a demo project" is treated identically to "this is
 * production", because from a safety standpoint they are the same statement.
 *
 * WHY AMBIGUITY IS A REFUSAL. The candidates come from independent sources
 * (`GCLOUD_PROJECT`, `GOOGLE_CLOUD_PROJECT`, the initialized Admin app). When
 * they disagree, the process genuinely cannot say which database `admin.firestore()`
 * will reach — that is precisely the situation in which a write must not happen.
 * Picking a winner would be inventing a fact.
 *
 * Pure rules only: no Admin SDK, no `firebase-functions`, no `process.env` read.
 * The caller supplies the candidates, which is what makes the decision testable
 * deterministically. Nothing here reads a credential, a service account or a
 * `.env` file, and the project id NEVER reaches the client — see `assertDemoProject`.
 */

export const DEMO_PROJECT_PREFIX = "demo-";

/** Why the gate refused. For logs and tests — never for the client. */
export type DemoProjectRefusal = "absent" | "ambiguous" | "not-demo";

export type DemoProjectDecision =
  | { readonly kind: "allowed"; readonly projectId: string }
  | { readonly kind: "refused"; readonly reason: DemoProjectRefusal };

/**
 * The single curated message every refusal returns.
 *
 * Deliberately identical for all three reasons and deliberately contentless: it
 * names no project, no environment variable and no configuration. A caller who
 * is refused learns only that the operation is unavailable — which is all a
 * caller is entitled to learn about the server's deployment shape.
 */
export const DEMO_PROJECT_REFUSED_MESSAGE = "Operação indisponível.";

/** Keeps only usable, trimmed string candidates. */
function usable(candidates: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (trimmed.length > 0) out.push(trimmed);
  }
  return out;
}

/**
 * Decides whether the effective project is a demo project.
 *
 * The candidates are server-side facts ONLY. Passing anything a client can
 * influence would defeat the whole gate.
 */
export function decideDemoProject(
  candidates: readonly unknown[]
): DemoProjectDecision {
  const present = usable(candidates);

  if (present.length === 0) {
    return { kind: "refused", reason: "absent" };
  }

  const distinct = [...new Set(present)];
  if (distinct.length > 1) {
    return { kind: "refused", reason: "ambiguous" };
  }

  const projectId = distinct[0];

  // `startsWith` alone would accept the degenerate id "demo-", which names no
  // project at all — so the prefix must be followed by something.
  if (
    !projectId.startsWith(DEMO_PROJECT_PREFIX) ||
    projectId.length <= DEMO_PROJECT_PREFIX.length
  ) {
    return { kind: "refused", reason: "not-demo" };
  }

  return { kind: "allowed", projectId };
}

/**
 * Throws the curated `DomainError` unless the effective project is a demo one.
 *
 * Returns the project id for the CALLER'S OWN use (logging inside the function),
 * never for the response body. The thrown message is constant, so production and
 * a misconfigured environment are indistinguishable from the outside.
 */
export function assertDemoProject(candidates: readonly unknown[]): string {
  const decision = decideDemoProject(candidates);

  if (decision.kind === "refused") {
    throw new DomainError(
      "failed-precondition",
      DEMO_PROJECT_REFUSED_MESSAGE
    );
  }

  return decision.projectId;
}
