/**
 * GAME MODES AND HOW MANY PEOPLE FIT IN THEM.
 *
 * WHY THIS IS A RULE AND NOT A SUGGESTION. A mode is not a label — it decides
 * how the lobby is actually played. A "2v2" is two teams of two facing each
 * other; a tournament created as 2v2 with fifty slots is not a big 2v2, it is
 * a tournament that cannot be run. Production has several of those today,
 * created before this file existed, which is exactly the evidence that a free
 * text box was the wrong control.
 *
 * TEAMS HAVE TO BE FULL. Twenty-three players in a duo lobby is eleven duos
 * and one person with no partner. Nobody configures that on purpose, and the
 * person who discovers it is the player left out — so the count must always be
 * a whole number of teams.
 *
 * TWO SHAPES, NOT FIVE. Solo, duo and squad are a battle-royale LOBBY: many
 * teams drop together, and the ceiling is how many the lobby holds. 2v2 and
 * 4v4 are a VERSUS match: exactly two teams, so the count is not a ceiling —
 * it is the only number that works.
 */

/**
 * How many players a battle-royale lobby holds.
 *
 * Forty-eight because that is what the game seats: twelve squads of four,
 * twenty-four duos, or forty-eight solos. Every battle-royale mode shares it,
 * which is why it is one constant and not three.
 */
export const BATTLE_ROYALE_LOBBY = 48;

export type FormatType = "battle_royale" | "versus" | "cup";

/**
 * Os tamanhos de equipe que uma Copa aceita.
 *
 * A Copa é o único modo em que o criador escolhe o tamanho: um mata-mata pode
 * ser individual, de duplas ou de squads, e as três coisas são a mesma
 * estrutura de chaveamento com participantes de tamanhos diferentes.
 */
export const CUP_TEAM_SIZES = [1, 2, 4] as const;

/** Quantas equipes cabem numa Copa. Espelha MAX_CUP_ENTRANTS em cup.ts. */
export const MAX_CUP_TEAMS = 64;

export interface GameModeSpec {
  /** Exactly what the client sends and what is stored. Never re-cased. */
  readonly key: string;
  /** Operator-facing name. */
  readonly label: string;
  readonly formatType: FormatType;
  readonly teamSize: number;
  /** Fewest players that make a tournament: two full teams. */
  readonly minPlayers: number;
  readonly maxPlayers: number;
  /**
   * True when the count is FIXED rather than capped — a versus match is two
   * teams, so `minPlayers === maxPlayers` and there is nothing to choose.
   */
  readonly fixedCount: boolean;
}

function battleRoyale(
  key: string,
  label: string,
  teamSize: number
): GameModeSpec {
  return {
    key,
    label,
    formatType: "battle_royale",
    teamSize,
    // Um torneio precisa de pelo menos dois times para ter uma disputa.
    minPlayers: teamSize * 2,
    maxPlayers: BATTLE_ROYALE_LOBBY,
    fixedCount: false,
  };
}

function versus(key: string, label: string, teamSize: number): GameModeSpec {
  const players = teamSize * 2;
  return {
    key,
    label,
    formatType: "versus",
    teamSize,
    minPlayers: players,
    maxPlayers: players,
    fixedCount: true,
  };
}

/**
 * A Copa, para um tamanho de equipe.
 *
 * NÃO É UM LOBBY. Os confrontos são jogados separadamente, um contra um, então
 * o teto não é quanta gente senta na sala — é quantas equipes o chaveamento
 * comporta.
 */
export function cupSpec(teamSize: number): GameModeSpec | null {
  if (!CUP_TEAM_SIZES.includes(teamSize as (typeof CUP_TEAM_SIZES)[number])) {
    return null;
  }
  return {
    key: CUP_KEY,
    label: teamSize === 1 ? "Copa" : `Copa ${teamSize}v${teamSize}`,
    formatType: "cup",
    teamSize,
    minPlayers: teamSize * 2,
    maxPlayers: teamSize * MAX_CUP_TEAMS,
    fixedCount: false,
  };
}

export const CUP_KEY = "copa";

/** Every mode the platform knows, in the order an operator picks from. */
export const GAME_MODES: readonly GameModeSpec[] = [
  battleRoyale("solo", "Solo", 1),
  battleRoyale("duo", "Duo", 2),
  battleRoyale("squad", "Squad", 4),
  versus("2v2", "2v2", 2),
  versus("4v4", "4v4", 4),
  cupSpec(1)!,
];

/**
 * O modo com o tamanho de equipe RESOLVIDO.
 *
 * Só a Copa lê `teamSize`; nos outros modos ele é consequência do modo e um
 * valor divergente vindo do cliente é recusado em vez de ignorado — aceitar
 * em silêncio gravaria um torneio cujo `team_size` contradiz o próprio modo.
 */
export function resolveGameMode(
  key: unknown,
  teamSize: unknown
): GameModeSpec | null {
  const base = gameModeSpec(key);
  if (base === null) return null;

  if (base.formatType !== "cup") {
    if (teamSize === undefined || teamSize === null) return base;
    return Number(teamSize) === base.teamSize ? base : null;
  }

  // Ausente é Copa individual — o mata-mata mais simples, e o padrão.
  const size = teamSize === undefined || teamSize === null ? 1 : Number(teamSize);
  return cupSpec(size);
}

/** The spec for a mode key, or null when the key is not one we run. */
export function gameModeSpec(key: unknown): GameModeSpec | null {
  if (typeof key !== "string") return null;
  const normalized = key.trim().toLowerCase().replace(/\s+/g, "");
  return GAME_MODES.find((mode) => mode.key === normalized) ?? null;
}

/** The mode keys, for a message that has to list them. */
export function gameModeKeys(): string[] {
  return GAME_MODES.map((mode) => mode.key);
}

export type CapacityRefusal =
  | "bad-number"
  | "below-minimum"
  | "above-maximum"
  | "partial-team"
  | "fixed-count";

export type CapacityCheck =
  | { readonly ok: true; readonly teams: number }
  | { readonly ok: false; readonly reason: CapacityRefusal };

/** How many full teams a player count makes. */
export function teamsFor(spec: GameModeSpec, players: number): number {
  return Math.floor(players / spec.teamSize);
}

/** Whether this many players can actually play this mode. */
export function checkPlayerCount(
  spec: GameModeSpec,
  maxPlayers: unknown
): CapacityCheck {
  if (
    typeof maxPlayers !== "number" ||
    !Number.isSafeInteger(maxPlayers) ||
    maxPlayers <= 0
  ) {
    return { ok: false, reason: "bad-number" };
  }

  // A CONTAGEM FIXA RECUSA PRIMEIRO, e com a própria razão: dizer "acima do
  // máximo" para um 2v2 com cinco jogadores sugere que quatro é um teto que
  // dava para escolher abaixo, quando quatro é o único número que existe.
  if (spec.fixedCount) {
    return maxPlayers === spec.maxPlayers
      ? { ok: true, teams: 2 }
      : { ok: false, reason: "fixed-count" };
  }

  if (maxPlayers < spec.minPlayers) {
    return { ok: false, reason: "below-minimum" };
  }
  if (maxPlayers > spec.maxPlayers) {
    return { ok: false, reason: "above-maximum" };
  }
  if (maxPlayers % spec.teamSize !== 0) {
    return { ok: false, reason: "partial-team" };
  }
  return { ok: true, teams: teamsFor(spec, maxPlayers) };
}

function teamWord(teamSize: number): string {
  return teamSize === 1 ? "jogador" : "equipe";
}

/** A frozen operator-facing message for each capacity refusal. */
export function capacityMessage(
  spec: GameModeSpec,
  reason: CapacityRefusal
): string {
  switch (reason) {
    case "fixed-count":
      return (
        `${spec.label} é uma disputa entre duas equipes de ${spec.teamSize}: ` +
        `são exatamente ${spec.maxPlayers} jogadores.`
      );
    case "below-minimum":
      return (
        `${spec.label} precisa de pelo menos ${spec.minPlayers} jogadores — ` +
        `duas ${teamWord(spec.teamSize)}s de ${spec.teamSize}.`
      );
    case "above-maximum":
      return spec.formatType === "cup"
        ? `Uma ${spec.label} comporta no máximo ${MAX_CUP_TEAMS} ` +
            `${spec.teamSize === 1 ? "jogadores" : "equipes"} — ` +
            `${spec.maxPlayers} jogadores.`
        : `${spec.label} cabe no máximo ${spec.maxPlayers} jogadores` +
            (spec.teamSize > 1
              ? `, ou seja ${teamsFor(spec, spec.maxPlayers)} equipes de ${spec.teamSize}.`
              : ".");
    case "partial-team":
      return (
        `Em ${spec.label} as equipes são de ${spec.teamSize}, então o número ` +
        `de jogadores precisa ser múltiplo de ${spec.teamSize}.`
      );
    default:
      return "O número máximo de jogadores precisa ser maior que zero.";
  }
}

/** "12 equipes de 4", "48 jogadores", "2 equipes de 2". */
export function capacitySummary(spec: GameModeSpec, players: number): string {
  if (spec.teamSize === 1) {
    return `${players} ${players === 1 ? "jogador" : "jogadores"}`;
  }
  const teams = teamsFor(spec, players);
  return `${teams} ${teams === 1 ? "equipe" : "equipes"} de ${spec.teamSize}`;
}
