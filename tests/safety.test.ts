import { describe, expect, it } from "vitest";
import { childEnv } from "../src/config.js";
import { registerSecret, safeUrl, scrub, Secret } from "../src/util/redact.js";
import { showsValue } from "../src/util/dates.js";
import { showsPlanned } from "../src/browser/report.js";
import { settleStep } from "../src/browser/session.js";
import { mailSearchUrl } from "../src/run/assist.js";
import { fromThisPage } from "../src/report/server.js";
import { HUMAN_CHECK } from "../src/browser/submit.js";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

describe("secrets stay out of what is printed and saved", () => {
  it("replaces a registered value and anything shaped like a key or a token", () => {
    registerSecret("correct-horse-battery");
    expect(scrub("the password is correct-horse-battery, really")).toBe("the password is [redacted], really");
    expect(scrub(`key ${["sk", "or", "v1", "abcdef123456"].join("-")} end`)).toBe("key [redacted] end");
    expect(scrub("https://x.test/verify?code=123456&next=/a")).toBe("https://x.test/verify?code=[redacted]&next=/a");
  });
  it("cuts a link to its origin and path", () => {
    expect(safeUrl("https://a.test/save?token=abc#frag")).toBe("https://a.test/save");
  });
  it("a Secret cannot be printed or serialized by accident", () => {
    const s = new Secret("hunter2-hunter2");
    expect(`${s}`).toBe("[redacted]");
    expect(JSON.stringify({ s })).toBe('{"s":"[redacted]"}');
    expect(s.reveal()).toBe("hunter2-hunter2");
  });
  it("a child process inherits only the allowed names", () => {
    process.env.JEV_TEST_PASSWORD = "nope";
    process.env.OPENROUTER_API_KEY ??= "not-a-key";
    const env = childEnv({ EXTRA: "1" });
    expect(env.JEV_TEST_PASSWORD).toBeUndefined();
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
    expect(env.PATH).toBe(process.env.PATH);
    expect(env.EXTRA).toBe("1");
    delete process.env.JEV_TEST_PASSWORD;
  });
  it("every child process in the source is started with childEnv", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts")) files.push(p);
      }
    };
    walk(path.join(import.meta.dirname, "..", "src"));
    const bare: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(/\b(spawn|spawnSync|execFile|execFileSync)\(/g)) {
        const call = text.slice(m.index, text.indexOf("\n", text.indexOf(");", m.index)));
        const window = text.slice(m.index, (m.index ?? 0) + 900);
        if (!/childEnv\(/.test(window) && !/import/.test(call.slice(0, 20))) bare.push(`${path.basename(f)}: ${m[0]}`);
      }
    }
    expect(bare).toEqual([]);
  });
});

describe("what a box shows against what it was given", () => {
  it("a short answer or a plain yes or no must be the whole answer", () => {
    expect(showsValue("No", "No")).toBe(true);
    expect(showsValue("No", "No, I do not")).toBe(true);
    expect(showsValue("No", "No - I do not consent")).toBe(true);
    expect(showsValue("No", "Not applicable")).toBe(false);
    expect(showsValue("No", "No preference")).toBe(false);
    expect(showsValue("Yes", "Yesterday")).toBe(false);
    expect(showsValue("CA", "CA")).toBe(true);
  });
  it("a choice is compared with the option that was picked, a checkbox with its tick", () => {
    expect(showsPlanned({ kind: "radio", value: "Yes", optionLabel: "Yes" }, "No")).toBe(false);
    expect(showsPlanned({ kind: "radio", value: "Yes", optionLabel: "Yes" }, "Yes")).toBe(true);
    expect(showsPlanned({ kind: "select", value: "ca", optionLabel: "Canada" }, "Canada")).toBe(true);
    expect(showsPlanned({ kind: "select", value: "ca", optionLabel: "Canada" }, "United States")).toBe(false);
    expect(showsPlanned({ kind: "checkbox", value: "true" }, "checked")).toBe(true);
    expect(showsPlanned({ kind: "checkbox", value: "true" }, "")).toBe(false);
    expect(showsPlanned({ kind: "text", value: "Edmonton" }, "Edmonton, AB, Canada")).toBe(true);
  });
});

describe("waiting for a page to settle", () => {
  it("is stable when controls and words both hold, and counts controls alone when words keep changing", () => {
    let s = { sig: "", stable: 0, countStable: 0 };
    for (const sig of ["5:10", "5:10", "5:10", "5:10"]) s = settleStep(s, sig);
    expect(s.stable).toBe(3);
    s = { sig: "", stable: 0, countStable: 0 };
    for (const sig of ["5:1", "5:2", "5:3", "5:4"]) s = settleStep(s, sig);
    expect(s.stable).toBe(0);
    expect(s.countStable).toBe(3);
    expect(settleStep({ sig: "5:1", stable: 2, countStable: 2 }, "-1")).toEqual({ sig: "-1", stable: 0, countStable: 0 });
  });
});

describe("help for the person", () => {
  it("builds a mail search with the board's name and nothing personal", () => {
    const url = mailSearchUrl("job-boards.greenhouse.io");
    expect(url).toContain("mail.google.com");
    expect(decodeURIComponent(url)).toContain("greenhouse (code OR verification OR security) newer_than:1h");
    expect(url).not.toContain("@");
  });
  it("a footer badge is not a robot check", () => {
    expect(HUMAN_CHECK.test("This site is protected by reCAPTCHA and the Google Privacy Policy apply.")).toBe(false);
    expect(HUMAN_CHECK.test("Almost there! Please confirm you're not a robot to continue.")).toBe(true);
    expect(HUMAN_CHECK.test("Human Check* Please verify.")).toBe(true);
  });
});

describe("the dashboard server", () => {
  it("answers only its own page", () => {
    expect(fromThisPage({ headers: { host: "127.0.0.1:4545" } }, 4545)).toBe(true);
    expect(fromThisPage({ headers: { host: "127.0.0.1:4545", origin: "http://127.0.0.1:4545" } }, 4545)).toBe(true);
    expect(fromThisPage({ headers: { host: "127.0.0.1:4545", origin: "https://evil.example" } }, 4545)).toBe(false);
    expect(fromThisPage({ headers: { host: "evil.example" } }, 4545)).toBe(false);
  });
});
