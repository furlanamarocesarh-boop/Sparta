import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import * as admin from "firebase-admin";

import { assertEmulatorOnly } from "../support/emulatorGuard.js";

/**
 * O PAINEL DO ADMIN, contra um Firestore real.
 *
 * O que só o emulador prova: que os agregados somam o CAMPO CERTO por
 * categoria. Uma linha de caixa guarda `amount_centavos` e nenhuma `amount` —
 * um painel somando `amount` a reportaria como R$ 0 e ninguém veria.
 */

const PROJECT_ID = "demo-sparta-battle";
const ADMIN = "e2e-admin-overview";
const P1 = "e2e-ov-partner-1";
const P2 = "e2e-ov-partner-2";
const NOW = new Date(Date.UTC(2026, 7, 25, 12));
const ago = (h: number) => new Date(NOW.getTime() - h * 3600_000);

const ctx = (uid: string, isAdmin = true) => ({
  auth: { uid, token: isAdmin ? { admin: true } : {} },
});

let db: admin.firestore.Firestore;
let handler: (d: unknown, c: unknown, o?: unknown) => Promise<any>;
const overview = (c: unknown) => handler({}, c, { now: NOW });

const TX = "e2e-ov-";
const seeded: string[] = [];

async function tx(id: string, fields: Record<string, unknown>, hoursAgo: number) {
  const docId = TX + id;
  seeded.push(docId);
  await db.collection("transactions").doc(docId).set({
    ...fields,
    timestamp: admin.firestore.Timestamp.fromDate(ago(hoursAgo)),
  });
}

async function wipe(): Promise<void> {
  await Promise.all([
    ...seeded.map((id) => db.collection("transactions").doc(id).delete()),
    ...[ADMIN, `${TX}u1`, `${TX}u2`, `${TX}u3`].map((u) =>
      db.collection("users").doc(u).delete()
    ),
    db.collection("partners").doc(P1).delete(),
    db.collection("partners").doc(P2).delete(),
  ]);
}

const windowOf = (out: any, key: string) =>
  out.windows.find((w: any) => w.window === key);
const categoryOf = (out: any, key: string, category: string) =>
  windowOf(out, key).categories.find((c: any) => c.category === category);

describe("E2E — painel do admin", () => {
  before(async () => {
    assertEmulatorOnly(PROJECT_ID);
    process.env.GCLOUD_PROJECT = PROJECT_ID;
    if (admin.apps.length === 0) admin.initializeApp();
    db = admin.firestore();

    const mod = await import("../../src/index.js");
    handler = (mod as any).getAdminOverviewHandler;

    await wipe();

    // Dentro de 24h.
    await tx("d1", { category: "deposit", amount: 20.01, economy_type: "cash" }, 2);
    await tx("d2", { category: "deposit", amount: 30, economy_type: "cash" }, 5);
    await tx("w1", { category: "withdrawal", amount: 5.02, economy_type: "cash" }, 3);
    // A FAMÍLIA DA PLATAFORMA: valor em centavos, e SEM `amount`.
    await tx("h1", { category: "house_funding", amount_centavos: 10_000, economy_type: "cash" }, 4);
    await tx("m1", { category: "house_margin", amount_centavos: 250, economy_type: "cash" }, 4);
    // MARGEM NEGATIVA: a casa subsidiou este prêmio. É gravada abaixo de zero.
    await tx("m2", { category: "house_margin", amount_centavos: -100, economy_type: "cash" }, 4);
    await tx("c1", { category: "commission_accrued", amount_centavos: 30, economy_type: "cash" }, 4);
    // Uma liquidação que pagou MAIS do que arrecadou — o caso de produção.
    await tx("e1", { category: "entry_fee", amount: 10.03, economy_type: "cash" }, 1);
    await tx("p1", { category: "prize", amount: 30.3, economy_type: "cash" }, 1);
    // Beta, que nunca pode se misturar com dinheiro.
    await tx("b1", { category: "beta_entry_fee", amount: 5, economy_type: "beta_credit" }, 6);
    // Mais velha que 24h, dentro da semana.
    await tx("d3", { category: "deposit", amount: 100, economy_type: "cash" }, 72);

    await db.collection("users").doc(ADMIN).set({
      username: "ADMIN",
      created_at: admin.firestore.Timestamp.fromDate(ago(2)),
    });
    await db.collection("users").doc(`${TX}u1`).set({
      created_at: admin.firestore.Timestamp.fromDate(ago(3)),
      partner_ref: P1,
    });
    await db.collection("users").doc(`${TX}u2`).set({
      created_at: admin.firestore.Timestamp.fromDate(ago(80)),
      partner_ref: P1,
    });
    await db.collection("users").doc(`${TX}u3`).set({
      created_at: admin.firestore.Timestamp.fromDate(ago(4)),
      partner_ref: P2,
    });
    await db.collection("partners").doc(P1).set({ active: true });
    await db.collection("partners").doc(P2).set({ active: false });
  });

  after(async () => {
    await wipe();
  });

  it("O CAIXA NÃO SOMA ZERO — é a armadilha que este painel existe para evitar", async () => {
    // `house_funding` guarda `amount_centavos` e nenhuma `amount`. Um painel
    // somando `amount` reportaria R$ 0 e alguém decidiria em cima disso.
    const out = await overview(ctx(ADMIN));
    const caixa = categoryOf(out, "day", "house_funding");
    assert.equal(caixa.count, 1);
    assert.equal(caixa.centavos, 10_000);

    const margem = categoryOf(out, "day", "house_margin");
    assert.equal(margem.centavos, 150, "250 retidos menos 100 subsidiados");
    // E a margem NÃO entra no lucro: ela é o registro derivado da mesma
    // diferença, e somá-la dobraria o dinheiro das liquidações que a têm.
    const lucro = windowOf(out, "day").profit.find(
      (p: any) => p.economy === "cash"
    );
    // -2027 vem SÓ de inscrição menos prêmio. Se a margem entrasse, os 150
    // apareceriam aqui e o mesmo dinheiro contaria duas vezes.
    assert.equal(lucro.grossCentavos, -2027);
  });

  it("MARGEM NEGATIVA sobrevive ao agregado", async () => {
    // Um subsídio é gravado abaixo de zero. Se o painel o pisasse em zero, um
    // prejuízo apareceria como "nada aconteceu".
    const out = await overview(ctx(ADMIN));
    const lucro = windowOf(out, "day").profit.find(
      (p: any) => p.economy === "cash"
    );
    // Não há inscrição nem prêmio nesta janela do seed além do de baixo, então
    // o que importa aqui é a comissão sair do resultado.
    assert.equal(lucro.commissionCentavos, 30);
  });

  it("O LUCRO VEM DAS INSCRIÇÕES E DOS PRÊMIOS, não da margem", async () => {
    // A margem só é gravada por liquidações posteriores ao caixa existir — em
    // produção não há nenhuma. Inscrição e prêmio estão no razão desde o
    // primeiro dia, então o lucro derivado deles cobre toda a história.
    const out = await overview(ctx(ADMIN));
    const lucro = windowOf(out, "day").profit.find(
      (p: any) => p.economy === "cash"
    );
    assert.equal(lucro.collectedCentavos, 1003);
    assert.equal(lucro.paidCentavos, 3030);
    assert.equal(lucro.grossCentavos, -2027, "pagou mais do que entrou");
  });

  it("um subsídio MOVEU dinheiro, então conta no volume", async () => {
    const cash = windowOf(await overview(ctx(ADMIN)), "day").economies.find(
      (e: any) => e.economy === "cash"
    );
    // 100 de subsídio entram como magnitude, não encolhendo o volume.
    assert.ok(cash.volumeCentavos > 0);
  });

  it("reais viram centavos exatos, sem sobra de ponto flutuante", async () => {
    const out = await overview(ctx(ADMIN));
    const dep = categoryOf(out, "day", "deposit");
    assert.equal(dep.count, 2);
    assert.equal(dep.centavos, 5001, "20.01 + 30.00");
  });

  it("AS DUAS ECONOMIAS NÃO SE SOMAM", async () => {
    const out = await overview(ctx(ADMIN));
    const eco = windowOf(out, "day").economies;
    const cash = eco.find((e: any) => e.economy === "cash");
    const beta = eco.find((e: any) => e.economy === "beta_credit");

    assert.equal(beta.volumeCentavos, 500, "só a inscrição beta");
    // A margem entra como |líquido|: +250 retidos e -100 subsidiados chegam
    // já somados pelo Firestore, então contribuem 150 — não 350.
    assert.equal(
      cash.volumeCentavos,
      5001 + 502 + 10_000 + 150 + 30 + 1003 + 3030
    );
  });

  it("entrada e saída ficam ao lado do volume", async () => {
    const cash = windowOf(await overview(ctx(ADMIN)), "day").economies.find(
      (e: any) => e.economy === "cash"
    );
    assert.equal(cash.inCentavos, 5001 + 3030, "depósitos e prêmio");
    assert.equal(cash.outCentavos, 502 + 1003, "saque e inscrição");
    // O caixa e a margem são internos: entram no volume e em nenhum lado.
    assert.equal(
      cash.volumeCentavos - cash.inCentavos - cash.outCentavos,
      10_000 + 150 + 30
    );
  });

  it("a janela maior contém a menor", async () => {
    const out = await overview(ctx(ADMIN));
    const dia = categoryOf(out, "day", "deposit").centavos;
    const semana = categoryOf(out, "week", "deposit").centavos;
    const total = categoryOf(out, "all", "deposit").centavos;

    assert.equal(dia, 5001);
    assert.equal(semana, 5001 + 10_000, "inclui o depósito de 72h atrás");
    assert.equal(total, semana);
  });

  it("categoria sem movimento no período não vira linha vazia", async () => {
    // Uma linha zerada lê como "aconteceu e deu zero"; ausência lê como
    // "não aconteceu", que é a verdade.
    const out = await overview(ctx(ADMIN));
    assert.equal(categoryOf(out, "day", "kill_prize"), undefined);
  });

  it("conta novos usuários por janela", async () => {
    const out = await overview(ctx(ADMIN));
    assert.equal(windowOf(out, "day").newUsers, 3, "admin + u1 + u3");
    assert.equal(windowOf(out, "week").newUsers, 4, "mais o u2");
  });

  it("separa a origem POR PARCEIRO", async () => {
    const out = await overview(ctx(ADMIN));
    const p1 = out.origin.partners.find((p: any) => p.partnerId === P1);
    const p2 = out.origin.partners.find((p: any) => p.partnerId === P2);

    assert.equal(p1.brought.day, 1);
    assert.equal(p1.brought.week, 2);
    assert.equal(p1.active, true);
    assert.equal(p2.brought.all, 1);
    assert.equal(p2.active, false);
  });

  it("quem não veio de parceiro é o resto, por subtração", async () => {
    // "Sem partner_ref" não é filtro possível no Firestore sem índice de
    // ausência, então o direto é derivado — e a soma tem que fechar.
    const out = await overview(ctx(ADMIN));
    assert.equal(out.origin.attributed + out.origin.direct, out.origin.totalUsers);
    assert.ok(out.origin.attributed >= 3);
  });

  it("um não-admin NÃO vê o painel", async () => {
    await assert.rejects(
      () => overview(ctx("qualquer-um", false)),
      /administradores/i
    );
  });

  it("deslogado tampouco", async () => {
    await assert.rejects(() => overview({ auth: null }), /Entre na sua conta/i);
  });

  it("chave a mais no payload derruba a chamada", async () => {
    await assert.rejects(
      () => handler({ window: "day" }, ctx(ADMIN), { now: NOW }),
      /.+/
    );
  });
});
