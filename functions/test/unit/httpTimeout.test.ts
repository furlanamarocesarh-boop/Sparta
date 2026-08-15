import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import {
  E2E_HTTP_TIMEOUT_MS,
  fetchWithTimeout,
} from "../support/httpTimeout.js";

/**
 * Timeout behaviour of the E2E HTTP helper, proven WITHOUT any real network.
 *
 * Everything here talks to a throwaway loopback server started by this file:
 *  - `/hang`  accepts the connection and never answers — the exact shape of the
 *             failure that hung a run for 1h54m;
 *  - `/ok`    answers immediately, proving the timeout does not fire spuriously.
 *
 * No emulator, no Firebase, no outbound traffic, and the server is closed in
 * `after` so no port is left held.
 */

let server: Server;
let base = "";

/** Sockets parked by `/hang`, destroyed on teardown so the process can exit. */
const parked: Array<{ destroy: () => void }> = [];

before(async () => {
  server = createServer((req, res) => {
    if (req.url === "/ok") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    // `/hang`: hold the request open forever, answering nothing.
    parked.push(res.socket ?? { destroy: () => {} });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  for (const socket of parked) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("fetchWithTimeout", () => {
  it("um servidor que nunca responde produz erro — não pendura", async () => {
    const started = Date.now();

    await assert.rejects(
      () => fetchWithTimeout(`${base}/hang`, {}, 200),
      (error: Error) => {
        assert.match(error.message, /E2E HTTP timeout após 200ms/);
        return true;
      }
    );

    // Determinístico: falha PERTO do orçamento, não em uma hora.
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 5000, `demorou ${elapsed}ms — o timeout não atuou`);
  });

  it("a mensagem identifica método e URL do chamado que travou", async () => {
    await assert.rejects(
      () => fetchWithTimeout(`${base}/hang`, { method: "POST" }, 150),
      (error: Error) => {
        assert.match(error.message, /POST/);
        assert.match(error.message, new RegExp(`${base}/hang`));
        assert.match(error.message, /não respondeu/);
        return true;
      }
    );
  });

  it("não dispara quando o servidor responde a tempo", async () => {
    const res = await fetchWithTimeout(`${base}/ok`, {}, 5000);
    assert.equal(res.ok, true);
    assert.deepEqual(await res.json(), { ok: true });
  });

  it("erros que não são timeout propagam intactos", async () => {
    // Porta fechada: recusa de conexão, não expiração — deve manter o erro real.
    await assert.rejects(
      () => fetchWithTimeout("http://127.0.0.1:1/nada", {}, 5000),
      (error: Error) => {
        assert.doesNotMatch(error.message, /E2E HTTP timeout/);
        return true;
      }
    );
  });

  it("o orçamento padrão é finito e explícito", () => {
    assert.equal(typeof E2E_HTTP_TIMEOUT_MS, "number");
    assert.ok(E2E_HTTP_TIMEOUT_MS > 0 && Number.isFinite(E2E_HTTP_TIMEOUT_MS));
    assert.ok(
      E2E_HTTP_TIMEOUT_MS <= 60_000,
      "um orçamento acima de 60s reintroduz a espera longa que motivou isto"
    );
  });
});
