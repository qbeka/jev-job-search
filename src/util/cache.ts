/**
 * A small file cache for JEV's answers. JEV is asked the same question again
 * whenever a form is filled a second time or a posting is rated on a later
 * day. The answer to an unchanged question is kept under a hash of everything
 * that went into it, so any change to the form, the posting or the profile
 * makes a new key and a new call. Nothing here can make an answer stale.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { writeAtomic } from "./store.js";
import path from "node:path";

export const hashOf = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);

/** One JSON file holding many answers by key. It is bounded, so it does not grow without end. */
export class KeyedCache<T> {
  private entries: Record<string, T> = {};
  private touched = new Set<string>();
  hits = 0;

  /** keep "touched": only what this run used survives. keep "all": everything does, up to `max` of the newest. */
  constructor(private file: string, private keep: "touched" | "all" = "touched", private max = Infinity) {
    if (!existsSync(file)) return;
    try {
      this.entries = JSON.parse(readFileSync(file, "utf8")) as Record<string, T>;
    } catch {
      this.entries = {};
    }
  }

  get(key: string): T | undefined {
    const hit = this.entries[key];
    if (hit !== undefined) {
      this.touched.add(key);
      this.hits++;
    }
    return hit;
  }

  set(key: string, value: T): void {
    this.entries[key] = value;
    this.touched.add(key);
  }

  save(): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const all = Object.entries(this.entries);
    const kept = Object.fromEntries(this.keep === "all" ? all.slice(Math.max(0, all.length - this.max)) : all.filter(([k]) => this.touched.has(k)));
    writeAtomic(this.file, JSON.stringify(kept));
  }
}
