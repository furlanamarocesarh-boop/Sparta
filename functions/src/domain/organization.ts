/**
 * ORGANIZAÇÕES — as regras puras, sem `firebase-functions` e sem Admin SDK,
 * para que cada ramo seja testado sem rede.
 *
 * O QUE UMA ORGANIZAÇÃO É. O time que organiza campeonatos. Ela tem um DONO e
 * até um punhado de ADMINISTRADORES, e é a associação a ela — não uma claim no
 * token — que autoriza criar campeonato.
 *
 * DOIS PAPÉIS QUE NÃO SE MISTURAM, e esta é a decisão que manda no arquivo.
 * Até aqui `admin: true` significava duas coisas ao mesmo tempo: operar a
 * PLATAFORMA (dar Créditos Beta, aportar no caixa da casa) e organizar
 * CAMPEONATOS. Convidar alguém para ajudar a organizar não pode dar a essa
 * pessoa a chave do caixa. Então a claim continua sendo só do dono da
 * plataforma, e organizar passa a ser associação a uma organização.
 *
 * A ASSOCIAÇÃO É UM DOCUMENTO, NÃO UMA CLAIM. Uma custom claim só entra no
 * token na renovação seguinte — até uma hora depois —, e o cliente pode segurar
 * um token velho até lá. Isso significa que REVOGAR um administrador demoraria
 * uma hora para valer, e o convite que vaza é justamente o caso em que revogar
 * precisa valer agora. Um documento lido no servidor a cada chamada revoga no
 * instante em que é apagado.
 */

import { DomainError } from "./errors.js";

/** Onde as organizações vivem. */
export const ORGANIZATIONS_COLLECTION = "organizations";

/** A associação, endereçada por organização e uid. */
export const ORG_MEMBERS_SUBCOLLECTION = "members";

/** Os convites pendentes, endereçados PELO token. */
export const ORG_INVITES_COLLECTION = "organization_invites";

/**
 * Quantos administradores uma organização aceita, ALÉM do dono.
 *
 * Oito porque foi o número pedido. O teto existe para que um convite vazado não
 * vire uma organização com trezentos administradores antes de alguém perceber:
 * ele transforma um vazamento em, no máximo, oito intrusos — e o oitavo aceite
 * é recusado, o que é o sinal de que algo está errado.
 */
export const MAX_ORG_ADMINS = 8;

/** O dono conta à parte: ele não ocupa uma das oito vagas. */
export const MAX_ORG_MEMBERS = MAX_ORG_ADMINS + 1;

export const ROLE_OWNER = "owner";
export const ROLE_ADMIN = "admin";

export type OrgRole = typeof ROLE_OWNER | typeof ROLE_ADMIN;

export const MIN_ORG_NAME_LENGTH = 2;
export const MAX_ORG_NAME_LENGTH = 60;

/** Dígitos de um telefone brasileiro com DDD, com ou sem o nono dígito. */
export const MIN_PHONE_DIGITS = 10;
export const MAX_PHONE_DIGITS = 11;

const CONTROL_CHARS = /[\x00-\x1F\x7F]/;

/**
 * O formato congelado do token de convite.
 *
 * 32 bytes aleatórios em base64url sem preenchimento — 43 caracteres. O
 * `publicPlayerId` desta base usa 16 bytes, e para um identificador isso basta;
 * aqui não é identificador, é CHAVE: quem tem o token vira administrador. O
 * dobro de bytes custa nada e tira do horizonte qualquer tentativa de
 * adivinhação.
 */
export const INVITE_TOKEN_BYTES = 32;
export const INVITE_TOKEN_LENGTH = 43;
const INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Quantos minutos um convite vale.
 *
 * TRINTA, e é curto de propósito. Um link de uso único que nunca vence continua
 * sendo uma chave viva num grupo de mensagens meses depois; meia hora é o tempo
 * de mandar para alguém e a pessoa aceitar. Gerar de novo não custa nada e não
 * tem limite, então o prazo curto não atrapalha quem está do lado certo — só
 * quem encontrou o link velho.
 */
export const INVITE_TTL_MINUTES = 30;

export type NameRefusal = "empty" | "too-short" | "too-long" | "malformed";

export type NameCheck =
  | { readonly ok: true; readonly name: string }
  | { readonly ok: false; readonly reason: NameRefusal };

/** Valida e normaliza o nome da organização. */
export function checkOrgName(value: unknown): NameCheck {
  if (typeof value !== "string") return { ok: false, reason: "malformed" };
  // Espaços internos repetidos viram um só: "Sparta   Battle" e "Sparta Battle"
  // são o mesmo nome para quem lê, e guardar os dois convida a confusão.
  const name = value.trim().replace(/\s+/g, " ");
  if (name === "") return { ok: false, reason: "empty" };
  if (CONTROL_CHARS.test(name)) return { ok: false, reason: "malformed" };
  if (name.length < MIN_ORG_NAME_LENGTH) return { ok: false, reason: "too-short" };
  if (name.length > MAX_ORG_NAME_LENGTH) return { ok: false, reason: "too-long" };
  return { ok: true, name };
}

export type PhoneCheck =
  | { readonly ok: true; readonly digits: string }
  | { readonly ok: false; readonly reason: "empty" | "malformed" };

/**
 * Valida o telefone do dono e guarda SÓ OS DÍGITOS.
 *
 * Normalizar aqui existe para que "(11) 98888-7777" e "11988887777" não virem
 * dois cadastros diferentes do mesmo número.
 *
 * TELEFONE É DADO PESSOAL. Ele nunca vai para o cliente, nunca entra em log e
 * nunca aparece em mensagem de erro — as recusas abaixo dizem que o número é
 * inválido, jamais qual número foi recebido.
 */
export function checkOwnerPhone(value: unknown): PhoneCheck {
  if (typeof value !== "string") return { ok: false, reason: "malformed" };
  const raw = value.trim();
  if (raw === "") return { ok: false, reason: "empty" };
  const digits = raw.replace(/\D/g, "");
  if (
    digits.length < MIN_PHONE_DIGITS ||
    digits.length > MAX_PHONE_DIGITS
  ) {
    return { ok: false, reason: "malformed" };
  }
  // DDD brasileiro começa em 11; nenhum começa com 0 ou 1 no segundo dígito.
  if (digits[0] === "0") return { ok: false, reason: "malformed" };
  return { ok: true, digits };
}

/** True quando o token tem exatamente o formato congelado. */
export function isValidInviteToken(value: unknown): value is string {
  return typeof value === "string" && INVITE_TOKEN_PATTERN.test(value);
}

export type InviteRefusal =
  | "malformed"
  | "not-found"
  | "expired"
  | "already-used"
  | "revoked"
  | "already-member"
  | "org-full"
  | "own-invite";

export type InviteDecision =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: InviteRefusal };

export interface InviteState {
  /** O convite existe no banco. */
  readonly exists: boolean;
  /** Já foi aceito por alguém. Uso ÚNICO: o segundo aceite é recusado. */
  readonly usedByUid: string | null;
  /** O dono revogou. */
  readonly revoked: boolean;
  /** Quando expira, em milissegundos. */
  readonly expiresAtMs: number | null;
}

export interface AcceptContext {
  readonly nowMs: number;
  /** Quem está aceitando. */
  readonly uid: string;
  /** Quem criou a organização. */
  readonly ownerUid: string;
  /** Já é membro (dono ou administrador). */
  readonly alreadyMember: boolean;
  /** Quantos administradores a organização já tem, sem contar o dono. */
  readonly currentAdmins: number;
}

/**
 * Decide se um aceite de convite pode acontecer.
 *
 * A ORDEM DAS RECUSAS É DELIBERADA. As três primeiras — inexistente, expirado,
 * já usado — respondem sobre o TOKEN, e quem chega com um token qualquer
 * aprende apenas que ele não serve. As de baixo respondem sobre a
 * ORGANIZAÇÃO, e só são alcançadas por quem já provou ter um token válido.
 * Invertê-las contaria a um estranho quantas vagas a organização tem.
 */
export function decideInviteAccept(
  invite: InviteState,
  context: AcceptContext
): InviteDecision {
  if (!invite.exists) return { ok: false, reason: "not-found" };
  if (invite.revoked) return { ok: false, reason: "revoked" };

  // Expirado antes de "já usado": um convite vencido é vencido, tenha sido
  // usado ou não, e essa é a resposta mais simples de entender.
  if (invite.expiresAtMs !== null && context.nowMs >= invite.expiresAtMs) {
    return { ok: false, reason: "expired" };
  }

  // USO ÚNICO. O segundo aceite é recusado mesmo que seja a mesma pessoa —
  // aceitar duas vezes não é intenção de ninguém, é um link reencaminhado.
  if (invite.usedByUid !== null) return { ok: false, reason: "already-used" };

  // O dono aceitando o próprio convite queimaria um link de uso único sem
  // acrescentar ninguém, e ainda o faria virar "administrador" de si mesmo.
  if (context.uid === context.ownerUid) {
    return { ok: false, reason: "own-invite" };
  }

  if (context.alreadyMember) return { ok: false, reason: "already-member" };

  if (context.currentAdmins >= MAX_ORG_ADMINS) {
    return { ok: false, reason: "org-full" };
  }

  return { ok: true };
}

/** A mensagem em pt-BR de cada recusa. Nunca revela detalhe interno. */
export function inviteMessage(reason: InviteRefusal): string {
  switch (reason) {
    case "malformed":
    case "not-found":
      return "Este convite não é válido.";
    case "expired":
      return "Este convite expirou. Peça um novo para quem te chamou.";
    case "already-used":
      return "Este convite já foi usado. Cada link serve para uma pessoa.";
    case "revoked":
      return "Este convite foi cancelado.";
    case "already-member":
      return "Você já faz parte desta organização.";
    case "org-full":
      return `Esta organização já tem ${MAX_ORG_ADMINS} administradores.`;
    case "own-invite":
      return "Você é o dono desta organização.";
  }
}

/** A mensagem de cada recusa de nome. */
export function orgNameMessage(reason: NameRefusal): string {
  switch (reason) {
    case "empty":
      return "Dê um nome à organização.";
    case "too-short":
      return `O nome precisa ter pelo menos ${MIN_ORG_NAME_LENGTH} caracteres.`;
    case "too-long":
      return `O nome pode ter no máximo ${MAX_ORG_NAME_LENGTH} caracteres.`;
    case "malformed":
      return "O nome tem caracteres inválidos.";
  }
}

/**
 * Lança quando quem chama não pode organizar campeonatos por esta organização.
 *
 * Uma mensagem SÓ para os dois casos — não é membro, ou a organização não
 * existe. Distingui-los diria a um estranho que a organização existe.
 */
export function assertOrgMember(role: OrgRole | null): OrgRole {
  if (role === null) {
    throw new DomainError(
      "permission-denied",
      "Você não faz parte desta organização."
    );
  }
  return role;
}

/** Só o dono revoga convite, remove administrador e vê a contabilidade. */
export function assertOrgOwner(role: OrgRole | null): void {
  if (role !== ROLE_OWNER) {
    throw new DomainError(
      "permission-denied",
      "Apenas o dono da organização pode fazer isso."
    );
  }
}

/** Quando um convite criado agora expira. */
export function inviteExpiryMs(nowMs: number): number {
  return nowMs + INVITE_TTL_MINUTES * 60 * 1000;
}
