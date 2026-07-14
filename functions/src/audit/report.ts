import { MoneyProblem } from "../domain/money.js";
import { TournamentFinding, ShapeCategory, ValueProblem } from "./tournamentAudit.js";
import { WalletField, WalletFinding } from "./walletAudit.js";

/**
 * Aggregation and presentation — pure, no Firebase, no I/O.
 *
 * PRIVACY: this layer only ever receives ids and problem codes. It has no access
 * to document bodies, so it *cannot* print an e-mail, a PIX key, a WhatsApp
 * number or a balance even by accident. Ids are carried but printed only when
 * the operator explicitly asks (`--show-ids`).
 */

/** Process exit codes. Stable — CI and humans depend on them. */
export const EXIT_OK = 0;
/** Operational failure or unsafe configuration. Never means "data is fine". */
export const EXIT_FAILURE = 1;
/** The audit ran and found anomalies. */
export const EXIT_ANOMALIES = 2;

export interface AuditSummary {
  readonly walletsScanned: number;
  readonly walletsWithIssues: number;
  /** Count per (field, problem) pair, e.g. "balance:too-many-decimals" -> 3. */
  readonly walletProblems: Readonly<Record<string, number>>;

  readonly tournamentsScanned: number;
  readonly tournamentsBlocking: number;
  readonly tournamentShapes: Readonly<Record<ShapeCategory, number>>;
  readonly tournamentValueProblems: Readonly<Record<string, number>>;

  readonly walletFindings: readonly WalletFinding[];
  readonly tournamentFindings: readonly TournamentFinding[];
}

const EMPTY_SHAPES: Record<ShapeCategory, number> = {
  "canonical-only": 0,
  "legacy-only": 0,
  "both-matching": 0,
  "both-diverging": 0,
  partial: 0,
  "capacity-missing": 0,
};

export function summarize(
  walletsScanned: number,
  walletFindings: readonly WalletFinding[],
  tournamentsScanned: number,
  tournamentFindings: readonly TournamentFinding[]
): AuditSummary {
  const walletProblems: Record<string, number> = {};
  for (const finding of walletFindings) {
    for (const issue of finding.issues) {
      const key = `${issue.field}:${issue.problem}`;
      walletProblems[key] = (walletProblems[key] ?? 0) + 1;
    }
  }

  const tournamentShapes: Record<ShapeCategory, number> = { ...EMPTY_SHAPES };
  const tournamentValueProblems: Record<string, number> = {};
  let tournamentsBlocking = 0;

  for (const finding of tournamentFindings) {
    tournamentShapes[finding.shape] += 1;
    for (const problem of finding.valueProblems) {
      tournamentValueProblems[problem] =
        (tournamentValueProblems[problem] ?? 0) + 1;
    }
    if (finding.blocking) tournamentsBlocking += 1;
  }

  return {
    walletsScanned,
    walletsWithIssues: walletFindings.length,
    walletProblems,
    tournamentsScanned,
    tournamentsBlocking,
    tournamentShapes,
    tournamentValueProblems,
    walletFindings,
    tournamentFindings,
  };
}

/**
 * Anomalies are wallet issues and BLOCKING tournament issues.
 *
 * A `legacy-only` tournament is NOT an anomaly: the hardened backend reads it
 * correctly through the legacy fallback. Counting it as one would drown the
 * real problems in noise on the very first run.
 */
export function hasAnomalies(summary: AuditSummary): boolean {
  return summary.walletsWithIssues > 0 || summary.tournamentsBlocking > 0;
}

export function exitCodeFor(summary: AuditSummary): number {
  return hasAnomalies(summary) ? EXIT_ANOMALIES : EXIT_OK;
}

/** Renders the report. Aggregate counts only, unless `showIds` is set. */
export function renderReport(
  summary: AuditSummary,
  options: { readonly showIds: boolean; readonly target: string }
): string {
  const lines: string[] = [];

  lines.push("=".repeat(64));
  lines.push(`AUDITORIA DE DADOS (SOMENTE LEITURA) — alvo: ${options.target}`);
  lines.push("=".repeat(64));
  lines.push("");

  lines.push("WALLETS");
  lines.push(`  documentos lidos:      ${summary.walletsScanned}`);
  lines.push(`  com problemas:         ${summary.walletsWithIssues}`);
  if (Object.keys(summary.walletProblems).length === 0) {
    lines.push("  nenhum problema monetário encontrado");
  } else {
    lines.push("  problemas por campo:");
    for (const [key, count] of sorted(summary.walletProblems)) {
      lines.push(`    ${key.padEnd(38)} ${count}`);
    }
  }
  lines.push("");

  lines.push("TOURNAMENTS");
  lines.push(`  documentos lidos:      ${summary.tournamentsScanned}`);
  lines.push(`  bloqueantes:           ${summary.tournamentsBlocking}`);
  lines.push("  formato dos campos de participantes:");
  for (const [shape, count] of Object.entries(summary.tournamentShapes)) {
    lines.push(`    ${shape.padEnd(38)} ${count}`);
  }
  if (Object.keys(summary.tournamentValueProblems).length > 0) {
    lines.push("  problemas de valor:");
    for (const [key, count] of sorted(summary.tournamentValueProblems)) {
      lines.push(`    ${key.padEnd(38)} ${count}`);
    }
  }
  lines.push("");

  if (options.showIds) {
    lines.push("-".repeat(64));
    lines.push("IDS DOS DOCUMENTOS AFETADOS");
    lines.push("NÃO COMMITE ESTA SAÍDA: ids identificam usuários e torneios.");
    lines.push("-".repeat(64));

    for (const finding of summary.walletFindings) {
      const issues = finding.issues
        .map((issue) => `${issue.field}=${issue.problem}`)
        .join(", ");
      lines.push(`  wallet ${finding.id}: ${issues}`);
    }
    for (const finding of summary.tournamentFindings.filter((f) => f.blocking)) {
      const problems = [finding.shape, ...finding.valueProblems].join(", ");
      lines.push(`  tournament ${finding.id}: ${problems}`);
    }
    lines.push("");
  } else if (hasAnomalies(summary)) {
    lines.push("Use --show-ids para listar os documentos afetados.");
    lines.push("");
  }

  lines.push(
    hasAnomalies(summary)
      ? `RESULTADO: anomalias encontradas (exit ${EXIT_ANOMALIES})`
      : `RESULTADO: nenhuma anomalia (exit ${EXIT_OK})`
  );
  lines.push("Nenhum documento foi alterado. Esta ferramenta é somente leitura.");

  return lines.join("\n");
}

function sorted(record: Record<string, number>): [string, number][] {
  return Object.entries(record).sort((a, b) => b[1] - a[1]);
}

/** Re-exported so callers can type a problem without importing money.ts. */
export type { MoneyProblem, ValueProblem, WalletField };
