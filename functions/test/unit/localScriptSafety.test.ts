import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

/**
 * LOCAL SCRIPT SAFETY — the deployment-surface guard's counterpart for
 * package.json, and the reason `.firebaserc` can no longer decide anything.
 *
 * `.firebaserc` sets `"default": "sparta-battle"`, the REAL project. Any
 * `firebase` invocation without `--project` inherits it, and `admin.initializeApp()`
 * (src/index.ts) binds to whatever Firestore it can reach — production included.
 * Nothing in `functions/src` reads FIRESTORE_EMULATOR_HOST, so the RUNTIME cannot
 * detect that mistake: the only place it can be prevented is here, statically.
 *
 * The rules below are what "fail-closed against production" means concretely:
 *  - every `firebase` call names its project EXPLICITLY;
 *  - every emulator call names the DEMO project;
 *  - the Functions emulator never starts alone, because functions code reaches
 *    Firestore and Auth the moment it is loaded;
 *  - `functions:shell` is refused outright — it cannot guarantee the emulator
 *    host variables, so it is unsafe by construction, not by configuration;
 *  - a broad deploy is refused; the runbook requires one function at a time.
 *
 * This mirrors functions/test/unit/firestoreIndexes.test.ts (versioned config
 * read from disk) and functions/test/unit/functionRegions.test.ts (a closed,
 * explicitly authorized surface).
 */

const DEMO_PROJECT = "demo-sparta-battle";
const REAL_PROJECT = "sparta-battle";

/** The ONLY scripts allowed to name the real project, and why. */
const PRODUCTION_READ_ONLY = new Set(["logs"]);

/** Scripts that must refuse to run at all, fail-closed. */
const MUST_REFUSE = new Set(["shell", "deploy"]);

function packageJsonPath(): string {
  const cwd = process.cwd();
  for (const candidate of [
    join(cwd, "package.json"),
    join(cwd, "functions", "package.json"),
    join(cwd, "..", "package.json"),
  ]) {
    if (existsSync(candidate)) {
      const parsed = JSON.parse(readFileSync(candidate, "utf8"));
      if (parsed?.scripts?.["test:e2e"]) return candidate;
    }
  }
  throw new Error(`cannot locate functions/package.json from cwd: ${cwd}`);
}

const scripts: Record<string, string> = JSON.parse(
  readFileSync(packageJsonPath(), "utf8")
).scripts;

const entries = Object.entries(scripts);

/** Every `--project X` a script pins, in order. */
function projectsOf(command: string): string[] {
  return [...command.matchAll(/--project\s+([^\s"']+)/g)].map((m) => m[1]);
}

/** Every `--only a,b,c` list a script pins, split into products. */
function onlyListsOf(command: string): string[][] {
  return [...command.matchAll(/--only\s+([A-Za-z0-9:,]+)/g)].map((m) =>
    m[1].split(",")
  );
}

function invokesFirebaseCli(command: string): boolean {
  return /(^|[\s&|;])firebase\s/.test(command);
}

/**
 * A script that only prints and exits non-zero. It runs no tool, so its TEXT is
 * a message to a human, not a command — flag-shaped words inside that message
 * must not be read as if they configured anything.
 */
function isRefusal(command: string): boolean {
  return /process\.exit\(1\)/.test(command) && !invokesFirebaseCli(command);
}

function startsEmulators(command: string): boolean {
  return /firebase\s+emulators:(start|exec)\b/.test(command);
}

describe("functions/package.json — nenhum script depende do default de .firebaserc", () => {
  it("existe e expõe as três suítes", () => {
    for (const name of ["test", "test:rules", "test:e2e"]) {
      assert.ok(scripts[name], `script ausente: ${name}`);
    }
  });

  it("toda invocação da CLI firebase fixa --project explicitamente", () => {
    for (const [name, command] of entries) {
      if (!invokesFirebaseCli(command)) continue;
      assert.ok(
        projectsOf(command).length > 0,
        `"${name}" chama a CLI firebase sem --project e herdaria "${REAL_PROJECT}" de .firebaserc: ${command}`
      );
    }
  });

  it("nenhum script não autorizado nomeia o projeto REAL", () => {
    for (const [name, command] of entries) {
      if (PRODUCTION_READ_ONLY.has(name)) continue;
      if (isRefusal(command)) continue; // texto humano, não configuração
      for (const project of projectsOf(command)) {
        assert.notEqual(
          project,
          REAL_PROJECT,
          `"${name}" aponta para o projeto real: ${command}`
        );
        assert.ok(
          project.startsWith("demo-"),
          `"${name}" usa um projeto sem prefixo demo-: ${project}`
        );
      }
    }
  });
});

describe("functions/package.json — emuladores", () => {
  it("todo script que sobe emulador fixa demo-sparta-battle", () => {
    for (const [name, command] of entries) {
      if (!startsEmulators(command)) continue;
      const projects = projectsOf(command);
      assert.ok(
        projects.includes(DEMO_PROJECT),
        `"${name}" sobe emulador sem --project ${DEMO_PROJECT}: ${command}`
      );
    }
  });

  it("o emulador de Functions NUNCA sobe sozinho — auth e firestore juntos", () => {
    let checked = 0;
    for (const [name, command] of entries) {
      for (const only of onlyListsOf(command)) {
        if (!only.includes("functions")) continue;
        checked += 1;
        assert.ok(
          only.includes("firestore"),
          `"${name}" sobe functions sem firestore: o Admin SDK alcançaria a Firestore real. ${command}`
        );
        assert.ok(
          only.includes("auth"),
          `"${name}" sobe functions sem auth: os tokens cairiam no Auth real. ${command}`
        );
      }
    }
    assert.ok(checked >= 2, `esperava ao menos serve e test:e2e, vi ${checked}`);
  });

  it("nenhum script usa functions:shell — ele não garante os hosts de emulador", () => {
    for (const [name, command] of entries) {
      assert.ok(
        !/functions:shell/.test(command),
        `"${name}" usa functions:shell, que não exporta FIRESTORE_EMULATOR_HOST nem FIREBASE_AUTH_EMULATOR_HOST: ${command}`
      );
    }
  });
});

describe("functions/package.json — publicação", () => {
  it("nenhum script executa deploy amplo", () => {
    for (const [name, command] of entries) {
      assert.ok(
        !/firebase\s+deploy\b/.test(command),
        `"${name}" executa um deploy pela CLI; o runbook exige alvo seletivo manual: ${command}`
      );
    }
  });
});

describe("functions/package.json — scripts fail-closed", () => {
  for (const name of MUST_REFUSE) {
    it(`"${name}" recusa execução com status diferente de zero`, () => {
      const command = scripts[name];
      assert.ok(command, `script ausente: ${name}`);
      assert.ok(
        /process\.exit\(1\)/.test(command),
        `"${name}" deve sair com status 1: ${command}`
      );
      assert.ok(
        !invokesFirebaseCli(command),
        `"${name}" deve recusar ANTES de tocar a CLI firebase: ${command}`
      );
    });
  }

  it("serve sobe a suíte completa no projeto demo", () => {
    const command = scripts.serve;
    assert.ok(startsEmulators(command), `serve deve subir emuladores: ${command}`);
    assert.deepEqual(projectsOf(command), [DEMO_PROJECT]);
    const [only] = onlyListsOf(command);
    assert.deepEqual([...only].sort(), ["auth", "firestore", "functions"]);
  });

  it("start não é um atalho para um fluxo inseguro", () => {
    const command = scripts.start;
    // Ou delega a um script já provado seguro, ou é ele próprio seguro.
    if (/npm run (\S+)/.test(command)) {
      const target = /npm run (\S+)/.exec(command)![1];
      assert.ok(
        !MUST_REFUSE.has(target),
        `start delega para "${target}", que é um script de recusa`
      );
      assert.equal(target, "serve", `start deve delegar para serve: ${command}`);
    } else {
      assert.ok(
        !invokesFirebaseCli(command) || projectsOf(command).includes(DEMO_PROJECT),
        `start inseguro: ${command}`
      );
    }
  });
});
