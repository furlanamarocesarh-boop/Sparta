import { SPARTA_FEE_BPS, BPS_DENOMINATOR } from "./partnerReferral.js";

/**
 * O REPASSE AO CRIADOR — quanto da sobra de um campeonato é dele.
 *
 * A REGRA DE PRODUTO, nas palavras do dono: "a sobra é do criador, a gente só
 * tem a taxa mesmo". A plataforma retém 7,5% da inscrição em dinheiro — a taxa
 * já aprovada em `partnerReferral.ts`, embutida no preço, então o jogador nunca
 * paga a mais — e o que sobra depois dos prêmios e da taxa vai para quem
 * organizou.
 *
 * O QUE MUDA NO CAIXA. Até aqui a margem inteira ficava com a casa. Agora a
 * casa fica com a TAXA e o resto sai. É a mesma soma, repartida — nenhum
 * centavo é criado aqui.
 *
 * TRÊS PORTAS FECHADAS, e cada uma é uma decisão registrada:
 *
 *  - CRÉDITO BETA NÃO REPASSA NADA. Ele não é dinheiro: é ficha de teste que a
 *    plataforma emite de graça, e a política aprovada já dizia que campeonato
 *    beta não gera taxa. Repassar criaria crédito que ninguém emitiu.
 *  - SEM ORGANIZAÇÃO, NINGUÉM RECEBE. Quem recebe é o DONO da organização — o
 *    campeonato é do time, e o administrador convidado organiza em nome dele.
 *    Campeonato criado antes das organizações não tem dona, e inventar um
 *    destinatário para dinheiro é a última coisa que este arquivo faria.
 *  - MARGEM NEGATIVA NÃO VIRA DÍVIDA. Quando a premiação passa do arrecadado,
 *    quem cobriu foi o caixa da plataforma. O criador recebe zero — nunca um
 *    valor negativo, e nunca uma cobrança.
 */

/** A taxa da plataforma, em pontos-base. A mesma da política do parceiro. */
export const PLATFORM_FEE_BPS = SPARTA_FEE_BPS;

export type PayoutRefusal =
  | "not-cash"
  | "no-payee"
  | "no-margin"
  | "fee-eats-margin"
  | "invalid-amount";

export type CreatorPayoutDecision =
  | {
      readonly kind: "pay";
      /** O que fica com a plataforma. */
      readonly feeCentavos: number;
      /** O que vai para o dono da organização. */
      readonly creatorCentavos: number;
      /** feeCentavos + creatorCentavos, sempre igual à margem. */
      readonly marginCentavos: number;
    }
  | {
      readonly kind: "none";
      readonly reason: PayoutRefusal;
      /** O que fica com a plataforma quando não há repasse: a margem inteira. */
      readonly feeCentavos: number;
    };

export interface CreatorPayoutInput {
  /** `cash` ou `beta_credit`. */
  readonly economy: string;
  /** O arrecadado real do campeonato, em centavos. */
  readonly poolCentavos: number;
  /** O total distribuído em prêmios, em centavos. */
  readonly paidCentavos: number;
  /** O dono da organização dona do campeonato, ou null. */
  readonly payeeUid: string | null;
}

const isWholeNonNegative = (n: number): boolean =>
  Number.isSafeInteger(n) && n >= 0;

/**
 * Reparte a margem entre a plataforma e quem organizou.
 *
 * A TAXA É SOBRE O ARRECADADO, não sobre a sobra. É o que a política diz —
 * 7,5% da inscrição — e é a única leitura que não muda de valor conforme o
 * criador escolhe a premiação: cobrar sobre a sobra premiaria quem paga pouco
 * e puniria quem paga bem.
 *
 * ARREDONDA A TAXA PARA BAIXO. Com centavos inteiros alguém tem que ficar com
 * a fração, e ela fica com o criador — a plataforma nunca cobra a mais do que
 * a política diz, nem por um centavo.
 */
export function decideCreatorPayout(
  input: CreatorPayoutInput
): CreatorPayoutDecision {
  const { economy, poolCentavos, paidCentavos, payeeUid } = input;

  if (!isWholeNonNegative(poolCentavos) || !isWholeNonNegative(paidCentavos)) {
    return { kind: "none", reason: "invalid-amount", feeCentavos: 0 };
  }

  const marginCentavos = poolCentavos - paidCentavos;

  // A ORDEM DAS RECUSAS É DELIBERADA: as que não dependem de dinheiro vêm
  // primeiro, para que a razão devolvida descreva a causa mais fundamental.
  if (economy !== "cash") {
    return {
      kind: "none",
      reason: "not-cash",
      feeCentavos: Math.max(0, marginCentavos),
    };
  }
  if (payeeUid === null || payeeUid === "") {
    return {
      kind: "none",
      reason: "no-payee",
      feeCentavos: Math.max(0, marginCentavos),
    };
  }
  if (marginCentavos <= 0) {
    // Subsidiado: quem cobriu foi a casa, e o criador não deve nada.
    return { kind: "none", reason: "no-margin", feeCentavos: 0 };
  }

  const feeCentavos = Math.floor((poolCentavos * PLATFORM_FEE_BPS) / BPS_DENOMINATOR);

  // A TAXA NUNCA COME MAIS DO QUE A MARGEM. Um campeonato que premiou quase
  // tudo pode sobrar menos que a taxa — aí a plataforma fica com o que sobrou e
  // o criador com zero. Cobrar o que não existe viraria saldo negativo.
  if (feeCentavos >= marginCentavos) {
    return { kind: "none", reason: "fee-eats-margin", feeCentavos: marginCentavos };
  }

  return {
    kind: "pay",
    feeCentavos,
    creatorCentavos: marginCentavos - feeCentavos,
    marginCentavos,
  };
}

/** A categoria da linha de razão do repasse. */
export const CREATOR_PAYOUT_CATEGORY = "creator_payout";

/** Id determinístico: um repasse por campeonato, nunca dois. */
export function creatorPayoutId(tournamentId: string): string {
  return `creator_payout_${tournamentId}`;
}
