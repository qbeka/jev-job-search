/**
 * Single source of every tunable: paths, thresholds, weights, limits.
 * Nothing else in the codebase hardcodes a number that changes behaviour.
 */
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const PATHS = {
  root: ROOT,
  data: path.join(ROOT, "data"),
  profile: path.join(ROOT, "data", "profile.json"),
  profileExample: path.join(ROOT, "data", "profile.example.json"),
  /** The style guide for written answers. data/voice.local.md, when present, is the candidate's own and wins over the shipped one. */
  voice: existsSync(path.join(ROOT, "data", "voice.local.md")) ? path.join(ROOT, "data", "voice.local.md") : path.join(ROOT, "data", "voice.md"),
  bank: path.join(ROOT, "data", "bank.json"),
  bankExample: path.join(ROOT, "data", "bank.example.json"),
  queue: path.join(ROOT, "data", "queue.json"),
  /** Every job the tool considered, with what happened to it. */
  /** The four records a person reads, in one folder at the top of the project: applications/. */
  applications: path.join(ROOT, "applications", "all.csv"),
  /** Only the applications that were sent, newest first. It sits at the top of the folder so it is easy to find. */
  applied: path.join(ROOT, "applications", "applied.csv"),
  /** Answers the writer has given before, kept so the same question is not paid for twice. */
  memory: path.join(ROOT, "data", "memory.json"),
  cache: path.join(ROOT, "data", "cache"),
  /** What every user's runs have taught the tool about sites. Shipped with the repository. */
  knowledgeShipped: path.join(ROOT, "knowledge", "sites.json"),
  /** What this machine's runs have learned since. Merged with the shipped notes on reading. */
  knowledgeLocal: path.join(ROOT, "data", "knowledge.json"),
  /** Left by earlier versions: sites found behind a sign-in. Read once more and folded into the notes above. */
  walledHosts: path.join(ROOT, "data", "cache", "walled-hosts.json"),
  /** JEV's ratings of postings, kept so an unchanged posting is not rated again. */
  ratings: path.join(ROOT, "data", "cache", "ratings.json"),
  /** JEV's field mappings of forms, kept so an unchanged form is not mapped again. */
  plans: path.join(ROOT, "data", "cache", "plans.json"),
  /** Jobs the tool could not finish and left for the person, with the reason and the link. */
  manual: path.join(ROOT, "applications", "manual.csv"),
  /** Applications sent to a company that also wants a take-home assignment: the link and the instructions, for the person to do. */
  takehome: path.join(ROOT, "applications", "takehome.csv"),
  runs: path.join(ROOT, "data", "runs"),
  /** The person's standing instructions for the daily run. Without this file `daily` does nothing. */
  policy: path.join(ROOT, "data", "policy.json"),
  policyExample: path.join(ROOT, "data", "policy.example.json"),
  /** Emails already looked at for replies, and the ones waiting for the person to confirm. */
  inbox: path.join(ROOT, "data", "runs", "inbox.json"),
  /** Boards the daily run leaves alone until a date, because they asked for a human check or refused a burst. */
  boardPauses: path.join(ROOT, "data", "runs", "board-pauses.json"),
  /** Left by the person to ask a daily run that is working to stop after its current application. */
  dailyStop: path.join(ROOT, "data", "runs", "daily.stop"),
  /** What the scheduled run prints. */
  dailyLog: path.join(ROOT, "data", "runs", "daily.log"),
  /** The job-board accounts the person allowed, and the rule for making new ones. No secret is in it. */
  accounts: path.join(ROOT, "data", "accounts.json"),
  accountsExample: path.join(ROOT, "data", "accounts.example.json"),
  /** What the tool remembers about each account between runs: when it last signed in, attempts, a pause after a lockout. */
  accountsState: path.join(ROOT, "data", "runs", "accounts-state.json"),
  /** The Gmail connection: the OAuth client id and the address. The tokens are in the Keychain. */
  gmail: path.join(ROOT, "data", "gmail.json"),
  /** Verification emails already used, so one message never answers two requests. */
  verifications: path.join(ROOT, "data", "runs", "verifications.json"),
  /** Short locks around read-modify-write of the records, and the lock a browser run holds. */
  locks: path.join(ROOT, "data", "runs", "locks"),
  runLock: path.join(ROOT, "data", "runs", "run.lock"),
  jevUsage: path.join(ROOT, "data", "runs", "jev-usage.jsonl"),
  writerUsage: path.join(ROOT, "data", "runs", "writer-usage.jsonl"),
  imports: path.join(ROOT, "data", "imports"),
  /** Tailored resumes and cover letters, one folder per job: documents/tailored/<Company>_<Role>_<job id>/. */
  documents: path.join(ROOT, "documents", "tailored"),
  /** The person's own files, at the top of the project: the resume to send, a transcript, and the tailored pairs under tailored/. */
  documentsDir: path.join(ROOT, "documents"),
  browserScripts: path.join(ROOT, "src", "forms"),
} as const;

/** Loads KEY=value lines from .env into process.env without overriding existing values. */
export function loadEnv(file = path.join(ROOT, ".env")): void {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export const JEV = {
  endpoint: "https://openrouter.ai/api/alpha/decisions",
  model: "typesafe/jev-1.13",
  /** Context window per the model page. We keep requests well under it. */
  contextTokens: 32_000,
  /** Approximate budget for the job description inside a rating request (chars, ~4 chars per token). */
  maxDescriptionChars: 14_000,
  /** Approximate budget for a page's text when deciding page state. */
  maxPageTextChars: 8_000,
  timeoutMs: 20_000,
  maxRetries: 3,
  retryBaseMs: 500,
  /** Hard stop for one discover run, in USD. The model page lists $0.042 per million input tokens. */
  runSpendCapUsd: 1.0,
} as const;

export const DISCOVER = {
  /** Only postings this fresh are considered. */
  maxAgeDays: 14,
  /** Concurrency for description fetches. */
  fetchConcurrency: 8,
  /** Concurrency for JEV rating calls. */
  rateConcurrency: 6,
  /** Fetch timeout for job pages and ATS APIs. */
  fetchTimeoutMs: 15_000,
  /** How many jobs to surface in the queue per run. */
  queueSize: 150,
  /**
   * Minimum composite score to be queued. Hard rules (work authorization,
   * degree, pay, level) are skips, not scores, so this only trims the long
   * tail of weak matches. The queue is ranked, so the best apply first.
   */
  applyThreshold: 0.3,
  /**
   * Careers sites known to need an account or a login before the form, by hostname fragment.
   * Jobs there are skipped before rating. Sites the apply run finds walled are remembered in
   * data/cache/walled-hosts.json and skipped the same way next time.
   */
  accountWalledHosts: ["eightfold.ai", "careers.microsoft.com", "jobs.intuit.com", "jobs.ea.com"],
  /** Job boards whose forms the page scripts cannot read yet. Their jobs are skipped with that reason. */
  unreadableAts: ["smartrecruiters"],
  /** Sources that are read from GitHub. Each entry names the raw file and its parser. */
  sources: {
    simplifyInternships:
      "https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json",
    simplifyNewGrad:
      "https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/.github/scripts/listings.json",
    canadianInternships2027:
      "https://raw.githubusercontent.com/negarprh/Canadian-Tech-Internships-2027/main/README.md",
    vanshSummer2027:
      "https://raw.githubusercontent.com/vanshb03/Summer2027-Internships/dev/README.md",
    canadaSummer2027:
      "https://raw.githubusercontent.com/michelleokolie/canada-tech-internships-summer-2027/main/README.md",
  },
} as const;

/**
 * Composite fit score. Every component is 0..1 before weighting.
 * Weights sum to 1; location and recency are multipliers applied after.
 */
export const FIT_WEIGHTS = {
  stackMatch: 0.22,
  experienceMatch: 0.18,
  callbackLikelihood: 0.3,
  levelFit: 0.15,
  termFit: 0.1,
  interviewPractical: 0.05,
} as const;

export const LOCATION_MULTIPLIER = {
  vancouver: 1.0,
  canada: 0.92,
  remote: 0.9,
  us: 0.75,
  international: 0.6,
  unclear: 0.7,
} as const;

/** Applied when the posting asks for a graduation date the candidate does not have. They can still apply, so it ranks lower instead of being dropped. */
export const GRADUATION_MISMATCH_MULTIPLIER = 0.6;

/** Recency multiplier: 1.0 for today, decaying linearly to this floor at maxAgeDays. */
export const RECENCY_FLOOR = 0.7;

export const FORM = {
  /** JEV confidence at or above which a mapping is applied without note. */
  autoConfidence: 0.9,
  /** Below this, Claude decides the field by hand. */
  reviewConfidence: 0.5,
  /**
   * Stricter rules for the answers that must be true. A checkbox is ticked at or above `tick` and
   * left at or below `leave`; between the two a person decides. An answer about the right to work
   * whose option is not a plain yes or no needs `authority` confidence.
   */
  gates: { tick: 0.7, leave: 0.3, authority: 0.85 },
  /** An answer this short (or a plain yes or no) must be what the box shows, not merely inside it: "No" is not "Not applicable". */
  shortAnswerChars: 3,
  /** Selects with more options than this are pre-filtered in code before JEV sees them. */
  maxOptionsForJev: 40,
  /** How many times a page is read again after a fill, for questions that only appear once another is answered. */
  followUpRounds: 3,
  /** The most optional fields that may be left blank because they could not be set. More than this means the fill itself went wrong, and the form is held. */
  maxLeftBlank: 2,
  /** Fields per JEV call. Larger forms are split into several calls. */
  fieldsPerCall: 40,
} as const;

/** Answers JEV already gave to an unchanged question are reused. Turning this off only costs money and time. */
export const CACHE = {
  ratings: true,
  plans: true,
  /** The most form mappings kept. Each is a few kilobytes. */
  maxPlans: 400,
} as const;

export const BROWSER = {
  /** The Chrome binary the fill runner drives over the DevTools protocol. */
  chromePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  /** Local DevTools port of the runner's own Chrome window. */
  port: 9333,
  /** Its profile lives with the other run data, so it is git-ignored and keeps cookies between runs. */
  profileDir: path.join(ROOT, "data", "runs", "chrome-profile"),
  /** Longest wait for a page to load and its form controls to stop changing. */
  settleMs: 15_000,
  /** A form whose labels keep changing is taken as settled once its controls have held still for this many reads. */
  settleCountPolls: 12,
  /** How long a loaded page with no form controls is given before it is read as having no form. */
  emptyPageMs: 6_000,
  /** Longest wait for a dropdown's options to appear after a click or typing. */
  optionsMs: 4_000,
  /** A page that answered with an error is reopened once after this pause. */
  retryAfterMs: 8_000,
  /** The most months a calendar is turned to reach a date. */
  calendarTurns: 48,
  /** Waits before a typed value the page did not keep is put back: once soon, once later. */
  putBackAfterMs: [1_500, 5_000],
  /** Longest wait for a form to finish saving one field to its own server before the next field is set. */
  saveMs: 3_000,
  /** Longest wait for an uploaded resume to reach the form's server. */
  uploadMs: 20_000,
  /** Longest wait for the page to change after Submit is clicked. */
  submitMs: 12_000,
  /** A page that still looks like the form after that, with no error on it, is given this much longer: some boards take their time to confirm. */
  confirmMs: 20_000,
  pollMs: 150,
} as const;

/**
 * The writer for what JEV cannot type: open questions, and fields it was unsure of.
 * By default it is Claude Code itself, run headless, so it uses the person's own subscription and
 * no API key. With ANTHROPIC_API_KEY in .env the Claude API is called directly instead.
 */
export const WRITER = {
  command: "claude",
  model: "claude-sonnet-5-5",
  effort: "low",
  timeoutMs: 180_000,
  /** Job description characters handed to the writer. The posting is most of what each call costs. */
  maxDescriptionChars: 4_000,
  /** Posting characters per job when writing the two sheet notes, where the opening paragraph is enough. */
  maxNoteChars: 1_500,
  /**
   * Where the headless call runs. Claude Code adds the CLAUDE.md of the folder it starts in to every
   * prompt, and this project's CLAUDE.md is about changing the code, not about writing answers.
   * An empty folder outside the project keeps those 1,300 tokens out of every call.
   */
  cwd: path.join(os.tmpdir(), "jev-job-search-writer"),
  /**
   * The candidate's context is cached by the provider. A run reads it again within seconds, so the
   * five-minute cache is enough, and writing to it costs 1.25 times the input price where the
   * one-hour cache costs 2 times.
   */
  env: { FORCE_PROMPT_CACHING_5M: "1" },
  /** The Claude API, used instead of Claude Code when ANTHROPIC_API_KEY is in .env. */
  apiUrl: "https://api.anthropic.com/v1/messages",
  apiVersion: "2023-06-01",
  maxOutputTokens: 4_096,
  /**
   * Claude API prices per million tokens for the model above, only to report what API calls cost.
   * Check them against https://www.anthropic.com/pricing when the model changes.
   */
  apiPricesPerMillion: { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
} as const;

/** Tailored resumes and cover letters, written per job from the profile and rendered to PDF by the runner's Chrome. */
export const DOCUMENTS = {
  /** Writing a resume deserves more thought than finishing a form field. */
  effort: "high",
  /** A second writer pass that reads the first draft as a reviewer and tightens it. Twice the writer calls per job. */
  review: true,
  /** The most skills the tailored resume lists. */
  maxSkills: 14,
  /** Bullets per experience or project entry on the tailored resume, at most. */
  maxBullets: 4,
  /** Pages the resume may run to. A longer one loses its lowest-ranked bullets until it fits. */
  resumePages: 1,
  /** Pages the cover letter may run to. */
  coverPages: 1,
  /** Paper for the PDFs, in inches. US Letter; A4 is 8.27 by 11.69. */
  paper: { width: 8.5, height: 11 },
  /** How long one headless Chrome print may take. */
  printTimeoutMs: 30_000,
  /** The stock templates shipped with the tool, and where a person's own go. */
  templatesShipped: path.join(ROOT, "src", "documents", "templates"),
  templatesLocal: path.join(ROOT, "documents", "templates"),
  /** Which template is in use, kept in data/. */
  activeTemplate: path.join(ROOT, "data", "template.json"),
  /**
   * Phrases that mark a letter as machine-written. A cover letter that uses one is sent back once to
   * be rewritten in the person's own register, and refused if it still does. Matched without case.
   */
  machinePhrases: [
    "i am writing to", "i am applying for", "i am applying to", "i would like to apply", "i am excited", "i'm excited", "i am thrilled", "i'm thrilled", "i am passionate", "passionate about", "i believe i would", "i am confident that", "great fit", "perfect fit", "strong fit",
    "aligns with", "aligned with", "resonates", "resonate with", "leverage", "utilize", "furthermore", "moreover", "additionally", "in conclusion", "in today's", "fast-paced", "cutting-edge", "innovative", "dynamic", "impactful",
    "world-class", "best-in-class", "delve", "tapestry", "journey", "seamless", "robust", "spearheaded", "synergy", "eager to contribute", "contribute to your team", "hone my skills", "hit the ground running", "thrive",
    "unique opportunity", "i look forward to hearing", "thank you for considering", "not only", "testament to", "deeply", "truly", "it is worth noting", "skill set", "wealth of experience",
  ],
  /** The longest a cover letter sentence may run, in words, and the longest letter. People write short. */
  maxSentenceWords: 28,
  maxLetterWords: 260,
  /** Words that may be capitalized in a sentence without being a claim about the candidate. */
  plainWords: ["I", "A", "An", "The", "My", "In", "At", "On", "For", "With", "And", "As", "To", "Of", "This", "That", "It", "We", "You", "Your", "Our", "If", "When", "While", "After", "Before", "Over", "Since", "Through", "Then", "There", "Here", "What", "Which", "Who", "How", "Why", "Yes", "No", "Dear", "Hi", "Hello", "Sincerely", "Best", "Regards", "Thank", "Thanks", "Team", "Hiring", "Manager", "Regarding", "Re"],
} as const;

/** Reading the mailbox for replies to applications (`src/mail/status.ts`). */
export const INBOX = {
  /** How many days back a run looks, and how many emails it reads at most. */
  days: 7,
  maxMessages: 60,
  /** How much of an email JEV is shown, when the rules cannot name it: its subject and Gmail's own preview, cut to these lengths. */
  subjectChars: 160,
  snippetChars: 240,
  /** JEV's answer is taken only at or above this confidence. Under it the email waits for the person. */
  jevConfidence: 0.8,
  /** A company name shorter than this is too common a word to match on. */
  minCompanyChars: 4,
  clockSkewMs: 10 * 60_000,
} as const;

/**
 * The daily run (`src/run/daily.ts`). No rate is known to be safe, so these are set to look like
 * one careful person: few applications, spread over boards and employers, minutes apart, and a
 * full stop at the first signs that a board is asking whether a person is there.
 */
export const DAILY = {
  /** Applications a day when the policy names no number, and the most a policy or a flag may ask for. */
  target: 15,
  maxTarget: 25,
  /** Applications to one job board in a day. */
  perBoard: 8,
  /** Applications to one employer in a day, and forms open or unconfirmed with one employer at once. */
  perEmployerPerDay: 1,
  openPerEmployer: 2,
  /** The pause between two submissions to one board: a random time between these two. */
  gapMs: [3 * 60_000, 6 * 60_000],
  /** Boards that asked for a human check in one run before the whole run stops. */
  challengesStopRun: 2,
  /** Jobs one run opens at most, whatever became of them. */
  maxAttempts: 30,
  /** Longest one run lasts. */
  maxMinutes: 90,
  /** The most JEV may cost in a day before the run stops, when the policy names no number. */
  jevBudgetUsd: 0.5,
  /** The name the scheduled run is registered under with macOS, and the time it runs when none is given. */
  label: "com.jev-job-search.daily",
  at: "09:00",
} as const;

/** Signing in to job boards the person has an account on, and making an account where they allowed it (`src/accounts/`). */
export const ACCOUNTS = {
  /** The name every secret is kept under in the Keychain. */
  keychainService: "jev-job-search",
  /** The one password used for employer accounts, set with `jev accounts password`. */
  passwordItem: "accounts-password",
  /** How long a password the tool makes for a new account is. */
  generatedLength: 24,
  /** How long the window that asks for the password waits for the person, in seconds, and how many times it asks again after a password that misses a rule. */
  askSeconds: 300,
  askRounds: 3,
  /** Sign-in tries per account per day. A wrong password is never retried; this bounds everything else (a sign-in before and after an email verification is two). */
  maxLoginAttempts: 3,
  /** How many times the tool asks a board to send its verification email again. */
  maxResends: 1,
  /** Steps one sign-in may take before it is handed to the person. */
  maxSteps: 16,
  /** New employer accounts per day when the person set no number of their own. */
  maxNewAccountsPerDay: 3,
  /** The pause after a click on a sign-in page before the page is read again. */
  stepMs: 2_500,
  /** Reads after a click on Sign In or Create Account, while the page has neither moved nor said anything. */
  settleReads: 6,
  /** Extra time a form on an account board gets, for the sign-in and the verification email, on top of RUN.fillTimeoutMs. */
  signInBudgetMs: 240_000,
  /** Reads of a page the sign-in does not know before it is handed to the person: a page still drawing itself gets this many. */
  unknownReads: 4,
  /** What the boards the tool supports ask of a new account's secret (Workday's rules). Only these rules are ever printed, never the secret. */
  mustHave: { minLength: 8, digit: true, lower: true, upper: true, special: true },
} as const;

/** Reading the person's Gmail, with their consent, for the email a board sends to prove an inbox is theirs (`src/mail/`). */
export const GMAIL = {
  scope: "https://www.googleapis.com/auth/gmail.readonly",
  authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  revokeUrl: "https://oauth2.googleapis.com/revoke",
  apiUrl: "https://gmail.googleapis.com/gmail/v1/users/me",
  clientSecretItem: "gmail-client-secret",
  refreshTokenItem: "gmail-refresh-token",
  /** How long `gmail connect` waits for the person to finish Google's consent page. */
  consentWaitMs: 5 * 60_000,
  /** The waits between looks for a verification email. The total is how long a board gets to send it. */
  pollMs: [5_000, 8_000, 12_000, 15_000, 20_000, 30_000, 30_000],
  /** A verification email older than the request by more than this is not the one asked for. */
  clockSkewMs: 60_000,
  /** A verification request is given up after this long. */
  requestTtlMs: 15 * 60_000,
  /** Messages looked at per poll. More than one fresh match is ambiguous and is refused. */
  maxResults: 5,
  timeoutMs: 20_000,
} as const;

/** Help for the person when a form waits on them (`src/run/assist.ts`). */
export const ASSIST = {
  /** Post a notification on the Mac. */
  notify: true,
  /** For an emailed human-check code, open the person's own mail at a search for it. The tool reads no mail for this. */
  openMail: true,
  mailSearchBase: "https://mail.google.com/mail/u/0/#search/",
} as const;

/** What a child process may inherit from the environment. Keys and passwords are not on the list, so no child ever sees one. */
export const CHILD_ENV = {
  allow: ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TZ", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS", "__CF_USER_TEXT_ENCODING", "DISPLAY"],
} as const;

/** The environment for a child process: the allowed names only, plus what the caller adds on purpose. */
export function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of CHILD_ENV.allow) if (process.env[k] !== undefined) out[k] = process.env[k];
  return { ...out, ...extra };
}

/** How files are written and locked (`src/util/store.ts`). */
export const STORE = {
  /** How long a command waits for another command's write to finish. */
  lockWaitMs: 15_000,
  lockPollMs: 25,
  /** A write lock older than this was left by a process that hung. */
  lockStaleMs: 60_000,
  /** A run lock older than this was left behind: no run lasts this long. */
  runStaleMs: 6 * 60 * 60_000,
} as const;

/** The dashboard: a page on your own machine that reads the records and lets you change a status by hand. */
export const REPORT = {
  port: 4545,
  /** The statuses the page lets a person set, in the order they are offered. */
  statuses: ["applied", "needs_review", "queued", "skipped", "blocked", "failed"],
} as const;

export type WriterBackend = "claude-code" | "api";

/**
 * How Claude is reached. Claude Code runs headless on the person's own subscription and is the
 * default. With ANTHROPIC_API_KEY in .env the Claude API is called directly and billed to that key.
 * WRITER_BACKEND=claude-code in .env keeps Claude Code even when a key is present.
 */
export function writerBackend(): WriterBackend {
  const asked = (process.env.WRITER_BACKEND ?? "").trim();
  if (asked === "claude-code" || asked === "api") return asked;
  return process.env.ANTHROPIC_API_KEY ? "api" : "claude-code";
}

/** The answer memory: what the writer already answered, reused instead of asked again. */
export const MEMORY = {
  enabled: true,
  /** JEV's confidence that a new question asks for the same thing as a remembered one, at or above which the remembered answer is used. */
  sameQuestionConfidence: 0.9,
  /** Remembered questions shown to JEV per open field, closest wording first. */
  candidates: 5,
  /** Share of the shorter question's words the two must have in common before JEV is asked at all. */
  minWordOverlap: 0.3,
} as const;

/** What `doctor` checks against. */
export const DOCTOR = {
  minNodeMajor: 22,
  /** Most job boards refuse a larger resume. */
  maxResumeBytes: 5_000_000,
  /** A queue older than this is worth refreshing before a run: postings close. */
  staleQueueHours: 24,
  claudeTimeoutMs: 60_000,
} as const;

export const RUN = {
  /** How many queued jobs `discover` lists when it is done. */
  listed: 50,
  /**
   * Forms the runner fills side by side, one tab each. One means one job at a time: open, fill, send,
   * close, next. That is the cleanest to watch and the fastest per form, because no tab waits for the
   * window; the documents for the next job are written while this one is being filled.
   */
  fillConcurrency: 1,
  /** Of those, how many may be on the same site at once, and the pause between opening two forms there. Job boards throttle bursts. */
  perHostConcurrency: 1,
  /** Sites that save every field to their server as it changes, and rate-limit bursts: one form at a time, with a longer pause. */
  gentleHosts: ["ashbyhq.com"],
  gentleGapMs: 3_000,
  /** The pause before a submission to a site that has answered a burst with an emailed code before. */
  submitGapAfterCodeMs: 15_000,
  /** The pause between two submissions to the same site. A burst of applications from one person reads as a robot; one form at a time is most of the pacing already. */
  submitGapMs: 5_000,
  /** The most pages of one form the tool will walk. A form that goes on longer is left for the person. */
  maxPages: 8,
  /** How long `resume` watches one waiting form for the person to finish it. */
  resumeWaitMs: 5 * 60_000,
  /** A form kept open for the person is given up after this long: its session has usually expired by then. */
  waitingExpiryHours: 12,
  /** How long an abandoned fill is given to stop before its form is tried again. */
  abortGraceMs: 5_000,
  /** How many times a form is opened and filled when values did not land. The second go comes when the other forms are done, with the window to itself. */
  fillAttempts: 2,
  /** Longest one form may take to open and fill. A page that never settles is recorded as blocked instead of holding up the run. */
  fillTimeoutMs: 180_000,
  /** Forms handed to the writer at once. */
  writerConcurrency: 3,
  hostGapMs: 1_000,
} as const;
