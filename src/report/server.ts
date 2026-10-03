/**
 * The dashboard server: serves the page and the records from your own machine, and takes a
 * status change from the page the same way `mark` does. Listens on localhost only.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { REPORT } from "../config.js";
import { mutateQueue, updateEntry } from "../jobs/queue.js";
import { currentRun, withStore } from "../util/store.js";
import { loadRows, saveRows, upsertEntry } from "../log/csv.js";
import { buildReport, StatusChange } from "./data.js";
import { reportPage } from "./page.js";

/** Applies one change from the page: the queue entry and the record row both move. */
export function applyStatusChange(c: StatusChange): { company: string; title: string } {
  return withStore(() => {
    const e = mutateQueue((q) =>
      updateEntry(q, c.id, {
        ...(c.status ? { status: c.status, statusReason: c.reason ?? null, waitingFor: null } : {}),
        ...(c.notes !== undefined ? { notes: c.notes } : {}),
        ...(c.status === "applied" ? { appliedAt: new Date().toISOString() } : {}),
      }),
    );
    saveRows(upsertEntry(loadRows(), e, c.notes !== undefined ? { Notes: c.notes } : {}));
    return { company: e.job.company, title: e.job.title };
  });
}

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    let body = "";
    req.on("data", (d: Buffer) => {
      body += d.toString();
      if (body.length > 100_000) reject(new Error("too large"));
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });

const send = (res: ServerResponse, status: number, type: string, body: string) => {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
};

/**
 * True for a request from the dashboard's own page: the Host is this server on this machine, and
 * a request that names where it came from (every POST from a browser does) names this server too.
 */
export function fromThisPage(req: Pick<IncomingMessage, "headers">, port: number): boolean {
  const here = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!here.includes(String(req.headers.host ?? ""))) return false;
  const origin = req.headers.origin;
  return origin === undefined || here.some((h) => origin === `http://${h}`);
}

/** Starts the server and returns the address it listens on. */
export function startReportServer(port: number = REPORT.port): Promise<string> {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      // Only this machine's own page may talk to the server: a web page elsewhere must not be able to read the records or change a status.
      if (!fromThisPage(req, port)) return send(res, 403, "text/plain", "forbidden");
      if (req.method === "GET" && url.pathname === "/") return send(res, 200, "text/html; charset=utf-8", reportPage(null));
      if (req.method === "GET" && url.pathname === "/api/data") return send(res, 200, "application/json", JSON.stringify({ ...buildReport(loadRows()), run: currentRun() }));
      if (req.method === "POST" && url.pathname === "/api/status") {
        if (!/^application\/json/.test(String(req.headers["content-type"] ?? ""))) return send(res, 415, "text/plain", "send JSON");
        const parsed = StatusChange.safeParse(JSON.parse(await readBody(req)));
        if (!parsed.success) return send(res, 400, "application/json", JSON.stringify({ error: parsed.error.issues.map((i) => i.message).join("; ") }));
        const changed = applyStatusChange(parsed.data);
        console.log(`${changed.company} | ${changed.title} → ${parsed.data.status ?? "notes"}`);
        return send(res, 200, "application/json", JSON.stringify({ ok: true }));
      }
      send(res, 404, "text/plain", "not found");
    } catch (err) {
      send(res, 500, "application/json", JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(`http://127.0.0.1:${port}`));
  });
}
