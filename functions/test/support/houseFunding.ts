import * as admin from "firebase-admin";

import {
  HOUSE_BALANCE_FIELD,
  HOUSE_COLLECTION,
  houseDocId,
} from "../../src/domain/house.js";

/**
 * Puts capital in a treasury, straight through the Admin SDK.
 *
 * WHY EVERY SETTLEMENT SUITE NEEDS THIS NOW. A settlement may not leave the
 * house negative, and the house starts empty — so a tournament that pays a
 * fixed prize larger than its entry fees is refused until capital exists.
 * That is the real production rule, not a test artefact: an operator has to
 * fund the treasury before running a tournament whose prize is guaranteed.
 *
 * These suites seed generous prizes against tiny pools, so each one funds the
 * treasury first, exactly as the operator will.
 */
export async function seedHouse(
  db: admin.firestore.Firestore,
  economy: string,
  centavos: number
): Promise<void> {
  await db
    .collection(HOUSE_COLLECTION)
    .doc(houseDocId(economy))
    .set(
      { [HOUSE_BALANCE_FIELD]: centavos, economy_type: economy },
      { merge: true }
    );
}

/** Removes both treasuries, so a suite starts from a known empty state. */
export async function clearHouse(
  db: admin.firestore.Firestore
): Promise<void> {
  await Promise.all([
    db.collection(HOUSE_COLLECTION).doc("cash").delete(),
    db.collection(HOUSE_COLLECTION).doc("beta_credit").delete(),
  ]);
}
