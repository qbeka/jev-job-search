/**
 * How the tool's files are written. Two rules: a file is replaced whole or
 * not at all (a temp file beside it, then a rename), and a read-modify-write
 * holds a short lock, so two commands running at once (a dashboard and a run,
 * a search and a run) never overwrite each other's work. A separate run lock
 * keeps two browser runs from driving the same window.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";
import { PATHS, STORE } from "../config.js";

/** Writes a file so that a reader sees the old text or the new text, never half of one. */
export function writeAtomic(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists and belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

type LockBody = { pid: number; at: number; command?: string };
const readLock = (file: string): LockBody | null => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as LockBody;
  } catch {
    return null;
  }
};

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const depth = new Map<string, number>();

/**
 * Runs fn while holding the named lock. The lock is a file made with "create only", so one
 * process wins. A lock left by a process that died, or held far longer than any write takes, is
 * taken over. The same process may nest calls.
 */
export function withLock<T>(name: string, fn: () => T, dir = PATHS.locks): T {
  const held = depth.get(name) ?? 0;
  if (held > 0) {
    depth.set(name, held + 1);
    try {
      return fn();
    } finally {
      depth.set(name, held);
    }
  }
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.lock`);
  const deadline = Date.now() + STORE.lockWaitMs;
  for (;;) {
    try {
      const fd = openSync(file, "wx");
      writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      closeSync(fd);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const body = readLock(file);
      if (!body || !alive(body.pid) || Date.now() - body.at > STORE.lockStaleMs) {
        try {
          unlinkSync(file);
        } catch {
          /* another process took it over first */
        }
        continue;
      }
      if (Date.now() > deadline) throw new Error(`could not get the ${name} lock: process ${body.pid} has held it for ${Math.round((Date.now() - body.at) / 1000)}s`);
      pause(STORE.lockPollMs);
    }
  }
  depth.set(name, 1);
  try {
    return fn();
  } finally {
    depth.set(name, 0);
    try {
      unlinkSync(file);
    } catch {
      /* already gone */
    }
  }
}

/** A read-modify-write on the tool's records: fresh data in, whole files out, one process at a time. */
export const withStore = <T>(fn: () => T): T => withLock("store", fn);

export type RunInfo = { pid: number; command: string; startedAt: string };

/** The run that holds the browser now, or null. A lock whose process is gone, or older than any run lasts, does not count. */
export function currentRun(file = PATHS.runLock): RunInfo | null {
  if (!existsSync(file)) return null;
  try {
    const r = JSON.parse(readFileSync(file, "utf8")) as RunInfo;
    if (!alive(r.pid) || Date.now() - Date.parse(r.startedAt) > STORE.runStaleMs) return null;
    return r;
  } catch {
    return null;
  }
}

/**
 * Takes the run lock for a command that drives the browser. A second run is refused with the
 * first one named. The lock is released when the process ends, however it ends.
 */
export function acquireRun(command: string, file = PATHS.runLock): () => void {
  const other = currentRun(file);
  if (other && other.pid !== process.pid) {
    throw new Error(`another run is using the browser: "${other.command}" since ${new Date(other.startedAt).toLocaleTimeString()} (process ${other.pid}). Wait for it to finish, or stop it.`);
  }
  writeAtomic(file, JSON.stringify({ pid: process.pid, command, startedAt: new Date().toISOString() } satisfies RunInfo));
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      const mine = JSON.parse(readFileSync(file, "utf8")) as RunInfo;
      if (mine.pid === process.pid) unlinkSync(file);
    } catch {
      /* already gone */
    }
  };
  process.once("exit", release);
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      release();
      process.exit(130);
    });
  }
  return release;
}
