import { describe, expect, it } from "vitest";
import { keyedFieldIds, keyTableOf, matchKey, matchProblem } from "../../src/shared/matches";
import { allowedEdges, pathEdges } from "../../src/shared/paths";
import type { Field, FieldOptions, FieldType } from "../../src/shared/types";

const field = (id: string, tableId: string, type: FieldType, options: FieldOptions = {}): Field => ({ id, tableId, name: id, type, options, ord: "a" });

describe("matchKey", () => {
  it("trims and lowercases, and leaves blanks and non-text out", () => {
    expect(matchKey(" Alice@X.com ")).toBe("alice@x.com");
    expect(matchKey("Ä@x.com")).toBe(matchKey("ä@x.com"));
    expect(matchKey("  ")).toBeNull();
    expect(matchKey(undefined)).toBeNull();
    expect(matchKey(3)).toBeNull();
  });
});

describe("matchProblem and keyedFieldIds", () => {
  const address = field("fAddr", "tEmails", "text");
  it("names what is wrong", () => {
    expect(matchProblem(field("fTw", "tTw", "email", { match: { fieldId: "fGone" } }), [address])).toBe("Its column was deleted");
    expect(matchProblem(field("fTw", "tTw", "number", { match: { fieldId: "fAddr" } }), [address])).toBe("This column is no longer text");
    expect(matchProblem(field("fTw", "tTw", "email", { match: { fieldId: "fNum" } }), [field("fNum", "tEmails", "number")])).toBe("Its column is no longer text");
    const self = field("fTw", "tTw", "email", { match: { fieldId: "fTw" } });
    expect(matchProblem(self, [self])).toBe("A column cannot match itself");
    expect(matchProblem(field("fTw", "tTw", "email", { match: { fieldId: "fAddr" } }), [address])).toBeNull();
    expect(matchProblem(address, [address])).toBeNull();
  });
  it("keys both sides of valid matches only", () => {
    const tw = field("fTw", "tTw", "email", { match: { fieldId: "fAddr" } });
    const bad = field("fBad", "tTw", "text", { match: { fieldId: "fGone" } });
    expect(keyedFieldIds([address, tw, bad])).toEqual(new Set(["fTw", "fAddr"]));
    expect(keyTableOf("fTw")).toBe("k_fTw");
  });
});

describe("pathEdges with matches", () => {
  const address = field("fAddr", "tEmails", "text");
  it("orients a match like a link created on the matching table", () => {
    const tw = field("fTw", "tTw", "email", { match: { fieldId: "fAddr" } });
    expect(pathEdges([address, tw], "dependents")).toEqual([{ fieldId: "fTw", linkTable: "", from: "tEmails", to: "tTw", fromCol: "a", toCol: "a", keys: { from: "k_fAddr", to: "k_fTw" } }]);
    const flipped = field("fTw", "tTw", "email", { match: { fieldId: "fAddr", dependsOn: false } });
    expect(pathEdges([address, flipped], "dependents")).toMatchObject([{ from: "tTw", to: "tEmails", keys: { from: "k_fTw", to: "k_fAddr" } }]);
    expect(pathEdges([address, field("fTw", "tTw", "email", { match: { fieldId: "fAddr", pathRole: "none" } })], "dependents")).toEqual([]);
    expect(pathEdges([address, field("fTw", "tTw", "email", { match: { fieldId: "fGone" } })], "dependents")).toEqual([]);
  });
  it("lets a path run through a match and a link", () => {
    const tw = field("fTw", "tTw", "email", { match: { fieldId: "fAddr" } });
    const accTw = field("fAccTw", "tAcc", "link", { linkedTableId: "tTw", linkTable: "l_1", linkSide: "a", inverseFieldId: "fTwAcc" });
    const twAcc = field("fTwAcc", "tTw", "link", { linkedTableId: "tAcc", linkTable: "l_1", linkSide: "b", inverseFieldId: "fAccTw" });
    const edges = allowedEdges([address, tw, accTw, twAcc], "tEmails", "tAcc", "dependents");
    expect(edges.map(e => e.fieldId).sort()).toEqual(["fTw", "fTwAcc"]);
  });
});
