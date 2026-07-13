import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  assertAdmin,
  assertSignedIn,
  hasAdminClaim,
  isAdmin,
  isLegacyAdmin,
  LEGACY_ADMIN_UID,
} from "../../src/domain/adminAuth.js";
import { DomainError } from "../../src/domain/errors.js";

const UNAUTH = "Você precisa estar logado.";
const DENIED = "Você não tem permissão.";

function assertCode(fn: () => unknown, code: string, message: string): void {
  assert.throws(
    fn,
    (error: unknown) => {
      assert.ok(error instanceof DomainError, `${message}: not a DomainError`);
      assert.equal(error.code, code, `${message}: wrong code`);
      return true;
    },
    message
  );
}

describe("assertAdmin", () => {
  it("rejects a signed-out request as unauthenticated", () => {
    assertCode(
      () => assertAdmin({}, UNAUTH, DENIED),
      "unauthenticated",
      "no auth"
    );
    assertCode(
      () => assertAdmin({ auth: null }, UNAUTH, DENIED),
      "unauthenticated",
      "null auth"
    );
  });

  it("rejects a normal authenticated user as permission-denied", () => {
    assertCode(
      () => assertAdmin({ auth: { uid: "player-1" } }, UNAUTH, DENIED),
      "permission-denied",
      "normal user"
    );
  });

  it("accepts an administrator holding the custom claim", () => {
    const auth = { uid: "someone-else", token: { admin: true } };
    const result = assertAdmin({ auth }, UNAUTH, DENIED);
    assert.equal(result.uid, "someone-else");
  });

  it("accepts the legacy administrator during the transition", () => {
    // This fallback is what keeps the existing admin from being locked out.
    // It must be removed only after docs/admin-transition.md stage 2.
    const auth = { uid: LEGACY_ADMIN_UID };
    const result = assertAdmin({ auth }, UNAUTH, DENIED);
    assert.equal(result.uid, LEGACY_ADMIN_UID);
  });
});

describe("admin claim strictness", () => {
  it("requires the claim to be exactly boolean true", () => {
    // A truthy value must NOT be enough — "false" and 1 are both truthy.
    assert.equal(hasAdminClaim({ uid: "u", token: { admin: "true" } }), false);
    assert.equal(hasAdminClaim({ uid: "u", token: { admin: "false" } }), false);
    assert.equal(hasAdminClaim({ uid: "u", token: { admin: 1 } }), false);
    assert.equal(hasAdminClaim({ uid: "u", token: {} }), false);
    assert.equal(hasAdminClaim({ uid: "u" }), false);

    assert.equal(hasAdminClaim({ uid: "u", token: { admin: true } }), true);
  });

  it("identifies the legacy admin by uid only", () => {
    assert.equal(isLegacyAdmin({ uid: LEGACY_ADMIN_UID }), true);
    assert.equal(isLegacyAdmin({ uid: "player-1" }), false);
  });

  it("grants admin via either route", () => {
    assert.equal(isAdmin({ uid: LEGACY_ADMIN_UID }), true);
    assert.equal(isAdmin({ uid: "x", token: { admin: true } }), true);
    assert.equal(isAdmin({ uid: "x" }), false);
  });
});

describe("assertSignedIn", () => {
  it("rejects a signed-out request", () => {
    assertCode(() => assertSignedIn({}, UNAUTH), "unauthenticated", "no auth");
  });

  it("accepts any authenticated user", () => {
    const result = assertSignedIn({ auth: { uid: "player-1" } }, UNAUTH);
    assert.equal(result.uid, "player-1");
  });
});
