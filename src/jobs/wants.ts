/**
 * What the person said they want, as the ranking uses it: which kinds of job, which places, and
 * which areas of engineering. A profile that says nothing keeps the default ranking.
 */
import { LOCATION_MULTIPLIER, PLACE_MULTIPLIER as M } from "../config.js";
import type { Profile } from "../profile/schema.js";
import { locationTier, type LocationTier } from "./hardFilters.js";
import type { Job } from "./normalize.js";

export type Level = "internship" | "new_grad";

export type Wants = {
  /** Empty means both. */
  levels: Level[];
  /** Places in the person's order, as they typed them. "Remote" may be one of them. */
  places: string[];
  remote: "preferred" | "open" | "no";
  relocate: boolean;
  /** Areas of engineering in the person's order. Empty means no preference. */
  areas: string[];
};

export function wantsOf(profile: Pick<Profile, "preferences">): Wants {
  const p = profile.preferences;
  const levels = (p.roleTypes ?? []).filter((r): r is Level => r === "internship" || r === "new_grad");
  return {
    // Asking for both is the same as asking for neither.
    levels: levels.length === 2 ? [] : levels,
    places: (p.preferredLocations ?? []).map((s) => s.trim()).filter(Boolean),
    remote: p.remote,
    relocate: p.willingToRelocate === "yes",
    areas: (p.engineeringAreas ?? []).map((s) => s.trim()).filter(Boolean),
  };
}

const INTERN_TITLE = /\b(intern|interns|internship|co-?op|work term|summer analyst|summer associate|placement student)\b/i;
const FULL_TIME_TITLE = /\b(new grad|new graduate|graduate program|early career|entry[- ]level|university grad|full[- ]time|associate software engineer)\b/i;

export const LEVEL_WORDS: Record<Level, string> = { internship: "internships", new_grad: "new grad roles" };

/** Why the title alone rules a job out for the kinds of job the person asked for, or null. */
export function levelRefusedByTitle(title: string, w: Wants): string | null {
  if (!w.levels.length) return null;
  const intern = INTERN_TITLE.test(title);
  if (intern && !w.levels.includes("internship")) return `an internship, and you asked for ${LEVEL_WORDS.new_grad}`;
  if (!intern && FULL_TIME_TITLE.test(title) && !w.levels.includes("new_grad")) return `a full-time role, and you asked for ${LEVEL_WORDS.internship}`;
  return null;
}

/** Spellings a place goes by in job postings. */
const ALIASES: Record<string, string[]> = {
  "new york": ["new york", "nyc", "manhattan", "brooklyn", "ny, ny"],
  "san francisco": ["san francisco", "sf", "bay area", "south san francisco"],
  "bay area": ["bay area", "san francisco", "sf", "palo alto", "menlo park", "mountain view", "sunnyvale", "san jose", "redwood city", "san mateo", "santa clara", "cupertino", "oakland", "berkeley"],
  "los angeles": ["los angeles", "la", "santa monica", "culver city"],
  "washington dc": ["washington, dc", "washington dc", "washington, d.c.", "district of columbia"],
  seattle: ["seattle", "bellevue", "redmond", "kirkland"],
  boston: ["boston", "cambridge, ma"],
  vancouver: ["vancouver", "burnaby", "richmond, bc", "surrey, bc"],
  toronto: ["toronto", "mississauga", "markham", "north york"],
  montreal: ["montreal", "montréal"],
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Short names people type for a place.
ALIASES.nyc = ALIASES["new york"]!;
ALIASES["new york city"] = ALIASES["new york"]!;
ALIASES.sf = ALIASES["san francisco"]!;
ALIASES.la = ALIASES["los angeles"]!;
ALIASES.dc = ALIASES["washington dc"]!;

function spellings(place: string): string[] {
  const key = place.toLowerCase().replace(/\s+/g, " ").replace(/,?\s*(usa|us|united states|canada)$/i, "").trim();
  const city = key.split(",")[0]!.trim();
  return ALIASES[key] ?? ALIASES[city] ?? [city];
}

/** True when the job is in one of the places, by name. */
export function inPlaces(locations: string[], places: string[]): boolean {
  const text = locations.join(" | ");
  return places.some((p) => !/^remote$/i.test(p) && spellings(p).some((s) => new RegExp(`(^|[^a-z])${escapeRe(s)}([^a-z]|$)`, "i").test(text)));
}

const region = (t: LocationTier): LocationTier => (t === "vancouver" ? "canada" : t);

/**
 * How much the place counts toward the score. With no places given, the default tiers. Otherwise
 * the person's own places first, then remote when they are open to it, then the same country,
 * then anywhere else (less when they will not move).
 */
export function placeMultiplier(job: Pick<Job, "locations">, tier: LocationTier, w: Wants): number {
  if (!w.places.length) return LOCATION_MULTIPLIER[tier];
  if (inPlaces(job.locations, w.places)) return M.preferred;
  const remoteJob = tier === "remote" || /remote/i.test(job.locations.join(" "));
  if (remoteJob && w.remote !== "no") return w.remote === "preferred" || w.places.some((p) => /^remote$/i.test(p)) ? M.remoteWanted : M.remoteOpen;
  if (tier === "unclear") return M.unclear;
  const wantedRegions = new Set(w.places.filter((p) => !/^remote$/i.test(p)).map((p) => region(locationTier([p]))));
  if (wantedRegions.has(region(tier))) return w.relocate ? M.sameCountryWillMove : M.sameCountry;
  return w.relocate ? M.elsewhereWillMove : M.elsewhere;
}
