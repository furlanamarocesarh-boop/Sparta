/**
 * The public profile — what a STRANGER may learn about a player.
 *
 * THIS MODULE EXISTS TO BE A WALL. Every other read path in this backend
 * refuses to show one player anything about another: the Rules deny reading
 * someone else's `users/{uid}`, a tournament result does not name its winner to
 * a non-admin, and `getPartnerEarnings` returns counts rather than people. A
 * public profile deliberately opens a hole in that, so the hole is cut here, in
 * one place, by an allowlist — never by projecting a document and removing the
 * fields someone remembered to remove.
 *
 * ADDRESSED BY PSEUDONYM, NEVER BY UID. `publicPlayerId` is 22 random bytes,
 * not derived from anything, and the map back to the account is Rules-denied to
 * every client in both directions. So a profile link identifies a player
 * without handing over the identifier that every other collection is keyed by.
 *
 * NENHUM DINHEIRO SEM O DONO TER PEDIDO. A regra era absoluta: nem saldo, nem
 * total ganho, nem quanto um campeonato pagou. Ela continua sendo o PADRÃO —
 * uma conta que nunca tocou em nada não mostra número nenhum, e quem não mexe
 * em configuração fica exatamente como estava.
 *
 * O que mudou é que o dono passou a poder ABRIR essa porta para o próprio
 * perfil, e só para o total de prêmios recebidos. Três coisas fazem disso uma
 * escolha e não um vazamento: o padrão é fechado, a decisão é de quem é dono do
 * número, e o que sai é UM total — nunca o saldo, nunca quanto foi gasto, nunca
 * quais campeonatos pagaram.
 *
 * SALDO NUNCA SAI, nem com a porta aberta. "Quanto essa pessoa ganhou ao longo
 * do tempo" é uma conquista; "quanto essa pessoa tem agora" é um convite.
 *
 * COUNTS, NOT HISTORY. How many tournaments someone played is a fact about
 * them; WHICH tournaments, and when, is a movement pattern. The first is a
 * profile, the second is surveillance.
 */

/** Exactly what leaves the server for a stranger. Nothing else is added. */
export interface PublicProfile {
  readonly publicPlayerId: string;
  /** The Sparta nickname. Empty when the player has not chosen one. */
  readonly nickname: string;
  /** Badge ids. The client resolves names and art from its own catalogue. */
  readonly badges: readonly string[];
  readonly tournamentsPlayed: number;
  readonly tournamentsCreated: number;

  /**
   * Campeonatos vencidos, de vida inteira.
   *
   * VENCER NÃO É GANHAR DINHEIRO: um pagamento por abate soma ao valor recebido
   * e não é vitória. A distinção é feita uma vez só, na categoria da transação
   * de prêmio, e serve tanto a este contador quanto ao ranking da temporada.
   */
  readonly tournamentsWon: number;

  /**
   * Se o dono abriu o total de prêmios para quem olha o perfil.
   *
   * SAI SEMPRE, verdadeiro ou falso, e isso é deliberado: quando é verdadeiro o
   * número está logo ali de todo jeito, e quando é falso a única coisa que um
   * estranho aprende é que existe uma configuração — que é pública por
   * natureza. Esconder o próprio interruptor obrigaria o dono a ter um segundo
   * caminho só para saber como ele está.
   */
  readonly earningsVisible: boolean;

  /**
   * O total de prêmios em DINHEIRO, em centavos — ou null quando fechado.
   *
   * SÓ DINHEIRO, e não é omissão: os prêmios em Créditos Beta não têm total
   * acumulado em lugar nenhum desta base — a liquidação beta move o saldo e
   * não mantém um "total ganho". Somar as duas economias seria proibido de
   * qualquer forma, então este campo diz o que é: reais recebidos em prêmio.
   */
  readonly lifetimeWonCentavos: number | null;
  /**
   * Month and year the account was created, never the exact instant.
   *
   * "Desde agosto de 2026" is the fact a profile wants to convey. A precise
   * timestamp is a correlation handle — it pins an account to a moment that can
   * be matched against a signup elsewhere.
   */
  readonly memberSince: string | null;
}

/** The stored fields this projection is allowed to read. */
export interface PublicProfileSource {
  readonly publicPlayerId: string;
  readonly username: unknown;
  readonly badges: unknown;
  readonly tournamentsPlayed: unknown;
  readonly tournamentsCreated: unknown;
  readonly tournamentsWon: unknown;
  readonly createdAt: unknown;

  /** `users/{uid}.earnings_public`. Ausente significa FECHADO. */
  readonly earningsPublic: unknown;

  /**
   * `wallets/{uid}.total_won` já em centavos, ou null quando não foi lido.
   *
   * O chamador só lê a carteira quando a porta está aberta — assim um perfil
   * fechado não custa a leitura, e o número nem chega perto desta função.
   */
  readonly lifetimeWonCentavos: unknown;
}

const MONTHS = [
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
];

/**
 * Builds the profile, key by key.
 *
 * BUILT UP, NOT STRIPPED DOWN. A projection that starts from the stored
 * document and deletes the private fields leaks every field added later by
 * someone who did not know this function existed. Starting from nothing means
 * a new field on `users/{uid}` is invisible here until somebody deliberately
 * adds it — which is the only version of this that stays safe over time.
 */
export function projectPublicProfile(
  source: PublicProfileSource
): PublicProfile {
  const visible = readVisibility(source.earningsPublic);
  return {
    publicPlayerId: source.publicPlayerId,
    nickname: readNickname(source.username),
    badges: readBadges(source.badges),
    tournamentsPlayed: readCount(source.tournamentsPlayed),
    tournamentsCreated: readCount(source.tournamentsCreated),
    tournamentsWon: readCount(source.tournamentsWon),
    memberSince: readMonth(source.createdAt),
    earningsVisible: visible,
    // A PORTA MANDA, e o número só existe quando ela está aberta. Mesmo que o
    // chamador passe um valor por engano com a porta fechada, ele morre aqui.
    lifetimeWonCentavos: visible ? readCentavos(source.lifetimeWonCentavos) : null,
  };
}

/**
 * A porta é FECHADA por padrão.
 *
 * Só o booleano verdadeiro abre. Ausente, nulo, `"true"` em texto ou qualquer
 * outra coisa lê como fechado — um campo corrompido não pode virar consentimento
 * que ninguém deu.
 */
function readVisibility(raw: unknown): boolean {
  return raw === true;
}

/** Centavos inteiros e não negativos, ou null. Prêmio recebido nunca é negativo. */
function readCentavos(raw: unknown): number | null {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0
    ? raw
    : null;
}

function readNickname(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

function readBadges(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((b): b is string => typeof b === "string" && b !== "");
}

/**
 * A stored count, or zero.
 *
 * Zero for anything unusable, because this is a display path for a stranger:
 * refusing to render a profile over a malformed counter would turn a data
 * fault into a broken page for someone who has no way to fix it.
 */
function readCount(raw: unknown): number {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : 0;
}

/** "agosto de 2026", or null when there is no usable date. */
function readMonth(raw: unknown): string | null {
  const date = toDate(raw);
  if (date === null) return null;
  return `${MONTHS[date.getUTCMonth()]} de ${date.getUTCFullYear()}`;
}

function toDate(raw: unknown): Date | null {
  if (raw instanceof Date) {
    return Number.isNaN(raw.getTime()) ? null : raw;
  }
  // Duck-typed so a Firestore Timestamp works without importing the Admin SDK.
  const candidate = raw as { toDate?: () => Date } | null | undefined;
  if (candidate && typeof candidate.toDate === "function") {
    try {
      const date = candidate.toDate();
      return date instanceof Date && !Number.isNaN(date.getTime())
        ? date
        : null;
    } catch {
      return null;
    }
  }
  return null;
}
