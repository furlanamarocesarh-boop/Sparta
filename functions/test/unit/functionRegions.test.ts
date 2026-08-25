import assert from "node:assert/strict";
import { describe, it } from "node:test";

/**
 * Region pinning — proves the region each export actually produces.
 *
 * Regressão que estes testes travam: se alguém remover o `.region(...)` de um
 * export, sua região volta ao default do SDK (us-central1) silenciosamente. Para
 * `onUserCreated` isso significaria um deploy criar uma SEGUNDA cópia em
 * us-central1 em vez de atualizar a de us-east1 — exatamente o Bloqueador B do
 * runbook.
 *
 * Os objetos exportados (Gen 1 / firebase-functions v1) carregam a região em
 * `__trigger.regions`. Importamos o build compilado (`lib/index.js`), então este
 * teste roda depois de `npm run build:test`.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
type ExportedFn = {
  __trigger?: { regions?: string[] };
  __endpoint?: {
    region?: string[];
    platform?: string;
    callableTrigger?: unknown;
    secretEnvironmentVariables?: Array<{ key?: unknown }>;
  };
};

// O index compilado fica em lib-test/src/index.js quando compilado por
// tsconfig.test.json (rootDir = ".").
async function loadFunctions(): Promise<Record<string, ExportedFn>> {
  // Import dinâmico do build de teste. GCLOUD_PROJECT evita que a inicialização
  // do firebase-functions v1 reclame de ambiente ausente.
  process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT ?? "demo-sparta-battle";
  const mod = await import("../../src/index.js");
  return mod as unknown as Record<string, ExportedFn>;
}

/** A região declarada de um export Gen 1 v1. */
function regionOf(fn: ExportedFn): string[] | undefined {
  return fn.__trigger?.regions;
}

/**
 * Os secrets que o ARTEFATO realmente declara para um export.
 *
 * Lidos de `__endpoint.secretEnvironmentVariables` — a representação que o
 * deploy consome — e não do texto-fonte, porque o defeito que este teste trava
 * é invisível no fonte: `FunctionBuilder.prototype.runWith()` MUTA o builder
 * compartilhado e retorna `this`, então um `central.runWith({secrets})` contamina
 * silenciosamente todo export declarado depois dele.
 */
function secretsOf(fn: ExportedFn): string[] {
  return (fn.__endpoint?.secretEnvironmentVariables ?? [])
    .map((s) => String(s.key))
    .sort();
}

const CENTRAL = "us-central1";
const EAST = "us-east1";

/**
 * THE MANIFEST — the single authorized deployment surface.
 *
 * One entry per deployable Function: its exact exported name (casing included)
 * mapped to the ONE region it must declare. Every assertion below is derived
 * from this object, so the surface is stated exactly once.
 *
 * This is an ALLOWLIST, deliberately closed. It is not a mirror of whatever
 * `index.ts` happens to export: an export that is not listed here FAILS, even
 * if it carries a valid `__trigger`. That is the protection — a new endpoint
 * (and therefore a new deploy target, a new attack surface and a new billing
 * line) must be authorized here on purpose, never merely by appearing.
 *
 * ADDING AN AUTHORIZED FUNCTION: add exactly one entry, `name: REGION`. Its
 * presence, its casing and its region are then all verified automatically —
 * there is no second list to keep in sync.
 */
const AUTHORIZED_FUNCTIONS: Readonly<Record<string, string>> = {
  onUserCreated: EAST,
  testdeposit: CENTRAL,
  requestwithdrawal: CENTRAL,
  jointournament: CENTRAL,
  payprize: CENTRAL,
  createTournament: CENTRAL,
  createtournament: CENTRAL,
  setTournamentRoom: CENTRAL,
  getTournamentRoom: CENTRAL,
  startTournament: CENTRAL,
  declareTournamentResult: CENTRAL,
  grantBetaCredit: CENTRAL,
  cancelTournament: CENTRAL,
  recordDailyAppOpen: CENTRAL,
  getPlayerEngagementStats: CENTRAL,
  onPrizeTransactionCreated: CENTRAL,
  getSeasonLeaderboard: CENTRAL,
  getMySeasonRanking: CENTRAL,
  publicTournamentPreview: CENTRAL,
  claimReferral: CENTRAL,
  onEntryFeeTransactionCreated: CENTRAL,
  createPartner: CENTRAL,
  getPartnerEarnings: CENTRAL,
  declareTournamentResultWithKills: CENTRAL,
  fundHouse: CENTRAL,
  setPartnerActive: CENTRAL,
  setNickname: CENTRAL,
  getMyBadges: CENTRAL,
  acknowledgeBadges: CENTRAL,
  getPublicProfile: CENTRAL,
  getMyProfile: CENTRAL,
  applyForPartner: CENTRAL,
  reviewPartnerApplication: CENTRAL,
};

/**
 * THE SECRET MANIFEST — which deployable Functions may declare which secrets.
 *
 * Least privilege, stated once and closed: a Function absent from this map may
 * declare NO secret at all. Today exactly one callable holds exactly one secret
 * — the cursor-signing key of the leaderboard. `getMySeasonRanking` never signs
 * or verifies a cursor, so it must not carry the key.
 */
const AUTHORIZED_SECRETS: Readonly<Record<string, readonly string[]>> = {
  getSeasonLeaderboard: ["RANKING_CURSOR_HMAC_SECRET"],
};

/**
 * Names that must NEVER exist. This is the opposite contract to the manifest —
 * a denylist of retired camelCase aliases — so it is a separate structure by
 * design, not a second copy of the surface.
 */
const FORBIDDEN_LEGACY_ALIASES = [
  "joinTournament",
  "payPrize",
  "requestWithdrawal",
] as const;

/**
 * The exports that are actually deployable: those carrying `__trigger`.
 *
 * Discovered dynamically, which is what lets an UNAUTHORIZED export be caught.
 * The filter also drops `default`/`__esModule` from the CommonJS↔ESM interop
 * and every exported helper that is not a deployable endpoint (for example
 * createTournamentHandler, declareTournamentResultHandler,
 * recordDailyAppOpenHandler, getPlayerEngagementStatsHandler).
 */
function deployableExports(fns: Record<string, ExportedFn>): string[] {
  return Object.keys(fns)
    .filter((k) => (fns[k] as ExportedFn).__trigger != null)
    .sort();
}

describe("regiões explícitas por função", () => {
  it("a superfície implantável é EXATAMENTE a autorizada no manifest", async () => {
    const fns = await loadFunctions();
    const actual = deployableExports(fns);
    const authorized = Object.keys(AUTHORIZED_FUNCTIONS).sort();

    // Separado em duas asserções para que a falha diga QUAL é o problema:
    // uma Function sumiu, ou uma Function não autorizada apareceu.
    const missing = authorized.filter((name) => !actual.includes(name));
    assert.deepEqual(
      missing,
      [],
      `Functions autorizadas AUSENTES do build (removidas ou renomeadas?): ${missing.join(", ")}`
    );

    const unauthorized = actual.filter(
      (name) => !Object.prototype.hasOwnProperty.call(AUTHORIZED_FUNCTIONS, name)
    );
    assert.deepEqual(
      unauthorized,
      [],
      `Exports implantáveis NÃO autorizados: ${unauthorized.join(", ")}. ` +
        `Se forem legítimos, adicione cada um ao manifest AUTHORIZED_FUNCTIONS ` +
        `com sua região esperada.`
    );

    // Rede de segurança: cobre também casing divergente e qualquer duplicata.
    assert.deepEqual(actual, authorized);
  });

  it("cada Function do manifest declara EXATAMENTE a região autorizada", async () => {
    const fns = await loadFunctions();
    for (const [name, expectedRegion] of Object.entries(AUTHORIZED_FUNCTIONS)) {
      assert.ok(fns[name], `${name} não foi exportada`);
      assert.deepEqual(
        regionOf(fns[name]),
        [expectedRegion],
        `${name} deve estar em ${expectedRegion}`
      );
    }
  });

  it("nenhuma Function usa região IMPLÍCITA (default do SDK)", async () => {
    const fns = await loadFunctions();
    for (const name of Object.keys(AUTHORIZED_FUNCTIONS)) {
      const regions = regionOf(fns[name]);
      assert.ok(
        Array.isArray(regions) && regions.length === 1,
        `${name} deve ter exatamente uma região explícita — ` +
          `esquecer .region(...) faz o deploy cair no default ${CENTRAL}`
      );
    }
  });

  it("cada Function declara EXATAMENTE os secrets autorizados — verificado no ARTEFATO", async () => {
    const fns = await loadFunctions();

    // Nenhum secret autorizado pode apontar para uma Function fora do manifest.
    for (const name of Object.keys(AUTHORIZED_SECRETS)) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(AUTHORIZED_FUNCTIONS, name),
        `${name} tem secret autorizado mas não é uma Function autorizada`
      );
    }

    for (const name of Object.keys(AUTHORIZED_FUNCTIONS)) {
      const expected = [...(AUTHORIZED_SECRETS[name] ?? [])].sort();
      assert.deepEqual(
        secretsOf(fns[name]),
        expected,
        expected.length > 0
          ? `${name} deve declarar exatamente [${expected.join(", ")}]`
          : `${name} NÃO pode declarar secret nenhum. Se este teste falhou, ` +
            `provavelmente um runWith({secrets}) rodou no builder COMPARTILHADO ` +
            `e contaminou os exports declarados depois dele — use um builder ` +
            `exclusivo: region(...).runWith({secrets}).https.onCall(...)`
      );
    }
  });

  it("as callables do ranking continuam Gen1, callable e na região autorizada", async () => {
    const fns = await loadFunctions();
    for (const name of ["getSeasonLeaderboard", "getMySeasonRanking"]) {
      const endpoint = fns[name]?.__endpoint;
      assert.ok(endpoint, `${name} não expõe __endpoint`);
      assert.equal(endpoint.platform, "gcfv1", `${name} deve continuar Gen1`);
      assert.ok(
        endpoint.callableTrigger !== undefined,
        `${name} deve continuar callable`
      );
      assert.deepEqual(endpoint.region, [CENTRAL], `${name} deve estar em ${CENTRAL}`);
    }
  });

  it("não existe nenhum alias camelCase legado (joinTournament/payPrize/requestWithdrawal)", async () => {
    const fns = await loadFunctions();
    for (const alias of FORBIDDEN_LEGACY_ALIASES) {
      assert.equal(fns[alias], undefined, `${alias} não pode voltar a existir`);
      assert.ok(
        !Object.prototype.hasOwnProperty.call(AUTHORIZED_FUNCTIONS, alias),
        `${alias} é um alias proibido e nunca pode ser autorizado no manifest`
      );
    }
  });
});
