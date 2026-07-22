import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ADMIN_ACCOUNT_UID } from "../../src/adminclaim/target.js";
import {
  assertAdmin,
  assertSignedIn,
  hasAdminClaim,
  isAdmin,
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

  it("accepts an administrator holding the custom claim, whatever the uid", () => {
    // The uid is irrelevant — only the claim matters. The historical admin uid
    // is accepted here ONLY because it now carries the claim, like any account.
    for (const uid of ["someone-else", ADMIN_ACCOUNT_UID, "another-admin"]) {
      const result = assertAdmin(
        { auth: { uid, token: { admin: true } } },
        UNAUTH,
        DENIED
      );
      assert.equal(result.uid, uid);
    }
  });

  it("rejects the historical admin uid when it does NOT carry the claim", () => {
    // Phase 2: the UID fallback is gone. Without the claim, that uid is an
    // ordinary user and is denied — proving the fallback no longer authorizes.
    assertCode(
      () => assertAdmin({ auth: { uid: ADMIN_ACCOUNT_UID } }, UNAUTH, DENIED),
      "permission-denied",
      "legacy uid without claim"
    );
  });
});

describe("admin claim strictness", () => {
  it("requires the claim to be exactly boolean true", () => {
    // Every truthy-but-not-true, falsy, and missing form must be denied.
    assert.equal(hasAdminClaim({ uid: "u", token: { admin: "true" } }), false);
    assert.equal(hasAdminClaim({ uid: "u", token: { admin: "false" } }), false);
    assert.equal(hasAdminClaim({ uid: "u", token: { admin: 1 } }), false);
    assert.equal(hasAdminClaim({ uid: "u", token: { admin: false } }), false);
    assert.equal(hasAdminClaim({ uid: "u", token: { admin: null } }), false);
    assert.equal(hasAdminClaim({ uid: "u", token: {} }), false);
    assert.equal(hasAdminClaim({ uid: "u" }), false);

    assert.equal(hasAdminClaim({ uid: "u", token: { admin: true } }), true);
  });

  it("grants admin via the claim on ANY account", () => {
    assert.equal(isAdmin({ uid: "x", token: { admin: true } }), true);
    assert.equal(isAdmin({ uid: "player-1", token: { admin: true } }), true);
    assert.equal(
      isAdmin({ uid: ADMIN_ACCOUNT_UID, token: { admin: true } }),
      true
    );
  });

  it("denies admin without the claim, including the historical admin uid", () => {
    // The uid is never consulted: the same uid is admin with the claim and not
    // admin without it.
    assert.equal(isAdmin({ uid: ADMIN_ACCOUNT_UID }), false);
    assert.equal(isAdmin({ uid: "player-1" }), false);
    assert.equal(isAdmin({ uid: "x", token: { admin: "true" } }), false);
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
