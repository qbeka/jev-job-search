import { describe, expect, it } from "vitest";
import { withDistinctLabels } from "../src/forms/mapForm.js";
import { FieldsDump } from "../src/forms/fields.js";

const box = (id: string, label: string, placeholder: string) => ({ id, selector: `#${id}`, kind: "text", label, placeholder, name: id });

describe("boxes that share one label", () => {
  it("are told apart by their placeholders, the way a JazzHR address block is laid out", () => {
    const dump = FieldsDump.parse({ url: "https://x.applytojob.com/apply/1", fields: [
      box("a", "Address", "Address"), box("c", "Address", "City"), box("s", "Address", "State/Province"), box("p", "Address", "Postal"), box("e", "Email", "you@example.com"),
    ] });
    expect(withDistinctLabels(dump).fields.map((f) => f.label)).toEqual(["Address", "Address: City", "Address: State/Province", "Address: Postal", "Email"]);
  });
  it("leaves a label alone when it is the only one, or when there is no placeholder", () => {
    const dump = FieldsDump.parse({ url: "https://x", fields: [box("a", "Phone", "555"), box("b", "Address", ""), box("c", "Address", "")] });
    expect(withDistinctLabels(dump).fields.map((f) => f.label)).toEqual(["Phone", "Address", "Address"]);
  });
});
