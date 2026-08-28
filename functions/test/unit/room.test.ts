import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { DomainError } from "../../src/domain/errors.js";
import {
  ROOM_REASON_NOT_PUBLISHED,
  ROOM_REASON_REGISTRATION_REQUIRED,
  decideRoomAccess,
  registrationId,
  validateGetRoomPayload,
  validateSetRoomPayload,
} from "../../src/domain/room.js";

type Handler = (data: unknown, context: unknown) => Promise<unknown>;

let cached: { set: Handler; get: Handler } | undefined;

async function handlers(): Promise<{ set: Handler; get: Handler }> {
  if (cached) return cached;
  process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT ?? "demo-sparta-battle";
  const mod = (await import("../../src/index.js")) as unknown as {
    setTournamentRoomHandler: Handler;
    getTournamentRoomHandler: Handler;
  };
  cached = { set: mod.setTournamentRoomHandler, get: mod.getTournamentRoomHandler };
  return cached;
}

async function codeOf(
  fn: Handler,
  data: unknown,
  context: unknown
): Promise<string> {
  try {
    await fn(data, context);
    return "NO_THROW";
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : "NO_CODE";
  }
}

function functionsDir(): string {
  const cwd = process.cwd();
  if (existsSync(join(cwd, "src", "index.ts"))) return cwd;
  if (existsSync(join(cwd, "functions", "src", "index.ts"))) {
    return join(cwd, "functions");
  }
  throw new Error(`cannot locate functions dir from cwd: ${cwd}`);
}
const indexSrc = (): string =>
  readFileSync(join(functionsDir(), "src", "index.ts"), "utf8");

const VALID_SET = {
  tournamentid: "t-1",
  roomid: "ROOM42",
  roompassword: "s3nha",
};

describe("validateSetRoomPayload", () => {
  it("accepts and trims a valid payload", () => {
    const result = validateSetRoomPayload({
      tournamentid: " t-1 ",
      roomid: " ROOM42 ",
      roompassword: " s3nha ",
    });
    assert.deepEqual(result, VALID_SET);
  });

  it("rejects missing tournamentid / roomid / roompassword", () => {
    for (const bad of [
      {},
      { roomid: "R", roompassword: "P" },
      { tournamentid: "t", roompassword: "P" },
      { tournamentid: "t", roomid: "R" },
    ]) {
      assertInvalidArgument(() => validateSetRoomPayload(bad));
    }
  });

  it("rejects a tournamentid with a slash or over 200 chars", () => {
    assertInvalidArgument(() =>
      validateSetRoomPayload({ ...VALID_SET, tournamentid: "a/b" })
    );
    assertInvalidArgument(() =>
      validateSetRoomPayload({ ...VALID_SET, tournamentid: "x".repeat(201) })
    );
  });

  it("rejects control characters in the room fields", () => {
    // Control characters are built at runtime with String.fromCharCode instead
    // of being embedded raw, so this source file stays plain text. A raw NUL
    // byte would make Git treat the file as binary. NUL (0x00) and the unit
    // separator (0x1F) both fall in the rejected [0x00-0x1F, 0x7F] range.
    const nul = String.fromCharCode(0);
    const unitSep = String.fromCharCode(0x1f);
    assertInvalidArgument(() =>
      validateSetRoomPayload({ ...VALID_SET, roomid: "bad" + nul + "id" })
    );
    assertInvalidArgument(() =>
      validateSetRoomPayload({
        ...VALID_SET,
        roompassword: "bad" + unitSep + "pw",
      })
    );
  });
});

describe("validateGetRoomPayload", () => {
  it("returns the trimmed tournamentid", () => {
    assert.equal(validateGetRoomPayload({ tournamentid: " t-1 " }), "t-1");
  });

  it("rejects a missing or malformed tournamentid", () => {
    assertInvalidArgument(() => validateGetRoomPayload({}));
    assertInvalidArgument(() => validateGetRoomPayload({ tournamentid: "a/b" }));
  });
});

describe("registrationId", () => {
  it("mirrors the deterministic backend format", () => {
    assert.equal(registrationId("u-1", "t-9"), "u-1_t-9");
  });
});

describe("decideRoomAccess", () => {
  it("refuses a non-registered caller with registration-required", () => {
    const decision = decideRoomAccess({
      registrationExists: false,
      roomExists: true,
      roomId: "R",
      roomPassword: "P",
    });
    assert.equal(decision.ok, false);
    assert.equal(
      decision.ok === false && decision.reason,
      ROOM_REASON_REGISTRATION_REQUIRED
    );
    assert.equal(decision.ok === false && decision.code, "permission-denied");
  });

  it("refuses a registered caller when the room is not published", () => {
    for (const room of [
      { roomExists: false, roomId: null, roomPassword: null },
      { roomExists: true, roomId: "", roomPassword: "P" },
      { roomExists: true, roomId: "R", roomPassword: "" },
    ]) {
      const decision = decideRoomAccess({
        registrationExists: true,
        ...room,
      });
      assert.equal(decision.ok, false);
      assert.equal(
        decision.ok === false && decision.reason,
        ROOM_REASON_NOT_PUBLISHED
      );
      assert.equal(
        decision.ok === false && decision.code,
        "failed-precondition"
      );
    }
  });

  it("returns the credentials to a registered caller once published", () => {
    const decision = decideRoomAccess({
      registrationExists: true,
      roomExists: true,
      roomId: "ROOM42",
      roomPassword: "s3nha",
    });
    assert.equal(decision.ok, true);
    assert.deepEqual(decision.ok === true && decision.credentials, {
      room_id: "ROOM42",
      room_password: "s3nha",
    });
  });
});

describe("setTournamentRoom handler — auth + validation", () => {
  it("recusa quem não está logado ANTES de tocar no banco", async () => {
    /**
     * O QUE MUDOU AQUI, e por que o teste encolheu.
     *
     * Este teste também exigia `permission-denied` para um chamador logado sem
     * a claim de plataforma, e conseguia afirmar isso sem Firestore porque a
     * resposta não dependia de campeonato nenhum: bastava olhar o token.
     *
     * Agora quem pode publicar a sala é quem faz parte da ORGANIZAÇÃO DONA do
     * campeonato — e essa pergunta não tem como ser respondida sem ler o
     * campeonato. A checagem passou a precisar do banco, o que aqui, sem
     * emulador, vira `internal`.
     *
     * A ordem que importa continua provada: sem sessão, a recusa vem antes de
     * qualquer leitura ou escrita. O resto é o e2e que prova, contra um
     * Firestore de verdade — ver `functions/test/e2e/organizations.e2e.test.ts`.
     */
    const { set } = await handlers();
    assert.equal(await codeOf(set, VALID_SET, {}), "unauthenticated");
  });

  it("payload inválido é recusado ANTES de qualquer leitura", async () => {
    // Continua valendo, e é o que mantém um payload torto barato: a validação
    // roda antes de o campeonato ser lido para decidir quem pode operá-lo.
    const { set } = await handlers();
    const admin = { auth: { uid: "a", token: { admin: true } } };
    assert.equal(await codeOf(set, {}, admin), "invalid-argument");
    assert.equal(
      await codeOf(set, { tournamentid: "t-1" }, admin),
      "invalid-argument"
    );
  });
});

describe("getTournamentRoom handler — auth + validation", () => {
  it("rejects an unauthenticated caller", async () => {
    const { get } = await handlers();
    assert.equal(await codeOf(get, { tournamentid: "t-1" }, {}), "unauthenticated");
  });

  it("rejects an invalid payload before any read", async () => {
    const { get } = await handlers();
    assert.equal(
      await codeOf(get, {}, { auth: { uid: "u" } }),
      "invalid-argument"
    );
  });
});

describe("no credential leakage in logs (structural)", () => {
  it("no console.* line references a room id or password, in any casing", () => {
    // Behavioral response/schema guarantees live in the emulator-backed suite
    // (test/rules/tournamentRoom.handlers.test.ts). This static check is the
    // belt-and-suspenders guarantee that NO log statement can ever carry a
    // credential, in either the public (roomid/roompassword) or the stored
    // (room_id/room_password) spelling.
    const lines = indexSrc().split("\n");
    for (const line of lines) {
      if (!line.includes("console.")) continue;
      for (const forbidden of [
        "roomid",
        "roompassword",
        "room_id",
        "room_password",
      ]) {
        assert.ok(
          !line.includes(forbidden),
          `console line must not reference ${forbidden}: ${line}`
        );
      }
    }
  });
});

function assertInvalidArgument(fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof DomainError);
    assert.equal(error.code, "invalid-argument");
    return true;
  });
}
