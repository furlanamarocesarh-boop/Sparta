/**
 * SCORING PRESETS — a saved tournament format, reusable across tournaments.
 *
 * WHY THIS EXISTS. A creator who runs the same championship every week types
 * the same six numbers every week: how many matches, what a kill is worth, the
 * placement table, and how the prize is split. Getting one of them wrong is not
 * a typo the creator sees — it is a payout somebody else discovers. A preset is
 * that configuration, named and stored once.
 *
 * IT IS THE SAME CONFIGURATION, NOT A PARALLEL ONE. A preset holds exactly the
 * fields `createTournament` accepts, and it is validated by exactly the same
 * functions — `checkPointsConfig` and `checkPrizeDistribution`. A preset that
 * saved cleanly and then failed to create a tournament would be worse than no
 * preset at all, so the two can never diverge: there is no second rule here.
 *
 * THE NAME IS THE IDENTITY. The id is derived from the name, so saving "Squad 6
 * partidas" twice REPLACES it instead of leaving two rows the creator has to
 * tell apart. That is what a save button means everywhere else, and it makes
 * saving idempotent for free — a double tap cannot mint a duplicate.
 *
 * SERVER-SIDE, NOT ON THE DEVICE. The creator invests real thought in a scoring
 * table; a cleared browser cache must not be able to lose it, and the same
 * account on a phone has to find the same presets.
 */

import {
  checkPointsConfig,
  checkPrizeDistribution,
  type PointsConfig,
  type PrizeSlice,
} from "./matchPoints.js";

/** How many presets one owner may keep. A ceiling, not a capacity plan. */
export const MAX_PRESETS_PER_OWNER = 20;

/** Bounds on the name. Long enough to describe a format, short enough to list. */
export const MIN_PRESET_NAME_LENGTH = 2;
export const MAX_PRESET_NAME_LENGTH = 60;

/** The derived id is truncated to this. Long ids are unreadable in a console. */
export const MAX_PRESET_ID_LENGTH = 40;

export type PresetRefusal =
  | "bad-name"
  | "name-too-short"
  | "name-too-long"
  | "name-has-no-letters"
  | "bad-preset-id"
  | "too-many-presets";

export type PresetCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: PresetRefusal };

/**
 * The id a name maps to: accent-free, lowercase, alphanumerics and hyphens.
 *
 * Returns null when the name carries nothing that survives — "!!!" and "..."
 * are not names, and a document id of "" or "." is not addressable in
 * Firestore. Refusing here is what keeps `__proto__`, `.`, `..` and a path
 * separator from ever reaching a document reference.
 */
export function presetIdFor(name: string): string | null {
  const slug = name
    .normalize("NFD")
    // Combining marks — the accents NFD just split off.
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_PRESET_ID_LENGTH)
    // The slice can leave a trailing hyphen behind.
    .replace(/-+$/g, "");

  return slug === "" ? null : slug;
}

/** Whether a name is usable, and whether it yields an addressable id. */
export function checkPresetName(name: unknown): PresetCheck {
  if (typeof name !== "string") return { ok: false, reason: "bad-name" };
  const trimmed = name.trim();
  if (trimmed.length < MIN_PRESET_NAME_LENGTH) {
    return { ok: false, reason: "name-too-short" };
  }
  if (trimmed.length > MAX_PRESET_NAME_LENGTH) {
    return { ok: false, reason: "name-too-long" };
  }
  if (presetIdFor(trimmed) === null) {
    return { ok: false, reason: "name-has-no-letters" };
  }
  return { ok: true };
}

/**
 * Whether a supplied id is one this module could have produced.
 *
 * Delete takes an id, and an id is a document path. Accepting anything the
 * client sends would let a caller aim a delete at a path this collection never
 * writes; requiring the id to be in the derived alphabet closes that.
 */
export function checkPresetId(presetId: unknown): PresetCheck {
  if (
    typeof presetId !== "string" ||
    presetId.length === 0 ||
    presetId.length > MAX_PRESET_ID_LENGTH ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(presetId)
  ) {
    return { ok: false, reason: "bad-preset-id" };
  }
  return { ok: true };
}

/** A saved format, exactly as `createTournament` would receive it. */
export interface ScoringPreset {
  readonly presetId: string;
  /** As the creator typed it — the id is derived, the name is displayed. */
  readonly name: string;
  readonly matchesCount: number;
  readonly killPoints: number;
  readonly placementPoints: readonly number[];
  /** null means "the champion takes the whole prize" — the default shape. */
  readonly prizeDistribution: readonly PrizeSlice[] | null;
}

export type PresetBodyCheck =
  | { readonly ok: true; readonly preset: ScoringPreset }
  | { readonly ok: false; readonly reason: PresetRefusal | string };

/**
 * Validates a preset end to end and returns the normalized value.
 *
 * The scoring and distribution refusals are returned VERBATIM from the shared
 * checks, so the operator reads the same sentence whether they hit it while
 * saving a preset or while creating a tournament.
 */
export function checkPreset(input: {
  readonly name: unknown;
  readonly matchesCount: unknown;
  readonly killPoints: unknown;
  readonly placementPoints: unknown;
  readonly prizeDistribution: unknown;
}): PresetBodyCheck {
  const nameCheck = checkPresetName(input.name);
  if (!nameCheck.ok) return { ok: false, reason: nameCheck.reason };
  const name = String(input.name).trim();
  const presetId = presetIdFor(name);
  if (presetId === null) return { ok: false, reason: "name-has-no-letters" };

  const matchesCount =
    input.matchesCount === undefined || input.matchesCount === null
      ? 1
      : Number(input.matchesCount);

  const config: PointsConfig = {
    killPoints:
      input.killPoints === undefined || input.killPoints === null
        ? 0
        : Number(input.killPoints),
    placementPoints: Array.isArray(input.placementPoints)
      ? input.placementPoints.map((p: unknown) => Number(p))
      : [],
  };

  const configCheck = checkPointsConfig(matchesCount, config);
  if (!configCheck.ok) return { ok: false, reason: configCheck.reason };

  let prizeDistribution: PrizeSlice[] | null = null;
  const raw = input.prizeDistribution;
  if (raw !== undefined && raw !== null) {
    if (!Array.isArray(raw)) return { ok: false, reason: "bad-slice" };
    const slices: PrizeSlice[] = raw.map((entry: any) => ({
      position: Number(entry?.position),
      shareBps: Number(entry?.share_bps),
    }));
    const check = checkPrizeDistribution(slices);
    if (!check.ok) return { ok: false, reason: check.reason };
    prizeDistribution = slices;
  }

  return {
    ok: true,
    preset: {
      presetId,
      name,
      matchesCount,
      killPoints: config.killPoints,
      placementPoints: config.placementPoints,
      prizeDistribution,
    },
  };
}

/** A frozen operator-facing message for each preset refusal. */
export function presetMessage(reason: string): string {
  switch (reason) {
    case "bad-name":
    case "name-too-short":
      return `O nome da configuração precisa ter ao menos ${MIN_PRESET_NAME_LENGTH} caracteres.`;
    case "name-too-long":
      return `O nome da configuração precisa ter no máximo ${MAX_PRESET_NAME_LENGTH} caracteres.`;
    case "name-has-no-letters":
      return "O nome da configuração precisa ter letras ou números.";
    case "bad-preset-id":
      return "Configuração não encontrada.";
    case "too-many-presets":
      return `Você já tem ${MAX_PRESETS_PER_OWNER} configurações salvas. Apague uma para salvar outra.`;
    default:
      return "Configuração inválida.";
  }
}
