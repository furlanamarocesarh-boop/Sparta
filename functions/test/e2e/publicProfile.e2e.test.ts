import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import * as admin from "firebase-admin";

import { PUBLIC_PLAYER_ID_INDEX_COLLECTION } from "../../src/domain/publicPlayerId.js";
import { assertEmulatorOnly } from "../support/emulatorGuard.js";

/**
 * O PERFIL PÚBLICO, contra um Firestore real.
 *
 * O que só o emulador prova: que o pseudônimo resolve para a conta certa pelo
 * índice server-only, que um estranho consegue ler o perfil, e que o uid — a
 * chave de todas as outras coleções — nunca sai na resposta.
 */

const PROJECT_ID = "demo-sparta-battle";
const OWNER = "e2e-profile-owner";
const STRANGER = "e2e-profile-stranger";
const PSEUDO = "e2eProfileAAAAAAAAAAAA"; // 22 chars, formato congelado

const ctx = (uid: string) => ({ auth: { uid, token: {} } });

let db: admin.firestore.Firestore;
let getProfile: (d: unknown, c: unknown) => Promise<any>;

async function cleanup(): Promise<void> {
  await Promise.all([
    db.collection("users").doc(OWNER).delete(),
    db.collection(PUBLIC_PLAYER_ID_INDEX_COLLECTION).doc(PSEUDO).delete(),
  ]);
}

describe("E2E — perfil público", () => {
  before(async () => {
    assertEmulatorOnly(PROJECT_ID);
    process.env.GCLOUD_PROJECT = PROJECT_ID;
    if (admin.apps.length === 0) admin.initializeApp();
    db = admin.firestore();

    const mod = await import("../../src/index.js");
    getProfile = (mod as any).getPublicProfileHandler;

    await cleanup();
    await db.collection("users").doc(OWNER).set({
      username: "RDKILL",
      badges: ["creator_verified", "spartan_noobie"],
      tournaments_played: 12,
      created_at: admin.firestore.Timestamp.fromDate(
        new Date(Date.UTC(2026, 7, 3))
      ),
      // Privado. Nada disto pode atravessar.
      email: "dono@sparta.gg",
      partner_ref: "parceiro-1",
      kyc_verified: true,
    });
    await db
      .collection(PUBLIC_PLAYER_ID_INDEX_COLLECTION)
      .doc(PSEUDO)
      .set({ uid: OWNER });
  });

  after(async () => {
    await cleanup();
  });

  it("um ESTRANHO logado consegue ver o perfil", async () => {
    // É o ponto da feature: um perfil é uma página que se manda para alguém.
    const p = await getProfile({ public_player_id: PSEUDO }, ctx(STRANGER));
    assert.equal(p.nickname, "RDKILL");
    assert.deepEqual(p.badges, ["creator_verified", "spartan_noobie"]);
    assert.equal(p.tournamentsPlayed, 12);
    assert.equal(p.memberSince, "agosto de 2026");
  });

  it("o uid NÃO sai — nem o e-mail, nem o parceiro, nem o KYC", async () => {
    const p = await getProfile({ public_player_id: PSEUDO }, ctx(STRANGER));
    const flat = JSON.stringify(p);
    for (const secret of [OWNER, "dono@sparta.gg", "parceiro-1", "kyc"]) {
      assert.equal(flat.includes(secret), false, `vazou "${secret}"`);
    }
  });

  it("deslogado não lê perfil nenhum", async () => {
    // Endpoint aberto sobre um id de 22 caracteres é superfície de raspagem;
    // exigir conta põe nome em quem percorre o espaço.
    await assert.rejects(
      () => getProfile({ public_player_id: PSEUDO }, { auth: null }),
      /Entre na sua conta/i
    );
  });

  it("pseudônimo fora do formato é recusado antes de qualquer leitura", async () => {
    for (const bad of ["curto", "", "a".repeat(23), "com espaco aqui!!!!!!!"]) {
      await assert.rejects(
        () => getProfile({ public_player_id: bad }, ctx(STRANGER)),
        /Perfil inválido/i,
        bad
      );
    }
  });

  it("pseudônimo válido mas inexistente é not-found", async () => {
    await assert.rejects(
      () =>
        getProfile(
          { public_player_id: "naoExisteAAAAAAAAAAAAA" },
          ctx(STRANGER)
        ),
      /não encontrado/i
    );
  });

  it("chave a mais no payload derruba a chamada", async () => {
    await assert.rejects(
      () =>
        getProfile(
          { public_player_id: PSEUDO, uid: OWNER },
          ctx(STRANGER)
        ),
      /.+/
    );
  });
});
