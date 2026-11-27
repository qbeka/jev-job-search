/**
 * Some lists link every job through a link shortener. The real posting is one redirect away, and
 * without it the tool cannot tell the board, read the posting, or skip a board that needs an
 * account. Short links on the hosts in DISCOVER.shortLinkHosts are followed (redirects only, the
 * page is never read) and the job takes the real link, its board and its id.
 */
import { DISCOVER, PATHS } from "../config.js";
import { atsFromUrl, hostIs, jobId, type Job } from "../jobs/normalize.js";
import { KeyedCache } from "../util/cache.js";
import { mapLimit } from "../util/http.js";

const isShort = (url: string): boolean => {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return DISCOVER.shortLinkHosts.some((d) => hostIs(h, d));
  } catch {
    return false;
  }
};

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** Where a short link leads, following at most a few redirects, or null when it does not lead anywhere readable. */
export async function followShortLink(url: string, fetchImpl: Fetch = fetch): Promise<string | null> {
  let at = url;
  for (let hop = 0; hop < 4 && isShort(at); hop++) {
    const res = await fetchImpl(at, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(DISCOVER.shortLinkTimeoutMs) });
    const loc = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || !loc) return null;
    at = new URL(loc, at).toString();
  }
  return isShort(at) || !/^https?:\/\//i.test(at) ? null : at;
}

export async function resolveShortLinks(jobs: Job[], opts: { log?: (s: string) => void; fetchImpl?: Fetch; cacheFile?: string | null } = {}): Promise<Job[]> {
  const short = jobs.filter((j) => isShort(j.url));
  if (!short.length) return jobs;
  const cache = opts.cacheFile === null ? null : new KeyedCache<string>(opts.cacheFile ?? PATHS.shortLinks, "all", 5000);
  const resolved = await mapLimit(short, DISCOVER.fetchConcurrency, async (j) => cache?.get(j.url) ?? (await followShortLink(j.url, opts.fetchImpl)));
  let n = 0;
  short.forEach((j, i) => {
    const r = resolved[i];
    const to = r?.ok ? r.value : null;
    if (!to) return;
    cache?.set(j.url, to);
    j.url = to;
    j.ats = atsFromUrl(to);
    j.id = jobId(to);
    n++;
  });
  cache?.save();
  opts.log?.(`[sources] followed ${n} of ${short.length} short links`);
  return jobs;
}
