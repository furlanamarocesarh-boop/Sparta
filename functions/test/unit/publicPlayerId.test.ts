import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PUBLIC_PLAYER_ID_COLLECTION,
  PUBLIC_PLAYER_ID_ENTROPY_BYTES,
  PUBLIC_PLAYER_ID_INDEX_COLLECTION,
  PUBLIC_PLAYER_ID_LENGTH,
  PUBLIC_PLAYER_LABEL_PREFIX,
  PUBLIC_PLAYER_LABEL_VISIBLE_CHARS,
  assertPublicPlayerId,
  encodePublicPlayerId,
  isPublicPlayerId,
  publicPlayerLabel,
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
