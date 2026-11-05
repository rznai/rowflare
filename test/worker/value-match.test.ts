import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { BaseDO } from "../../src/worker/base-do";
import type { BaseStore } from "../../src/worker/base/store";
import type { FilterSpec, LinkValue } from "../../src/shared/types";

const actor = { userId: "u1", name: "Tester" };

async function withStore<R>(name: string, fn: (s: BaseStore, d: BaseDO) => R | Promise<R>): Promise<R> {
  const stub = env.BASE.get(env.BASE.idFromName(name));
  return runInDurableObject(stub, async (instance: BaseDO) => {
    if (!instance.store.initialized) instance.store.init(name);
    return fn(instance.store, instance);
  });
}

const fieldId = (s: BaseStore, t: string, n: string) => s.fieldsOf(t).find(x => x.name === n)!.id;
const keys = (s: BaseStore, fid: string) => s.all<{ v: string; id: number }>(`SELECT v, id FROM k_${fid} ORDER BY id, v`);
const keyTables = (s: BaseStore) => s.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'k\\_%' ESCAPE '\\' ORDER BY name").map(r => r.name);
const keyRows = (s: BaseStore) => s.all<{ field_id: string }>("SELECT field_id FROM _keys ORDER BY field_id").map(r => r.field_id);

/** Emails, and a Twitter table whose Email column holds addresses as text. */
function setupTwitter(s: BaseStore, match = true) {
  const emails = s.createTable(actor, { name: "Emails", fields: [{ name: "Address", type: "text" }] }).tableId;
  const addr = fieldId(s, emails, "Address");
  const twitter = s.createTable(actor, { name: "Twitter", fields: [{ name: "Handle", type: "text" }, { name: "Email", type: "email", ...(match ? { options: { match: { fieldId: addr } } } : {}) }, { name: "Notes", type: "text" }] }).tableId;
  const twEmail = fieldId(s, twitter, "Email"), handle = fieldId(s, twitter, "Handle"), notes = fieldId(s, twitter, "Notes");
  const [e1, e2] = s.createRows(actor, emails, [{ cells: { [addr]: "a@x.com" } }, { cells: { [addr]: "B@x.com" } }]).created!;
  const [t1, t2] = s.createRows(actor, twitter, [{ cells: { [handle]: "@alice", [twEmail]: " A@X.com " } }, { cells: { [handle]: "@nobody" } }]).created!;
  return { emails, twitter, addr, twEmail, handle, notes, e1, e2, t1, t2 };
}

describe("value match: keys", () => {
  it("builds key tables for both sides when a match is set", async () => {
    await withStore("vm-build", s => {
      const p = setupTwitter(s);
      expect(s.keyReady(p.twEmail)).toBe(true);
      expect(s.keyReady(p.addr)).toBe(true);
      expect(keys(s, p.twEmail)).toEqual([{ v: "a@x.com", id: p.t1 }]);
      expect(keys(s, p.addr)).toEqual([{ v: "a@x.com", id: p.e1 }, { v: "b@x.com", id: p.e2 }]);
    });
  });

  it("keeps keys in step with writes and leaves other columns alone", async () => {
    await withStore("vm-writes", s => {
      const p = setupTwitter(s);
      const [t3] = s.createRows(actor, p.twitter, [{ cells: { [p.twEmail]: "c@x.com" } }]).created!;
      s.updateRows(actor, p.twitter, [{ id: p.t1, cells: { [p.twEmail]: "" } }, { id: p.t2, cells: { [p.twEmail]: "b@x.com" } }]);
      expect(keys(s, p.twEmail)).toEqual([{ v: "b@x.com", id: p.t2 }, { v: "c@x.com", id: t3 }]);
      s.deleteRows(actor, p.twitter, [t3]);
      expect(keys(s, p.twEmail)).toEqual([{ v: "b@x.com", id: p.t2 }]);
      // A write that does not touch a keyed column rewrites no keys.
      s.sql.exec(`UPDATE k_${p.twEmail} SET v = 'sentinel'`);
      s.updateRows(actor, p.twitter, [{ id: p.t2, cells: { [p.notes]: "hi" } }]);
      expect(keys(s, p.twEmail)).toEqual([{ v: "sentinel", id: p.t2 }]);
    });
  });

  it("fills large tables in a job, and writes during the job leave one right key per record", async () => {
    await withStore("vm-job", s => {
      const p = setupTwitter(s, false);
      const many = s.createRows(actor, p.twitter, Array.from({ length: 2001 }, (_, i) => ({ cells: { [p.twEmail]: `u${i}@x.com` } })), { noTriggers: true }).created!;
      s.updateField(p.twEmail, { options: { match: { fieldId: p.addr } } });
      expect(s.keyReady(p.twEmail)).toBe(false);
      // Until the addresses are keyed and the first of the Twitter batches is in.
      while (!s.keyReady(p.addr) || !keys(s, p.twEmail).length) s.runJobStep();
      const early = many[0], late = many[2000];
      s.updateRows(actor, p.twitter, [{ id: early, cells: { [p.twEmail]: "early@x.com" } }, { id: late, cells: { [p.twEmail]: "late@x.com" } }]);
      while (!s.keyReady(p.twEmail)) s.runJobStep();
      const all = keys(s, p.twEmail);
      expect(all.length).toBe(2001 + 1); // the 2,001 rows plus " A@X.com " of @alice
      expect(all.filter(k => k.id === early)).toEqual([{ v: "early@x.com", id: early }]);
      expect(all.filter(k => k.id === late)).toEqual([{ v: "late@x.com", id: late }]);
    });
  });

  it("drops key tables with the match, the column or the table", async () => {
    await withStore("vm-drop", s => {
      const p = setupTwitter(s);
      // A second column matching the same address keeps the address keys alive.
      const other = s.createField(p.twitter, { name: "Backup", type: "text", options: { match: { fieldId: p.addr } } }).fieldId;
      expect(keyRows(s)).toEqual([p.addr, other, p.twEmail].sort());
      s.updateField(p.twEmail, { options: { match: null as never } });
      expect(keyRows(s)).toEqual([p.addr, other].sort());
      expect(keyTables(s)).toEqual(["k_" + p.addr, "k_" + other].sort());
      s.deleteField(other);
      expect(keyRows(s)).toEqual([]);
      expect(keyTables(s)).toEqual([]);
      s.updateField(p.twEmail, { options: { match: { fieldId: p.addr } } });
      expect(keyRows(s).length).toBe(2);
      s.deleteTable(p.emails);
      expect(keyRows(s)).toEqual([]);
      expect(keyTables(s)).toEqual([]);
    });
  });

  it("keeps a broken match and comes back when the column is text again", async () => {
    await withStore("vm-revive", s => {
      const p = setupTwitter(s);
      s.updateField(p.addr, { type: "number" });
      expect(s.field(p.twEmail).options.match?.fieldId).toBe(p.addr);
      expect(keyTables(s)).toEqual([]);
      s.updateField(p.addr, { type: "text" });
      s.updateRows(actor, p.emails, [{ id: p.e1, cells: { [p.addr]: "a@x.com" } }]);
      expect(keys(s, p.twEmail)).toEqual([{ v: "a@x.com", id: p.t1 }]);
      expect(keys(s, p.addr).map(k => k.id)).toContain(p.e1);
      // The matching column's own type change keeps its setting too.
      s.updateField(p.twEmail, { type: "number" });
      expect(s.field(p.twEmail).options.match?.fieldId).toBe(p.addr);
      expect(keyTables(s)).toEqual([]);
    });
  });

  it("refuses matches it cannot answer", async () => {
    await withStore("vm-check", s => {
      const p = setupTwitter(s, false);
      const num = s.createField(p.twitter, { name: "Count", type: "number" }).fieldId;
      expect(() => s.updateField(num, { options: { match: { fieldId: p.addr } } })).toThrow("Only text, email, URL and phone fields can match another table");
      expect(() => s.updateField(p.twEmail, { options: { match: { fieldId: num } } })).toThrow("Choose a text, email, URL or phone field to match");
      expect(() => s.updateField(p.twEmail, { options: { match: { fieldId: p.twEmail } } })).toThrow("A field cannot match itself");
      expect(() => s.createField(p.twitter, { name: "X", type: "text", options: { match: { fieldId: "fldNope" } } })).toThrow("Choose a text, email, URL or phone field to match");
    });
  });
});

/** Emails; Twitter accounts naming an email as text; platform Accounts signed in with Twitter (or with an email link). */
function setupPaths(s: BaseStore, opts: { matchRows?: number } = {}) {
  const emails = s.createTable(actor, { name: "Emails", fields: [{ name: "Address", type: "text" }] }).tableId;
  const addr = fieldId(s, emails, "Address");
  const twitter = s.createTable(actor, { name: "Twitter", fields: [{ name: "Handle", type: "text" }, { name: "Email", type: "email" }] }).tableId;
  const twEmail = fieldId(s, twitter, "Email"), twHandle = fieldId(s, twitter, "Handle");
  const accounts = s.createTable(actor, {
    name: "Accounts",
    fields: [{ name: "Handle", type: "text" }, { name: "Platform", type: "singleSelect", options: { choices: [{ id: "selXxx000000", name: "xxx", color: "#eee" }, { id: "selYyy000000", name: "yyy", color: "#eee" }] } }],
  }).tableId;
  const handle = fieldId(s, accounts, "Handle"), platform = fieldId(s, accounts, "Platform");
  const accTw = s.createField(accounts, { name: "Twitter", type: "link", options: { linkedTableId: twitter } }).fieldId;
  const accEmail = s.createField(accounts, { name: "Email", type: "link", options: { linkedTableId: emails } }).fieldId;
  const [e1, e2, e3] = s.createRows(actor, emails, ["a@x.com", "b@x.com", "c@x.com"].map(a => ({ cells: { [addr]: a } }))).created!;
  const [t1, t2] = s.createRows(actor, twitter, [{ cells: { [twHandle]: "@alice2", [twEmail]: " B@X.com " } }, { cells: { [twHandle]: "@empty" } }]).created!;
  if (opts.matchRows) s.createRows(actor, twitter, Array.from({ length: opts.matchRows }, (_, i) => ({ cells: { [twEmail]: `bulk${i}@x.com` } })), { noTriggers: true });
  s.updateField(twEmail, { options: { match: { fieldId: addr } } });
  const [a1, a2] = s.createRows(actor, accounts, [
    { cells: { [handle]: "bob-x", [platform]: "selXxx000000", [accTw]: [t1] } },
    { cells: { [handle]: "ann-x", [platform]: "selXxx000000", [accTw]: [t2] } },
  ]).created!;
  const onlyXxx: FilterSpec = { conjunction: "and", conditions: [{ fieldId: platform, op: "eq", value: "selXxx000000" }] };
  const lookup = (extra: Record<string, unknown> = {}) => s.createField(emails, { name: "xxx accounts", type: "pathLookup", options: { targetTableId: accounts, pathDirection: "dependents", targetFilter: onlyXxx, ...extra } }).fieldId;
  return { emails, twitter, accounts, addr, twEmail, twHandle, handle, platform, accTw, accEmail, e1, e2, e3, t1, t2, a1, a2, onlyXxx, lookup };
}

const emptyFilter = (fid: string): FilterSpec => ({ conjunction: "and", conditions: [{ fieldId: fid, op: "empty" }] });
const ids = (v: unknown) => ((v ?? []) as LinkValue[]).map(x => x.id);

describe("value match: paths", () => {
  it("walks a match like a link, comparing values without case or spaces", async () => {
    await withStore("vm-start", s => {
      const p = setupPaths(s);
      const pl = p.lookup();
      const rows = s.getRows(p.emails, [p.e1, p.e2, p.e3]);
      expect(rows.map(r => ids(r.cells[pl]))).toEqual([[], [p.a1], []]);
      // @empty has no email, so ann-x reaches nothing.
      expect(s.query(p.emails, { filters: emptyFilter(pl) }).ids).toEqual([p.e1, p.e3]);
    });
  });

  it("ignores columns with the same values that were not set to match", async () => {
    await withStore("vm-unset", s => {
      const p = setupPaths(s);
      const other = s.createTable(actor, { name: "Other", fields: [{ name: "Address", type: "text" }] }).tableId;
      const link = s.createField(p.accounts, { name: "Other", type: "link", options: { linkedTableId: other } }).fieldId;
      const [o1] = s.createRows(actor, other, [{ cells: { [fieldId(s, other, "Address")]: "a@x.com" } }]).created!;
      s.updateRows(actor, p.accounts, [{ id: p.a2, cells: { [link]: [o1] } }]);
      const pl = p.lookup();
      expect(ids(s.getRows(p.emails, [p.e1])[0].cells[pl])).toEqual([]);
    });
  });

  it("follows the match's direction and stays out when it is not a dependency", async () => {
    await withStore("vm-direction", s => {
      const p = setupPaths(s);
      const pl = p.lookup();
      s.updateField(p.twEmail, { options: { match: { fieldId: p.addr, dependsOn: false } } });
      expect(ids(s.getRows(p.emails, [p.e2])[0].cells[pl])).toEqual([]);
      const up = s.createField(p.emails, { name: "Twitter it depends on", type: "pathLookup", options: { targetTableId: p.twitter, pathDirection: "dependencies" } }).fieldId;
      expect(ids(s.getRows(p.emails, [p.e2])[0].cells[up])).toEqual([p.t1]);
      s.updateField(p.twEmail, { options: { match: { fieldId: p.addr, pathRole: "none" } } });
      expect(s.pathProblem(up)).toBe("No links lead to its target table any more");
    });
  });

  it("can be left out of a path lookup like a link", async () => {
    await withStore("vm-exclude", s => {
      const p = setupPaths(s);
      s.updateRows(actor, p.accounts, [{ id: p.a2, cells: { [p.accEmail]: [p.e3] } }]);
      const pl = p.lookup({ excludeLinkFieldIds: [p.twEmail] });
      expect(s.field(pl).options.excludeLinkFieldIds).toEqual([p.twEmail]);
      expect(s.getRows(p.emails, [p.e2, p.e3]).map(r => ids(r.cells[pl]))).toEqual([[], [p.a2]]);
    });
  });

  it("reflects edits on either side, and tells the right views to reload", async () => {
    await withStore("vm-fresh", s => {
      const p = setupPaths(s);
      const pl = p.lookup();
      const misc = s.createTable(actor, { name: "Misc", fields: [{ name: "Name", type: "text" }] }).tableId;
      const cell = (e: number) => ids(s.getRows(p.emails, [e])[0].cells[pl]);
      const tw = s.updateRows(actor, p.twitter, [{ id: p.t1, cells: { [p.twEmail]: "c@x.com" } }]);
      expect([cell(p.e2), cell(p.e3)]).toEqual([[], [p.a1]]);
      expect(s.pathTablesAffected(tw)).toEqual([p.emails]);
      // An edit to the matched column alone changes paths from Emails, and the Twitter rows that match it.
      const em = s.updateRows(actor, p.emails, [{ id: p.e3, cells: { [p.addr]: "zzz@x.com" } }]);
      expect(cell(p.e3)).toEqual([]);
      expect(s.pathTablesAffected(em).sort()).toEqual([p.emails, p.twitter].sort());
      const [t3] = s.createRows(actor, p.twitter, [{ cells: { [p.twEmail]: "A@x.com" } }]).created!;
      s.updateRows(actor, p.accounts, [{ id: p.a2, cells: { [p.accTw]: [t3] } }]);
      expect(cell(p.e1)).toEqual([p.a2]);
      s.deleteRows(actor, p.twitter, [t3]);
      expect(cell(p.e1)).toEqual([]);
      expect(s.pathTablesAffected(s.createRows(actor, misc, [{}]))).toEqual([]);
    });
  });

  it("marks cells incomplete and refuses filters until the keys are filled", async () => {
    await withStore("vm-pending", s => {
      const p = setupPaths(s, { matchRows: 2001 });
      expect(s.keyReady(p.twEmail)).toBe(false);
      const pl = p.lookup();
      expect(() => s.query(p.emails, { filters: emptyFilter(pl) })).toThrow("still being prepared");
      expect(s.getRows(p.emails, [p.e2])[0].paths?.[pl]?.incomplete).toBe(true);
      while (s.hasJobs()) s.runJobStep();
      expect(s.query(p.emails, { filters: emptyFilter(pl) }).ids).toEqual([p.e1, p.e3]);
      expect(s.getRows(p.emails, [p.e2])[0].paths?.[pl]).toBeUndefined();
    });
  });

  it("lists the matched records on the matching row", async () => {
    await withStore("vm-cells", s => {
      const p = setupPaths(s);
      expect(s.getRows(p.twitter, [p.t1])[0].matches).toEqual({ [p.twEmail]: [{ id: p.e2, t: "b@x.com" }] });
      const [e4] = s.createRows(actor, p.emails, [{ cells: { [p.addr]: "b@x.com " } }]).created!;
      expect(ids(s.getRows(p.twitter, [p.t1])[0].matches?.[p.twEmail])).toEqual([p.e2, e4]);
      expect(s.getRows(p.twitter, [p.t2])[0].matches).toBeUndefined();
      // Rows returned by a person's write carry them too.
      const res = s.updateRows(actor, p.twitter, [{ id: p.t2, cells: { [p.twEmail]: "a@x.com" } }]);
      expect(res.changes.find(c => c.tableId === p.twitter)!.rows[0].matches).toEqual({ [p.twEmail]: [{ id: p.e1, t: "a@x.com" }] });
    });
  });

  it("explains a result reached through a match", async () => {
    await withStore("vm-why", s => {
      const p = setupPaths(s);
      const pl = p.lookup();
      const hops = s.explainPath(pl, p.e2, p.a1)!;
      expect(hops.map(h => [h.tableId, h.id, h.fieldId])).toEqual([
        [p.emails, p.e2, undefined],
        [p.twitter, p.t1, p.twEmail],
        [p.accounts, p.a1, s.field(p.accTw).options.inverseFieldId],
      ]);
    });
  });

  it("leaves the matching column an ordinary text column", async () => {
    await withStore("vm-plain", s => {
      const p = setupPaths(s);
      const sorted = s.query(p.twitter, { sorts: [{ fieldId: p.twEmail, dir: "desc" }] }).ids;
      expect(sorted[0]).toBe(p.t1);
      expect(s.query(p.twitter, { filters: { conjunction: "and", conditions: [{ fieldId: p.twEmail, op: "contains", value: "b@x" }] } }).ids).toEqual([p.t1]);
      expect(s.query(p.twitter, { groupLevels: [{ fieldId: p.twEmail, dir: "asc" }] }).ids.length).toBe(2);
    });
  });
});

describe("value match: review fixes", () => {
  it("saves other edits to a field whose match is broken", async () => {
    await withStore("vm-fix-broken", s => {
      const p = setupTwitter(s);
      s.updateField(p.addr, { type: "number" });
      s.updateField(p.twEmail, { name: "Mail", options: { match: { fieldId: p.addr } } });
      expect(s.field(p.twEmail).name).toBe("Mail");
      expect(s.field(p.twEmail).options.match?.fieldId).toBe(p.addr);
    });
  });

  it("reloads matching views only when the matched values can have changed", async () => {
    await withStore("vm-fix-reload", s => {
      const p = setupPaths(s);
      const notes = s.createField(p.emails, { name: "Notes", type: "text" }).fieldId;
      p.lookup();
      expect(s.pathTablesAffected(s.updateRows(actor, p.emails, [{ id: p.e1, cells: { [notes]: "hi" } }]))).toEqual([]);
      expect(s.pathTablesAffected(s.updateRows(actor, p.emails, [{ id: p.e1, cells: { [p.addr]: "q@x.com" } }])).sort()).toEqual([p.emails, p.twitter].sort());
      expect(s.pathTablesAffected(s.createRows(actor, p.emails, [{ cells: { [notes]: "new" } }])).sort()).toEqual([p.emails, p.twitter].sort());
      expect(s.pathTablesAffected(s.deleteRows(actor, p.emails, [p.e3])).sort()).toEqual([p.emails, p.twitter].sort());
    });
  });

  it("fills keys after a type change has converted the values", async () => {
    await withStore("vm-fix-order", s => {
      const p = setupTwitter(s);
      s.createRows(actor, p.twitter, Array.from({ length: 2001 }, (_, i) => ({ cells: { [p.twEmail]: `u${i}@x.com` } })), { noTriggers: true });
      s.updateField(p.twEmail, { type: "longText" });
      s.updateField(p.twEmail, { type: "text" });
      const kinds = s.all<{ kind: string; payload: string }>("SELECT kind, payload FROM _jobs ORDER BY id").filter(j => j.payload.includes(p.twEmail)).map(j => j.kind);
      expect(kinds.lastIndexOf("convert")).toBeLessThan(kinds.indexOf("keys"));
    });
  });

  it("caps matched records at 100 per cell", async () => {
    await withStore("vm-fix-cap", s => {
      const p = setupTwitter(s);
      s.createRows(actor, p.emails, Array.from({ length: 150 }, () => ({ cells: { [p.addr]: "a@x.com" } })), { noTriggers: true });
      expect(s.getRows(p.twitter, [p.t1])[0].matches?.[p.twEmail]).toHaveLength(100);
    });
  });
});
