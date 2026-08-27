/**
 * AVISOS AO JOGADOR — as regras puras, sem `firebase-functions` e sem Admin
 * SDK, para que cada ramo seja testado sem rede. `index.ts` faz as leituras e
 * as entregas; aqui mora o que pode ser dito, para quem, e uma única vez.
 *
 * A REGRA QUE MANDA NESTE ARQUIVO: O AVISO NÃO CARREGA A CREDENCIAL.
 *
 * O ID e a senha da sala vivem só em `tournament_rooms/{id}`, que o cliente
 * não lê, e saem exclusivamente pelo `getTournamentRoom`, que confere a
 * inscrição antes de entregar. Um push ou um SMS quebra essa cadeia em três
 * lugares de uma vez: o corpo aparece na tela de bloqueio sem desbloquear o
 * aparelho, fica no histórico do sistema depois de lido, e sobrevive a uma
 * troca de chip. Quem estiver com o telefone na mão entra na sala — inscrito
 * ou não —, e a garantia inteira que o `room.ts` protege deixa de valer.
 *
 * Então o aviso diz que a sala ABRIU e leva ao torneio. O jogador toca, o app
 * chama `getTournamentRoom` autenticado, e a credencial aparece para quem tem
 * direito a ela. O jogador ganha os mesmos segundos; o segredo não viaja.
 */

/** Os tipos de aviso que existem. Um `kind` novo é uma decisão, não um acaso. */
export const NOTIFICATION_ROOM_OPEN = "room_open";

export type NotificationKind = typeof NOTIFICATION_ROOM_OPEN;

export const NOTIFICATION_KINDS: readonly NotificationKind[] = [
  NOTIFICATION_ROOM_OPEN,
];

/**
 * Um token do FCM é longo e opaco. O limite existe para que um token forjado
 * não vire um id de documento absurdo; a barra é proibida porque um id com
 * barra deixaria de ser um documento e viraria um caminho.
 */
export const MAX_DEVICE_TOKEN_LENGTH = 4096;

/** As plataformas que registram token hoje. iOS entra quando existir APNs. */
export const DEVICE_PLATFORMS = ["android", "ios", "web"] as const;

export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

const CONTROL_CHARS = /[\x00-\x1F\x7F]/;

export type TokenCheck =
  | { readonly ok: true; readonly token: string }
  | { readonly ok: false; readonly reason: "empty" | "too-long" | "malformed" };

/**
 * Valida um token de aparelho para uso como ID DE DOCUMENTO.
 *
 * O token é a chave de `device_tokens/{token}` de propósito: um aparelho tem
 * um token, e um token pertence a UMA conta por vez. Guardar por conta
 * (`device_tokens/{uid}/tokens/{...}`) deixaria o token de um aparelho vivo em
 * duas contas depois de uma troca de usuário no mesmo celular — e a conta
 * antiga continuaria recebendo aviso de torneio no aparelho de outra pessoa.
 * Com o token como chave, registrar simplesmente sobrescreve o dono.
 */
export function checkDeviceToken(token: unknown): TokenCheck {
  if (typeof token !== "string") return { ok: false, reason: "malformed" };
  const trimmed = token.trim();
  if (trimmed === "") return { ok: false, reason: "empty" };
  if (trimmed.length > MAX_DEVICE_TOKEN_LENGTH) {
    return { ok: false, reason: "too-long" };
  }
  // `.` e `..` são nomes reservados de documento; a barra viraria caminho.
  if (
    trimmed.includes("/") ||
    trimmed === "." ||
    trimmed === ".." ||
    CONTROL_CHARS.test(trimmed)
  ) {
    return { ok: false, reason: "malformed" };
  }
  return { ok: true, token: trimmed };
}

/** Uma plataforma desconhecida é recusada em vez de virar "outra". */
export function checkPlatform(platform: unknown): DevicePlatform | null {
  if (typeof platform !== "string") return null;
  const value = platform.trim().toLowerCase();
  return (DEVICE_PLATFORMS as readonly string[]).includes(value)
    ? (value as DevicePlatform)
    : null;
}

/**
 * O id do aviso na caixa de entrada, derivado do assunto.
 *
 * Determinístico porque a entrega roda DEPOIS da transação que inicia o
 * torneio: se ela falhar no meio e alguém reiniciar, a segunda passada precisa
 * escrever exatamente os mesmos documentos em vez de duplicar o aviso. Um id
 * aleatório transformaria cada retentativa numa notificação a mais.
 */
export function notificationIdFor(
  kind: NotificationKind,
  tournamentId: string
): string {
  return `${kind}_${tournamentId}`;
}

export interface NotificationBody {
  readonly title: string;
  readonly body: string;
}

/**
 * O texto do aviso de sala aberta.
 *
 * Sem ID e sem senha, pelo motivo no topo do arquivo. O corpo diz o que
 * aconteceu e o que fazer; a credencial espera atrás da autenticação.
 */
export function roomOpenNotification(
  tournamentTitle: unknown
): NotificationBody {
  const title = String(tournamentTitle ?? "").trim();
  return {
    // O nome do torneio no título é o que distingue dois avisos na bandeja
    // quando o jogador está em mais de um torneio no mesmo dia.
    title: title === "" ? "Seu torneio começou" : title,
    body: "A sala está aberta. Toque para ver o ID e a senha.",
  };
}

/**
 * Extrai o uid de um id de inscrição (`{uid}_{tournamentId}`).
 *
 * O `user_ref` é a fonte preferida; isto existe para a inscrição antiga cujo
 * `user_ref` esteja ausente. Devolve null em vez de adivinhar, porque um uid
 * errado manda o aviso de um torneio para a caixa de outra pessoa.
 */
export function uidFromRegistrationId(
  registrationId: string,
  tournamentId: string
): string | null {
  const suffix = `_${tournamentId}`;
  if (!registrationId.endsWith(suffix)) return null;
  const uid = registrationId.slice(0, -suffix.length);
  return uid === "" ? null : uid;
}
