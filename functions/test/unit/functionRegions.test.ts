import assert from "node:assert/strict";
import { describe, it } from "node:test";

/**
 * Region pinning — proves the region each export actually produces.
 *
 * Regressão que estes testes travam: se alguém remover o `.region(...)` de um
 * export, sua região volta ao default do SDK (us-central1) silenciosamente. Para
 * `onUserCreated` isso significaria um deploy criar uma SEGUNDA cópia em
 * us-central1 em vez de atualizar a de us-east1 — exatamente o Bloqueador B do
 * runbook.
 *
 * Os objetos exportados (Gen 1 / firebase-functions v1) carregam a região em
 * `__trigger.regions`. Importamos o build compilado (`lib/index.js`), então este
 * teste roda depois de `npm run build:test`.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
type ExportedFn = { __trigger?: { regions?: string[] } };

// O index compilado fica em lib-test/src/index.js quando compilado por
// tsconfig.test.json (rootDir = ".").
async function loadFunctions(): Promise<Record<string, ExportedFn>> {
  // Import dinâmico do build de teste. GCLOUD_PROJECT evita que a inicialização
  // do firebase-functions v1 reclame de ambiente ausente.
  process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT ?? "demo-sparta-battle";
  const mod = await import("../../src/index.js");
  return mod as unknown as Record<string, ExportedFn>;
}

/** A região declarada de um export Gen 1 v1. */
function regionOf(fn: ExportedFn): string[] | undefined {
  return fn.__trigger?.regions;
}

const CENTRAL = "us-central1";
const EAST = "us-east1";

describe("regiões explícitas por função", () => {
  it("onUserCreated está em us-east1 (nunca no default us-central1)", async () => {
    const fns = await loadFunctions();
    assert.deepEqual(regionOf(fns.onUserCreated), [EAST]);
  });

  it("as doze callables estão em us-central1", async () => {
    const fns = await loadFunctions();
    for (const name of [
      "testdeposit",
      "requestwithdrawal",
      "jointournament",
      "payprize",
      "createTournament",
      "createtournament",
      "setTournamentRoom",
      "getTournamentRoom",
      "startTournament",
      "declareTournamentResult",
      "grantBetaCredit",
      "cancelTournament",
    ]) {
      assert.deepEqual(
        regionOf(fns[name]),
        [CENTRAL],
        `${name} deve estar em ${CENTRAL}`
      );
    }
  });

  it("toda função exportada tem uma região EXPLÍCITA (nenhuma implícita)", async () => {
    const fns = await loadFunctions();
    for (const name of [
      "onUserCreated",
      "testdeposit",
      "requestwithdrawal",
      "jointournament",
      "payprize",
      "createTournament",
      "createtournament",
      "setTournamentRoom",
      "getTournamentRoom",
      "startTournament",
      "declareTournamentResult",
      "grantBetaCredit",
      "cancelTournament",
    ]) {
      const regions = regionOf(fns[name]);
      assert.ok(
        Array.isArray(regions) && regions.length === 1,
        `${name} deve ter exatamente uma região explícita`
      );
    }
  });

  it("os treze exports implantáveis existem, com casing idêntico", async () => {
    const fns = await loadFunctions();
    // Só exports que SÃO gatilho implantável (têm `__trigger`) — ignora
    // `default`/`__esModule` do interop CommonJS↔ESM e quaisquer helpers
    // exportados que NÃO são funções deployáveis (ex.: createTournamentHandler,
    // setTournamentRoomHandler, getTournamentRoomHandler,
    // startTournamentHandler, declareTournamentResultHandler,
    // grantBetaCreditHandler, cancelTournamentHandler).
    const exported = Object.keys(fns)
      .filter((k) => (fns[k] as ExportedFn).__trigger != null)
      .sort();
    assert.deepEqual(exported, [
      "cancelTournament",
      "createTournament",
      "createtournament",
      "declareTournamentResult",
      "getTournamentRoom",
      "grantBetaCredit",
      "jointournament",
      "onUserCreated",
      "payprize",
      "requestwithdrawal",
      "setTournamentRoom",
      "startTournament",
      "testdeposit",
    ]);
  });

  it("não existe nenhum alias camelCase legado (joinTournament/payPrize/requestWithdrawal)", async () => {
    const fns = await loadFunctions();
    assert.equal(fns.joinTournament, undefined);
    assert.equal(fns.payPrize, undefined);
    assert.equal(fns.requestWithdrawal, undefined);
  });
});
