import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_PUBLIC_ID_LENGTH,
  MAX_PUBLIC_NAME_LENGTH,
  PUBLIC_PREVIEW_KEYS,
  isValidPublicId,
  projectPublicPreview,
  sanitizeTournamentName,
} from "../../src/domain/publicTournamentPreview.js";

/**
 * The public projection is the ONLY thing an unauthenticated caller ever sees.
 * Every test here answers one question: can this leave the building?
 *
 * Hostile characters are built with String.fromCharCode and NEVER pasted
 * literally. An invisible character in a fixture is invisible in code review
 * too, so naming each one is the point.
 */
const RLO = String.fromCharCode(0x202e); // RIGHT-TO-LEFT OVERRIDE
const PDF = String.fromCharCode(0x202c); // POP DIRECTIONAL FORMATTING
const LRI = String.fromCharCode(0x2066); // LEFT-TO-RIGHT ISOLATE
const PDI = String.fromCharCode(0x2069); // POP DIRECTIONAL ISOLATE
const ZWSP = String.fromCharCode(0x200b); // ZERO WIDTH SPACE
const ZWJ = String.fromCharCode(0x200d); // ZERO WIDTH JOINER
const BOM = String.fromCharCode(0xfeff); // BYTE ORDER MARK
const ESC = String.fromCharCode(0x1b); // ESCAPE
const DEL = String.fromCharCode(0x7f); // DELETE
const NBSP = String.fromCharCode(0x00a0); // NO-BREAK SPACE
const ELLIPSIS = String.fromCharCode(0x2026);

/** A complete, well-formed tournament document, as Firestore stores it. */
function doc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Copa de Squad",
    game_mode: "squad",
    game_mode_label: "Squad",
    economy_type: "cash",
    // Money is stored in REAIS.
    entry_fee: 10,
    prize: 400,
    status: "open",
    current_participants: 36,
    max_participants: 48,
    current_players: 36,
    max_players: 48,
    starts_at: null,
    ...overrides,
  };
}

describe("isValidPublicId", () => {
  it("accepts a plausible Firestore document id", () => {
    assert.equal(isValidPublicId("aBc123XyZ456"), true);
    assert.equal(isValidPublicId("a".repeat(MAX_PUBLIC_ID_LENGTH)), true);
  });

  it("refuses ids that would change what the URL means", () => {
    for (const bad of [
      "",
      ".",
      "..",
      "a/b",
      "a b",
      "a\tb",
      "a\nb",
      "a" + DEL + "b",
      "a".repeat(MAX_PUBLIC_ID_LENGTH + 1),
    ]) {
      assert.equal(
        isValidPublicId(bad),
        false,
        "should refuse " + JSON.stringify(bad)
      );
    }
  });

  it("refuses non-strings, including a repeated query parameter", () => {
    // `?id=a&id=b` arrives as an array.
    for (const bad of [undefined, null, 42, ["a", "b"], {}]) {
      assert.equal(isValidPublicId(bad), false);
    }
  });
});

describe("sanitizeTournamentName", () => {
  it("keeps ordinary names untouched", () => {
    assert.equal(sanitizeTournamentName("Copa de Squad"), "Copa de Squad");
  });

  it("collapses whitespace so one name cannot occupy a screen", () => {
    assert.equal(
      sanitizeTournamentName("  Copa    de\t\tSquad  "),
      "Copa de Squad"
    );
    assert.equal(sanitizeTournamentName("Copa\n\n\nSquad"), "Copa Squad");
  });

  it("strips bidi overrides that can reverse or hide text", () => {
    assert.equal(
      sanitizeTournamentName("Copa" + RLO + "abusivo" + PDF),
      "Copaabusivo"
    );
    assert.equal(sanitizeTournamentName("A" + LRI + "B" + PDI + "C"), "ABC");
  });

  it("strips zero-width padding used to smuggle content", () => {
    assert.equal(
      sanitizeTournamentName("Co" + ZWSP + "pa" + ZWJ + "Squad" + BOM),
      "CopaSquad"
    );
  });

  it("strips control characters", () => {
    assert.equal(
      sanitizeTournamentName("Copa" + ESC + "[31mSquad" + DEL),
      "Copa[31mSquad"
    );
  });

  it("truncates without leaving a dangling space", () => {
    const long = "A".repeat(MAX_PUBLIC_NAME_LENGTH + 40);
    const clean = sanitizeTournamentName(long);
    assert.ok(clean !== null);
    assert.equal(clean.length, MAX_PUBLIC_NAME_LENGTH + 1); // + ellipsis
    assert.ok(clean.endsWith(ELLIPSIS));
    assert.ok(!clean.endsWith(" " + ELLIPSIS));
  });

  it("returns null when nothing legible survives", () => {
    for (const empty of [
      "",
      "   ",
      ZWSP + ZWSP,
      RLO,
      NBSP,
      42,
      null,
      undefined,
    ]) {
      assert.equal(sanitizeTournamentName(empty), null);
    }
  });
});

describe("projectPublicPreview", () => {
  it("publishes exactly the allowlisted keys, and no others", () => {
    const preview = projectPublicPreview(doc());
    assert.ok(preview !== null);
    assert.deepEqual(
      Object.keys(preview).sort(),
      [...PUBLIC_PREVIEW_KEYS].sort()
    );
  });

  it("converts stored reais into published centavos", () => {
    const preview = projectPublicPreview(doc({ entry_fee: 10, prize: 400.5 }));
    assert.ok(preview !== null);
    assert.equal(preview.entryFeeCentavos, 1000);
    assert.equal(preview.prizeCentavos, 40050);
  });

  it("allows a free tournament but refuses malformed money", () => {
    assert.ok(projectPublicPreview(doc({ entry_fee: 0 })) !== null);
    for (const bad of [-1, Number.NaN, Infinity, "10", null, undefined, {}]) {
      assert.equal(
        projectPublicPreview(doc({ prize: bad })),
        null,
        "prize " + String(bad)
      );
    }
  });

  it("refuses a status it does not recognise", () => {
    for (const status of ["open", "in_progress", "completed", "cancelled"]) {
      assert.ok(projectPublicPreview(doc({ status })) !== null, status);
    }
    // An internal state added later must not leak through a public URL.
    for (const bad of ["settling", "shadow_banned", "", null, 7]) {
      assert.equal(projectPublicPreview(doc({ status: bad })), null);
    }
  });

  it("refuses an unknown economy instead of defaulting to cash", () => {
    assert.ok(
      projectPublicPreview(doc({ economy_type: "beta_credit" })) !== null
    );
    for (const bad of ["CASH", "beta", "", null, undefined]) {
      assert.equal(projectPublicPreview(doc({ economy_type: bad })), null);
    }
  });

  it("refuses a document with no legible name", () => {
    assert.equal(projectPublicPreview(doc({ name: "   " })), null);
    assert.equal(projectPublicPreview(doc({ name: null })), null);
    assert.equal(projectPublicPreview(doc({ name: RLO + ZWSP })), null);
  });

  it("refuses ambiguous participant counts rather than guessing", () => {
    // Contradictory canonical/legacy pair: publishing either number could
    // oversell the tournament or lock players out.
    assert.equal(
      projectPublicPreview(
        doc({ current_participants: 36, current_players: 99 })
      ),
      null
    );
  });

  it("reads a start instant, or reports none", () => {
    assert.equal(projectPublicPreview(doc())!.startsAt, null);

    const date = new Date("2026-09-05T21:00:00.000Z");
    assert.equal(
      projectPublicPreview(doc({ starts_at: date }))!.startsAt,
      "2026-09-05T21:00:00.000Z"
    );

    // Firestore Timestamp shape.
    assert.equal(
      projectPublicPreview(doc({ starts_at: { toDate: () => date } }))!.startsAt,
      "2026-09-05T21:00:00.000Z"
    );

    // Unusable values are reported as "no start", never guessed.
    for (const bad of ["amanha", 123, { toDate: () => new Date(NaN) }]) {
      assert.equal(
        projectPublicPreview(doc({ starts_at: bad }))!.startsAt,
        null
      );
    }
  });

  it("returns null for a missing document", () => {
    assert.equal(projectPublicPreview(null), null);
    assert.equal(projectPublicPreview(undefined), null);
  });

  /**
   * THE REGRESSION THAT MATTERS. A field added to the tournament document later
   * must be invisible here until someone adds it deliberately. This test fails
   * the moment the projection starts spreading the document.
   */
  it("never leaks identity, settlement, credentials or future fields", () => {
    const preview = projectPublicPreview(
      doc({
        creator_uid: "uid-SECRET",
        creator_ref: { path: "users/uid-SECRET" },
        creator_name: "Nome Real Do Criador",
        result: { winner_uid: "uid-WINNER", prize_paid: 400 },
        winner_uid: "uid-WINNER",
        locked_economy_type: "cash",
        room_id: "SALA-123",
        room_password: "senha-secreta",
        registrations: ["uid-a", "uid-b"],
        created_at: new Date(),
        updated_at: new Date(),
        // A field nobody has invented yet.
        future_internal_flag: "NAO-DEVE-VAZAR",
      })
    );
    assert.ok(preview !== null);

    // Structural: only the allowlist survived.
    assert.deepEqual(
      Object.keys(preview).sort(),
      [...PUBLIC_PREVIEW_KEYS].sort()
    );

    // Value-level: no sensitive substring appears anywhere in the response,
    // including nested inside a legitimate field.
    const serialized = JSON.stringify(preview);
    for (const secret of [
      "uid-SECRET",
      "uid-WINNER",
      "Nome Real Do Criador",
      "SALA-123",
      "senha-secreta",
      "NAO-DEVE-VAZAR",
      "locked_economy_type",
      "creator",
      "result",
    ]) {
      assert.ok(
        !serialized.includes(secret),
        "resposta publica vazou " + JSON.stringify(secret)
      );
    }
  });
});
