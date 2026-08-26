/**
 * COPA — mata-mata, chaveamento único.
 *
 * O QUE É. Duplas de confrontos; quem perde sai, quem ganha sobe. Nada de
 * pontos somados: a Copa não usa `matchPoints`, e cada confronto tem um
 * vencedor e um eliminado.
 *
 * QUALQUER NÚMERO DE PARTICIPANTES, com bye. Um chaveamento só fecha em
 * potência de dois, então doze equipes entram num chaveamento de dezesseis e
 * quatro delas passam direto na primeira rodada. Isso exige uma regra de QUEM
 * passa, e essa regra é a seguinte:
 *
 *   O CABEÇA DE CHAVE É A ORDEM DE INSCRIÇÃO. Quem se inscreveu primeiro é o
 *   cabeça 1. É a única regra verificável hoje — cada inscrição tem carimbo de
 *   tempo e o jogador pode conferir a própria — e não depende do ranking, que
 *   ainda não abriu. Quando a temporada abrir, trocar a semente por colocação
 *   é mudar UMA função, porque é a única coisa que decide isso.
 *
 * O BYE CAI SOZINHO DO CHAVEAMENTO CERTO. Com a semeadura clássica (1 contra o
 * último, 2 contra o penúltimo, e os dois só se encontram na final), as vagas
 * que sobram ficam justamente nos adversários dos primeiros cabeças. Não há
 * uma segunda regra dizendo quem ganha bye: quem ganha é quem enfrentaria uma
 * vaga vazia, e isso é consequência de semear direito.
 *
 * TUDO AQUI É PURO. Nenhuma leitura, nenhuma escrita, nenhum relógio. O
 * chaveamento é uma função da lista de inscritos e nada mais, o que é o que
 * torna possível conferi-lo.
 */

/** Quantas equipes cabem numa Copa. Teto, não plano de capacidade. */
export const MAX_CUP_ENTRANTS = 64;

/** Menos que isto não é mata-mata: é uma partida. */
export const MIN_CUP_ENTRANTS = 2;

/** Um lado de um confronto. Vazio quando é bye. */
export type Side = string | null;

export interface CupMatch {
  /** 1-based, contínuo em todo o chaveamento. É o id do confronto. */
  readonly matchNumber: number;
  /** 1-based. A rodada 1 é a primeira; a última é a final. */
  readonly round: number;
  /** Posição dentro da rodada, 1-based — a ordem em que a chave é lida. */
  readonly slot: number;
  readonly home: Side;
  readonly away: Side;
  /**
   * Quem passou. Já vem preenchido quando o confronto é bye — não há o que
   * jogar, e deixá-lo em aberto obrigaria o operador a lançar um resultado
   * que não existe.
   */
  readonly winner: Side;
  /** Verdadeiro quando um dos lados está vazio: passagem sem jogo. */
  readonly bye: boolean;
}

export interface Bracket {
  /** Potência de dois: o tamanho real do chaveamento. */
  readonly size: number;
  readonly rounds: number;
  readonly entrants: readonly string[];
  readonly matches: readonly CupMatch[];
}

/** O menor chaveamento que comporta [entrants]. */
export function bracketSizeFor(entrants: number): number {
  let size = 1;
  while (size < entrants) size *= 2;
  return Math.max(size, 2);
}

/**
 * A ordem clássica das sementes num chaveamento de [size].
 *
 * Devolve as posições do chaveamento em pares: `[1, 8, 4, 5, 2, 7, 3, 6]` num
 * chaveamento de oito significa 1x8, 4x5, 2x7, 3x6 — que é o que faz o cabeça
 * 1 e o cabeça 2 só poderem se encontrar na final.
 */
export function seedOrder(size: number): number[] {
  let order = [1, 2];
  while (order.length < size) {
    const total = order.length * 2 + 1;
    const next: number[] = [];
    for (const seed of order) {
      next.push(seed);
      next.push(total - seed);
    }
    order = next;
  }
  return order;
}

export type CupRefusal = "too-few" | "too-many" | "duplicate-entrant" | "bad-entrant";

export type CupCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: CupRefusal };

/** Se esta lista de inscritos dá um chaveamento. */
export function checkEntrants(entrants: readonly unknown[]): CupCheck {
  if (!Array.isArray(entrants) || entrants.length < MIN_CUP_ENTRANTS) {
    return { ok: false, reason: "too-few" };
  }
  if (entrants.length > MAX_CUP_ENTRANTS) {
    return { ok: false, reason: "too-many" };
  }
  const seen = new Set<string>();
  for (const entrant of entrants) {
    if (typeof entrant !== "string" || entrant.trim() === "") {
      return { ok: false, reason: "bad-entrant" };
    }
    if (seen.has(entrant)) return { ok: false, reason: "duplicate-entrant" };
    seen.add(entrant);
  }
  return { ok: true };
}

/**
 * Monta o chaveamento a partir dos inscritos EM ORDEM DE INSCRIÇÃO.
 *
 * A ordem da lista É a semeadura: índice 0 é o cabeça 1. Quem chama passa a
 * lista já ordenada por carimbo de inscrição — ordenar aqui exigiria que esta
 * função soubesse o que é um documento, e ela não sabe.
 */
export function buildBracket(entrants: readonly string[]): Bracket {
  if (!checkEntrants(entrants).ok) {
    return { size: 0, rounds: 0, entrants: [], matches: [] };
  }

  const size = bracketSizeFor(entrants.length);
  const rounds = Math.log2(size);
  const order = seedOrder(size);

  // A vaga de cada posição do chaveamento: o cabeça daquela semente, ou vazia.
  const slots: Side[] = order.map((seed) =>
    seed <= entrants.length ? entrants[seed - 1] : null
  );

  const matches: CupMatch[] = [];
  let matchNumber = 1;

  // ── Primeira rodada: os pares saem direto da semeadura ────────────────
  for (let i = 0; i < size; i += 2) {
    const home = slots[i];
    const away = slots[i + 1];
    const bye = home === null || away === null;
    matches.push({
      matchNumber,
      round: 1,
      slot: i / 2 + 1,
      home,
      away,
      // BYE JÁ RESOLVIDO. Quem enfrenta uma vaga vazia passou; deixar em aberto
      // faria o operador lançar um resultado de um jogo que não aconteceu.
      winner: bye ? home ?? away : null,
      bye,
    });
    matchNumber += 1;
  }

  // ── Rodadas seguintes: vazias, esperando quem sobe ────────────────────
  //
  // ELAS EXISTEM DESDE O SORTEIO. O jogador precisa ver o caminho inteiro no
  // dia do sorteio, não descobrir a semifinal quando ela aparecer.
  let inRound = size / 2;
  for (let round = 2; round <= rounds; round += 1) {
    inRound = inRound / 2;
    for (let slot = 1; slot <= inRound; slot += 1) {
      matches.push({
        matchNumber,
        round,
        slot,
        home: null,
        away: null,
        winner: null,
        bye: false,
      });
      matchNumber += 1;
    }
  }

  return { size, rounds, entrants: [...entrants], matches };
}

/** O confronto para onde o vencedor de [match] sobe, ou null se for a final. */
export function nextMatchNumber(
  bracket: Bracket,
  match: CupMatch
): number | null {
  if (match.round >= bracket.rounds) return null;
  const nextSlot = Math.ceil(match.slot / 2);
  const next = bracket.matches.find(
    (m) => m.round === match.round + 1 && m.slot === nextSlot
  );
  return next?.matchNumber ?? null;
}

export type AdvanceRefusal =
  | "match-not-found"
  | "not-a-side"
  | "match-not-ready"
  | "bye-match"
  | "already-decided";

export type AdvanceResult =
  | { readonly ok: true; readonly bracket: Bracket }
  | { readonly ok: false; readonly reason: AdvanceRefusal };

/**
 * Registra o vencedor de um confronto e o sobe para a próxima rodada.
 *
 * DEVOLVE UM CHAVEAMENTO NOVO. Nada é mutado: o chaveamento é o registro do que
 * aconteceu, e um resultado aplicado pela metade — vencedor gravado mas não
 * promovido — é um estado que ninguém consegue consertar.
 *
 * RELANÇAR É RECUSADO. Corrigir um resultado depois que o vencedor já jogou a
 * rodada seguinte não é corrigir: é reescrever o torneio a partir dali. Quem
 * precisa disso cancela o campeonato.
 */
export function declareWinner(
  bracket: Bracket,
  matchNumber: number,
  winner: string
): AdvanceResult {
  const match = bracket.matches.find((m) => m.matchNumber === matchNumber);
  if (match === undefined) return { ok: false, reason: "match-not-found" };
  if (match.bye) return { ok: false, reason: "bye-match" };
  if (match.winner !== null) return { ok: false, reason: "already-decided" };
  if (match.home === null || match.away === null) {
    return { ok: false, reason: "match-not-ready" };
  }
  if (winner !== match.home && winner !== match.away) {
    return { ok: false, reason: "not-a-side" };
  }

  const nextNumber = nextMatchNumber(bracket, match);
  const matches = bracket.matches.map((m) => {
    if (m.matchNumber === matchNumber) return { ...m, winner };
    if (m.matchNumber === nextNumber) {
      // O lado ímpar do confronto anterior entra em casa; o par, fora. É o que
      // mantém a chave legível de cima para baixo.
      return match.slot % 2 === 1
        ? { ...m, home: winner }
        : { ...m, away: winner };
    }
    return m;
  });

  return { ok: true, bracket: { ...bracket, matches } };
}

/**
 * Sobe para a rodada seguinte todo bye já resolvido no sorteio.
 *
 * Chamado UMA VEZ depois de montar. Sem isto, quem passou direto ficaria de
 * fora da segunda rodada até alguém lançar um resultado de um jogo que não
 * aconteceu.
 *
 * UM PASSO SÓ BASTA, e isso é demonstrável em vez de esperado. Um bye em
 * cadeia exigiria um confronto com os DOIS lados vazios, e isso não existe:
 * `size` é a MENOR potência de dois que comporta `n`, logo `n > size/2`, logo
 * o número de vagas vazias `size - n` é menor que `size/2`. Na semeadura
 * clássica a semente `k` enfrenta `size+1-k`, então as duas serem vazias
 * pediria `k > n` e `k < size+1-n`; como `size+1-n <= n+1`, sai `k <= n`, que
 * contradiz `k > n`. Nenhum confronto nasce sem ninguém, e nenhum bye promove
 * para outro bye.
 */
export function settleByes(bracket: Bracket): Bracket {
  let matches = [...bracket.matches];

  for (const match of bracket.matches) {
    if (match.winner === null) continue;
    const nextNumber = nextMatchNumber(bracket, match);
    if (nextNumber === null) continue;

    matches = matches.map((m) =>
      m.matchNumber === nextNumber
        ? match.slot % 2 === 1
          ? { ...m, home: match.winner }
          : { ...m, away: match.winner }
        : m
    );
  }

  return { ...bracket, matches };
}

/** Monta o chaveamento COM os byes já subidos — o estado do sorteio. */
export function drawBracket(entrants: readonly string[]): Bracket {
  return settleByes(buildBracket(entrants));
}

/** Se todo confronto já tem vencedor. */
export function isComplete(bracket: Bracket): boolean {
  return bracket.matches.every((m) => m.winner !== null);
}

/** O campeão, ou null enquanto a final não foi decidida. */
export function champion(bracket: Bracket): string | null {
  const final = bracket.matches.find((m) => m.round === bracket.rounds);
  return final?.winner ?? null;
}

/**
 * A classificação final, do campeão para baixo.
 *
 * QUEM PERDEU MAIS TARDE FICA NA FRENTE, que é como toda copa é lida: os dois
 * semifinalistas ficam à frente dos quatro que caíram nas quartas.
 *
 * O EMPATE DESEMPATA PELA ORDEM DE INSCRIÇÃO, porque a divisão da premiação
 * paga por POSIÇÃO e posições precisam de ordem total. Dois semifinalistas
 * empatam de verdade num mata-mata; se a divisão paga 3º e 4º diferente,
 * alguém tem que ser o 3º, e a ordem de inscrição é a mesma régua que decidiu
 * a semeadura — não uma segunda regra inventada no fim.
 */
export function cupStandings(bracket: Bracket): string[] {
  const seedOf = new Map<string, number>();
  bracket.entrants.forEach((uid, index) => seedOf.set(uid, index));

  /** A última rodada que cada participante alcançou. */
  const lastRound = new Map<string, number>();
  const eliminated = new Set<string>();

  for (const match of bracket.matches) {
    for (const side of [match.home, match.away]) {
      if (side === null) continue;
      lastRound.set(side, Math.max(lastRound.get(side) ?? 0, match.round));
    }
    if (match.winner === null) continue;
    const loser =
      match.home === match.winner
        ? match.away
        : match.away === match.winner
          ? match.home
          : null;
    if (loser !== null) eliminated.add(loser);
  }

  const winner = champion(bracket);

  return [...bracket.entrants].sort((a, b) => {
    if (a === winner) return -1;
    if (b === winner) return 1;
    const roundA = lastRound.get(a) ?? 0;
    const roundB = lastRound.get(b) ?? 0;
    if (roundA !== roundB) return roundB - roundA;
    // Quem ainda está vivo fica à frente de quem já caiu na mesma rodada.
    const outA = eliminated.has(a) ? 1 : 0;
    const outB = eliminated.has(b) ? 1 : 0;
    if (outA !== outB) return outA - outB;
    return (seedOf.get(a) ?? 0) - (seedOf.get(b) ?? 0);
  });
}

/** Uma frase por recusa, para o operador. */
export function cupMessage(reason: string): string {
  switch (reason) {
    case "too-few":
      return `Uma Copa precisa de pelo menos ${MIN_CUP_ENTRANTS} inscritos.`;
    case "too-many":
      return `Uma Copa comporta no máximo ${MAX_CUP_ENTRANTS} inscritos.`;
    case "duplicate-entrant":
      return "O mesmo inscrito aparece duas vezes no chaveamento.";
    case "bad-entrant":
      return "Há um inscrito inválido no chaveamento.";
    case "match-not-found":
      return "Confronto não encontrado neste chaveamento.";
    case "not-a-side":
      return "O vencedor precisa ser um dos dois lados do confronto.";
    case "match-not-ready":
      return "Este confronto ainda não tem os dois lados definidos.";
    case "bye-match":
      return "Este confronto é passagem direta: não há resultado a lançar.";
    case "already-decided":
      return "Este confronto já foi decidido.";
    default:
      return "Chaveamento inválido.";
  }
}
