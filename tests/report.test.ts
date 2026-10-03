import { describe, expect, it } from "vitest";
import { buildReport, StatusChange } from "../src/report/data.js";
import { reportPage } from "../src/report/page.js";
import { emptyRow, type Row } from "../src/log/csv.js";

const row = (over: Partial<Row>): Row => ({ ...emptyRow(), Company: "Acme", "Role / Title": "Intern", "Job Link": "https://x/1", "Job ID": "a1", ATS: "ashby", ...over });

describe("the dashboard's numbers", () => {
  const rows = [
    row({ "App. Status": "Applied", "Applied On": "2026-10-02", "Job ID": "a1" }),
    row({ "App. Status": "Applied", "Applied On": "2026-10-01", "Job ID": "a2", ATS: "lever", "Take-home": "https://t/1 | do it" }),
    row({ "App. Status": "Needs you", "Skip Reason": "asks for a signature", "Job ID": "a3" }),
    row({ "App. Status": "Waiting for you: the board emailed you a code to confirm a person is applying", "Job ID": "a6" }),
    row({ "App. Status": "Unconfirmed: Submit was clicked and no confirmation was seen", "Job ID": "a7" }),
    row({ "App. Status": "Skipped: not a software role", "Job ID": "a4" }),
    row({ "App. Status": "Queued", "Job ID": "a5" }),
  ];
  it("counts what was sent, what waits, and what is left", () => {
    const r = buildReport(rows, new Date(2026, 9, 2));
    expect(r.totals).toEqual({ applied: 2, appliedToday: 1, unconfirmed: 1, waitingForYou: 1, leftForYou: 3, queued: 1, skipped: 1, considered: 7 });
    expect(r.byBoard).toEqual({ ashby: 1, lever: 1 });
    expect(r.byDay).toEqual([{ day: "2026-10-01", applied: 1 }, { day: "2026-10-02", applied: 1 }]);
    expect(r.rows.find((x) => x.job_id === "a2")?.takehome_link).toBe("https://t/1");
  });
  it("renders a snapshot page with the data embedded and escaped", () => {
    const html = reportPage(buildReport([row({ "App. Status": "Applied", Company: "<script>" })]));
    expect(html).toContain('id="data"');
    expect(html).not.toContain("<script>\"");
    expect(html).toContain("\\u003cscript>");
  });
  it("takes only a status the page offers", () => {
    expect(StatusChange.safeParse({ id: "a1", status: "applied" }).success).toBe(true);
    expect(StatusChange.safeParse({ id: "a1", status: "in_progress" }).success).toBe(false);
    expect(StatusChange.safeParse({ id: "a1", notes: "called back" }).success).toBe(true);
  });
});
