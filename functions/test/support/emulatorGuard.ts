/**
 * The fail-closed guard every E2E suite runs BEFORE touching any SDK.
 *
 * Extracted verbatim from the two original suites, which carried
 * byte-equivalent copies. One shared definition means a third suite cannot
 * quietly ship a weaker check, and a future tightening reaches every suite at
 * once.
 *
 * It refuses rather than warns, and it refuses on ABSENCE as much as on a wrong
 * value: an unset emulator host is treated exactly like a production host,
 * because "I cannot prove this is local" and "this is not local" carry the same
 * risk. `.firebaserc` names the REAL project as the default, so a suite that
 * merely forgot its environment would otherwise write to production.
 */

/** True for loopback authorities only — never a routable host. */
export function localHost(h: string): boolean {
  const bare = h.replace(/^https?:\/\//, "");
  return /^(127\.0\.0\.1|localhost|0\.0\.0\.0|\[?::1\]?)(:|$)/.test(bare);
}

/**
 * Aborts unless this process is provably pointed at a local emulator suite
 * under a `demo-` project.
 *
 * `fallbackProjectId` is used only when neither project environment variable is
 * set; it must itself be a `demo-` id, so the fallback can never open the gate.
 */
export function assertEmulatorOnly(fallbackProjectId: string): void {
  const fail = (m: string): never => {
    throw new Error(`FAIL-CLOSED (E2E aborted): ${m}`);
  };

  const projectId =
    process.env.GCLOUD_PROJECT ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    fallbackProjectId;
  if (!projectId.startsWith("demo-")) {
    fail(`project id "${projectId}" must start with "demo-"`);
  }

  const fsHost = process.env.FIRESTORE_EMULATOR_HOST;
  const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  if (!fsHost) fail("FIRESTORE_EMULATOR_HOST is not set");
  if (!authHost) fail("FIREBASE_AUTH_EMULATOR_HOST is not set");
  if (!localHost(fsHost!)) fail(`FIRESTORE_EMULATOR_HOST "${fsHost}" is not local`);
  if (!localHost(authHost!)) {
    fail(`FIREBASE_AUTH_EMULATOR_HOST "${authHost}" not local`);
  }

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    fail(
      "GOOGLE_APPLICATION_CREDENTIALS is set — refusing to run with a possible real credential"
    );
  }
}
