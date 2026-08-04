import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  PUBLIC_PLAYER_ID_COLLECTION,
  PUBLIC_PLAYER_ID_ENTROPY_BYTES,
  PUBLIC_PLAYER_ID_INDEX_COLLECTION,
  PUBLIC_PLAYER_ID_LENGTH,
  PUBLIC_PLAYER_ID_MAX_RESERVATION_ATTEMPTS,
  PUBLIC_PLAYER_LABEL_PREFIX,
  PUBLIC_PLAYER_LABEL_VISIBLE_CHARS,
  assertPublicPlayerId,
  decidePublicPlayerIdReservation,
  encodePublicPlayerId,
  isPublicPlayerId,
  normalizeIdentityUid,
  publicPlayerLabel,
  type PublicPlayerIdReservationState,
} from "../../src/domain/publicPlayerId.js";

/** The sample identity of design section 5.5. */
const SAMPLE_ID = "A7fQ2_kB9xLm3NpQr5TzUw";

/** Asserts the thrown value is a DomainError with the expected code. */
function assertDomainCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.equal((error as { code?: string }).code, code);
    return true;
  });
}

/** `count` bytes all holding `value`. */
function bytes(count: number, value = 0): Uint8Array {
  return Uint8Array.from(new Array<number>(count).fill(value));
}

describe("constantes congeladas da identidade pública", () => {
  it("fixa 16 bytes de entropia e 22 caracteres", () => {
    assert.equal(PUBLIC_PLAYER_ID_ENTROPY_BYTES, 16);
    assert.equal(PUBLIC_PLAYER_ID_LENGTH, 22);
  });

  it("o tamanho é consequência da entropia, não uma escolha independente", () => {
    // 16 bytes em base64url sem padding são exatamente 22 caracteres. Se um dia
    // a entropia mudar sem o tamanho, esta asserção quebra em vez de deixar
    // passar um id com metade da entropia prometida pelo contrato.
    const encoded = Buffer.from(bytes(PUBLIC_PLAYER_ID_ENTROPY_BYTES)).toString(
      "base64url"
    );
    assert.equal(encoded.length, PUBLIC_PLAYER_ID_LENGTH);
  });

  it("usa os nomes de coleção congelados, que não colidem com nada existente", () => {
    assert.equal(PUBLIC_PLAYER_ID_COLLECTION, "public_player_ids");
    assert.equal(PUBLIC_PLAYER_ID_INDEX_COLLECTION, "public_player_id_index");
    assert.notEqual(PUBLIC_PLAYER_ID_COLLECTION, PUBLIC_PLAYER_ID_INDEX_COLLECTION);
  });

  it("fixa o rótulo do MVP como `Jogador ` mais oito caracteres", () => {
    assert.equal(PUBLIC_PLAYER_LABEL_PREFIX, "Jogador ");
    assert.equal(PUBLIC_PLAYER_LABEL_VISIBLE_CHARS, 8);
  });
});

describe("encodePublicPlayerId — formato e entropia", () => {
  it("16 bytes zerados produzem 22 caracteres do alfabeto congelado", () => {
    const encoded = encodePublicPlayerId(bytes(16));

    assert.equal(encoded.length, PUBLIC_PLAYER_ID_LENGTH);
    assert.match(encoded, /^[A-Za-z0-9_-]{22}$/);
  });

  it("16 bytes em 0xFF também produzem 22 caracteres válidos", () => {
    const encoded = encodePublicPlayerId(bytes(16, 0xff));

    assert.equal(encoded.length, PUBLIC_PLAYER_ID_LENGTH);
    assert.match(encoded, /^[A-Za-z0-9_-]{22}$/);
  });

  it("nunca emite `+`, `/` ou `=` — base64 padrão não é url-safe", () => {
    for (const value of [0x00, 0x3f, 0x7f, 0xbf, 0xfb, 0xff]) {
      const encoded = encodePublicPlayerId(bytes(16, value));

      assert.ok(!encoded.includes("+"), `emitiu + para 0x${value.toString(16)}`);
      assert.ok(!encoded.includes("/"), `emitiu / para 0x${value.toString(16)}`);
      assert.ok(!encoded.includes("="), `emitiu = para 0x${value.toString(16)}`);
    }
  });

  it("usa de fato os dois caracteres url-safe `-` e `_`", () => {
    // 0xFB seguido de 0xFF produz os sextetos 62 e 63, que são exatamente os
    // dois pontos em que base64url difere do base64 padrão.
    const source = bytes(16);
    source[0] = 0xfb;
    source[1] = 0xff;

    const encoded = encodePublicPlayerId(source);

    assert.ok(encoded.includes("-"), `esperava '-' em ${encoded}`);
    assert.ok(encoded.includes("_"), `esperava '_' em ${encoded}`);
  });

  it("é o base64 padrão traduzido para o alfabeto url-safe, sem padding", () => {
    const source = bytes(16);
    for (let i = 0; i < source.length; i += 1) source[i] = i * 17;

    // Oráculo independente: base64 padrão, padding removido, `+`/`/` traduzidos.
    const expected = Buffer.from(source)
      .toString("base64")
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");

    assert.equal(encodePublicPlayerId(source), expected);
  });

  it("rejeita qualquer contagem de bytes diferente de 16", () => {
    for (const count of [0, 8, 15, 17, 32]) {
      assertDomainCode(() => encodePublicPlayerId(bytes(count)), "invalid-argument");
    }
  });

  it("rejeita pela ENTROPIA, não apenas pelo tamanho do texto resultante", () => {
    // A contagem de bytes é barrada na entrada, com mensagem própria. Sem essa
    // guarda a rejeição ainda aconteceria por acidente — o cheque defensivo de
    // saída recusaria o texto de tamanho errado — e um dia em que o formato
    // mudasse, bytes com metade da entropia passariam silenciosamente.
    assert.throws(
      () => encodePublicPlayerId(bytes(8)),
      (error: unknown) => {
        const message = (error as Error).message;
        assert.ok(
          message.includes(`${PUBLIC_PLAYER_ID_ENTROPY_BYTES} bytes`),
          `mensagem "${message}" deveria citar a entropia exigida`
        );
        return true;
      }
    );
  });

  it("rejeita entradas que não são bytes", () => {
    for (const value of [undefined, null, "16 bytes", 16, [0, 1, 2], {}]) {
      assertDomainCode(
        () => encodePublicPlayerId(value as unknown as Uint8Array),
        "invalid-argument"
      );
    }
  });
});

describe("encodePublicPlayerId — não derivação da conta", () => {
  it("recebe os bytes e nada mais — não há uid, e-mail ou nome na assinatura", () => {
    // A aridade é a asserção: um id derivado de qualquer dado da conta exigiria
    // um segundo parâmetro. Sem ele, derivar é estruturalmente impossível.
    assert.equal(encodePublicPlayerId.length, 1);
  });

  it("os mesmos bytes produzem sempre o mesmo id", () => {
    const source = bytes(16, 0x2a);

    assert.equal(encodePublicPlayerId(source), encodePublicPlayerId(source));
  });

  it("um único bit diferente produz um id diferente", () => {
    const a = bytes(16, 0x2a);
    const b = bytes(16, 0x2a);
    b[15] = 0x2b;

    assert.notEqual(encodePublicPlayerId(a), encodePublicPlayerId(b));
  });
});

describe("validação do formato", () => {
  it("aceita o identificador de exemplo do contrato", () => {
    assert.equal(SAMPLE_ID.length, PUBLIC_PLAYER_ID_LENGTH);
    assert.equal(isPublicPlayerId(SAMPLE_ID), true);
    assert.equal(assertPublicPlayerId(SAMPLE_ID), SAMPLE_ID);
  });

  it("rejeita tamanhos vizinhos ao congelado", () => {
    assert.equal(isPublicPlayerId(SAMPLE_ID.slice(0, 21)), false);
    assert.equal(isPublicPlayerId(`${SAMPLE_ID}x`), false);
    assert.equal(isPublicPlayerId(""), false);
  });

  it("rejeita caracteres fora do alfabeto url-safe", () => {
    for (const bad of [
      "A7fQ2+kB9xLm3NpQr5TzUw",
      "A7fQ2/kB9xLm3NpQr5TzUw",
      "A7fQ2_kB9xLm3NpQr5TzU=",
      "A7fQ2 kB9xLm3NpQr5TzUw",
      "A7fQ2.kB9xLm3NpQr5TzUw",
    ]) {
      assert.equal(isPublicPlayerId(bad), false, bad);
      assertDomainCode(() => assertPublicPlayerId(bad), "invalid-argument");
    }
  });

  it("rejeita valores que nem sequer são texto", () => {
    for (const value of [undefined, null, 22, {}, [SAMPLE_ID]]) {
      assert.equal(isPublicPlayerId(value), false);
      assertDomainCode(() => assertPublicPlayerId(value), "invalid-argument");
    }
  });
});

describe("rótulo visual do MVP", () => {
  it("é `Jogador ` mais os oito primeiros caracteres", () => {
    assert.equal(publicPlayerLabel(SAMPLE_ID), "Jogador A7fQ2_kB");
  });

  it("deriva apenas do próprio id", () => {
    assert.equal(publicPlayerLabel.length, 1);
  });

  it("nunca revela o identificador completo", () => {
    const label = publicPlayerLabel(SAMPLE_ID);

    assert.notEqual(label, SAMPLE_ID);
    assert.ok(!label.includes(SAMPLE_ID));
    assert.equal(
      label.length,
      PUBLIC_PLAYER_LABEL_PREFIX.length + PUBLIC_PLAYER_LABEL_VISIBLE_CHARS
    );
  });

  it("dois ids distintos podem colidir no rótulo sem colidir na identidade", () => {
    // Colisão visual aceita pelo MVP: o rótulo não carrega autoridade nenhuma —
    // ordenação, cursores e getMySeasonRanking usam sempre os 22 caracteres.
    const other = "A7fQ2_kBzzzzzzzzzzzzzz";

    assert.notEqual(other, SAMPLE_ID);
    assert.equal(publicPlayerLabel(other), publicPlayerLabel(SAMPLE_ID));
  });

  it("recusa derivar rótulo de um identificador malformado", () => {
    assertDomainCode(() => publicPlayerLabel("PLR-123456"), "invalid-argument");
    assertDomainCode(
      () => publicPlayerLabel(undefined as unknown as string),
      "invalid-argument"
    );
  });
});

// ---------------------------------------------------------------------------
// Reserva — decisão pura
// ---------------------------------------------------------------------------

const UID = "7N4hobJBzhOaWmWTidTduhlf7Wj1";
const OTHER_UID = "K3pQrS9tUvWxYz01AbCdEfGh2Ij3";

/** Another well-formed identity, distinct from SAMPLE_ID. */
const OTHER_ID = "Zq8Wv2_tR4mYbN7xJc-K1L";

/** Builds a reservation state, overriding only what a case cares about. */
function state(
  overrides: Partial<PublicPlayerIdReservationState> = {}
): PublicPlayerIdReservationState {
  return {
    uid: UID,
    candidate: SAMPLE_ID,
    map: null,
    indexId: SAMPLE_ID,
    index: null,
    ...overrides,
  };
}

describe("normalizeIdentityUid", () => {
  it("aceita e devolve o uid do token, sem espaços em volta", () => {
    assert.equal(normalizeIdentityUid(`  ${UID}  `), UID);
  });

  it("rejeita vazio, barra e comprimento capaz de escapar do caminho", () => {
    assertDomainCode(() => normalizeIdentityUid(""), "invalid-argument");
    assertDomainCode(() => normalizeIdentityUid(null), "invalid-argument");
    assertDomainCode(
      () => normalizeIdentityUid("uid/../wallets/victim"),
      "invalid-argument"
    );
    assertDomainCode(
      () => normalizeIdentityUid("x".repeat(201)),
      "invalid-argument"
    );
  });
});

describe("orçamento de tentativas", () => {
  it("é um inteiro finito, pequeno e maior que uma tentativa", () => {
    // Detalhe interno, não do contrato — mas precisa permitir ao menos uma
    // segunda tentativa, senão uma colisão legítima viraria falha imediata.
    assert.ok(Number.isInteger(PUBLIC_PLAYER_ID_MAX_RESERVATION_ATTEMPTS));
    assert.ok(PUBLIC_PLAYER_ID_MAX_RESERVATION_ATTEMPTS > 1);
    assert.ok(PUBLIC_PLAYER_ID_MAX_RESERVATION_ATTEMPTS <= 10);
  });
});

describe("decisão de reserva — caminhos benignos", () => {
  it("sem mapa e sem índice, reserva o candidato", () => {
    const decision = decidePublicPlayerIdReservation(state());

    assert.deepEqual(decision, { kind: "reserve", publicPlayerId: SAMPLE_ID });
  });

  it("mapa e índice coerentes reutilizam a identidade, sem escrita", () => {
    const decision = decidePublicPlayerIdReservation(
      state({
        // Um candidato novo foi sorteado, mas é irrelevante: a identidade já
        // existe e é imutável.
        candidate: OTHER_ID,
        map: { publicPlayerId: SAMPLE_ID },
        indexId: SAMPLE_ID,
        index: { uid: UID },
      })
    );

    assert.deepEqual(decision, { kind: "reuse", publicPlayerId: SAMPLE_ID });
  });

  it("candidato que pertence legitimamente a outro UID é colisão", () => {
    const decision = decidePublicPlayerIdReservation(
      state({ index: { uid: OTHER_UID } })
    );

    assert.deepEqual(decision, { kind: "collision", candidate: SAMPLE_ID });
  });
});

describe("decisão de reserva — imutabilidade e não-reuso", () => {
  it("com mapa válido, NENHUM candidato consegue produzir uma nova reserva", () => {
    // Imutabilidade: a identidade existente vence sempre. Percorre candidatos
    // distintos para provar que a decisão não depende do sorteio.
    for (let i = 0; i < 16; i += 1) {
      const candidate = encodePublicPlayerId(bytes(16, i * 7));
      const decision = decidePublicPlayerIdReservation(
        state({
          candidate,
          map: { publicPlayerId: SAMPLE_ID },
          indexId: SAMPLE_ID,
          index: { uid: UID },
        })
      );

      assert.equal(decision.kind, "reuse");
      assert.equal(
        (decision as { publicPlayerId: string }).publicPlayerId,
        SAMPLE_ID
      );
    }
  });

  it("um identificador já indexado por outra conta nunca vira reserva", () => {
    // Não-reuso: o índice reverso é permanente, então nenhum sorteio consegue
    // entregar a mesma identidade a uma segunda conta.
    for (const owner of [OTHER_UID, "outro-uid", "z"]) {
      const decision = decidePublicPlayerIdReservation(
        state({ index: { uid: owner } })
      );

      assert.equal(decision.kind, "collision");
    }
  });

  it("colisão devolve o candidato colidido, para que o laço o descarte", () => {
    const decision = decidePublicPlayerIdReservation(
      state({ candidate: OTHER_ID, indexId: OTHER_ID, index: { uid: OTHER_UID } })
    );

    assert.deepEqual(decision, { kind: "collision", candidate: OTHER_ID });
  });
});

describe("decisão de reserva — inconsistências falham fechadas", () => {
  /** Extrai a mensagem de uma decisão que precisa ser `fail`. */
  function failureOf(input: PublicPlayerIdReservationState): string {
    const decision = decidePublicPlayerIdReservation(input);
    assert.equal(decision.kind, "fail", `esperava fail, veio ${decision.kind}`);
    return (decision as { message: string }).message;
  }

  it("mapa malformado não é reparado nem sobrescrito", () => {
    for (const stored of [
      { publicPlayerId: "PLR-123456" },
      { publicPlayerId: "" },
      { publicPlayerId: 42 },
      { publicPlayerId: null },
      {},
    ]) {
      const message = failureOf(
        state({ map: stored, indexId: SAMPLE_ID, index: { uid: UID } })
      );
      assert.match(message, /[Mm]apa/);
    }
  });

  it("mapa existente sem índice reverso falha", () => {
    const message = failureOf(
      state({ map: { publicPlayerId: SAMPLE_ID }, indexId: SAMPLE_ID, index: null })
    );

    assert.match(message, /ausente/);
  });

  it("índice reverso malformado falha, com ou sem mapa", () => {
    for (const stored of [{ uid: "" }, { uid: 7 }, { uid: null }, {}, { uid: "a/b" }]) {
      failureOf(state({ index: stored }));
      failureOf(
        state({ map: { publicPlayerId: SAMPLE_ID }, indexId: SAMPLE_ID, index: stored })
      );
    }
  });

  it("índice do identificador mapeado pertencente a outro UID falha", () => {
    const message = failureOf(
      state({
        map: { publicPlayerId: SAMPLE_ID },
        indexId: SAMPLE_ID,
        index: { uid: OTHER_UID },
      })
    );

    assert.match(message, /outro UID/);
  });

  it("índice órfão apontando para o PRÓPRIO UID falha, em vez de adotar a metade solta", () => {
    // Metade de um par create-only. Criar o mapa agora adotaria uma reserva
    // cuja outra metade nunca foi confirmada.
    const message = failureOf(state({ index: { uid: UID } }));

    assert.match(message, /órfão/);
  });

  it("ler o índice ERRADO é detectado em vez de validar o par trocado", () => {
    // Sem mapa, o índice autoritativo é o do candidato.
    failureOf(state({ indexId: OTHER_ID }));

    // Com mapa, é o do identificador mapeado — nunca o do candidato novo.
    failureOf(
      state({
        candidate: OTHER_ID,
        map: { publicPlayerId: SAMPLE_ID },
        indexId: OTHER_ID,
        index: { uid: UID },
      })
    );
  });

  it("uid ou candidato inválidos falham antes de qualquer decisão de escrita", () => {
    failureOf(state({ uid: "" }));
    failureOf(state({ uid: "uid/escapado" }));
    failureOf(state({ candidate: "PLR-123456", indexId: "PLR-123456" }));
  });

  it("nenhuma inconsistência jamais produz reserve ou reuse", () => {
    const corrupt: PublicPlayerIdReservationState[] = [
      state({ map: { publicPlayerId: "quebrado" } }),
      state({ map: { publicPlayerId: SAMPLE_ID }, indexId: SAMPLE_ID, index: null }),
      state({ index: { uid: UID } }),
      state({
        map: { publicPlayerId: SAMPLE_ID },
        indexId: SAMPLE_ID,
        index: { uid: OTHER_UID },
      }),
      state({ indexId: OTHER_ID }),
    ];

    for (const input of corrupt) {
      const kind = decidePublicPlayerIdReservation(input).kind;
      assert.ok(
        kind !== "reserve" && kind !== "reuse",
        `estado corrompido produziu ${kind}`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Guarda estrutural do handler
// ---------------------------------------------------------------------------

/**
 * O emulador prova o COMPORTAMENTO da reserva, mas não consegue distinguir
 * `transaction.create` de `transaction.set`: dentro de uma transação, a decisão
 * pura já impede escrever sobre um documento existente, e o Firestore aborta e
 * repete quando alguém escreve entre a leitura e o commit. `create` é, portanto,
 * defesa em profundidade — e defesa em profundidade que nenhum teste observa é
 * defesa que alguém remove sem perceber.
 *
 * Esta guarda fecha exatamente essa lacuna, no mesmo estilo estrutural que
 * `payprizeAliasSecure.test.ts` já usa sobre `src/index.ts`.
 */
function srcDir(): string {
  const cwd = process.cwd();
  if (existsSync(join(cwd, "src", "index.ts"))) return join(cwd, "src");
  if (existsSync(join(cwd, "functions", "src", "index.ts"))) {
    return join(cwd, "functions", "src");
  }
  throw new Error(`cannot locate src from cwd: ${cwd}`);
}

// CRLF normalizado: o checkout no Windows grava \r\n e os delimitadores abaixo
// são todos em \n.
const SOURCE = readFileSync(join(srcDir(), "index.ts"), "utf8").replace(
  /\r\n/g,
  "\n"
);

/** Occurrences of a literal needle. */
function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** The source text of the reservation handler, and nothing else. */
function reservationSource(): string {
  const start = SOURCE.indexOf("export const ensurePublicPlayerIdHandler");
  assert.ok(start >= 0, "o handler de reserva precisa existir em index.ts");
  const end = SOURCE.indexOf("\n};\n", start);
  assert.ok(end > start, "não foi possível delimitar o corpo do handler");
  return SOURCE.slice(start, end);
}

describe("guarda estrutural — a reserva é create-only", () => {
  it("escreve exatamente dois documentos, ambos com transaction.create", () => {
    const body = reservationSource();

    assert.equal(
      occurrences(body, "transaction.create("),
      2,
      "o par mapa + índice precisa nascer de duas criações create-only"
    );
  });

  it("não usa nenhuma primitiva capaz de sobrescrever, mesclar ou apagar", () => {
    const body = reservationSource();

    for (const forbidden of [".set(", ".update(", ".delete(", "merge:", "merge :"]) {
      assert.equal(
        occurrences(body, forbidden),
        0,
        `a reserva não pode conter "${forbidden}"`
      );
    }
  });

  it("sorteia a entropia FORA da transação, com os bytes do contrato", () => {
    const body = reservationSource();

    assert.ok(
      body.includes("randomBytes(PUBLIC_PLAYER_ID_ENTROPY_BYTES)"),
      "a entropia precisa vir de randomBytes com os bytes congelados"
    );
    assert.ok(
      body.indexOf("generateEntropy()") < body.indexOf("db.runTransaction"),
      "gerar dentro da transação trocaria o candidato a cada retry interno"
    );
    assert.ok(
      body.includes("encodePublicPlayerId("),
      "a codificação precisa passar pelo encoder ratificado"
    );
    assert.ok(
      body.includes("assertPublicPlayerId("),
      "o candidato precisa ser validado antes de virar id de documento"
    );
  });

  it("não é um endpoint: nenhum metadado de trigger o acompanha", () => {
    for (const line of SOURCE.split("\n")) {
      if (!line.includes("ensurePublicPlayerId")) continue;
      for (const trigger of [
        "onCall",
        "onRequest",
        "onDocument",
        ".region(",
        "central.",
        "east.",
      ]) {
        assert.ok(
          !line.includes(trigger),
          `a reserva não pode virar função implantável: "${line.trim()}"`
        );
      }
    }
  });

  it("não tem call site: esta fase entrega a primitiva, não seu consumidor", () => {
    assert.equal(
      occurrences(SOURCE, "ensurePublicPlayerIdHandler"),
      1,
      "a única ocorrência deve ser a própria declaração"
    );
  });
});
