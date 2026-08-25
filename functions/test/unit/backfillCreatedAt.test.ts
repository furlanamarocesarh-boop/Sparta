import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  APPLY_FLAG,
  CONFIRMATION_FLAG,
  CONFIRMATION_PHRASE,
  CONFIRM_FLAG,
  decide,
  FORBIDDEN_TARGET_FLAGS,
  parseArgs,
  PRODUCTION_PROJECT_ID,
} from "../../src/backfill/guard.js";
import {
  AccountState,
  decideBackfill,
  EARLIEST_PLAUSIBLE,
  emptyTally,
  renderReport,
  tally,
} from "../../src/backfill/plan.js";

const NOW = new Date(Date.UTC(2026, 7, 24, 12, 0, 0));
const REAL_SIGNUP = "2026-02-11T09:14:22.000Z";

function account(overrides: Partial<AccountState> = {}): AccountState {
  return {
    authCreationTime: REAL_SIGNUP,
    userDocumentExists: true,
    storedCreatedAt: undefined,
    ...overrides,
  };
}

describe("o que o backfill grava", () => {
  it("transcreve o instante do Auth, sem alterar nada", () => {
    // É transcrição, não inferência: `creationTime` guarda exatamente o fato
    // que `created_at` deveria guardar.
    const plan = decideBackfill(account(), NOW);
    assert.equal(plan.kind, "write");
    assert.equal(
      (plan as { value: Date }).value.toISOString(),
      REAL_SIGNUP
    );
  });

  it("aceita o formato RFC que o Auth costuma devolver", () => {
    const plan = decideBackfill(
      account({ authCreationTime: "Wed, 11 Feb 2026 09:14:22 GMT" }),
      NOW
    );
    assert.equal(plan.kind, "write");
  });
});

describe("o que o backfill NUNCA faz", () => {
  it("não toca numa conta que já tem data", () => {
    // A garantia central. Contas criadas de hoje em diante têm o carimbo do
    // servidor, mais preciso do que qualquer coisa reconstruída aqui.
    const plan = decideBackfill(
      account({ storedCreatedAt: new Date(Date.UTC(2026, 0, 2)) }),
      NOW
    );
    assert.deepEqual(plan, { kind: "skip", reason: "already-set" });
  });

  it("reconhece um Timestamp do Firestore como data já gravada", () => {
    // Sem isto, o campo real de produção pareceria ausente e seria reescrito.
    const stamp = { toDate: () => new Date(Date.UTC(2026, 0, 2)) };
    const plan = decideBackfill(account({ storedCreatedAt: stamp }), NOW);
    assert.deepEqual(plan, { kind: "skip", reason: "already-set" });
  });

  it("recusa em vez de sobrescrever um valor gravado que não é data", () => {
    // Sobrescrever destruiria o que quer que aquilo fosse. Este comando só
    // PREENCHE, então ele relata e segue.
    for (const junk of ["2026-02-11", 42, {}, []]) {
      const plan = decideBackfill(account({ storedCreatedAt: junk }), NOW);
      assert.deepEqual(
        plan,
        { kind: "refuse", reason: "stored-value-not-a-date" },
        String(junk)
      );
    }
  });

  it("não cria documento de usuário a partir de uma conta do Auth", () => {
    // Fabricar um registro de conta é outra operação, e não é esta.
    const plan = decideBackfill(account({ userDocumentExists: false }), NOW);
    assert.deepEqual(plan, { kind: "skip", reason: "no-user-document" });
  });

  it("nem olha o Auth quando a data já existe", () => {
    // Assim uma conta saudável nunca é recusada por um problema do Auth que
    // não a afeta — e a segunda execução é no-op aconteça o que acontecer.
    const plan = decideBackfill(
      account({
        authCreationTime: "lixo",
        storedCreatedAt: new Date(Date.UTC(2026, 0, 2)),
      }),
      NOW
    );
    assert.deepEqual(plan, { kind: "skip", reason: "already-set" });
  });
});

describe("datas que não podem virar um perfil público", () => {
  it("recusa data ausente ou impossível de ler", () => {
    for (const bad of [undefined, null, "", "   ", 42, "não é data"]) {
      const plan = decideBackfill(account({ authCreationTime: bad }), NOW);
      assert.deepEqual(
        plan,
        { kind: "refuse", reason: "unusable-auth-time" },
        String(bad)
      );
    }
  });

  it("recusa a época, que renderizaria 'Desde janeiro de 1970'", () => {
    const plan = decideBackfill(
      account({ authCreationTime: new Date(0).toISOString() }),
      NOW
    );
    assert.deepEqual(plan, { kind: "refuse", reason: "unusable-auth-time" });
    assert.ok(EARLIEST_PLAUSIBLE > 0);
  });

  it("recusa data futura em vez de aparar", () => {
    // Aparar publicaria um palpite; recusar deixa a linha ausente, que é a
    // resposta honesta.
    const future = new Date(NOW.getTime() + 86_400_000).toISOString();
    const plan = decideBackfill(account({ authCreationTime: future }), NOW);
    assert.deepEqual(plan, { kind: "refuse", reason: "unusable-auth-time" });
  });
});

describe("o relatório", () => {
  it("conta cada desfecho e não imprime conta nenhuma", () => {
    const t = emptyTally();
    tally(t, decideBackfill(account(), NOW));
    tally(t, decideBackfill(account(), NOW));
    tally(t, decideBackfill(account({ storedCreatedAt: NOW }), NOW));
    tally(t, decideBackfill(account({ userDocumentExists: false }), NOW));
    tally(t, decideBackfill(account({ authCreationTime: null }), NOW));

    assert.equal(t.scanned, 5);
    assert.equal(t.written, 2);
    assert.equal(t.alreadySet, 1);
    assert.equal(t.noUserDocument, 1);
    assert.equal(t.unusableAuthTime, 1);

    const report = renderReport(t, false);
    assert.match(report, /DRY-RUN/);
    // Anonimato: nada que identifique uma conta pode sair.
    for (const leak of ["@", "uid", REAL_SIGNUP]) {
      assert.equal(report.includes(leak), false, leak);
    }
  });
});

describe("o guarda, antes de qualquer credencial", () => {
  const ok = [`--project`, PRODUCTION_PROJECT_ID];

  it("dry-run é o padrão com o projeto certo", () => {
    assert.deepEqual(decide(parseArgs(ok)), { allowed: true, mode: "dry-run" });
  });

  it("nunca cai no projeto do .firebaserc", () => {
    assert.equal(decide(parseArgs([])).allowed, false);
    assert.equal(
      decide(parseArgs(["--project", "outro-projeto"])).allowed,
      false
    );
  });

  it("recusa qualquer argumento que escolheria alvo ou data", () => {
    // Um backfill que aponta para uma conta é um editor de documento com nome
    // de migração — e todo o argumento de segurança deixa de valer.
    for (const flag of FORBIDDEN_TARGET_FLAGS) {
      const d = decide(parseArgs([...ok, flag, "qualquer-coisa"]));
      assert.equal(d.allowed, false, flag);
      assert.equal((d as { reason: string }).reason, "forbidden-target-arg");
    }
  });

  it("o VALOR de um argumento proibido nunca é capturado", () => {
    const parsed = parseArgs([...ok, "--uid", "uid-secreto-123"]);
    assert.equal(parsed.forbiddenFlag, "--uid");
    assert.equal(JSON.stringify(parsed).includes("uid-secreto-123"), false);
  });

  it("--apply sozinho não escreve", () => {
    const d = decide(parseArgs([...ok, APPLY_FLAG]));
    assert.equal(d.allowed, false);
    assert.equal(
      (d as { reason: string }).reason,
      "apply-missing-confirm-flag"
    );
  });

  it("--apply exige TODAS as confirmações ao mesmo tempo", () => {
    const semFrase = decide(parseArgs([...ok, APPLY_FLAG, CONFIRM_FLAG]));
    assert.equal((semFrase as { reason: string }).reason, "apply-missing-confirmation");

    const fraseErrada = decide(
      parseArgs([...ok, APPLY_FLAG, CONFIRM_FLAG, CONFIRMATION_FLAG, "SIM"])
    );
    assert.equal((fraseErrada as { reason: string }).reason, "apply-wrong-confirmation");
  });

  it("com tudo, e só com tudo, chega em apply", () => {
    const d = decide(
      parseArgs([
        ...ok,
        APPLY_FLAG,
        CONFIRM_FLAG,
        CONFIRMATION_FLAG,
        CONFIRMATION_PHRASE,
      ])
    );
    assert.deepEqual(d, { allowed: true, mode: "apply" });
  });

  it("recusa quando sobrou um host de emulador no ambiente", () => {
    // Não é risco de estragar produção — é risco de um no-op parecer sucesso:
    // varreria um emulador vazio, relataria "0 a gravar", e o operador acharia
    // que produção estava feita.
    for (const env of [
      { firestoreEmulatorHost: "127.0.0.1:8080" },
      { authEmulatorHost: "127.0.0.1:9099" },
    ]) {
      const d = decide(parseArgs(ok), env);
      assert.equal(d.allowed, false, JSON.stringify(env));
      assert.equal((d as { reason: string }).reason, "emulator-host-set");
    }
  });

  it("um ambiente limpo passa", () => {
    assert.equal(decide(parseArgs(ok), {}).allowed, true);
    assert.equal(
      decide(parseArgs(ok), { firestoreEmulatorHost: "" }).allowed,
      true
    );
  });

  it("aceita a forma --flag=valor tanto quanto a separada", () => {
    const d = decide(
      parseArgs([
        `--project=${PRODUCTION_PROJECT_ID}`,
        APPLY_FLAG,
        CONFIRM_FLAG,
        `${CONFIRMATION_FLAG}=${CONFIRMATION_PHRASE}`,
      ])
    );
    assert.deepEqual(d, { allowed: true, mode: "apply" });
  });
});
