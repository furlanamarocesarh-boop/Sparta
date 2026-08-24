import { DomainError } from "./errors.js";

/**
 * Applying to become a partner.
 *
 * WHY SELF-SERVICE. Registering a partner used to mean an admin typing their
 * Firebase UID — a value no creator knows about themselves and no support
 * conversation can produce reliably. So the person applies, and the UID comes
 * from their own verified token, where it is always correct and can never be
 * someone else's.
 *
 * WHAT THIS DATA IS. Platform handle, follower count and average views are
 * PERSONAL DATA about a real person's public identity and audience — a
 * different category from anything else this backend holds, which until now was
 * a uid, a wallet and tournament history. It is collected because it is the
 * whole basis of the decision, and for no other purpose: nothing in this
 * module ranks, scores or automates an approval.
 *
 * ONE APPLICATION PER ACCOUNT, keyed by uid. That makes a resubmission an
 * update rather than a queue of duplicates, and it means an admin reviewing
 * the list never sees the same person twice.
 */

export const PARTNER_APPLICATIONS_COLLECTION = "partner_applications";

export type ApplicationStatus = "pending" | "approved" | "rejected";

/** The platforms an audience can be on. A closed list: free text here would
 * make the admin's list unsortable and invite junk. */
export const PARTNER_PLATFORMS = [
  "instagram",
  "tiktok",
  "youtube",
  "twitch",
  "kwai",
  "x",
  "outra",
] as const;

export type PartnerPlatform = (typeof PARTNER_PLATFORMS)[number];

export interface PartnerApplicationInput {
  readonly platform: unknown;
  readonly handle: unknown;
  readonly followers: unknown;
  readonly averageViews: unknown;
  readonly expectedPlayers: unknown;
  readonly proposedCode: unknown;
}

export interface PartnerApplication {
  readonly platform: PartnerPlatform;
  readonly handle: string;
  readonly followers: number;
  readonly averageViews: number;
  readonly expectedPlayers: number;
  readonly proposedCode: string;
}

/** Longest a handle or code may be. Generous, but bounded: an unbounded
 * string is a storage and display problem, not a form field. */
const MAX_HANDLE = 64;
const MAX_CODE = 32;

/** Above this, the number is a boast or a typo — and either way it is not a
 * figure an admin should see presented as fact. */
const MAX_AUDIENCE = 1_000_000_000;

/**
 * Reads and validates one application, or refuses.
 *
 * EVERY NUMBER IS A WHOLE, NON-NEGATIVE COUNT. Zero is legitimate — a creator
 * starting out has zero average views and may still be worth approving — so
 * zero is accepted and only nonsense is refused. The decision belongs to the
 * admin, and a form that silently rejects small numbers would be making it.
 */
export function parsePartnerApplication(
  input: PartnerApplicationInput
): PartnerApplication {
  const platform = String(input.platform ?? "").trim().toLowerCase();
  if (!(PARTNER_PLATFORMS as readonly string[]).includes(platform)) {
    throw new DomainError("invalid-argument", "Escolha uma plataforma válida.");
  }

  const handle = String(input.handle ?? "").trim();
  if (handle === "" || handle.length > MAX_HANDLE) {
    throw new DomainError(
      "invalid-argument",
      "Informe seu perfil na plataforma."
    );
  }

  const proposedCode = String(input.proposedCode ?? "")
    .trim()
    .toLowerCase();
  if (proposedCode === "" || proposedCode.length > MAX_CODE) {
    throw new DomainError(
      "invalid-argument",
      "Informe o código que você quer no seu link."
    );
  }

  return {
    platform: platform as PartnerPlatform,
    handle,
    followers: readCount(input.followers, "seguidores"),
    averageViews: readCount(input.averageViews, "média de visualizações"),
    expectedPlayers: readCount(input.expectedPlayers, "jogadores estimados"),
    proposedCode,
  };
}

function readCount(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new DomainError(
      "invalid-argument",
      `O campo "${field}" precisa ser um número inteiro não negativo.`
    );
  }
  if (value > MAX_AUDIENCE) {
    throw new DomainError("invalid-argument", `O campo "${field}" é inválido.`);
  }
  return value;
}

/**
 * Whether an application in [current] may move to [next].
 *
 * A DECIDED APPLICATION IS NOT REOPENED by the applicant. Resubmitting after a
 * rejection would let someone bury the decision under a fresh form; changing an
 * approved one would let a partner rewrite the basis on which they were
 * accepted. Both are admin moves, and both keep the previous state visible.
 */
export function canApplicantSubmit(current: ApplicationStatus | null): boolean {
  return current === null || current === "pending";
}

/** Refusal copy for an applicant who cannot submit. */
export function submitRefusalMessage(current: ApplicationStatus): string {
  return current === "approved"
    ? "Você já é parceiro."
    : "Sua candidatura já foi avaliada. Fale com o suporte para revisá-la.";
}
