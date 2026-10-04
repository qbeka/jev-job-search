import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isFormWrite } from "../src/browser/cdp.js";
import { closestOptions, pickOption, sameItem } from "../src/browser/dropdowns.js";
import { rightAlready, tookChoice } from "../src/browser/fill.js";
import { askAgain } from "../src/run/pipeline.js";
import { showsPicked } from "../src/util/dates.js";
import { comparePages, fieldsBlamed, showsPlanned, isClean, isReady, pickNext, pickSubmit, notOnScreen, showsAnother, splitFailures } from "../src/browser/report.js";
import type { FieldsDump } from "../src/forms/fields.js";

const hints = ["Edmonton", "Alberta", "AB", "Canada"];

describe("pickOption", () => {
  it("prefers an exact match, then a prefix, then a substring", () => {
    expect(pickOption(["Yes", "Yes, with conditions", "No"], "Yes", [])).toBe("Yes");
    expect(pickOption(["Bachelor's Degree", "Master's Degree"], "Bachelor", [])).toBe("Bachelor's Degree");
    expect(pickOption(["I am not a protected veteran", "I am a veteran"], "not a protected veteran", [])).toBe("I am not a protected veteran");
  });

  it("breaks ties with the candidate's own places", () => {
    expect(pickOption(["American Samoa +1", "Canada +1", "United States +1"], "+1", hints)).toBe("Canada +1");
    expect(pickOption(["Edmonton, Kentucky, United States", "Edmonton, Alberta, Canada"], "Edmonton", hints)).toBe("Edmonton, Alberta, Canada");
  });

  it("matches a place written another way, but only with one of the candidate's places named", () => {
    expect(pickOption(["Edmonton, AB, Canada", "Edmonton, KY, USA"], "Edmonton, Alberta, Canada", hints)).toBe("Edmonton, AB, Canada");
    expect(pickOption(["Edmonton, KY, USA"], "Edmonton, Alberta, Canada", hints)).toBeNull();
    // "AB" has to be a word of its own, not letters inside another word.
    expect(pickOption(["Edmonton, Abbotsford"], "Edmonton, Alberta, Canada", ["AB"])).toBeNull();
  });

  it("returns null rather than something merely similar", () => {
    expect(pickOption(["Ajou University", "Aalto University"], "University of Alberta", hints)).toBeNull();
    expect(pickOption(["Computer Science"], "Computing Science", [])).toBeNull();
    expect(pickOption(["Yes", "No"], "", [])).toBeNull();
  });
});

describe("closestOptions", () => {
  const disciplines = ["Accounting", "Biology", "Computer Engineering", "Computer Science", "Data Science", "History", "Information Science", "Physics"];
  it("keeps a short list whole", () => {
    expect(closestOptions(disciplines, "Computing Science", 40)).toEqual(disciplines);
  });
  it("cuts a long list to the options that share word stems with the wanted value", () => {
    const top = closestOptions(disciplines, "Computing Science", 4);
    expect(top).toHaveLength(4);
    expect(top[0]).toBe("Computer Science");
    expect(top).toContain("Computer Engineering");
    expect(top).not.toContain("History");
  });
});

describe("isFormWrite", () => {
  const form = "https://jobs.ashbyhq.com/acme/134c282c/application";
  it("counts the form's own saves and direct file uploads", () => {
    expect(isFormWrite("https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiSetFormValue", form)).toBe(true);
    expect(isFormWrite("https://acme-uploads.s3.us-east-1.amazonaws.com/", form)).toBe(true);
  });
  it("ignores analytics, error reporting and widgets from other sites", () => {
    expect(isFormWrite("https://api.rollbar.com/api/1/item/", form)).toBe(false);
    expect(isFormWrite("https://www.linkedin.com/talentwidgets/apply-with-linkedin", form)).toBe(false);
    expect(isFormWrite("https://api.pinterest.com/v3/coc_event/", "https://job-boards.greenhouse.io/embed/job_app?for=pinterest")).toBe(false);
    expect(isFormWrite("https://c.spl.greenhouse.io/com.snowplowanalytics.snowplow/tp2", "https://job-boards.greenhouse.io/embed/job_app?for=acme")).toBe(false);
    expect(isFormWrite("not a url", form)).toBe(false);
  });
});

describe("the in-page scripts", () => {
  it.each(["dumpFields.js", "fillFields.js", "pageHelpers.js"])("%s parses as one expression", (name) => {
    const src = readFileSync(new URL(`../src/forms/${name}`, import.meta.url), "utf8").replace("__PLAN__", "[]");
    expect(() => new Function(`return ${src.replace(/^\s*\/\/.*$/gm, "").trim().replace(/;$/, "")}`)).not.toThrow();
  });
  it("never dumps a password box and reports that one is present", () => {
    const src = readFileSync(new URL("../src/forms/dumpFields.js", import.meta.url), "utf8");
    expect(src).toMatch(/SKIP_TYPES = new Set\(\[[^\]]*"password"/);
    expect(src).toContain("out.hasPassword");
  });
});

describe("what holds a form and what does not", () => {
  const field = (selector: string, over: Record<string, unknown> = {}) => ({ id: selector, selector, kind: "text", label: selector, required: false, action: "fill", key: "x", value: "v", confidence: 1, note: null, ...over });
  const plan = { fields: [field("#opt"), field("#req", { required: true }), field("#wrong"), field("#cv", { kind: "file", action: "upload" }), field("#pay", { required: true, label: "Salary Range" })] } as unknown as Parameters<typeof splitFailures>[0];
  const shown = ["", "", "Something else", "", ""];
  const why = "the page did not keep the value";
  it("lets an optional field that the page shows empty go blank", () => {
    const { holds, leftBlank } = splitFailures(plan, [{ selector: "#opt", why }], shown);
    expect(holds).toEqual([]);
    expect(leftBlank).toEqual([{ selector: "#opt", why }]);
  });
  it("holds the form for a required field, a field showing another value, the resume, and a field the plan does not know", () => {
    const { holds, leftBlank } = splitFailures(plan, [{ selector: "#req", why }, { selector: "#wrong", why }, { selector: "#cv", why: "file input not found" }, { selector: "#gone", why }], shown);
    expect(holds.map((f) => f.selector)).toEqual(["#req", "#wrong", "#cv", "#gone"]);
    expect(leftBlank).toEqual([]);
  });
  it("holds the form when its own server refused a save, even on an optional field", () => {
    expect(splitFailures(plan, [{ selector: "#opt", why: "the form's own server refused 1 save(s): 429" }], shown).holds).toHaveLength(1);
  });
  it("holds the form when more than a couple of optional fields would not take a value: that is a fill gone wrong", () => {
    const many = { fields: ["#a", "#b", "#c"].map((sel) => field(sel)) } as unknown as Parameters<typeof splitFailures>[0];
    const failed = ["#a", "#b", "#c"].map((selector) => ({ selector, why }));
    expect(splitFailures(many, failed.slice(0, 2), ["", "", ""]).leftBlank).toHaveLength(2);
    const all = splitFailures(many, failed, ["", "", ""]);
    expect(all.leftBlank).toEqual([]);
    expect(all.holds).toHaveLength(3);
  });
  it("says what a pay box that takes only a number is waiting for", () => {
    expect(splitFailures(plan, [{ selector: "#pay", why }], shown).holds[0]?.why).toMatch(/takes only a number/);
  });
});

describe("the button that sends a form", () => {
  it("is Submit before Apply, in English or French, and never a LinkedIn helper", () => {
    expect(pickSubmit(["#a  /* Apply with LinkedIn */", "#b  /* Submit application */"])?.selector).toBe("#b");
    expect(pickSubmit(["#a  /* Apply with LinkedIn */"])).toBeNull();
    expect(pickSubmit(["#s  /* Soumettre la candidature */"])?.selector).toBe("#s");
    expect(pickSubmit(["#p  /* Postuler */"])?.selector).toBe("#p");
  });
  it("finds the way to the next page only when the page has no way to send", () => {
    expect(pickNext(['button[name="next"]  /* Next */'])?.selector).toBe('button[name="next"]');
    expect(pickNext(["#c  /* Save and continue */"])?.text).toBe("Save and continue");
    expect(pickNext(["#n  /* Next */", "#s  /* Submit application */"])).toBeNull();
    expect(pickNext(["#r  /* Review your answers */"])).toBeNull();
    expect(pickNext([])).toBeNull();
  });
});

describe("when a form may be sent", () => {
  const page = { state: "filled" as const, drafts: [], reviews: [], failed: [], missingRequired: [] };
  it("only from a clean last page", () => {
    expect(isReady({ ...page, hasNext: false })).toBe(true);
    expect(isReady({ ...page, hasNext: true })).toBe(false);
    expect(isClean({ ...page })).toBe(true);
    expect(isReady({ ...page, hasNext: false, missingRequired: ["Phone"] })).toBe(false);
    expect(isReady({ ...page, state: "blocked", hasNext: false })).toBe(false);
  });
});

describe("a page read again after it was filled", () => {
  const f = (selector: string, label: string, kind = "radio", name = "") => ({ selector, label, kind, name });
  const page = (fields: ReturnType<typeof f>[]) => ({ fields }) as unknown as FieldsDump;
  it("finds a question that appeared once another was answered", () => {
    const before = page([f("#live", "Do you live near the office?"), f("#name", "Name", "text")]);
    const after = page([f("#live", "Do you live near the office?"), f("#move", "Are you willing to relocate?"), f("#name", "Name", "text")]);
    const { moved, fresh } = comparePages(before, after);
    expect(moved.size).toBe(0);
    expect(fresh.map((x) => x.label)).toEqual(["Are you willing to relocate?"]);
  });
  it("follows a control that the new question pushed down, and sees the new one in its old place", () => {
    const before = page([f("div:nth-of-type(1)", "Do you live near the office?"), f("div:nth-of-type(2)", "Do you need a visa?")]);
    const after = page([f("div:nth-of-type(1)", "Do you live near the office?"), f("div:nth-of-type(2)", "Are you willing to relocate?"), f("div:nth-of-type(3)", "Do you need a visa?")]);
    const { moved, fresh } = comparePages(before, after);
    // The second place now holds the new question, and the visa question is in the third.
    expect(fresh.map((x) => [x.selector, x.label])).toEqual([["div:nth-of-type(2)", "Are you willing to relocate?"]]);
    expect([...moved]).toEqual([["div:nth-of-type(2)", "div:nth-of-type(3)"]]);
  });
  it("does not take a control that only changed its words for a new one", () => {
    const before = page([f("#resume", "Resume/CV ATTACH RESUME/CV", "file"), f("input.code", "phone number code", "combobox", "aB3xZ")]);
    const after = page([f("#resume", "Resume/CV RESUME.PDF Success!", "file"), f("input.code", "phone number code", "combobox", "Qr9Lm")]);
    expect(comparePages(before, after)).toEqual({ moved: new Map(), fresh: [] });
  });
  it("sees nothing when nothing changed", () => {
    const same = page([f("#a", "A"), f("#b", "B")]);
    expect(comparePages(same, same)).toEqual({ moved: new Map(), fresh: [] });
  });
});

describe("a box that shows another value than the one it was given", () => {
  const planned = [
    { selector: "#country", kind: "combobox", label: "Country", action: "fill", value: "Canada", optionLabel: null },
    { selector: "#city", kind: "text", label: "City", action: "fill", value: "Edmonton", optionLabel: null },
    { selector: "#why", kind: "textarea", label: "Why us?", action: "draft", value: null, optionLabel: null },
    { selector: "#prefix", kind: "combobox", label: "Prefix", action: "skip", value: null, optionLabel: null },
  ] as unknown as Parameters<typeof showsAnother>[0];
  const on = ["on", "on", "on", "on"] as Parameters<typeof showsAnother>[3];

  it("holds the form when a list ended on the row beside the wanted one", () => {
    const found = showsAnother(planned, [], ["Central African Republic", "Edmonton", "", ""], on);
    expect(found).toHaveLength(1);
    expect(found[0]?.selector).toBe("#country");
    expect(found[0]?.why).toMatch(/shows "Central African Republic" instead of "Canada"/);
  });

  it("goes by a later answer when there is one, and leaves alone what was never given a value", () => {
    const answers = [{ selector: "#why", kind: "textarea", value: "I like the work." }];
    expect(showsAnother(planned, answers, ["Canada", "Edmonton", "I like the work.", "Mr."], on)).toEqual([]);
    expect(showsAnother(planned, answers, ["Canada", "Edmonton", "Something else", "Mr."], on).map((x) => x.selector)).toEqual(["#why"]);
  });

  it("says nothing about an empty box or one the form switched off: those are other checks", () => {
    expect(showsAnother(planned, [], ["", "Edmonton", "", ""], on)).toEqual([]);
    expect(showsAnother(planned, [], ["Central African Republic", "Edmonton", "", ""], ["off", "on", "on", "on"] as never)).toEqual([]);
  });
});

describe("a form that was not on screen when it was read back", () => {
  const planned = Array.from({ length: 10 }, (_, i) => ({ selector: `#f${i}`, kind: "text", label: `F${i}`, action: "fill", value: "v" })) as unknown as Parameters<typeof notOnScreen>[0];
  const states = (off: number) => planned.map((_, i) => (i < off ? "off" : "on")) as Parameters<typeof notOnScreen>[1];

  it("holds the form, and the hold is one no plan field can explain away", () => {
    const found = notOnScreen(planned, states(10));
    expect(found).toHaveLength(1);
    expect(found[0]?.why).toMatch(/10 of the form's 10 boxes were not on screen/);
    expect(splitFailures({ fields: planned } as never, found, planned.map(() => "v")).holds).toHaveLength(1);
    expect(notOnScreen(planned, planned.map(() => "missing") as never)).toHaveLength(1);
  });

  it("lets through the few boxes another answer switched off", () => {
    expect(notOnScreen(planned, states(0))).toEqual([]);
    expect(notOnScreen(planned, states(3))).toEqual([]);
    expect(notOnScreen(planned, states(4))).toHaveLength(1);
  });
});

describe("a box that already shows its value", () => {
  it("is left alone, whatever shape the site writes the value in", () => {
    expect(rightAlready({ selector: "#c", kind: "combobox", value: "Canada" }, "Canada")).toBe(true);
    expect(rightAlready({ selector: "#p", kind: "tel", value: "7805550100" }, "(780) 555-0100")).toBe(true);
    expect(rightAlready({ selector: "#code", kind: "combobox", value: "Canada (+1)" }, "Canada (+1)")).toBe(true);
    expect(rightAlready({ selector: "#r", kind: "radio", value: "No" }, "No")).toBe(true);
  });

  it("is written when it is empty or shows something else", () => {
    expect(rightAlready({ selector: "#c", kind: "combobox", value: "Canada" }, "")).toBe(false);
    expect(rightAlready({ selector: "#c", kind: "combobox", value: "Canada" }, "Cameroon")).toBe(false);
    expect(rightAlready({ selector: "#code", kind: "combobox", value: "Canada (+1)" }, "Anguilla (+1)")).toBe(false);
    expect(rightAlready({ selector: "#city", kind: "text", value: "Edmonton" }, "Calgary")).toBe(false);
    expect(rightAlready({ selector: "#cv", kind: "file", value: "resume.pdf" }, "resume.pdf")).toBe(false);
  });
});

describe("choices that sit close together", () => {
  it("picks none when a short value is inside many options and nothing of the candidate's tells them apart", () => {
    const codes = ["American Samoa (+1)", "Anguilla (+1)", "Bahamas (+1)"];
    expect(pickOption(codes, "+1", ["Edmonton", "Alberta", "AB", "Canada"])).toBeNull();
    expect(pickOption([...codes, "Canada (+1)"], "+1", ["Edmonton", "Alberta", "AB", "Canada"])).toBe("Canada (+1)");
    expect(pickOption([...codes, "Canada (+1)"], "Canada (+1)", [])).toBe("Canada (+1)");
    expect(pickOption(["Yes", "No"], "No", [])).toBe("No");
  });

  it("does not take two values for the same because their digits are", () => {
    expect(showsPicked("Canada (+1)", "Anguilla (+1)")).toBe(false);
    expect(showsPicked("May 2026", "June 2026")).toBe(false);
    expect(showsPicked("7805550100", "(780) 555-0100")).toBe(true);
    expect(showsPicked("T6J 1B5", "T6J1B5")).toBe(true);
  });

  it("takes a day or a month for the same with or without its leading zero, and nothing looser", () => {
    expect(showsPicked("05", "5")).toBe(true);
    expect(showsPicked("1", "01")).toBe(true);
    expect(showsPicked("5", "15")).toBe(false);
    expect(showsPicked("05", "6")).toBe(false);
  });

  it("takes the last step of a path as what a list shows once it is picked", () => {
    expect(showsPicked("Job Board > Other", "Other")).toBe(true);
    expect(showsPicked("Job Board > Other", "LinkedIn")).toBe(false);
    expect(showsPicked("Canada", "Canada")).toBe(true);
    expect(showsPicked("Canada", "Cameroon")).toBe(false);
  });
});

describe("a form that is not given up at the first trouble", () => {
  const planned = [
    { selector: "#zip", label: "Postal Code*" },
    { selector: "#src", label: "How Did You Hear About Us? (required)" },
    { selector: "#x", label: "No" },
  ];

  it("finds the boxes a page's own errors name, each once, with the page's words", () => {
    const found = fieldsBlamed(planned, ["Error: Postal Code is required and must have a value.", "Error - How Did You Hear About Us?: enter a value", "Postal Code is not valid"]);
    expect(found.map((x) => x.selector)).toEqual(["#zip", "#src"]);
    expect(found[0]?.why).toMatch(/would not move on and said: "Error: Postal Code is required/);
    expect(fieldsBlamed(planned, ["Something went wrong. No changes were saved."])).toEqual([]);
  });

  it("asks the writer again while a round changes what did not land, and stops when it changes nothing", () => {
    const report = (failed: { selector: string; why: string }[], over: object = {}) => ({ state: "filled", failed: failed.map((f) => ({ ...f, label: f.selector })), ...over }) as never;
    const seen = new Set<string>();
    const first = [{ selector: "#c", why: 'no option matches "Canada" among: CA | US' }];
    expect(askAgain(report(first), seen)).toBe(true);
    expect(askAgain(report(first), seen)).toBe(false);
    expect(askAgain(report([{ selector: "#c", why: 'the page shows "US" instead of "CA"' }]), seen)).toBe(true);
    expect(askAgain(report([]), new Set())).toBe(false);
    expect(askAgain(report(first, { stuck: "held" }), new Set())).toBe(false);
    expect(askAgain(report(first, { resolution: { verdict: "skip" } }), new Set())).toBe(false);
  });
});

describe("a dropdown that took an option for its value", () => {
  it("has landed when it shows that option, though the option says more than the value", () => {
    expect(tookChoice({ selector: "#country", kind: "combobox", value: "+1", picked: "Canada +1" }, "Canada +1")).toBe(true);
    expect(tookChoice({ selector: "#country", kind: "combobox", value: "+1", picked: "Canada +1" }, "Anguilla +1")).toBe(false);
    expect(tookChoice({ selector: "#country", kind: "combobox", value: "+1" }, "Canada +1")).toBe(false);
    expect(tookChoice({ selector: "#c", kind: "combobox", value: "Canada" }, "Canada")).toBe(true);
  });

  it("is held to that option by the read-back and by the check before Submit", () => {
    expect(showsPlanned({ kind: "combobox", value: "+1", optionLabel: "Canada +1" }, "Canada +1")).toBe(true);
    expect(showsPlanned({ kind: "combobox", value: "+1", optionLabel: "Canada +1" }, "Anguilla +1")).toBe(false);
    expect(showsPlanned({ kind: "combobox", value: "+1", optionLabel: null }, "Canada +1")).toBe(false);
  });
});

describe("one item of a list of several", () => {
  it("is the option with the same words, or the same words and a suffix, never a longer word", () => {
    expect(sameItem(["React Native", "React.js", "React (JavaScript Library)"], "React")).toBe("React.js");
    expect(sameItem(["C#", "C++", "C (Programming Language)"], "C")).toBe("C (Programming Language)");
    expect(sameItem(["JavaScript", "Java"], "Java")).toBe("Java");
    expect(sameItem(["TypeScript"], "Python")).toBeNull();
    expect(sameItem(["Python IDLE", "Python Scripting"], "Python")).toBeNull();
    expect(sameItem(["SQL Script", "SQL"], "SQL")).toBe("SQL");
  });
});
