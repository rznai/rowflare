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

/** Emails <- GitHub (sign-up email) <- Accounts (signed in with GitHub, with a Platform), plus direct email sign-ups and Google sign-ins. */
function setupAccounts(s: BaseStore) {
  const emails = s.createTable(actor, { name: "Emails", fields: [{ name: "Address", type: "text" }] }).tableId;
  const github = s.createTable(actor, { name: "GitHub", fields: [{ name: "Login", type: "text" }] }).tableId;
  const google = s.createTable(actor, { name: "Google", fields: [{ name: "Account", type: "text" }] }).tableId;
  const accounts = s.createTable(actor, {
    name: "Accounts",
    fields: [
      { name: "Handle", type: "text" },
      { name: "Platform", type: "singleSelect", options: { choices: [{ id: "selXxx000000", name: "xxx", color: "#eee" }, { id: "selYyy000000", name: "yyy", color: "#eee" }] } },
    ],
  }).tableId;
  const ghEmail = s.createField(github, { name: "Email", type: "link", options: { linkedTableId: emails } }).fieldId;
  const ggEmail = s.createField(google, { name: "Email", type: "link", options: { linkedTableId: emails } }).fieldId;
  const accEmail = s.createField(accounts, { name: "Email", type: "link", options: { linkedTableId: emails } }).fieldId;
  const accGithub = s.createField(accounts, { name: "GitHub", type: "link", options: { linkedTableId: github } }).fieldId;
  const accGoogle = s.createField(accounts, { name: "Google", type: "link", options: { linkedTableId: google } }).fieldId;
  const add = (t: string, cells: Record<string, unknown>[]) => s.createRows(actor, t, cells.map(c => ({ cells: c }))).created!;
  const addr = fieldId(s, emails, "Address");
  const [e1, e2, e3, e4, e5] = add(emails, ["a@x.com", "b@x.com", "c@x.com", "d@x.com", "e@x.com"].map(a => ({ [addr]: a })));
  const [g1, g2] = add(github, [{ [fieldId(s, github, "Login")]: "alice-dev", [ghEmail]: [e1] }, { [fieldId(s, github, "Login")]: "bob-dev", [ghEmail]: [e2] }]);
  const [o1] = add(google, [{ [fieldId(s, google, "Account")]: "carol.g", [ggEmail]: [e3] }]);
  const handle = fieldId(s, accounts, "Handle"), platform = fieldId(s, accounts, "Platform");
  const [a1, a2, a3, a4] = add(accounts, [
    { [handle]: "alice123", [platform]: "selXxx000000", [accGithub]: [g1] }, // via GitHub
    { [handle]: "bob-yyy", [platform]: "selYyy000000", [accGithub]: [g2] }, // other platform
    { [handle]: "carol-x", [platform]: "selXxx000000", [accGoogle]: [o1] }, // via Google
    { [handle]: "dave-x", [platform]: "selXxx000000", [accEmail]: [e4] }, // direct sign-up
  ]);
  const onlyXxx: FilterSpec = { conjunction: "and", conditions: [{ fieldId: platform, op: "eq", value: "selXxx000000" }] };
  return { emails, github, google, accounts, ghEmail, ggEmail, accEmail, accGithub, accGoogle, addr, handle, platform, e1, e2, e3, e4, e5, g1, g2, o1, a1, a2, a3, a4, onlyXxx };
}

const emptyFilter = (fid: string, op: "empty" | "notempty" = "empty"): FilterSpec => ({ conjunction: "and", conditions: [{ fieldId: fid, op }] });
const ids = (v: unknown) => ((v ?? []) as LinkValue[]).map(x => x.id);

describe("path lookup", () => {
  it("finds the emails not used on a platform through every path", async () => {
    await withStore("path-start", s => {
      const p = setupAccounts(s);
      const pl = s.createField(p.emails, { name: "xxx accounts", type: "pathLookup", options: { targetTableId: p.accounts, pathDirection: "dependents", targetFilter: p.onlyXxx } }).fieldId;
      const rows = s.getRows(p.emails, [p.e1, p.e2, p.e3, p.e4, p.e5]);
      expect(rows.map(r => ids(r.cells[pl]))).toEqual([[p.a1], [], [p.a3], [p.a4], []]);
      expect(rows[0].cells[pl]).toEqual([{ id: p.a1, t: "alice123" }]);
      expect(s.query(p.emails, { filters: emptyFilter(pl), limit: 0 }).ids.sort()).toEqual([p.e2, p.e5].sort());
      expect(s.query(p.emails, { filters: emptyFilter(pl, "notempty"), limit: 0 }).ids.sort()).toEqual([p.e1, p.e3, p.e4].sort());
      // Nothing is stored in the row.
      const t = s.table(p.emails);
      expect(s.one<{ data: string }>(`SELECT data FROM ${t.phys} WHERE id = ?`, p.e1)!.data).not.toContain(pl);
    });
  });

  it("uses links added after the field was made", async () => {
    await withStore("path-new-link", s => {
      const p = setupAccounts(s);
      const pl = s.createField(p.emails, { name: "xxx accounts", type: "pathLookup", options: { targetTableId: p.accounts, pathDirection: "dependents", targetFilter: p.onlyXxx } }).fieldId;
      const apple = s.createTable(actor, { name: "Apple", fields: [{ name: "Id", type: "text" }] }).tableId;
      const apEmail = s.createField(apple, { name: "Email", type: "link", options: { linkedTableId: p.emails } }).fieldId;
      const accApple = s.createField(p.accounts, { name: "Apple", type: "link", options: { linkedTableId: apple } }).fieldId;
      const [ap] = s.createRows(actor, apple, [{ cells: { [apEmail]: [p.e5] } }]).created!;
      const [a5] = s.createRows(actor, p.accounts, [{ cells: { [p.handle]: "eve", [p.platform]: "selXxx000000", [accApple]: [ap] } }]).created!;
      expect(ids(s.getRow(p.emails, p.e5)!.cells[pl])).toEqual([a5]);
      expect(s.query(p.emails, { filters: emptyFilter(pl), limit: 0 }).ids).toEqual([p.e2]);
    });
  });

  it("follows the dependency direction instead of walking links both ways", async () => {
    await withStore("path-direction", s => {
      const p = setupAccounts(s);
      // e5's recovery email is e4: e5 depends on e4, and e4 is used on xxx.
      const recovery = s.createField(p.emails, { name: "Recovery email", type: "link", options: { linkedTableId: p.emails } }).fieldId;
      s.updateRows(actor, p.emails, [{ id: p.e5, cells: { [recovery]: [p.e4] } }]);
      const pl = s.createField(p.emails, { name: "xxx accounts", type: "pathLookup", options: { targetTableId: p.accounts, pathDirection: "dependents", targetFilter: p.onlyXxx } }).fieldId;
      const all = s.createField(p.emails, { name: "Everything", type: "pathLookup", options: { targetTableId: p.accounts, pathDirection: "dependents" } }).fieldId;
      // Walking both ways, e5 would reach e4 and its xxx account; e5 depends on e4, it is not depended on by it.
      expect(ids(s.getRow(p.emails, p.e5)!.cells[pl])).toEqual([]);
      expect(s.query(p.emails, { filters: emptyFilter(pl), limit: 0 }).ids.sort()).toEqual([p.e2, p.e5].sort());
      // e4 is depended on by e5, so what depends on e5 counts for e4 too; e5 has an yyy account.
      const [a6] = s.createRows(actor, p.accounts, [{ cells: { [p.handle]: "e5-yyy", [p.platform]: "selYyy000000", [p.accEmail]: [p.e5] } }]).created!;
      expect(ids(s.getRow(p.emails, p.e4)!.cells[all]).sort()).toEqual([p.a4, a6].sort());
      // Not a dependency at all: the recovery link is left out, on both sides.
      s.updateField(recovery, { options: { pathRole: "none" } });
      expect(s.field(s.field(recovery).options.inverseFieldId!).options.pathRole).toBe("none");
      expect(ids(s.getRow(p.emails, p.e4)!.cells[all])).toEqual([p.a4]);
      expect(ids(s.getRow(p.emails, p.e5)!.cells[pl])).toEqual([]);
    });
  });

  it("derives the direction of links saved before it existed, and flips both sides together", async () => {
    await withStore("path-legacy", s => {
      const p = setupAccounts(s);
      expect(s.field(p.ghEmail).options.dependsOn).toBeUndefined();
      const pl = s.createField(p.emails, { name: "Accounts", type: "pathLookup", options: { targetTableId: p.accounts, pathDirection: "dependents" } }).fieldId;
      expect(ids(s.getRow(p.emails, p.e1)!.cells[pl])).toEqual([p.a1]);
      // GitHub accounts now count as depending on nothing in Emails: emails depend on them instead.
      s.updateField(p.ghEmail, { options: { dependsOn: false } });
      expect(s.field(s.field(p.ghEmail).options.inverseFieldId!).options.dependsOn).toBe(true);
      expect(ids(s.getRow(p.emails, p.e1)!.cells[pl])).toEqual([]);
      const back = s.createField(p.accounts, { name: "Emails", type: "pathLookup", options: { targetTableId: p.emails, pathDirection: "dependencies" } }).fieldId;
      expect(ids(s.getRow(p.accounts, p.a4)!.cells[back])).toEqual([p.e4]);
    });
  });

  it("ends on loops and walks self-links to any depth", async () => {
    await withStore("path-loops", s => {
      const lists = s.createTable(actor, { name: "Lists", fields: [{ name: "Name", type: "text" }] }).tableId;
      const members = s.createField(lists, { name: "Includes", type: "link", options: { linkedTableId: lists } }).fieldId;
      const name = fieldId(s, lists, "Name");
      const [l1, l2, l3, l4, l5] = s.createRows(actor, lists, ["L1", "L2", "L3", "L4", "L5"].map(n => ({ cells: { [name]: n } }))).created!;
      // L1 includes L2 includes L3 includes L4 includes L2 (a loop); L5 stands alone.
      s.updateRows(actor, lists, [
        { id: l1, cells: { [members]: [l2] } },
        { id: l2, cells: { [members]: [l3] } },
        { id: l3, cells: { [members]: [l4] } },
        { id: l4, cells: { [members]: [l2] } },
      ]);
      const all = s.createField(lists, { name: "All included", type: "pathLookup", options: { targetTableId: lists, pathDirection: "dependencies" } }).fieldId;
      const rows = s.getRows(lists, [l1, l2, l5]);
      expect(ids(rows[0].cells[all])).toEqual([l2, l3, l4]);
      // L2 reaches itself through the loop.
      expect(ids(rows[1].cells[all])).toEqual([l2, l3, l4]);
      expect(ids(rows[2].cells[all])).toEqual([]);
      expect(s.query(lists, { filters: emptyFilter(all), limit: 0 }).ids).toEqual([l5]);
      const two = s.createField(lists, { name: "Two levels", type: "pathLookup", options: { targetTableId: lists, pathDirection: "dependencies", maxDepth: 2 } }).fieldId;
      expect(ids(s.getRow(lists, l1)!.cells[two])).toEqual([l2, l3]);
      expect(s.getRow(lists, l1)!.paths?.[two]).toBeUndefined();

      // A -> B -> A across two tables.
      const a = s.createTable(actor, { name: "A", fields: [{ name: "Name", type: "text" }] }).tableId;
      const b = s.createTable(actor, { name: "B", fields: [{ name: "Name", type: "text" }] }).tableId;
      const ab = s.createField(a, { name: "To B", type: "link", options: { linkedTableId: b } }).fieldId;
      const ba = s.createField(b, { name: "To A", type: "link", options: { linkedTableId: a } }).fieldId;
      const [a1, a2] = s.createRows(actor, a, [{}, {}]).created!;
      const [b1, b2] = s.createRows(actor, b, [{}, {}]).created!;
      s.updateRows(actor, a, [{ id: a1, cells: { [ab]: [b1] } }]);
      s.updateRows(actor, b, [{ id: b1, cells: { [ba]: [a2] } }]);
      s.updateRows(actor, a, [{ id: a2, cells: { [ab]: [b2] } }]);
      const reachB = s.createField(a, { name: "Bs", type: "pathLookup", options: { targetTableId: b, pathDirection: "dependencies" } }).fieldId;
      expect(ids(s.getRow(a, a1)!.cells[reachB])).toEqual([b1, b2]);
      expect(ids(s.getRow(a, a2)!.cells[reachB])).toEqual([b2]);
    });
  });

  it("reflects every change on the next read", async () => {
    await withStore("path-fresh", s => {
      const p = setupAccounts(s);
      const pl = s.createField(p.emails, { name: "xxx accounts", type: "pathLookup", options: { targetTableId: p.accounts, pathDirection: "dependents", targetFilter: p.onlyXxx } }).fieldId;
      const unused = () => s.query(p.emails, { filters: emptyFilter(pl), limit: 0 }).ids.sort();
      expect(unused()).toEqual([p.e2, p.e5].sort());
      s.updateRows(actor, p.accounts, [{ id: p.a2, cells: { [p.platform]: "selXxx000000" } }]);
      expect(unused()).toEqual([p.e5]);
      const res = s.updateRows(actor, p.accounts, [{ id: p.a4, cells: { [p.accEmail]: [] } }]);
      expect(unused()).toEqual([p.e4, p.e5].sort());
      // Rows a write returns carry path values too, and views of the email table are told to reload.
      const e4 = res.changes.find(c => c.tableId === p.emails)!.rows.find(r => r.id === p.e4)!;
      expect(e4.cells[pl]).toBeUndefined();
      expect(res.changes.find(c => c.tableId === p.emails)!.rows.length).toBe(1);
      expect(s.pathTablesAffected(res)).toEqual([p.emails]);
      const other = s.createTable(actor, { name: "Other", fields: [{ name: "Name", type: "text" }] }).tableId;
      expect(s.pathTablesAffected(s.createRows(actor, other, [{}]))).toEqual([]);
      const g1row = s.updateRows(actor, p.accounts, [{ id: p.a4, cells: { [p.accEmail]: [p.e4] } }]).changes.find(c => c.tableId === p.emails)!.rows[0];
      expect(ids(g1row.cells[pl])).toEqual([p.a4]);
      s.updateRows(actor, p.accounts, [{ id: p.a4, cells: { [p.accEmail]: [] } }]);
      s.deleteRows(actor, p.github, [p.g1]);
      expect(unused()).toEqual([p.e1, p.e4, p.e5].sort());
      s.createRows(actor, p.accounts, [{ cells: { [p.handle]: "new", [p.platform]: "selXxx000000", [p.accEmail]: [p.e5] } }]);
      expect(unused()).toEqual([p.e1, p.e4].sort());
    });
  });

  it("marks cells incomplete and refuses to filter when a limit is hit", async () => {
    await withStore("path-limits", s => {
      const p = setupAccounts(s);
      const pl = s.createField(p.emails, { name: "Accounts", type: "pathLookup", options: { targetTableId: p.accounts, pathDirection: "dependents" } }).fieldId;
      s.pathLimits = { nodes: 1, ms: 60_000, depth: 64 };
      const row = s.getRow(p.emails, p.e1)!;
      expect(row.paths?.[pl]?.incomplete).toBe(true);
      let err: unknown;
      try {
        s.query(p.emails, { filters: emptyFilter(pl), limit: 0 });
      } catch (e) {
        err = e;
      }
      expect((err as { status?: number }).status).toBe(422);
      expect(String(err)).toMatch(/too many records/);
    });
  });

  it("caps a cell at 100 records and reports the total", async () => {
    await withStore("path-cap", s => {
      const p = setupAccounts(s);
      const pl = s.createField(p.emails, { name: "Accounts", type: "pathLookup", options: { targetTableId: p.accounts, pathDirection: "dependents" } }).fieldId;
      s.createRows(actor, p.accounts, Array.from({ length: 120 }, (_, i) => ({ cells: { [p.handle]: "h" + i, [p.accEmail]: [p.e5] } })));
      const row = s.getRow(p.emails, p.e5)!;
      expect((row.cells[pl] as LinkValue[]).length).toBe(100);
      expect(row.paths?.[pl]).toEqual({ total: 120 });
    });
  });

  it("explains a result with a path whose every hop exists", async () => {
    await withStore("path-why", s => {
      const p = setupAccounts(s);
      const pl = s.createField(p.emails, { name: "xxx accounts", type: "pathLookup", options: { targetTableId: p.accounts, pathDirection: "dependents", targetFilter: p.onlyXxx } }).fieldId;
      const hops = s.explainPath(pl, p.e1, p.a1)!;
      expect(hops.map(h => [h.tableId, h.id, h.t])).toEqual([
        [p.emails, p.e1, "a@x.com"],
        [p.github, p.g1, "alice-dev"],
        [p.accounts, p.a1, "alice123"],
      ]);
      expect(hops[1].fieldId).toBe(s.field(p.ghEmail).options.inverseFieldId);
      // Each hop is a real link: the record before it is in the hop's link cell.
      for (let i = 1; i < hops.length; i++) {
        const cell = s.getRow(hops[i - 1].tableId, hops[i - 1].id)!.cells[hops[i].fieldId!] as LinkValue[];
        expect(cell.map(v => v.id)).toContain(hops[i].id);
      }
      expect(s.explainPath(pl, p.e2, p.a2)).toBeNull();
    });
  });

  it("marks the field broken when no link leads to its target any more", async () => {
    await withStore("path-broken", s => {
      const lists = s.createTable(actor, { name: "People", fields: [{ name: "Name", type: "text" }] }).tableId;
      const teams = s.createTable(actor, { name: "Teams", fields: [{ name: "Name", type: "text" }] }).tableId;
      const link = s.createField(teams, { name: "Lead", type: "link", options: { linkedTableId: lists } }).fieldId;
      const [p1] = s.createRows(actor, lists, [{}]).created!;
      s.createRows(actor, teams, [{ cells: { [link]: [p1] } }]);
      const pl = s.createField(lists, { name: "Teams led", type: "pathLookup", options: { targetTableId: teams, pathDirection: "dependents" } }).fieldId;
      expect(s.pathProblem(pl)).toBeNull();
      s.deleteField(link);
      expect(s.field(pl).type).toBe("pathLookup");
      expect(s.pathProblem(pl)).toMatch(/No links/);
      expect(s.getRow(lists, p1)!.cells[pl]).toBeUndefined();
      expect(() => s.query(lists, { filters: emptyFilter(pl), limit: 0 })).toThrow(/No links/);
    });
  });

  it("validates its settings and stays out of writes, sorts, groups and other fields", async () => {
    await withStore("path-checks", s => {
      const p = setupAccounts(s);
      expect(() => s.createField(p.github, { name: "x", type: "pathLookup", options: { targetTableId: p.google, pathDirection: "dependents" } })).toThrow(/No links/);
      expect(() => s.createField(p.emails, { name: "x", type: "pathLookup", options: { targetTableId: "tblNope", pathDirection: "dependents" } })).toThrow(/target table/);
      const pl = s.createField(p.emails, { name: "Used by", type: "pathLookup", options: { targetTableId: p.accounts, pathDirection: "dependents" } }).fieldId;
      s.updateRows(actor, p.emails, [{ id: p.e1, cells: { [pl]: [p.a2] } }]);
      expect(ids(s.getRow(p.emails, p.e1)!.cells[pl])).toEqual([p.a1]);
      expect(() => s.query(p.emails, { sorts: [{ fieldId: pl, dir: "asc" }], limit: 0 })).toThrow(/sorted or grouped/);
      expect(() => s.query(p.emails, { groupLevels: [{ fieldId: pl, dir: "asc" }], limit: 0 })).toThrow(/sorted or grouped/);
      expect(() => s.aggregate(p.emails, { groupBy: [{ fieldId: pl }], metrics: [{ fn: "count", as: "n" }] })).toThrow(/Path lookup/);
      expect(() => s.createField(p.emails, { name: "f", type: "formula", options: { formula: "{Used by}" } })).toThrow();
      expect(() => s.updateTable(p.emails, { primaryFieldId: pl })).toThrow(/primary/);
      expect(() => s.createField(p.emails, { name: "x", type: "pathLookup", options: { targetTableId: p.accounts, pathDirection: "dependents", targetFilter: { conjunction: "and", conditions: [{ fieldId: pl, op: "empty" }] } } })).toThrow(/target table/);
    });
  });
});

describe("path lookup: review fixes", () => {
  it("answers filters inside a write's transaction from the new data", async () => {
    await withStore("path-fix-tx", s => {
      const p = setupAccounts(s);
      const pl = s.createField(p.emails, { name: "Used", type: "pathLookup", options: { targetTableId: p.accounts, pathDirection: "dependents" } }).fieldId;
      expect(s.matchRows(p.emails, emptyFilter(pl, "notempty"), [p.e1, p.e2])).toEqual([p.e1, p.e2]);
      let seen: number[] = [];
      s.onWrite = () => (seen = s.matchRows(p.emails, emptyFilter(pl, "notempty"), [p.e1, p.e2]));
      s.updateRows(actor, p.github, [{ id: p.g2, cells: { [p.ghEmail]: [] } }]);
      s.onWrite = undefined;
      expect(seen).toEqual([p.e1]);
    });
  });

  it("shares one record budget across the rows of a read", async () => {
    await withStore("path-fix-budget", s => {
      const p = setupAccounts(s);
      const pl = s.createField(p.emails, { name: "Used", type: "pathLookup", options: { targetTableId: p.accounts, pathDirection: "dependents" } }).fieldId;
      // e1 alone visits 2 records (its GitHub account and alice123); five rows need more than 4.
      s.pathLimits = { nodes: 4, ms: 60_000, depth: 64 };
      expect(s.getRow(p.emails, p.e1)!.paths?.[pl]).toBeUndefined();
      const rows = s.getRows(p.emails, [p.e1, p.e2, p.e3, p.e4, p.e5]);
      expect(rows.some(r => r.paths?.[pl]?.incomplete)).toBe(true);
    });
  });

  it("does not ask views to reload for edits that cannot change paths", async () => {
    await withStore("path-fix-reload", s => {
      const p = setupAccounts(s);
      s.createField(p.emails, { name: "Used", type: "pathLookup", options: { targetTableId: p.accounts, pathDirection: "dependents" } });
      // Renaming an email rewrites link titles in GitHub rows, which are on the path; an ordinary field does not.
      const notes = s.createField(p.emails, { name: "Notes", type: "text" }).fieldId;
      expect(s.pathTablesAffected(s.updateRows(actor, p.emails, [{ id: p.e1, cells: { [notes]: "hello" } }]))).toEqual([]);
      expect(s.pathTablesAffected(s.updateRows(actor, p.accounts, [{ id: p.a1, cells: { [p.handle]: "renamed" } }]))).toEqual([p.emails]);
    });
  });

  it("refuses conditions it cannot answer instead of dropping them", async () => {
    await withStore("path-fix-ops", s => {
      const p = setupAccounts(s);
      const pl = s.createField(p.emails, { name: "Used", type: "pathLookup", options: { targetTableId: p.accounts, pathDirection: "dependents" } }).fieldId;
      expect(() => s.query(p.emails, { filters: { conjunction: "and", conditions: [{ fieldId: pl, op: "contains", value: "x" }] }, limit: 0 })).toThrow(/is empty/);
    });
  });

  it("is broken, not wrong, when a target condition's field is deleted", async () => {
    await withStore("path-fix-target", s => {
      const p = setupAccounts(s);
      const pl = s.createField(p.emails, { name: "xxx", type: "pathLookup", options: { targetTableId: p.accounts, pathDirection: "dependents", targetFilter: p.onlyXxx } }).fieldId;
      s.deleteField(p.platform);
      expect(s.pathProblem(pl)).toMatch(/condition/);
      expect(s.getRow(p.emails, p.e2)!.cells[pl]).toBeUndefined();
      expect(() => s.query(p.emails, { filters: emptyFilter(pl), limit: 0 })).toThrow(/condition/);
    });
  });

  it("does not call a finished walk at the depth limit incomplete", async () => {
    await withStore("path-fix-depth", s => {
      const lists = s.createTable(actor, { name: "Lists", fields: [{ name: "Name", type: "text" }] }).tableId;
      const inc = s.createField(lists, { name: "Includes", type: "link", options: { linkedTableId: lists } }).fieldId;
      const [l1, l2, l3, l4] = s.createRows(actor, lists, [{}, {}, {}, {}]).created!;
      s.updateRows(actor, lists, [{ id: l1, cells: { [inc]: [l2] } }, { id: l2, cells: { [inc]: [l3] } }, { id: l3, cells: { [inc]: [l4] } }]);
      const all = s.createField(lists, { name: "All", type: "pathLookup", options: { targetTableId: lists, pathDirection: "dependencies" } }).fieldId;
      s.pathLimits = { nodes: 1000, ms: 60_000, depth: 3 };
      const row = s.getRow(lists, l1)!;
      expect(ids(row.cells[all])).toEqual([l2, l3, l4]);
      expect(row.paths?.[all]).toBeUndefined();
    });
  });

  it("keeps a chosen direction when a field becomes a link", async () => {
    await withStore("path-fix-convert", s => {
      const p = setupAccounts(s);
      const f = s.createField(p.github, { name: "Backup", type: "text" }).fieldId;
      s.updateField(f, { type: "link", options: { linkedTableId: p.emails, dependsOn: false, pathRole: "none" } });
      expect(s.field(f).options).toMatchObject({ dependsOn: false, pathRole: "none" });
      expect(s.field(s.field(f).options.inverseFieldId!).options).toMatchObject({ dependsOn: true, pathRole: "none" });
    });
  });
});
