import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEMO_PROJECT_PREFIX,
  DEMO_PROJECT_REFUSED_MESSAGE,
  assertDemoProject,
  decideDemoProject,
} from "../../src/domain/demoProject.js";

/**
 * Pure rules of the demo-project gate — the environment half of authorizing
 * `testdeposit`. No Admin SDK, no environment read: the candidates are supplied,
 * which is what makes every branch deterministic.
 *
 * The contract under test is fail-closed: the gate opens for exactly one shape
 * of input (present, unanimous, `demo-` prefixed) and refuses everything else,
 * including "I cannot tell" — because a process that cannot name its own project
 * cannot promise which database it is about to write to.
 */

const REAL = "sparta-battle";
const DEMO = "demo-sparta-battle";

describe("decideDemoProject — o caminho autorizado", () => {
  it("libera um único candidato demo", () => {
    assert.deepEqual(decideDemoProject([DEMO]), {
      kind: "allowed",
      projectId: DEMO,
    });
  });

  it("libera candidatos repetidos e concordantes, ignorando ausentes", () => {
    assert.deepEqual(decideDemoProject([DEMO, undefined, DEMO, null]), {
      kind: "allowed",
      projectId: DEMO,
    });
  });

  it("normaliza espaços em volta antes de comparar", () => {
    assert.deepEqual(decideDemoProject([` ${DEMO} `, DEMO]), {
      kind: "allowed",
      projectId: DEMO,
    });
  });

  it("aceita qualquer projeto demo, não apenas o desta suíte", () => {
    for (const id of [
      "demo-sparta-battle-room-handlers",
      "demo-outro",
      "demo-x",
    ]) {
      assert.deepEqual(decideDemoProject([id]), { kind: "allowed", projectId: id });
    }
  });
});

describe("decideDemoProject — ausência é recusa", () => {
  it("recusa a lista vazia", () => {
    assert.deepEqual(decideDemoProject([]), { kind: "refused", reason: "absent" });
  });

  it("recusa quando nenhum candidato é utilizável", () => {
    for (const candidates of [
      [undefined],
      [null],
      [""],
      ["   "],
      [undefined, null, "", "  "],
    ]) {
      assert.deepEqual(
        decideDemoProject(candidates),
        { kind: "refused", reason: "absent" },
        JSON.stringify(candidates)
      );
    }
  });

  it("recusa candidatos que não são string, sem coerção", () => {
    for (const bad of [0, 1, true, false, {}, [], NaN]) {
      assert.deepEqual(
        decideDemoProject([bad]),
        { kind: "refused", reason: "absent" },
        String(bad)
      );
    }
  });
});

describe("decideDemoProject — ambiguidade é recusa", () => {
  it("recusa dois demos diferentes: não há como eleger um vencedor", () => {
    assert.deepEqual(decideDemoProject([DEMO, "demo-outro"]), {
      kind: "refused",
      reason: "ambiguous",
    });
  });

  it("recusa demo misturado com o projeto real, em qualquer ordem", () => {
    assert.deepEqual(decideDemoProject([DEMO, REAL]), {
      kind: "refused",
      reason: "ambiguous",
    });
    assert.deepEqual(decideDemoProject([REAL, DEMO]), {
      kind: "refused",
      reason: "ambiguous",
    });
  });

  it("a ambiguidade vence sobre o prefixo — um demo presente não autoriza", () => {
    // A propriedade crítica: basta UM discordante para fechar o portão.
    const decision = decideDemoProject([DEMO, DEMO, DEMO, REAL]);
    assert.equal(decision.kind, "refused");
  });
});

describe("decideDemoProject — produção é recusa", () => {
  it("recusa o projeto real", () => {
    assert.deepEqual(decideDemoProject([REAL]), {
      kind: "refused",
      reason: "not-demo",
    });
  });

  it("recusa nomes que apenas se parecem com demo", () => {
    for (const id of [
      "sparta-battle",
      "sparta-demo",
      "demo",
      "demo-", // prefixo degenerado: não nomeia projeto algum
      "Demo-sparta-battle", // o prefixo é sensível a caixa
      "xdemo-sparta-battle",
      " demo",
    ]) {
      assert.deepEqual(
        decideDemoProject([id]),
        { kind: "refused", reason: "not-demo" },
        id
      );
    }
  });

  it("o prefixo exigido é exatamente demo-", () => {
    assert.equal(DEMO_PROJECT_PREFIX, "demo-");
  });
});

describe("assertDemoProject", () => {
  it("devolve o projeto quando autorizado", () => {
    assert.equal(assertDemoProject([DEMO]), DEMO);
  });

  it("lança failed-precondition em toda recusa", () => {
    for (const candidates of [[REAL], [], [DEMO, REAL], [undefined]]) {
      assert.throws(
        () => assertDemoProject(candidates),
        (error: any) => {
          assert.equal(error.code, "failed-precondition");
          return true;
        },
        JSON.stringify(candidates)
      );
    }
  });

  it("a mensagem é curada, constante e não revela nada", () => {
    const messages = new Set<string>();
    for (const candidates of [[REAL], [], [DEMO, REAL], [undefined], ["demo-"]]) {
      try {
        assertDemoProject(candidates);
        assert.fail(`deveria recusar: ${JSON.stringify(candidates)}`);
      } catch (error: any) {
        messages.add(error.message);
      }
    }

    // Um único texto para os três motivos: de fora, produção e ambiente
    // malconfigurado são indistinguíveis.
    assert.deepEqual([...messages], [DEMO_PROJECT_REFUSED_MESSAGE]);

    const only = [...messages][0];
    assert.ok(!only.includes(REAL), "a mensagem não pode citar o projeto real");
    assert.ok(!only.includes("demo"), "a mensagem não pode citar o prefixo");
    assert.ok(
      !/PROJECT|env|config/i.test(only),
      "a mensagem não pode citar variáveis de ambiente ou configuração"
    );
  });
});
