import { centavosToReais } from "../domain/money.js";
import { EXIT_ANOMALIES, EXIT_OK } from "./report.js";
import { Classification, ReconciliationResult } from "./reconcile.js";

/**
 * Anonymized reconciliation report.
 *
 * PRIVACY: this layer receives labels ("Wallet A"), counts, and derived totals —
 * never an id, uid, e-mail, PIX key or WhatsApp number. Ids exist only inside
 * the correlation step and are dropped before anything reaches here, so a leak
 * is not merely avoided by discipline: there is nothing here to leak.
 *
 * The derived totals ARE printed, because they are the whole point: you cannot
 * decide a backfill without knowing what the value would be.
 */

/** "Wallet A", "Wallet B", ... "Wallet Z", then "Wallet AA". */
export function anonymousLabel(index: number): string {
  let n = index;
  let suffix = "";
  do {
    suffix = String.fromCharCode(65 + (n % 26)) + suffix;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return `Wallet ${suffix}`;
}

const CLASSIFICATION_LABEL: Record<Classification, string> = {
  "safe-zero-candidate": "safe-zero-candidate",
  reconstructable: "reconstructable",
  "manual-review": "manual-review",
};

export function renderReconciliation(
  results: readonly ReconciliationResult[]
): string {
  const lines: string[] = [];

  lines.push("=".repeat(64));
  lines.push("RECONCILIAÇÃO DE WALLETS (SOMENTE LEITURA, ANONIMIZADA)");
  lines.push("=".repeat(64));
  lines.push("");

  if (results.length === 0) {
    lines.push("Nenhuma wallet com campos monetários ausentes.");
    return lines.join("\n");
  }

  for (const result of results) {
    lines.push("-".repeat(64));
    lines.push(`${result.label}`);
    lines.push("-".repeat(64));
    lines.push(`  campos ausentes:        ${result.missingFields.join(", ")}`);
    lines.push(
      `  users/{uid} existe:     ${result.userDocExists ? "sim" : "NÃO"}`
    );
    lines.push(
      `  user_ref válido:        ${
        result.userRefValid ? "sim" : `NÃO (${result.userRefStatus})`
      }`
    );
    lines.push(
      `  atividade financeira:   ${result.hasFinancialActivity ? "SIM" : "nenhuma"}`
    );
    lines.push("");

    lines.push("  transactions por categoria e status:");
    if (result.transactionCounts.length === 0) {
      lines.push("    (nenhuma)");
    } else {
      for (const count of result.transactionCounts) {
        lines.push(
          `    ${(count.category + " / " + count.status).padEnd(32)} ${count.count}`
        );
      }
    }

    lines.push("  withdrawals por status:");
    const withdrawalEntries = Object.entries(result.withdrawalCounts);
    if (withdrawalEntries.length === 0) {
      lines.push("    (nenhum)");
    } else {
      for (const [status, count] of withdrawalEntries) {
        lines.push(`    ${status.padEnd(32)} ${count}`);
      }
    }

    lines.push(`  registrations:            ${result.registrationCount}`);
    lines.push("");

    lines.push("  totais derivados do histórico (para reconciliação):");
    for (const [field, centavos] of Object.entries(result.derivedCentavos)) {
      lines.push(
        `    ${field.padEnd(20)} R$ ${centavosToReais(centavos)
          .toFixed(2)
          .padStart(12)}`
      );
    }
    // Beta Credits are NOT BRL — printed without the currency symbol.
    lines.push(
      `    ${"beta_balance".padEnd(20)}    ${centavosToReais(
        result.derivedBetaCentavos
      )
        .toFixed(2)
        .padStart(12)} (créditos beta)`
    );

    if (result.conflicts.length > 0) {
      lines.push("");
      lines.push("  CONFLITOS (campo presente diverge do histórico):");
      for (const conflict of result.conflicts) {
        lines.push(`    - ${conflict}`);
      }
    }

    lines.push("");
    lines.push(`  CLASSIFICAÇÃO: ${CLASSIFICATION_LABEL[result.classification]}`);
    for (const reason of result.reasons) {
      lines.push(`    · ${reason}`);
    }
    lines.push("");
  }

  lines.push("=".repeat(64));
  lines.push("RESUMO");
  lines.push("=".repeat(64));
  const summary = new Map<Classification, number>();
  for (const result of results) {
    summary.set(
      result.classification,
      (summary.get(result.classification) ?? 0) + 1
    );
  }
  for (const [classification, count] of summary.entries()) {
    lines.push(`  ${classification.padEnd(24)} ${count}`);
  }
  lines.push("");
  lines.push("NENHUM backfill foi executado. Esta ferramenta é somente leitura.");
  lines.push("Nenhum ID, UID, e-mail, PIX ou WhatsApp foi exibido.");

  return lines.join("\n");
}

/** Anomalies here are wallets that are not provably safe to leave as they are. */
export function reconciliationExitCode(
  results: readonly ReconciliationResult[]
): number {
  return results.length > 0 ? EXIT_ANOMALIES : EXIT_OK;
}
