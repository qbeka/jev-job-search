/**
 * Keeping secrets out of everything the tool prints or saves. A value registered here (a
 * password, a code, a token) is replaced wherever it would appear, and the usual shapes of keys
 * and tokens are replaced whether registered or not. A link is cut to its origin and path, since
 * the part after the question mark is where sites put tokens.
 */
const secrets = new Set<string>();

/** Marks a value as secret for the rest of the process. Short values are ignored: they would blank out ordinary words. */
export function registerSecret(value: string): void {
  if (value.length >= 6) secrets.add(value);
}

const PATTERNS: RegExp[] = [
  /sk-or-v1-[A-Za-z0-9]+/g,
  /sk-ant-[A-Za-z0-9_-]+/g,
  /ya29\.[A-Za-z0-9._-]+/g,
  /\b1\/\/[A-Za-z0-9_-]{20,}/g,
  /([?&](?:code|token|access_token|id_token|refresh_token|sig|signature|jwt|key|password|otp)=)[^&\s"']+/gi,
];

/** The text with every registered secret and every key-shaped string replaced. */
export function scrub(text: string): string {
  let out = text;
  for (const s of secrets) if (out.includes(s)) out = out.split(s).join("[redacted]");
  for (const p of PATTERNS) out = out.replace(p, (_m, lead?: string) => `${typeof lead === "string" ? lead : ""}[redacted]`);
  return out;
}

/** A link as its origin and path only. */
export function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.split(/[?#]/)[0] ?? url;
  }
}

/** A value that cannot be printed, logged or serialized by accident. Only reveal() gives it up. */
export class Secret {
  readonly #value: string;
  constructor(value: string) {
    this.#value = value;
    registerSecret(value);
  }
  reveal(): string {
    return this.#value;
  }
  get length(): number {
    return this.#value.length;
  }
  toString(): string {
    return "[redacted]";
  }
  toJSON(): string {
    return "[redacted]";
  }
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "[redacted]";
  }
}

/** Passes everything the process prints through scrub. Called once, at start. */
export function installRedaction(): void {
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream) as (chunk: unknown, ...rest: unknown[]) => boolean;
    (stream as unknown as { write: (chunk: unknown, ...rest: unknown[]) => boolean }).write = (chunk, ...rest) => write(typeof chunk === "string" ? scrub(chunk) : chunk, ...rest);
  }
}
