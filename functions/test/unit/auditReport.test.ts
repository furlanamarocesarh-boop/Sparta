import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EXIT_ANOMALIES,
  EXIT_FAILURE,
  EXIT_OK,
  exitCodeFor,
  hasAnomalies,
  renderReport,
  summarize,
} from "../../src/audit/report.js";
import { auditTournamentDocument } from "../../src/audit/tournamentAudit.js";
import { auditWalletDocument } from "../../src/audit/walletAudit.js";

const healthyWallet = {
  balance: 0,
  total_deposited: 0,
  total_won: 0,
  total_spent: 0,
  total_withdrawn: 0,
};

const walletFinding = (id: string, data: Record<string, unknown>) => {
  const finding = auditWalletDocument(id, data);
  assert.ok(finding, "expected a finding");
  return finding;
};

describe("exit codes", () => {
  it("is 0 when the audit ran and found nothing", () => {
    const summary = summarize(3, [], 2, [
      auditTournamentDocument("t1", {
        current_participants: 0,
        max_participants: 10,
      }),
      // legacy-only is healthy: the backend reads it via the fallback.
      auditTournamentDocument("t2", { current_players: 1, max_players: 8 }),
    ]);

    assert.equal(hasAnomalies(summary), false);
    assert.equal(exitCodeFor(summary), EXIT_OK);
  });

  it("is 2 when a wallet is defective", () => {
    const summary = summarize(
      2,
      [walletFinding("w1", { ...healthyWallet, balance: -1 })],
      0,
      []
    );
    assert.equal(exitCodeFor(summary), EXIT_ANOMALIES);
  });

  it("is 2 when a tournament is blocking", () => {
    const summary = summarize(0, [], 1, [
      auditTournamentDocument("t1", { name: "sem capacidade" }),
    ]);
    assert.equal(summary.tournamentsBlocking, 1);
    assert.equal(exitCodeFor(summary), EXIT_ANOMALIES);
  });

  it("keeps 1 reserved for operational failure, never for data findings", () => {
    // A refused/failed run must never be confused with "no anomalies".
    assert.equal(EXIT_FAILURE, 1);
    assert.notEqual(EXIT_FAILURE, EXIT_OK);
    assert.notEqual(EXIT_FAILURE, EXIT_ANOMALIES);
  });
});

describe("summarize", () => {
  it("counts wallet problems per field and problem", () => {
    const summary = summarize(
      3,
      [
        walletFinding("w1", { ...healthyWallet, balance: -1 }),
        walletFinding("w2", { ...healthyWallet, balance: -2 }),
        walletFinding("w3", { ...healthyWallet, total_won: 10.001 }),
      ],
      0,
      []
    );

    assert.equal(summary.walletsScanned, 3);
    assert.equal(summary.walletsWithIssues, 3);
    assert.equal(summary.walletProblems["balance:negative"], 2);
    assert.equal(summary.walletProblems["total_won:too-many-decimals"], 1);
  });

  it("counts tournament shapes and value problems", () => {
    const summary = summarize(0, [], 4, [
      auditTournamentDocument("t1", {
        current_participants: 0,
        max_participants: 10,
      }),
      auditTournamentDocument("t2", { current_players: 0, max_players: 10 }),
      auditTournamentDocument("t3", {
        current_participants: 1,
        max_participants: 10,
        current_players: 1,
        max_players: 8,
      }),
      auditTournamentDocument("t4", { current_participants: -1, max_participants: 10 }),
    ]);

    assert.equal(summary.tournamentShapes["canonical-only"], 2);
    assert.equal(summary.tournamentShapes["legacy-only"], 1);
    assert.equal(summary.tournamentShapes["both-diverging"], 1);
    assert.equal(summary.tournamentValueProblems["negative"], 1);
    assert.equal(summary.tournamentsBlocking, 2); // diverging + negative
  });
});

describe("renderReport — privacy", () => {
  const sensitive = {
    ...healthyWallet,
    balance: -1,
    email: "vitima@example.com",
    pix_key: "chave-pix-secreta",
    whatsapp: "+5511999999999",
  };

  it("prints aggregate counts only, never document content", () => {
    const summary = summarize(1, [walletFinding("w1", sensitive)], 0, []);
    const output = renderReport(summary, {
      showIds: false,
      target: "demo-sparta-battle (emulator)",
    });

    // The audit layer never even receives these — but assert it anyway, because
    // a leak here would be a privacy incident, not a cosmetic bug.
    assert.ok(!output.includes("vitima@example.com"));
    assert.ok(!output.includes("chave-pix-secreta"));
    assert.ok(!output.includes("+5511999999999"));
    // And no document id without the explicit flag.
    assert.ok(!output.includes("w1"));

    assert.ok(output.includes("balance:negative"));
    assert.ok(output.includes("somente leitura"));
  });

  it("prints ids only with --show-ids, and warns not to commit them", () => {
    const summary = summarize(1, [walletFinding("w1", sensitive)], 0, []);
    const output = renderReport(summary, {
      showIds: true,
      target: "demo-sparta-battle (emulator)",
    });

    assert.ok(output.includes("w1"));
    assert.ok(output.includes("NÃO COMMITE"));
    // Still no document content.
    assert.ok(!output.includes("vitima@example.com"));
    assert.ok(!output.includes("chave-pix-secreta"));
  });

  it("states clearly that nothing was modified", () => {
    const summary = summarize(0, [], 0, []);
    const output = renderReport(summary, { showIds: false, target: "x" });
    assert.ok(output.includes("Nenhum documento foi alterado"));
  });
});
