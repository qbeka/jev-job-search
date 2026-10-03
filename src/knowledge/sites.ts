/**
 * What the tool has learned about each site, kept so the next form on that
 * site is filled the way that worked: which kind of control takes a value
 * from script and which needs real typing or clicking, whether the site puts
 * a sign-in in front of its form, how many pages its form has, whether it
 * emails a code, and which controls the tool could not set at all.
 *
 * There are two files. knowledge/sites.json ships with the repository and
 * holds what every user's runs have taught the tool. data/knowledge.json is
 * this machine's own notes, written after every form. Reading merges the
 * two. `knowledge --share` writes the merged notes into the shipped file, so
 * they can be committed and sent as a pull request.
 *
 * The notes are about sites, never about the person: a host name, kinds of
 * controls, counts, and reasons with every quoted value taken out.
 */
import { existsSync, readFileSync } from "node:fs";
import { withStore, writeAtomic } from "../util/store.js";
import { z } from "zod";
import { PATHS } from "../config.js";

/** How a value got into a control. */
export const Method = z.enum(["script", "typed", "clicked", "calendar"]);
export type Method = z.infer<typeof Method>;

const ControlNote = z.object({
  /** The way that worked most recently. */
  method: Method,
  worked: z.number().default(0),
});

const Trouble = z.object({ why: z.string(), count: z.number().default(1) });

export const SiteNotes = z.object({
  /** By control signature: the kind of control, and the widget that draws it when the tool knows it. */
  controls: z.record(ControlNote).default({}),
  /** The site showed a sign-in or account page in front of its form. */
  signIn: z.boolean().default(false),
  /** The most pages one of its forms ran over. */
  pages: z.number().default(1),
  /** After Submit, the site emailed a code to confirm a person is applying. */
  emailsCode: z.boolean().default(false),
  /** The last day it did. A site that asks once asks for the rest of that day. */
  codeOn: z.string().default(""),
  /** Forms opened here, and how many of them ended ready to send. */
  forms: z.number().default(0),
  ready: z.number().default(0),
  /** Controls the tool could not set, by signature, with the last reason. This is the list of what to teach it next. */
  trouble: z.record(Trouble).default({}),
  updated: z.string().default(""),
});
export type SiteNotes = z.infer<typeof SiteNotes>;

export const Knowledge = z.object({ version: z.literal(1).default(1), sites: z.record(SiteNotes).default({}) });
export type Knowledge = z.infer<typeof Knowledge>;

export const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
};

/** A control's signature: "tel:intl-tel", "combobox:react-select", "text". The same signature takes values the same way across a site. */
export const signatureOf = (f: { kind: string; widget?: string }) => (f.widget ? `${f.kind}:${f.widget}` : f.kind);

/** A reason with nothing of the person's in it: every quoted value is taken out, and it is kept short. */
export const sanitize = (why: string) => why.replace(/"[^"]*"/g, "a value").replace(/\S+@\S+/g, "an address").replace(/\d{5,}/g, "a number").slice(0, 120);

function read(file: string): Knowledge {
  if (!existsSync(file)) return Knowledge.parse({});
  try {
    return Knowledge.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return Knowledge.parse({});
  }
}

/** Two sets of notes as one. Where both know a control, the second (this machine's, the newer) wins. */
export function mergeKnowledge(shipped: Knowledge, local: Knowledge): Knowledge {
  const sites: Record<string, SiteNotes> = {};
  for (const host of new Set([...Object.keys(shipped.sites), ...Object.keys(local.sites)])) {
    const a = shipped.sites[host] ?? SiteNotes.parse({});
    const b = local.sites[host] ?? SiteNotes.parse({});
    sites[host] = {
      controls: { ...a.controls, ...b.controls },
      signIn: a.signIn || b.signIn,
      pages: Math.max(a.pages, b.pages),
      emailsCode: a.emailsCode || b.emailsCode,
      codeOn: a.codeOn > b.codeOn ? a.codeOn : b.codeOn,
      forms: a.forms + b.forms,
      ready: a.ready + b.ready,
      // A control that has since been set is no longer trouble.
      trouble: Object.fromEntries(Object.entries({ ...a.trouble, ...b.trouble }).filter(([signature]) => !(signature in b.controls))),
      updated: a.updated > b.updated ? a.updated : b.updated,
    };
  }
  return { version: 1, sites };
}

let cached: Knowledge | null = null;

/** Everything known: the shipped notes and this machine's, merged. */
export function loadKnowledge(shipped = PATHS.knowledgeShipped, local = PATHS.knowledgeLocal): Knowledge {
  if (shipped === PATHS.knowledgeShipped && local === PATHS.knowledgeLocal) return (cached ??= mergeKnowledge(read(shipped), read(local)));
  return mergeKnowledge(read(shipped), read(local));
}

export const notesFor = (url: string, k: Knowledge = loadKnowledge()): SiteNotes => k.sites[hostOf(url)] ?? SiteNotes.parse({});

/** What one form taught: the methods that worked, what could not be set, and how it ended. */
export type Lesson = {
  landed?: Record<string, Method>;
  trouble?: Record<string, string>;
  signIn?: boolean;
  pages?: number;
  emailsCode?: boolean;
  /** Counts one more form for the site, and whether it ended ready. */
  form?: { ready: boolean };
};

/** Notes with one lesson added. Pure, so it is tested without a file. */
export function withLesson(notes: SiteNotes, lesson: Lesson, today: string): SiteNotes {
  const controls = { ...notes.controls };
  for (const [signature, method] of Object.entries(lesson.landed ?? {})) {
    const before = controls[signature];
    controls[signature] = { method, worked: (before?.method === method ? before.worked : 0) + 1 };
  }
  const trouble = Object.fromEntries(Object.entries(notes.trouble).filter(([signature]) => !(signature in (lesson.landed ?? {}))));
  for (const [signature, why] of Object.entries(lesson.trouble ?? {})) {
    if (signature in (lesson.landed ?? {})) continue;
    trouble[signature] = { why: sanitize(why), count: (notes.trouble[signature]?.count ?? 0) + 1 };
  }
  return {
    controls,
    signIn: notes.signIn || !!lesson.signIn,
    pages: Math.max(notes.pages, lesson.pages ?? 1),
    emailsCode: notes.emailsCode || !!lesson.emailsCode,
    codeOn: lesson.emailsCode ? today : notes.codeOn,
    forms: notes.forms + (lesson.form ? 1 : 0),
    ready: notes.ready + (lesson.form?.ready ? 1 : 0),
    trouble,
    updated: today,
  };
}

/** Writes one lesson into this machine's notes. A lesson that cannot be saved is lost, never an error: learning must not stop a run. */
export function learn(url: string, lesson: Lesson, local = PATHS.knowledgeLocal): void {
  const host = hostOf(url);
  if (!host) return;
  try {
    withStore(() => {
      const mine = read(local);
      mine.sites[host] = withLesson(mine.sites[host] ?? SiteNotes.parse({}), lesson, new Date().toISOString().slice(0, 10));
      writeAtomic(local, JSON.stringify(mine, null, 1));
    });
    cached = null;
  } catch {
    /* best effort */
  }
}

/** Sites that asked for an emailed code today, by their last two labels ("greenhouse.io"): the rest of their jobs wait for another day. */
export const askingForCodeToday = (k: Knowledge = loadKnowledge(), today = new Date().toISOString().slice(0, 10)): string[] =>
  [...new Set(Object.entries(k.sites).filter(([, s]) => s.codeOn === today).map(([host]) => host.split(".").slice(-2).join(".")))];

/** Sites known to put a sign-in in front of their form. */
export const signInHosts = (k: Knowledge = loadKnowledge()): string[] => Object.entries(k.sites).filter(([, s]) => s.signIn).map(([host]) => host);

/** Writes the merged notes into the shipped file, hosts in order, ready to be committed. Returns how many sites it holds. */
export function shareKnowledge(shipped = PATHS.knowledgeShipped, local = PATHS.knowledgeLocal): number {
  const merged = mergeKnowledge(read(shipped), read(local));
  const sites = Object.fromEntries(Object.entries(merged.sites).sort(([a], [b]) => a.localeCompare(b)));
  writeAtomic(shipped, JSON.stringify({ version: 1, sites }, null, 1) + "\n");
  // What was shared now lives in the shipped file. Keeping it locally too would count every form twice.
  writeAtomic(local, JSON.stringify(Knowledge.parse({}), null, 1));
  cached = null;
  return Object.keys(sites).length;
}
