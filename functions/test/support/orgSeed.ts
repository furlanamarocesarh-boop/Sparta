import * as admin from "firebase-admin";

/**
 * Dá uma ORGANIZAÇÃO a quem os testes usam para criar campeonatos.
 *
 * POR QUE ISTO EXISTE. Criar campeonato deixou de depender da claim
 * `admin: true` e passou a depender de ser membro de uma organização — é o
 * ponto da feature: o dono convida ajudantes e eles organizam sem ganhar a
 * chave do caixa da plataforma. Todo teste que cria um campeonato precisa,
 * portanto, de uma organização, e repetir a semeadura em cinco arquivos seria
 * cinco chances de ela divergir.
 *
 * Escreve pelo Admin SDK, que ignora as Rules — exatamente como o backend faz
 * em produção.
 */
export async function seedOrganization(
  db: admin.firestore.Firestore,
  ownerUid: string,
  orgId = `org-${ownerUid}`
): Promise<string> {
  const now = admin.firestore.Timestamp.now();

  await db.collection("organizations").doc(orgId).set({
    name: "Organização de Teste",
    logo_url: null,
    owner_uid: ownerUid,
    created_at: now,
  });
  await db.collection("organization_members").doc(`${ownerUid}_${orgId}`).set({
    uid: ownerUid,
    org_id: orgId,
    role: "owner",
    joined_at: now,
  });

  return orgId;
}

/** Desfaz o que `seedOrganization` escreveu. */
export async function wipeOrganization(
  db: admin.firestore.Firestore,
  ownerUid: string,
  orgId = `org-${ownerUid}`
): Promise<void> {
  await Promise.all([
    db.collection("organizations").doc(orgId).delete(),
    db.collection("organization_private").doc(orgId).delete(),
    db.collection("organization_members").doc(`${ownerUid}_${orgId}`).delete(),
  ]);
}
