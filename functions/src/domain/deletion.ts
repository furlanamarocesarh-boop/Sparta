import {
  ECONOMY_BETA_CREDIT,
  ECONOMY_CASH,
  type EconomyType,
} from "./economy.js";

/**
 * APAGAR UM CAMPEONATO — as regras puras, sem Admin SDK e sem
 * `firebase-functions`, para que cada ramo seja testado sem rede.
 *
 * O QUE "APAGADO" SIGNIFICA AQUI. Some o campeonato e tudo que É o campeonato:
 * o documento, as inscrições, a sala, o chaveamento e os avisos que apontavam
 * para ele. NÃO somem as transações. Elas não pertencem ao campeonato — são o
 * extrato da carteira de quem pagou, e apagar o histórico financeiro de outra
 * pessoa porque o criador desistiu do torneio seria pior do que qualquer
 * sobra. O vínculo com o torneio é anulado para que nenhuma linha do extrato
 * aponte para um documento que não existe mais.
 *
 * O DINHEIRO VOLTA ANTES, NUNCA DEPOIS. Apagar não é um jeito de ficar com o
 * dinheiro dos inscritos: se o campeonato ainda retém entrada paga, o
 * reembolso acontece primeiro, pelo caminho do cancelamento — que é atômico,
 * devolve ao bolso exato que pagou e é exatamente-uma-vez. Só então os
 * documentos somem.
 *
 * SÓ QUEM CRIOU. Em toda a base, `creator_uid` nunca foi consultado como
 * autorização: qualquer admin pode agir sobre o campeonato de qualquer outro.
 * Isso passa numa ação reversível como cancelar; numa ação IRREVERSÍVEL, não.
 * Aqui o dono do documento é conferido.
 */

/** Por que a exclusão foi recusada. Para logs e testes. */
export type DeletionRefusal =
  | "not-creator"
  | "running-with-players"
  | "too-many-registrations";

export type DeletionDecision =
  /** Reembolsar primeiro (pelo caminho do cancelamento) e então apagar. */
  | { readonly kind: "refund-then-delete" }
  /** Apagar direto: não há entrada retida a devolver. */
  | { readonly kind: "delete" }
  | { readonly kind: "refuse"; readonly reason: DeletionRefusal };

/**
 * O teto de inscrições, herdado do cancelamento.
 *
 * O reembolso inteiro tem que caber numa transação só — reembolso parcial não
 * existe nesta base, de propósito. Como a exclusão delega o reembolso ao
 * cancelamento, ela herda o mesmo teto em vez de inventar outro.
 */
export const MAX_DELETABLE_REGISTRATIONS = 150;

export interface DeletionInput {
  /** Status persistido do torneio, já normalizado em minúsculas. */
  readonly status: string;
  /** Inscrições com status "registered" — as que ainda retêm dinheiro. */
  readonly activeRegistrations: number;
  /** O chamador é quem criou o campeonato. */
  readonly isCreator: boolean;
  /** Há resultado persistido ou prêmio pago: o dinheiro já se moveu. */
  readonly hasSettlement: boolean;
}

/**
 * Decide o que fazer com um pedido de exclusão.
 *
 * A ORDEM DAS RECUSAS IMPORTA. Quem não é o dono é recusado ANTES de qualquer
 * outra coisa: as demais mensagens descrevem o estado do campeonato, e revelar
 * o estado do campeonato alheio a quem não pode mexer nele é responder uma
 * pergunta que não foi autorizada.
 */
export function decideDeletion(input: DeletionInput): DeletionDecision {
  if (!input.isCreator) {
    return { kind: "refuse", reason: "not-creator" };
  }

  // EM ANDAMENTO COM GENTE DENTRO é a única recusa de estado que sobra.
  //
  // O dinheiro dos inscritos está no bolo e o prêmio ainda não saiu. Apagar
  // sem devolver seria ficar com o dinheiro deles; devolver no meio da partida
  // é o que o contrato do cancelamento recusa de propósito, porque o jogo está
  // acontecendo. Declarar o resultado — ou não ter ninguém inscrito — resolve
  // as duas coisas.
  if (input.status === "in_progress" && input.activeRegistrations > 0) {
    return { kind: "refuse", reason: "running-with-players" };
  }

  if (input.activeRegistrations > MAX_DELETABLE_REGISTRATIONS) {
    return { kind: "refuse", reason: "too-many-registrations" };
  }

  // LIQUIDADO NÃO REEMBOLSA. As entradas já viraram prêmio pago; devolvê-las
  // agora criaria dinheiro do nada — o jogador receberia o prêmio e a entrada
  // de volta. Os documentos somem, o extrato de quem pagou e de quem ganhou
  // continua contando a verdade.
  if (input.hasSettlement || input.activeRegistrations === 0) {
    return { kind: "delete" };
  }

  return { kind: "refund-then-delete" };
}

/** A mensagem em pt-BR de cada recusa. Nunca revela detalhe interno. */
export function deletionMessage(reason: DeletionRefusal): string {
  switch (reason) {
    case "not-creator":
      return "Só quem criou o campeonato pode apagá-lo.";
    case "running-with-players":
      return "Não dá para apagar um campeonato em andamento com jogadores "
        + "inscritos. Declare o resultado primeiro.";
    case "too-many-registrations":
      return "O campeonato tem inscrições demais para ser apagado de uma vez.";
  }
}

/**
 * O rótulo da economia para o extrato que sobrevive ao campeonato.
 *
 * Guardado como TEXTO junto da transação porque, depois que o torneio some,
 * não há mais de onde derivá-lo — e uma linha de extrato sem economia é uma
 * linha que ninguém consegue ler, já que as duas nunca podem ser somadas.
 */
export function economyLabel(economy: EconomyType): string {
  return economy === ECONOMY_BETA_CREDIT ? "Créditos Beta" : "Dinheiro";
}

/** As economias conhecidas, para o teste exaustivo do rótulo. */
export const KNOWN_ECONOMIES: readonly EconomyType[] = [
  ECONOMY_CASH,
  ECONOMY_BETA_CREDIT,
];
