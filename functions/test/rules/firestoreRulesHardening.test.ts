import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  RulesTestEnvironment,
} from "@firebase/rules-unit-testing";

/**
 * SERVER-AUTHORITATIVE hardening matrix (feat/beta-rules-audit).
 *
 * The production `firestore.rules` already deny EVERY client write on every
 * financial/lifecycle collection — admin clients included — since the
 * admin-transition phase 2. This suite LOCKS that contract exhaustively for
 * the beta-era fields and lifecycle states:
 *
 *  - wallets: `balance`, `beta_balance` and the four cash totals are not
 *    client-writable by anyone (owner, other, admin claim);
 *  - tournaments: `status`, `economy_type`, `locked_economy_type`, prices,
 *    counters, settlement and cancellation fields cannot be written, flipped
 *    or "reopened" by any client — the lifecycle transitions live ONLY in the
 *    server-authoritative handlers (Admin SDK, which bypasses these rules);
 *  - registrations/transactions: joins, refunds, ledgers stay immutable to
 *    clients;
 *  - DECIDED here (FASE 10): NO `started_at` marker is introduced — `status`
 *    remains the canonical lifecycle marker, and the direct-client tampering
 *    avenue is closed by these rules. Residual risk (documented, NOT solved):
 *    a bug or privileged Admin-SDK write could still change `status` without
 *    an independent marker; fixing that would be a deliberate lifecycle
 *    contract change outside this branch.
 *
 * NEVER touches production: project id `demo-*`, local emulator only.
 */

const PROJECT_ID = "demo-sparta-battle-hardening";

const OWNER = "user-owner";
const OTHER = "user-other";

let testEnv: RulesTestEnvironment;

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: readFileSync(resolve(process.cwd(), "..", "firestore.rules"), "utf8"),
    },
  });
});

after(async () => {
  await testEnv?.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    const ownerRef = db.doc(`users/${OWNER}`);

    await ownerRef.set({ email: "owner@example.com", username: "" });
    await db.doc(`users/${OTHER}`).set({ email: "other@example.com" });

    await db.doc(`wallets/${OWNER}`).set({
      balance: 10,
      total_deposited: 10,
      total_won: 0,
      total_spent: 0,
      total_withdrawn: 0,
      beta_balance: 50,
      user_ref: ownerRef,
    });

    await db.doc("tournaments/t-open").set({
      name: "Aberta",
      status: "open",
      economy_type: "beta_credit",
      locked_economy_type: "beta_credit",
      entry_fee: 10,
      prize: 100,
      current_participants: 1,
      max_participants: 8,
      current_players: 1,
      max_players: 8,
    });
    await db.doc("tournaments/t-progress").set({
      name: "Em andamento",
      status: "in_progress",
      economy_type: "cash",
      locked_economy_type: "cash",
      entry_fee: 10,
      prize: 100,
    });
    await db.doc("tournaments/t-cancelled").set({
      name: "Cancelada",
      status: "cancelled",
      economy_type: "beta_credit",
      locked_economy_type: "beta_credit",
      cancelled_by: "admin-1",
      refunded_registration_count: 1,
      refunded_total: 10,
      refund_economy_type: "beta_credit",
      current_participants: 0,
      current_players: 0,
    });

    await db.doc(`registrations/${OWNER}_t-open`).set({
      user_ref: ownerRef,
      tournament_ref: db.doc("tournaments/t-open"),
      status: "registered",
      economy_type: "beta_credit",
      entry_fee: 10,
      entry_fee_snapshot: 10,
    });

    await db.doc("transactions/tx-owner").set({
      amount: 10,
      category: "beta_entry_fee",
      economy_type: "beta_credit",
      user_ref: ownerRef,
    });
  });
});

const asOwner = () => testEnv.authenticatedContext(OWNER).firestore();
const asOther = () => testEnv.authenticatedContext(OTHER).firestore();
const asAdmin = () =>
  testEnv.authenticatedContext("admin-client", { admin: true }).firestore();

// ─────────────────────────────────────────────────────────────────────────────
// (1)(2)(25) Leituras legítimas preservadas.
// ─────────────────────────────────────────────────────────────────────────────

describe("leituras legítimas preservadas", () => {
  it("(1)(25) owner lê a própria wallet/registro/transaction; autenticado lê tournaments; admin lê wallets", async () => {
    await assertSucceeds(asOwner().doc(`wallets/${OWNER}`).get());
    await assertSucceeds(asOwner().doc(`registrations/${OWNER}_t-open`).get());
    await assertSucceeds(asOwner().doc("transactions/tx-owner").get());
    await assertSucceeds(asOwner().doc("tournaments/t-open").get());
    await assertSucceeds(asOther().doc("tournaments/t-cancelled").get());
    await assertSucceeds(asAdmin().doc(`wallets/${OWNER}`).get());
    await assertSucceeds(asAdmin().doc(`users/${OWNER}`).get());
  });

  it("(2) usuário não lê wallet alheia", async () => {
    await assertFails(asOther().doc(`wallets/${OWNER}`).get());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (3)-(9) Wallets: nenhum cliente escreve — owner ou admin, qualquer campo.
// ─────────────────────────────────────────────────────────────────────────────

describe("wallets — server-authoritative", () => {
  it("(3) owner não cria wallet (nem a própria)", async () => {
    const noWallet = testEnv.authenticatedContext("user-nowallet").firestore();
    await assertFails(
      noWallet.doc("wallets/user-nowallet").set({ balance: 0, beta_balance: 0 })
    );
  });

  it("(4)(5) owner não altera balance nem beta_balance", async () => {
    await assertFails(asOwner().doc(`wallets/${OWNER}`).update({ balance: 1e6 }));
    await assertFails(
      asOwner().doc(`wallets/${OWNER}`).update({ beta_balance: 1e6 })
    );
  });

  it("(6) owner não altera NENHUM total cash", async () => {
    for (const field of [
      "total_deposited",
      "total_won",
      "total_spent",
      "total_withdrawn",
    ]) {
      await assertFails(
        asOwner()
          .doc(`wallets/${OWNER}`)
          .update({ [field]: 999 })
      );
    }
  });

  it("(7) alteração mista (campo inocente + financeiro) e campo novo forjado também falham", async () => {
    await assertFails(
      asOwner().doc(`wallets/${OWNER}`).update({ note: "oi", balance: 11 })
    );
    // Um campo financeiro NOVO (forjado) também não entra.
    await assertFails(
      asOwner().doc(`wallets/${OWNER}`).update({ bonus_balance: 500 })
    );
    // Nem um update aparentemente inofensivo: a negação é total.
    await assertFails(asOwner().doc(`wallets/${OWNER}`).update({ note: "oi" }));
  });

  it("(8) owner não deleta wallet", async () => {
    await assertFails(asOwner().doc(`wallets/${OWNER}`).delete());
  });

  it("(9) admin client também não cria/altera/deleta wallet (incl. beta_balance)", async () => {
    await assertFails(asAdmin().doc(`wallets/${OWNER}`).update({ balance: 1 }));
    await assertFails(
      asAdmin().doc(`wallets/${OWNER}`).update({ beta_balance: 1e6 })
    );
    await assertFails(
      asAdmin().doc("wallets/new-wallet").set({ balance: 0 })
    );
    await assertFails(asAdmin().doc(`wallets/${OWNER}`).delete());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (10)-(17) + FASE 10: tournaments — lifecycle e economia intocáveis.
// ─────────────────────────────────────────────────────────────────────────────

describe("tournaments — lifecycle e economia server-authoritative", () => {
  it("(10) leitura autenticada preservada", async () => {
    await assertSucceeds(asOwner().doc("tournaments/t-progress").get());
  });

  it("(11) usuário comum não cria/altera/deleta tournament", async () => {
    await assertFails(asOwner().doc("tournaments/novo").set({ name: "x" }));
    await assertFails(
      asOwner().doc("tournaments/t-open").update({ entry_fee: 0 })
    );
    await assertFails(asOwner().doc("tournaments/t-open").delete());
  });

  it("(12) admin client não cria tournament diretamente", async () => {
    await assertFails(
      asAdmin().doc("tournaments/forjado").set({
        name: "Forjado",
        status: "in_progress",
        economy_type: "cash",
        locked_economy_type: "cash",
        prize: 1e6,
      })
    );
  });

  it("(13)+FASE10 admin client não altera status em NENHUMA direção", async () => {
    // open → in_progress (falsificar início)
    await assertFails(
      asAdmin().doc("tournaments/t-open").update({ status: "in_progress" })
    );
    // in_progress → open (apagar o marcador canônico de início)
    await assertFails(
      asAdmin().doc("tournaments/t-progress").update({ status: "open" })
    );
    // qualquer outro estado
    await assertFails(
      asAdmin().doc("tournaments/t-open").update({ status: "completed" })
    );
  });

  it("(14)(15) admin client não altera economy_type nem locked_economy_type", async () => {
    await assertFails(
      asAdmin().doc("tournaments/t-open").update({ economy_type: "cash" })
    );
    await assertFails(
      asAdmin()
        .doc("tournaments/t-open")
        .update({ locked_economy_type: "cash" })
    );
    await assertFails(
      asAdmin()
        .doc("tournaments/t-open")
        .update({ economy_type: "cash", locked_economy_type: "cash" })
    );
  });

  it("(16) admin client não altera preços, contadores nem settlement", async () => {
    for (const update of [
      { entry_fee: 0 },
      { prize: 1e6 },
      { current_participants: 0 },
      { current_players: 99 },
      { result: { winner_uid: "admin-client", prize: 1e6 } },
      { refunded_total: 0 },
    ]) {
      await assertFails(asAdmin().doc("tournaments/t-open").update(update));
    }
  });

  it("(17)+FASE10 admin client não reabre cancelled nem falsifica campos terminais", async () => {
    await assertFails(
      asAdmin().doc("tournaments/t-cancelled").update({ status: "open" })
    );
    await assertFails(
      asAdmin()
        .doc("tournaments/t-cancelled")
        .update({ refunded_registration_count: 0, refunded_total: 0 })
    );
    await assertFails(
      asAdmin().doc("tournaments/t-cancelled").update({ cancelled_by: "x" })
    );
    await assertFails(asAdmin().doc("tournaments/t-cancelled").delete());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (18)-(20) Registrations.
// ─────────────────────────────────────────────────────────────────────────────

describe("registrations — server-authoritative", () => {
  it("(18) owner não cria registration diretamente", async () => {
    await assertFails(
      asOwner()
        .doc(`registrations/${OWNER}_t-progress`)
        .set({ status: "registered" })
    );
  });

  it("(19) owner não altera status/economia/valor/refs da própria registration", async () => {
    for (const update of [
      { status: "refunded" },
      { status: "registered" },
      { economy_type: "cash" },
      { entry_fee_snapshot: 0 },
      { refunded_amount: 1e6 },
    ]) {
      await assertFails(
        asOwner().doc(`registrations/${OWNER}_t-open`).update(update)
      );
    }
    await assertFails(asOwner().doc(`registrations/${OWNER}_t-open`).delete());
  });

  it("(20) admin client também não altera registrations", async () => {
    await assertFails(
      asAdmin()
        .doc(`registrations/${OWNER}_t-open`)
        .update({ status: "refunded", refunded_amount: 10 })
    );
    await assertFails(
      asAdmin().doc(`registrations/forjada_t-open`).set({ status: "registered" })
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (21)-(24) Transactions e tournament_rooms.
// ─────────────────────────────────────────────────────────────────────────────

describe("transactions — ledger imutável para clientes", () => {
  it("(21)(22)(23) nenhum cliente cria, altera ou deleta transaction", async () => {
    await assertFails(
      asOwner().doc("transactions/forjada").set({ amount: 1e6, category: "deposit" })
    );
    await assertFails(
      asOwner().doc("transactions/tx-owner").update({ amount: 1 })
    );
    await assertFails(asOwner().doc("transactions/tx-owner").delete());
    await assertFails(
      asAdmin()
        .doc("transactions/beta_grant_forjado")
        .set({ amount: 1e6, category: "beta_grant", economy_type: "beta_credit" })
    );
    await assertFails(
      asAdmin().doc("transactions/tx-owner").update({ amount: 1 })
    );
    await assertFails(asAdmin().doc("transactions/tx-owner").delete());
  });
});

describe("tournament_rooms — credenciais inacessíveis", () => {
  it("(24) leitura e escrita diretas negadas para owner e admin", async () => {
    await assertFails(asOwner().doc("tournament_rooms/t-open").get());
    await assertFails(asAdmin().doc("tournament_rooms/t-open").get());
    await assertFails(
      asAdmin().doc("tournament_rooms/t-open").set({ room_id: "R" })
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (26)(27) O caminho do backend continua aberto: Admin SDK bypassa as Rules.
// ─────────────────────────────────────────────────────────────────────────────

describe("backend path — Admin SDK bypassa as Rules", () => {
  it("(26)(27) o contexto sem Rules (equivalente ao Admin SDK dos handlers) escreve normalmente", async () => {
    // Os handlers (jointournament, startTournament, declareTournamentResult,
    // cancelTournament, grantBetaCredit) usam o Admin SDK, que não passa pelas
    // Rules — provado aqui pelo contexto rules-disabled, e de ponta a ponta
    // pelas suítes de handlers que rodam neste mesmo emulador.
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await db.doc("tournaments/t-open").update({ status: "in_progress" });
      await db.doc(`wallets/${OWNER}`).update({ beta_balance: 40 });
    });
    // E o que o backend escreveu é legível pelo contrato normal.
    await assertSucceeds(asOwner().doc("tournaments/t-open").get());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (28) Configurações salvas de pontuação — fechadas nos dois sentidos.
// ─────────────────────────────────────────────────────────────────────────────

describe("scoring_presets — validação server-side, sem porta lateral", () => {
  it("(28) nem o dono nem o admin leem ou escrevem direto", async () => {
    // Não é sigilo: é que as regras que fazem uma configuração VÁLIDA —
    // pontos inteiros, posições sem buraco, percentuais somando exatamente
    // 100% — moram no servidor. Uma escrita direta passaria por fora delas, e
    // a configuração inválida não falharia aqui: falharia semanas depois, no
    // campeonato que ela configurou.
    const path = `scoring_presets/admin-client/presets/squad-6`;
    await assertFails(asAdmin().doc(path).get());
    await assertFails(asAdmin().doc(path).set({ name: "Squad 6" }));
    await assertFails(asAdmin().collection("scoring_presets/admin-client/presets").get());

    await assertFails(asOwner().doc(`scoring_presets/${OWNER}/presets/meu`).get());
    await assertFails(
      asOwner().doc(`scoring_presets/${OWNER}/presets/meu`).set({ name: "Meu" })
    );
    await assertFails(asOwner().doc(`scoring_presets/${OWNER}`).get());
  });

  it("(28) e um estranho não alcança as de outro criador", async () => {
    await assertFails(asOther().doc(`scoring_presets/${OWNER}/presets/meu`).get());
    await assertFails(
      asOther().collection(`scoring_presets/${OWNER}/presets`).get()
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// (29) Chaveamento da Copa — legível, jamais escrito por cliente.
// ─────────────────────────────────────────────────────────────────────────────

describe("bracket da Copa — leitura aberta, escrita fechada", () => {
  it("(29) qualquer logado LÊ a chave", async () => {
    // Uma chave que o jogador não consegue ver é uma chave que ele não
    // consegue conferir, e o caminho até a final é o centro de um mata-mata.
    await assertSucceeds(asOwner().doc("tournaments/t-open/bracket/state").get());
    await assertSucceeds(asOther().doc("tournaments/t-open/bracket/state").get());
  });

  it("(29) NINGUÉM escreve, admin incluído", async () => {
    // Uma escrita direta promoveria alguém para uma chave que não disputou — e
    // a premiação é paga pela classificação que sai daqui.
    for (const db of [asOwner(), asOther(), asAdmin()]) {
      await assertFails(
        db.doc("tournaments/t-open/bracket/state").set({ matches: [] })
      );
      await assertFails(
        db.doc("tournaments/t-open/bracket/state").update({ matches: [] })
      );
      await assertFails(db.doc("tournaments/t-open/bracket/state").delete());
    }
  });

  it("(29) deslogado não lê", async () => {
    await assertFails(
      testEnv.unauthenticatedContext().firestore()
        .doc("tournaments/t-open/bracket/state")
        .get()
    );
  });
});
