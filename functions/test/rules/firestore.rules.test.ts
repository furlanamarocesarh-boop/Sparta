import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  RulesTestEnvironment,
} from "@firebase/rules-unit-testing";

import { LEGACY_ADMIN_UID } from "../../src/domain/adminAuth.js";

/**
 * Firestore security-rules tests, run against the LOCAL emulator.
 *
 * NEVER touches production: the project id is `demo-sparta-battle`. Firebase
 * treats any `demo-*` project id as emulator-only — the SDK refuses to reach a
 * real backend with it, so a misconfigured host cannot silently read or write
 * the live `sparta-battle` project.
 *
 * Requires the Firestore Emulator (which requires a JRE). Run with:
 *   npm run test:rules
 */

const PROJECT_ID = "demo-sparta-battle";

const OWNER = "user-owner";
const OTHER = "user-other";
const CLAIM_ADMIN = "user-claim-admin";

let testEnv: RulesTestEnvironment;

/** A `users/{uid}` DocumentReference path, as the rules compare against. */
const userPath = (uid: string) => `users/${uid}`;

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      // npm scripts run with cwd = functions/, so the rules live one level up.
      rules: readFileSync(resolve(process.cwd(), "..", "firestore.rules"), "utf8"),
    },
  });
});

after(async () => {
  await testEnv?.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();

  // Seeding goes through the rules-disabled context on purpose: production data
  // is never imported, and the seed itself must not depend on the rules under
  // test (otherwise a rules bug would silently break the fixtures).
  await testEnv.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    const ownerRef = db.doc(userPath(OWNER));
    const otherRef = db.doc(userPath(OTHER));

    await ownerRef.set({ email: "owner@example.com", username: "" });
    await otherRef.set({ email: "other@example.com", username: "" });

    await db.doc(`wallets/${OWNER}`).set({ balance: 0, user_ref: ownerRef });
    await db.doc(`wallets/${OTHER}`).set({ balance: 0, user_ref: otherRef });

    await db.doc("transactions/tx-owner").set({ amount: 10, user_ref: ownerRef });
    await db.doc("transactions/tx-other").set({ amount: 10, user_ref: otherRef });

    await db.doc("withdrawals/wd-owner").set({ amount: 10, user_ref: ownerRef });
    await db.doc("withdrawals/wd-other").set({ amount: 10, user_ref: otherRef });

    await db
      .doc(`registrations/${OWNER}_t1`)
      .set({ user_ref: ownerRef, status: "registered" });
    await db
      .doc(`registrations/${OTHER}_t1`)
      .set({ user_ref: otherRef, status: "registered" });

    await db.doc("tournaments/t1").set({
      name: "Copa Sparta",
      status: "open",
      entry_fee: 10,
      current_participants: 0,
      max_participants: 16,
    });

    await db.doc("secretstuff/s1").set({ value: "nope" });
  });
});

const signedOut = () => testEnv.unauthenticatedContext().firestore();
const asOwner = () => testEnv.authenticatedContext(OWNER).firestore();
const asOther = () => testEnv.authenticatedContext(OTHER).firestore();
const asClaimAdmin = () =>
  testEnv.authenticatedContext(CLAIM_ADMIN, { admin: true }).firestore();
const asLegacyAdmin = () =>
  testEnv.authenticatedContext(LEGACY_ADMIN_UID).firestore();

describe("signed-out access", () => {
  it("denies reading users, wallets and tournaments", async () => {
    await assertFails(signedOut().doc(userPath(OWNER)).get());
    await assertFails(signedOut().doc(`wallets/${OWNER}`).get());
    await assertFails(signedOut().doc("tournaments/t1").get());
  });

  it("denies all writes", async () => {
    await assertFails(signedOut().doc(userPath(OWNER)).set({ hacked: true }));
    await assertFails(signedOut().doc(`wallets/${OWNER}`).set({ balance: 999 }));
  });
});

describe("users", () => {
  it("lets a user read their own document", async () => {
    await assertSucceeds(asOwner().doc(userPath(OWNER)).get());
  });

  it("denies reading another user's document", async () => {
    await assertFails(asOwner().doc(userPath(OTHER)).get());
  });

  it("denies writing users directly, even one's own", async () => {
    // onUserCreated uses the Admin SDK, which bypasses rules entirely — so no
    // client write path is needed, and allowing one would be a hole.
    await assertFails(asOwner().doc(userPath(OWNER)).set({ username: "x" }));
    await assertFails(
      asOwner().doc(userPath(OWNER)).update({ username: "x" })
    );
    await assertFails(asOwner().doc(userPath(OWNER)).delete());
  });
});

describe("wallets", () => {
  it("lets a user read their own wallet", async () => {
    await assertSucceeds(asOwner().doc(`wallets/${OWNER}`).get());
  });

  it("denies reading another user's wallet", async () => {
    await assertFails(asOwner().doc(`wallets/${OTHER}`).get());
  });

  it("denies modifying ANY wallet, including one's own", async () => {
    // The single most important rule in the app: money is not client-writable.
    await assertFails(asOwner().doc(`wallets/${OWNER}`).update({ balance: 1e6 }));
    await assertFails(asOwner().doc(`wallets/${OTHER}`).update({ balance: 1e6 }));
    await assertFails(asOwner().doc(`wallets/${OWNER}`).delete());
    await assertFails(asClaimAdmin().doc(`wallets/${OWNER}`).update({ balance: 1 }));
  });
});

describe("transactions", () => {
  it("lets a user read only their own transactions", async () => {
    await assertSucceeds(asOwner().doc("transactions/tx-owner").get());
    await assertFails(asOwner().doc("transactions/tx-other").get());
  });

  it("denies creating a transaction from a client", async () => {
    await assertFails(
      asOwner().doc("transactions/forged").set({ amount: 1000 })
    );
  });
});

describe("withdrawals", () => {
  it("lets a user read only their own withdrawals", async () => {
    await assertSucceeds(asOwner().doc("withdrawals/wd-owner").get());
    await assertFails(asOwner().doc("withdrawals/wd-other").get());
  });

  it("denies creating a withdrawal from a client", async () => {
    await assertFails(
      asOwner().doc("withdrawals/forged").set({ amount: 1000 })
    );
  });
});

describe("registrations", () => {
  it("lets a user read only their own registrations", async () => {
    await assertSucceeds(asOwner().doc(`registrations/${OWNER}_t1`).get());
    await assertFails(asOwner().doc(`registrations/${OTHER}_t1`).get());
  });

  it("denies self-registering without paying (jointournament only)", async () => {
    await assertFails(
      asOwner()
        .doc(`registrations/${OWNER}_t2`)
        .set({ status: "registered" })
    );
  });
});

describe("tournaments", () => {
  it("lets any authenticated user read tournaments", async () => {
    await assertSucceeds(asOwner().doc("tournaments/t1").get());
    await assertSucceeds(asOther().doc("tournaments/t1").get());
  });

  it("denies a normal user writing a tournament", async () => {
    await assertFails(asOwner().doc("tournaments/t2").set({ name: "Fake" }));
    await assertFails(
      asOwner().doc("tournaments/t1").update({ entry_fee: 0 })
    );
    await assertFails(asOwner().doc("tournaments/t1").delete());
  });

  it("lets a custom-claim admin write tournaments", async () => {
    await assertSucceeds(
      asClaimAdmin().doc("tournaments/t2").set({
        name: "Nova Copa",
        status: "open",
        entry_fee: 10,
        current_participants: 0,
        max_participants: 16,
      })
    );
    await assertSucceeds(
      asClaimAdmin().doc("tournaments/t1").update({ status: "closed" })
    );
  });

  it("still lets the legacy admin write tournaments during the transition", async () => {
    // If this fails, publishing these rules would lock the existing admin out.
    await assertSucceeds(
      asLegacyAdmin().doc("tournaments/t1").update({ status: "closed" })
    );
  });
});

describe("admin reads", () => {
  it("lets a custom-claim admin read any user and wallet", async () => {
    await assertSucceeds(asClaimAdmin().doc(userPath(OWNER)).get());
    await assertSucceeds(asClaimAdmin().doc(`wallets/${OWNER}`).get());
  });

  it("lets the legacy admin read any user and wallet during the transition", async () => {
    await assertSucceeds(asLegacyAdmin().doc(userPath(OWNER)).get());
    await assertSucceeds(asLegacyAdmin().doc(`wallets/${OWNER}`).get());
  });

  it("does not grant admin for a truthy-but-not-true claim", async () => {
    const fake = testEnv
      .authenticatedContext("fake-admin", { admin: "true" })
      .firestore();
    await assertFails(fake.doc(userPath(OWNER)).get());
    await assertFails(fake.doc("tournaments/t1").set({ name: "Fake" }));
  });
});

describe("unknown collections", () => {
  it("denies reads and writes to any collection not explicitly allowed", async () => {
    await assertFails(asOwner().doc("secretstuff/s1").get());
    await assertFails(asOwner().doc("secretstuff/s2").set({ value: "x" }));
    await assertFails(asClaimAdmin().doc("secretstuff/s1").get());
  });

  it("keeps the deny-all fallback even for an admin", async () => {
    await assertFails(asLegacyAdmin().doc("anything/else").set({ a: 1 }));
  });
});

// Sanity: the rules file we loaded really is the one under test.
describe("rules file", () => {
  it("is version 2 and contains the transitional admin check", () => {
    const rules = readFileSync(
      resolve(process.cwd(), "..", "firestore.rules"),
      "utf8"
    );
    assert.match(rules, /rules_version = '2'/);
    assert.match(rules, /hasAdminClaim/);
    assert.match(rules, /isLegacyAdmin/);
  });
});
