import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, it } from "node:test";

import * as admin from "firebase-admin";
import { FieldValue, Timestamp } from "firebase-admin/firestore";

import {
  MAX_RANK_SCALAR,
  MIN_RANK_SCALAR,
} from "../../src/domain/seasonLeaderboard.js";

/**
 * EMULATOR ADMIN COMPATIBILITY — the regression guard for the defect that made
 * `npm run test:e2e` unrunnable.
 *
 * ROOT CAUSE. `firebase-tools` hands the loaded functions module a compatibility
 * `admin` object whose `firestore` member is `originalFirestore.bind(admin)`.
 * `Function.prototype.bind` returns a NEW function object and copies none of the
 * target's own properties, so `Timestamp`, `FieldValue` and `FieldPath` — which
 * are statics hanging off the namespace function — vanish. `src/index.ts` built
 * its ranking ordering bounds at MODULE LOAD with
 * `new admin.firestore.Timestamp(...)`, so loading the module inside the emulator
 * threw "admin.firestore.Timestamp is not a constructor" and EVERY callable and
 * trigger failed, not just the ranking ones.
 *
 * WHY DEFERRING WOULD NOT HAVE BEEN ENOUGH. Making the bounds lazy would fix the
 * load, but the very first prize event still walks
 * `admin.firestore.FieldValue.serverTimestamp()` and
 * `admin.firestore.Timestamp.fromDate(...)` inside the trigger — so the crash
 * would simply move from startup to the first real event, which is strictly
 * worse. The fix has to remove the dependency on the namespace statics, not
 * postpone it.
 *
 * The tests below reproduce the stub FAITHFULLY (by the same `bind` the emulator
 * performs) and then load the real module through it.
 */

const REAL_TIMESTAMP = admin.firestore.Timestamp;
const REAL_FIELD_VALUE = admin.firestore.FieldValue;

/** Reproduces exactly what firebase-tools does to the admin namespace. */
function installEmulatorStub(): void {
  const original = admin.firestore;
  Object.defineProperty(admin, "firestore", {
    value: original.bind(admin),
    configurable: true,
    writable: true,
  });
}

let loaded: Record<string, unknown>;

before(async () => {
  process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT ?? "demo-sparta-battle";

  installEmulatorStub();

  // Sanity: the stub must really be lossy, otherwise the tests below prove nothing.
  assert.equal(
    (admin.firestore as unknown as { Timestamp?: unknown }).Timestamp,
    undefined,
    "a simulação do stub falhou: Timestamp ainda está presente"
  );
  assert.equal(
    (admin.firestore as unknown as { FieldValue?: unknown }).FieldValue,
    undefined,
    "a simulação do stub falhou: FieldValue ainda está presente"
  );

  // THE test: importing the real production module under the lossy namespace.
  loaded = (await import("../../src/index.js")) as unknown as Record<string, unknown>;
});

describe("1. o módulo carrega sob o namespace mutilado do emulador", () => {
  it("o import resolve sem lançar", () => {
    assert.ok(loaded, "src/index.ts deve carregar com o stub instalado");
  });

  it("os estáticos continuam ausentes — o carregamento não os restaurou", () => {
    assert.equal(
      (admin.firestore as unknown as { Timestamp?: unknown }).Timestamp,
      undefined
    );
    assert.equal(
      (admin.firestore as unknown as { FieldValue?: unknown }).FieldValue,
      undefined
    );
    assert.equal(
      (admin.firestore as unknown as { FieldPath?: unknown }).FieldPath,
      undefined
    );
  });

  it("a CHAMADA do namespace continua funcionando — só os estáticos se perdem", () => {
    // `admin.firestore()` é o que index.ts usa para obter a instância; o bug
    // nunca foi a chamada, apenas as propriedades penduradas nela.
    assert.equal(typeof admin.firestore, "function");
  });

  it("os exports implantáveis do ranking sobreviveram ao carregamento", () => {
    for (const name of [
      "onPrizeTransactionCreated",
      "onPrizeTransactionCreatedHandler",
      "getSeasonLeaderboard",
      "getMySeasonRanking",
    ]) {
      assert.ok(loaded[name], `export ausente após o carregamento: ${name}`);
    }
  });
});

describe("2. os limites de ordenação são idênticos", () => {
  it("Timestamp modular constrói exatamente o mesmo valor que o do namespace", () => {
    for (const scalar of [MIN_RANK_SCALAR, MAX_RANK_SCALAR]) {
      const modular = new Timestamp(scalar.seconds, scalar.nanoseconds);
      const real = new REAL_TIMESTAMP(scalar.seconds, scalar.nanoseconds);

      assert.equal(modular.seconds, real.seconds);
      assert.equal(modular.nanoseconds, real.nanoseconds);
      assert.equal(modular.toMillis(), real.toMillis());
      assert.equal(modular.isEqual(real), true, "devem ser iguais para o Firestore");
    }
  });

  it("os limites preservam os escalares de domínio, sem arredondar", () => {
    const min = new Timestamp(MIN_RANK_SCALAR.seconds, MIN_RANK_SCALAR.nanoseconds);
    const max = new Timestamp(MAX_RANK_SCALAR.seconds, MAX_RANK_SCALAR.nanoseconds);

    assert.equal(min.seconds, MIN_RANK_SCALAR.seconds);
    assert.equal(min.nanoseconds, MIN_RANK_SCALAR.nanoseconds);
    assert.equal(max.seconds, MAX_RANK_SCALAR.seconds);
    assert.equal(max.nanoseconds, MAX_RANK_SCALAR.nanoseconds);
  });

  it("MIN continua estritamente antes de MAX — a janela não inverteu", () => {
    const min = new Timestamp(MIN_RANK_SCALAR.seconds, MIN_RANK_SCALAR.nanoseconds);
    const max = new Timestamp(MAX_RANK_SCALAR.seconds, MAX_RANK_SCALAR.nanoseconds);
    assert.ok(min.toMillis() < max.toMillis(), "MIN deve preceder MAX");
  });
});

describe("3. Timestamp e FieldValue são obteníveis sem os estáticos", () => {
  it("o construtor modular funciona com o namespace mutilado", () => {
    const ts = new Timestamp(123, 456);
    assert.equal(ts.seconds, 123);
    assert.equal(ts.nanoseconds, 456);
  });

  it("fromDate funciona com o namespace mutilado", () => {
    const date = new Date("2026-09-04T18:22:11.000Z");
    const ts = Timestamp.fromDate(date);
    assert.equal(ts.toMillis(), date.getTime());
    // E produz o mesmo valor que o caminho antigo produziria.
    assert.equal(ts.isEqual(REAL_TIMESTAMP.fromDate(date)), true);
  });

  it("serverTimestamp funciona com o namespace mutilado", () => {
    const sentinel = FieldValue.serverTimestamp();
    assert.ok(sentinel, "serverTimestamp deve produzir um sentinel");
    assert.equal(
      sentinel.isEqual(REAL_FIELD_VALUE.serverTimestamp()),
      true,
      "deve ser o mesmo sentinel de antes"
    );
  });
});

// ---------------------------------------------------------------------------
// 4 e 5 — auditoria de fonte
// ---------------------------------------------------------------------------

function srcIndex(): string {
  const cwd = process.cwd();
  for (const candidate of [
    join(cwd, "src", "index.ts"),
    join(cwd, "functions", "src", "index.ts"),
    join(cwd, "..", "src", "index.ts"),
  ]) {
    if (existsSync(candidate)) return readFileSync(candidate, "utf8");
  }
  throw new Error(`cannot locate src/index.ts from cwd: ${cwd}`);
}

describe("4. não restam acessos incompatíveis", () => {
  const source = srcIndex();

  it("nenhum estático do namespace é lido em src/index.ts", () => {
    // Um estático é `admin.firestore.` seguido de Maiúscula. A CHAMADA
    // `admin.firestore()` é permitida e deliberadamente não casa aqui.
    const offenders = [...source.matchAll(/admin\.firestore\.[A-Z]\w*/g)].map(
      (m) => m[0]
    );
    assert.deepEqual(
      offenders,
      [],
      `estáticos incompatíveis remanescentes: ${offenders.join(", ")}`
    );
  });

  it("os nomes vêm do pacote modular", () => {
    assert.ok(
      /from "firebase-admin\/firestore"/.test(source),
      "index.ts deve importar de firebase-admin/firestore"
    );
    for (const name of ["FieldPath", "FieldValue", "Timestamp"]) {
      assert.ok(
        new RegExp(`\\b${name}\\b`).test(source),
        `${name} deve estar importado`
      );
    }
  });

  it("a instância ainda é obtida por admin.firestore()", () => {
    assert.ok(
      /const db = admin\.firestore\(\);/.test(source),
      "a obtenção da instância não deve ter mudado"
    );
  });
});

describe("5. o contrato não mudou", () => {
  const source = srcIndex();

  it("o trigger mantém caminho, tipo de evento e região", () => {
    assert.ok(
      /export const onPrizeTransactionCreated = central\.firestore\s*\n?\s*\.document\("transactions\/\{transactionId\}"\)\s*\n?\s*\.onCreate\(/.test(
        source
      ),
      "o binding do trigger deve permanecer idêntico"
    );
  });

  it("a ordenação canônica das entries permanece a mesma tupla", () => {
    assert.ok(
      /\.orderBy\("scoreOrder", "desc"\)\s*\n?\s*\.orderBy\("winsOrder", "desc"\)\s*\n?\s*\.orderBy\(FieldPath\.documentId\(\), "asc"\)/.test(
        source
      ),
      "scoreOrder desc, winsOrder desc, __name__ asc"
    );
  });

  it("os campos de ordenação escritos continuam scoreOrder e winsOrder", () => {
    assert.ok(/scoreOrder/.test(source) && /winsOrder/.test(source));
  });

  it("os nomes dos callables e do trigger não mudaram", () => {
    for (const decl of [
      "export const onPrizeTransactionCreated",
      "export const getSeasonLeaderboard",
      "export const getMySeasonRanking",
      "export const declareTournamentResult",
      "export const payprize",
      "export const testdeposit",
    ]) {
      assert.ok(source.includes(decl), `declaração ausente: ${decl}`);
    }
  });
});
