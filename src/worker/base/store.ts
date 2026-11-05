// Storage engine for one base, running inside its Durable Object.
//
// Layout (constraints from the 2026-10-12 load tests):
// - one physical SQLite table per user table (t_<n>), rows are JSON documents keyed by field id,
//   so adding / changing fields only touches metadata;
// - manual order is a fractional index string with its own index;
// - links live in an indexed pair table per link field (l_<n>) and are mirrored into both cells;
// - lookups, rollups and formulas are materialized into the row and maintained incrementally;
// - column-wide work (new formula, type conversion) runs in batches from the alarm handler.
import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";
import type { Cells, Choice, Field, FieldOptions, FieldType, GroupLevel, JobInfo, LinkValue, MatchOptions, Member, Row, Schema, FilterSpec, Table, View, ViewConfig, ViewType, Dashboard, Widget } from "../../shared/types";
import { keyedFieldIds, keyTableOf, MATCH_TYPES, matchKey, validMatches } from "../../shared/matches";
import { allowedEdges, MAX_PATH_DEPTH, pathFieldProblem } from "../../shared/paths";
import { hopsTo, nodeKey, planOf, Reach, REACH_LIMITS, type PathPlan, type ReachLimits } from "./reach";
import { COLORS, COMPUTED_TYPES, groupsByDay, isDateField, isNumberField } from "../../shared/types";
import { coerceCell, displayCell, formulaValue, type CoerceContext } from "../../shared/cells";
import { compileFormula, evaluate, FormulaError, type Compiled, type FieldRef, type Value } from "../../shared/formula";
import { aggregate } from "../../shared/rollup";
import { isSafeId, newChoiceId, newDashboardId, newFieldId, newTableId, newViewId, newWidgetId } from "../../shared/ids";
import { checkWidget, defaultSize, MAX_WIDGETS, SOURCE_KEYS, type LayoutItemInput, type WidgetInput, type WidgetPatch } from "../../shared/widgets";
import { filterSql, orderSql, rangeSql, searchSql, sortExpr, valueExpr, type DateRange, type FilterContext } from "./query";
import type { ButtonInfo } from "../../shared/automations";
import { Aggregator, OTHER_KEY, validateAggregate, type AggregateInput, type AggregateResult, type GroupKey } from "./aggregate";
import type { LimitInfo } from "../hosting";
import { AI_LIMITS, aiDeps, aiFieldProblem, isAiOutputType, normalizeAi, promptRefIds, type AiCellState } from "../../shared/ai";

export interface Actor {
  userId: string;
  name: string;
}

export interface MutationResult {
  changes: { tableId: string; rows: Row[] }[];
  deleted: { tableId: string; ids: number[] }[];
  schema?: Schema;
  /** Ids of records made by createRows, in input order. */
  created?: number[];
  /** Tables whose changed rows were returned without path lookup values. */
  unfilled?: string[];
  /** Fields whose values the write changed, by table; "__new" when it created rows. Not sent to clients. */
  fields?: Record<string, string[]>;
}

/** A row a write touched directly, with its stored state before the write (null for new rows). */
export interface WrittenRow {
  tableId: string;
  id: number;
  isNew: boolean;
  before: { data: string; createdAt: number; updatedAt: number } | null;
  /** Field ids whose values changed, computed fields of the same row included. */
  changed: Set<string>;
}

export interface WriteInfo {
  actor: Actor;
  rows: WrittenRow[];
  /** Automations that led to this write (empty for people). */
  chain: string[];
  /** False for imports, templates, jobs and test runs: they move date timers but fire no record triggers. */
  fire: boolean;
  /** Imports, templates, background jobs and writes without a person or automation behind them. */
  bulk: boolean;
  /** Rows the write deleted. */
  deleted: { tableId: string; ids: number[] }[];
}

export interface RowInput {
  cells?: Cells;
  id?: number;
  ord?: string;
  createdAt?: number;
  createdBy?: string | null;
}

export interface QueryInput {
  viewId?: string;
  filters?: ViewConfig["filters"];
  sorts?: ViewConfig["sorts"];
  search?: string;
  /** ANDed with the effective filters (explicit or the view's), so a caller can narrow a view. */
  extraFilters?: ViewConfig["filters"];
  /** Only records whose date span overlaps this window (calendar, timeline). */
  range?: DateRange;
  /** Grid grouping; defaults to the grid view's config.groups. Rows are ordered by these first. */
  groupLevels?: GroupLevel[];
  limit?: number;
  groupFieldId?: string;
  /** Minutes from UTC of the viewer: grid groups of values with a time are that viewer's days. */
  dayOffset?: number;
  /** Return at most this many ids when the view is in manual order (fast first paint); `total` has the full count. */
  idsLimit?: number;
}

export interface QueryResult {
  ids: number[];
  rows: Row[];
  groups?: (string | null)[];
  /** Per id, the stored value of each group level as text (JSON for arrays), null when empty. */
  groupKeys?: (string | null)[][];
  total: number;
  partial?: boolean;
}

export interface FieldInput {
  name: string;
  type: FieldType;
  options?: FieldOptions;
  description?: string;
}

interface RowRec {
  id: number;
  ord: string;
  data: Record<string, unknown>;
  created_at: number;
  updated_at: number;
  created_by: string | null;
  updated_by: string | null;
  isNew?: boolean;
  dirty?: boolean;
  touched?: boolean;
  orig?: { data: string; createdAt: number; updatedAt: number };
}

interface TableRec extends Table {
  phys: string;
}

interface Pending {
  tableId: string;
  id: number;
  changed: Set<string>;
  force: Set<string>;
}

interface Cache {
  version: number;
  tables: Map<string, TableRec>;
  fields: Map<string, Field>;
  byTable: Map<string, Field[]>;
  views: Map<string, View>;
  dashboards: Map<string, Dashboard>;
  compiled: Map<string, Compiled>;
  computeOrder: Map<string, Field[]>;
  /** Link fields (in any table) that point at the given table id. */
  incoming: Map<string, Field[]>;
  members: Map<string, Member>;
  /** Walk plans of path lookup fields, null when the field is broken; filled on first use. */
  pathPlans: Map<string, PathPlan | null>;
  /** Fields with a key table, by table, and whether the table is filled. */
  keyed: Map<string, { fieldId: string; ready: boolean }[]>;
  /** Value matches that work. */
  matches: { source: Field; target: Field }[];
}

export class UserError extends Error {
  status = 400;
  /** Set when a plan limit refused the request (status 402). */
  limit?: LimitInfo;
}

/** A plan limit refused a write. */
export function limitError(message: string, limit: LimitInfo): UserError {
  const e = new UserError(message);
  e.status = 402;
  e.limit = limit;
  return e;
}

/** Types that cannot be a table's primary field (it names records in links). */
const NOT_PRIMARY: ReadonlySet<FieldType> = new Set(["link", "attachment", "checkbox", "lookup", "rollup", "button", "pathLookup"]);
/** Records shown in one path lookup cell; the rest are counted in Row.paths. */
const PATH_CELL_MAX = 100;
const INLINE_JOB_ROWS = 2000;
const JOB_BATCH = 500;
const BROADCAST_LIMIT = 500;
const MAX_PROPAGATION = 200000;

const now = () => Date.now();
const AGG_CACHE_SIZE = 200;
/** JSON with object keys sorted, so equal requests built in a different key order share a cache entry. */
const stableJson = (v: unknown): string => JSON.stringify(v, (_, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

class Tx {
  rows = new Map<string, RowRec>();
  pending = new Map<string, Pending>();
  queue: string[] = [];
  changedRows = new Map<string, Set<number>>();
  deleted = new Map<string, number[]>();
  schemaDirty = false;
  processed = 0;
  /** Per row key, the fields whose values changed. */
  fields = new Map<string, Set<string>>();
  noTriggers = false;
  /** Records typecast may still create as new linked records under the plan's limit; set on first use. */
  linkRoom?: number;
  /** Field conversions run in batches that cannot be refused halfway: past the limit, names stay unlinked instead of failing. */
  softLinks = false;
}

const DAY_MS = 86_400_000;
/** Largest upload, also the most a file of unknown size counts for. */
const MAX_FILE_BYTES = 100 * 1024 * 1024;

export class BaseStore {
  readonly sql: SqlStorage;
  private cache?: Cache;
  /** Aggregate results by table and request; any write or schema change in the base clears it (rollups and lookups cross tables). */
  private aggCache = new Map<string, AggregateResult>();
  /** Source records with a non-empty path lookup, by field; cleared with aggCache, since any write can change paths. */
  private pathCache = new Map<string, number[]>();
  /** Limits of path lookup walks; tests lower them. */
  pathLimits: ReachLimits = REACH_LIMITS;
  onSchemaChange?: () => void;
  /** Button stubs for the schema; set by the Durable Object. */
  buttonsOf?: () => ButtonInfo[];
  /** Called inside each write's transaction with the rows it touched directly, so automation runs are queued atomically. */
  onWrite?: (w: WriteInfo) => void;
  /** Records the base may hold, from the workspace's plan (set by the Durable Object); undefined means no limit. */
  recordLimit?: () => { limit: number; upgradeUrl?: string } | undefined;
  /** AI cell states of rows, set by the Durable Object; rows of tables with AI fields carry them. */
  rowStates?: (tableId: string, ids: number[]) => Map<number, Record<string, AiCellState>>;
  private writeCtx: { chain: string[]; silent: boolean } = { chain: [], silent: false };

  /** Writes made inside fn carry this automation chain; silent writes (test runs) fire no triggers. */
  withWriteContext<T>(c: { chain: string[]; silent?: boolean }, fn: () => T): T {
    const prev = this.writeCtx;
    this.writeCtx = { chain: c.chain, silent: !!c.silent };
    try {
      return fn();
    } finally {
      this.writeCtx = prev;
    }
  }

  constructor(readonly storage: DurableObjectStorage) {
    this.sql = storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS _meta (k TEXT PRIMARY KEY, v TEXT)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS _tables (id TEXT PRIMARY KEY, name TEXT NOT NULL, ord TEXT NOT NULL, primary_field_id TEXT NOT NULL, phys TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS _fields (id TEXT PRIMARY KEY, table_id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, options TEXT NOT NULL, description TEXT, ord TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS _views (id TEXT PRIMARY KEY, table_id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, config TEXT NOT NULL, ord TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS _dashboards (id TEXT PRIMARY KEY, name TEXT NOT NULL, ord TEXT NOT NULL, config TEXT NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS _jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, label TEXT NOT NULL, payload TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`);
    // Files stored in R2 for this base, with the size R2 reported; cells carry sizes too, but those come from clients.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS _files (key TEXT PRIMARY KEY, size INTEGER NOT NULL, created_at INTEGER NOT NULL, unref_since INTEGER)`);
    // Fields with a key table k_<field id> for value matches; ready once the job filling it from existing rows is done.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS _keys (field_id TEXT PRIMARY KEY, ready INTEGER NOT NULL)`);
  }

  // ---------- small helpers ----------

  all<T = Record<string, SqlStorageValue>>(q: string, ...b: unknown[]): T[] {
    return this.sql.exec(q, ...(b as SqlStorageValue[])).toArray() as T[];
  }
  one<T = Record<string, SqlStorageValue>>(q: string, ...b: unknown[]): T | undefined {
    return this.all<T>(q, ...b)[0];
  }
  meta(k: string): string | undefined {
    return this.one<{ v: string }>("SELECT v FROM _meta WHERE k = ?", k)?.v;
  }
  setMeta(k: string, v: string) {
    this.sql.exec("INSERT INTO _meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, v);
  }
  private nextSeq(name: string): number {
    const n = Number(this.meta("seq:" + name) ?? "0") + 1;
    this.setMeta("seq:" + name, String(n));
    return n;
  }
  get initialized(): boolean {
    return this.meta("baseId") !== undefined;
  }

  // ---------- schema cache ----------

  private get c(): Cache {
    if (!this.cache) this.cache = this.loadCache();
    return this.cache;
  }

  invalidate() {
    this.cache = undefined;
    this.clearAggCache();
  }

  clearAggCache() {
    this.aggCache.clear();
    this.pathCache.clear();
  }

  private loadCache(): Cache {
    const tables = new Map<string, TableRec>();
    for (const t of this.all<{ id: string; name: string; ord: string; primary_field_id: string; phys: string }>("SELECT * FROM _tables ORDER BY ord")) {
      tables.set(t.id, { id: t.id, name: t.name, ord: t.ord, primaryFieldId: t.primary_field_id, phys: t.phys });
    }
    const fields = new Map<string, Field>();
    const byTable = new Map<string, Field[]>();
    for (const t of tables.keys()) byTable.set(t, []);
    for (const f of this.all<{ id: string; table_id: string; name: string; type: string; options: string; description: string | null; ord: string }>("SELECT * FROM _fields ORDER BY ord")) {
      const field: Field = { id: f.id, tableId: f.table_id, name: f.name, type: f.type as FieldType, options: JSON.parse(f.options), description: f.description ?? undefined, ord: f.ord };
      fields.set(f.id, field);
      byTable.get(f.table_id)?.push(field);
    }
    const views = new Map<string, View>();
    for (const v of this.all<{ id: string; table_id: string; name: string; type: string; config: string; ord: string }>("SELECT * FROM _views ORDER BY ord")) {
      views.set(v.id, { id: v.id, tableId: v.table_id, name: v.name, type: v.type as ViewType, config: JSON.parse(v.config), ord: v.ord });
    }
    const dashboards = new Map<string, Dashboard>();
    for (const d of this.all<{ id: string; name: string; ord: string; config: string }>("SELECT * FROM _dashboards ORDER BY ord")) {
      dashboards.set(d.id, { id: d.id, name: d.name, ord: d.ord, widgets: (JSON.parse(d.config) as { widgets?: Widget[] }).widgets ?? [] });
    }

    const compiled = new Map<string, Compiled>();
    const incoming = new Map<string, Field[]>();
    for (const f of fields.values()) {
      if (f.type === "formula" && f.options.formula) {
        try {
          compiled.set(f.id, compileFormula(f.options.formula, this.fieldRefs(byTable.get(f.tableId) ?? [])));
        } catch {
          // Broken formulas evaluate to empty; the error is shown when editing the field.
        }
      }
      if (f.type === "link" && f.options.linkedTableId) {
        const list = incoming.get(f.options.linkedTableId) ?? [];
        list.push(f);
        incoming.set(f.options.linkedTableId, list);
      }
    }
    const computeOrder = new Map<string, Field[]>();
    for (const [tid, list] of byTable) computeOrder.set(tid, this.topoOrder(list, compiled));
    const members = new Map<string, Member>();
    for (const m of JSON.parse(this.meta("members") ?? "[]") as Member[]) members.set(m.id, m);
    const keyed = new Map<string, { fieldId: string; ready: boolean }[]>();
    for (const k of this.all<{ field_id: string; ready: number }>("SELECT field_id, ready FROM _keys")) {
      const f = fields.get(k.field_id);
      if (f) (keyed.get(f.tableId) ?? keyed.set(f.tableId, []).get(f.tableId)!).push({ fieldId: f.id, ready: !!k.ready });
    }
    return { version: Number(this.meta("version") ?? "1"), tables, fields, byTable, views, dashboards, compiled, computeOrder, incoming, members, pathPlans: new Map(), keyed, matches: validMatches([...fields.values()]) };
  }

  /** Path lookups are computed on read and never stored, so formulas cannot refer to them. */
  private fieldRefs(list: Field[]): FieldRef[] {
    return list.filter(f => f.type !== "pathLookup").map(f => ({ id: f.id, name: f.name, type: valueTypeOf(f) }));
  }

  private depsOf(f: Field, compiled: Map<string, Compiled>): string[] {
    if (f.type === "lookup" || f.type === "rollup") return f.options.linkFieldId ? [f.options.linkFieldId] : [];
    if (f.type === "formula") return compiled.get(f.id)?.deps ?? [];
    return [];
  }

  /** Computed fields of a table in dependency order; fields in a cycle are left out. */
  private topoOrder(list: Field[], compiled: Map<string, Compiled>): Field[] {
    const computed = list.filter(f => f.type === "lookup" || f.type === "rollup" || f.type === "formula");
    const ids = new Set(computed.map(f => f.id));
    const out: Field[] = [];
    const state = new Map<string, 1 | 2>();
    const visit = (f: Field): boolean => {
      const s = state.get(f.id);
      if (s === 2) return true;
      if (s === 1) return false;
      state.set(f.id, 1);
      for (const d of this.depsOf(f, compiled)) {
        if (!ids.has(d)) continue;
        const dep = computed.find(x => x.id === d)!;
        if (!visit(dep)) return false;
      }
      state.set(f.id, 2);
      out.push(f);
      return true;
    };
    for (const f of computed) visit(f);
    return out;
  }

  /** keepResults: dashboard edits change no data, so cached aggregate results stay valid. */
  private bumpVersion(keepResults = false) {
    const v = Number(this.meta("version") ?? "1") + 1;
    this.setMeta("version", String(v));
    if (keepResults) this.cache = undefined;
    else this.invalidate();
  }

  table(id: string): TableRec {
    const t = this.c.tables.get(id);
    if (!t) throw new UserError("Table not found");
    return t;
  }
  field(id: string): Field {
    const f = this.c.fields.get(id);
    if (!f) throw new UserError("Field not found");
    return f;
  }
  fieldsOf(tableId: string): Field[] {
    return this.c.byTable.get(tableId) ?? [];
  }
  fieldMap(tableId: string): Map<string, Field> {
    return new Map(this.fieldsOf(tableId).map(f => [f.id, f]));
  }
  view(id: string): View {
    const v = this.c.views.get(id);
    if (!v) throw new UserError("View not found");
    return v;
  }
  findTable(idOrName: string): TableRec | undefined {
    const c = this.c;
    return c.tables.get(idOrName) ?? [...c.tables.values()].find(t => t.name === idOrName) ?? [...c.tables.values()].find(t => t.name.toLowerCase() === idOrName.toLowerCase());
  }  maybeTable(id: string): Table | undefined {
    return this.c.tables.get(id);
  }
  maybeField(id: string): Field | undefined {
    return this.c.fields.get(id);
  }
  memberName(id: string): string {
    return this.userName(id);
  }


  schema(): Schema {
    const c = this.c;
    const tables: Table[] = [...c.tables.values()].map(t => ({
      id: t.id,
      name: t.name,
      ord: t.ord,
      primaryFieldId: t.primaryFieldId,
      rowCount: this.one<{ n: number }>(`SELECT count(*) n FROM ${t.phys}`)!.n,
    }));
    return { baseId: this.meta("baseId") ?? "", version: c.version, tables, fields: [...c.fields.values()], views: [...c.views.values()], dashboards: [...c.dashboards.values()], buttons: this.buttonsOf?.() ?? [], jobs: this.jobs() };
  }

  jobs(): JobInfo[] {
    return this.all<{ id: number; kind: string; label: string; done: number; total: number }>("SELECT id, kind, label, done, total FROM _jobs ORDER BY id");
  }

  setMembers(members: Member[]) {
    this.setMeta("members", JSON.stringify(members));
    if (this.cache) this.cache.members = new Map(members.map(m => [m.id, m]));
    this.clearAggCache();
  }

  private userName = (id: string) => this.c.members.get(id)?.name ?? id;

  // ---------- rows: reading ----------

  private toRow(r: RowRec, fields: Field[]): Row {
    const cells: Cells = {};
    for (const f of fields) {
      // A field converted to a path lookup may leave its old value in the row; path values are filled on read.
      if (f.type === "pathLookup") continue;
      const v = r.data[f.id];
      if (v !== undefined && v !== null) cells[f.id] = v;
    }
    return { id: r.id, ord: r.ord, createdAt: r.created_at, updatedAt: r.updated_at, createdBy: r.created_by, updatedBy: r.updated_by, cells };
  }

  /** Adds AI cell states to rows of tables with AI fields. */
  private decorate(tableId: string, rows: Row[]): Row[] {
    if (!this.rowStates || !rows.length || !this.fieldsOf(tableId).some(f => f.options.ai)) return rows;
    const states = this.rowStates(tableId, rows.map(r => r.id));
    for (const r of rows) {
      const st = states.get(r.id);
      if (st) r.ai = st;
    }
    return rows;
  }

  private parseRec(r: Record<string, SqlStorageValue>): RowRec {
    return {
      id: r.id as number,
      ord: r.ord as string,
      data: JSON.parse(r.data as string),
      created_at: r.created_at as number,
      updated_at: r.updated_at as number,
      created_by: (r.created_by as string) ?? null,
      updated_by: (r.updated_by as string) ?? null,
      orig: { data: r.data as string, createdAt: r.created_at as number, updatedAt: r.updated_at as number },
    };
  }

  /** Rows by id, in the given order. `paths: false` skips path lookups for callers that cannot use them (aggregates). */
  getRows(tableId: string, ids: number[], opts: { paths?: boolean } = {}): Row[] {
    const t = this.table(tableId);
    const fields = this.fieldsOf(tableId);
    const found = new Map<number, RowRec>();
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100).map(Number).filter(Number.isFinite);
      if (!chunk.length) continue;
      for (const r of this.all(`SELECT * FROM ${t.phys} WHERE id IN (${chunk.map(() => "?").join(",")})`, ...chunk)) {
        const rec = this.parseRec(r);
        found.set(rec.id, rec);
      }
    }
    const rows = this.decorate(tableId, ids.filter(id => found.has(id)).map(id => this.toRow(found.get(id)!, fields)));
    if (opts.paths !== false) {
      this.fillPaths(tableId, rows);
      this.fillMatches(tableId, rows);
    }
    return rows;
  }

  getRow(tableId: string, id: number): Row | undefined {
    return this.getRows(tableId, [id])[0];
  }

  query(tableId: string, q: QueryInput): QueryResult {
    const t = this.table(tableId);
    const fields = this.fieldMap(tableId);
    let filters = q.filters, sorts = q.sorts, groupFieldId = q.groupFieldId, levels = q.groupLevels;
    if (q.viewId) {
      const v = this.view(q.viewId);
      filters = filters ?? v.config.filters;
      sorts = sorts ?? v.config.sorts;
      if (v.type === "kanban") groupFieldId = groupFieldId ?? v.config.groupFieldId;
      if (v.type === "grid") levels = levels ?? v.config.groups;
    }
    const groupLevels = (levels ?? []).filter(l => fields.has(l.fieldId) && isSafeId(l.fieldId));
    if (groupLevels.length > 3) throw new UserError("Group by at most 3 fields");
    for (const id of [...(sorts ?? []).map(x => x.fieldId), ...groupLevels.map(l => l.fieldId), groupFieldId]) {
      if (id && fields.get(id)?.type === "pathLookup") throw unprocessable(`"${fields.get(id)!.name}" is a path lookup; path lookups cannot be sorted or grouped`);
    }
    const where: string[] = [];
    const params: unknown[] = [];
    const ctx = this.filterCtx();
    const f = filterSql(filters, fields, ctx);
    if (f) { where.push(f.sql); params.push(...f.params); }
    const xf = filterSql(q.extraFilters, fields, ctx);
    if (xf) { where.push(xf.sql); params.push(...xf.params); }
    if (q.range) {
      const r = rangeSql(this.checkRange(q.range, fields), fields);
      where.push(r.sql);
      params.push(...r.params);
    }
    const s = searchSql(q.search, [...fields.values()]);
    if (s) { where.push(s.sql); params.push(...s.params); }
    // Group levels sort by display order, then by the raw key, so rows sharing a key are always consecutive.
    const offset = Number.isInteger(q.dayOffset) && Math.abs(q.dayOffset!) <= 1440 ? q.dayOffset! : 0;
    const keyExpr = (f: Field) => groupKeyExpr(f, offset);
    const lv = groupLevels.map(l => {
      const f = fields.get(l.fieldId)!;
      const dir = l.dir === "desc" ? "DESC" : "ASC";
      if (groupsByDay(f) || f.type === "checkbox") return { sql: `(${keyExpr(f)}) IS NULL, ${keyExpr(f)} ${dir}`, params: [] };
      const p = sortExpr(f);
      return { sql: `(${p.sql}) IS NULL, ${p.sql} ${dir}, ${valueExpr(f)} ${dir}`, params: [...p.params, ...p.params] };
    });
    const rest = orderSql(sorts, fields);
    const o = { sql: [...lv.map(p => p.sql), rest.sql].join(", "), params: [...lv.flatMap(p => p.params), ...rest.params] };
    const group = groupFieldId && fields.has(groupFieldId) && isSafeId(groupFieldId) ? `, json_extract(data, '$.${groupFieldId}') g` : "";
    const keyCols = groupLevels.map((l, i) => `, ${keyExpr(fields.get(l.fieldId)!)} k${i}`).join("");
    const limit = Math.max(0, Math.min(q.limit ?? 200, 2000));
    if (q.idsLimit && !where.length && !group && !keyCols && o.sql === "ord") {
      // Manual order with no filter: walk the ord index for the first page only.
      const ids = this.all<{ id: number }>(`SELECT id FROM ${t.phys} ORDER BY ord LIMIT ?`, q.idsLimit).map(r => r.id);
      const total = ids.length < q.idsLimit ? ids.length : this.rowCount(tableId);
      return { ids, rows: this.getRows(tableId, ids.slice(0, limit)), total, partial: ids.length < total };
    }
    const sql = `SELECT id${group}${keyCols} FROM ${t.phys} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY ${o.sql}`;
    const res = this.all<Record<string, SqlStorageValue>>(sql, ...params, ...o.params);
    const ids = res.map(r => r.id as number);
    const out: QueryResult = { ids, rows: this.getRows(tableId, ids.slice(0, limit)), total: ids.length };
    const text = (v: SqlStorageValue | undefined) => (v === undefined || v === null ? null : String(v));
    if (group) out.groups = res.map(r => text(r.g));
    if (groupLevels.length) out.groupKeys = res.map(r => groupLevels.map((_, i) => text(r[`k${i}`])));
    return out;
  }

  /** Validates the window and start field; an end or duration field of the wrong type is ignored, not an error. */
  private checkRange(r: DateRange, fields: Map<string, Field>): DateRange {
    const day = /^\d{4}-\d{2}-\d{2}$/;
    if (!day.test(r.from) || !day.test(r.to)) throw new UserError("Range dates must look like 2026-01-31");
    if (r.from > r.to) throw new UserError("Range start must not be after its end");
    if ((Date.parse(r.to) - Date.parse(r.from)) / 86400000 > 1100) throw new UserError("A range can span at most 3 years");
    const start = fields.get(r.startFieldId);
    if (!start || !isDateField(start)) throw new UserError("The start field must be a date field");
    const end = r.endFieldId ? fields.get(r.endFieldId) : undefined;
    const dur = r.durationFieldId ? fields.get(r.durationFieldId) : undefined;
    return { ...r, endFieldId: end && isDateField(end) ? end.id : undefined, durationFieldId: dur && isNumberField(dur) ? dur.id : undefined };
  }

  /** Ids of the records an aggregate covers: the view, extra filters, search and date range, in view order. */
  private aggIds(tableId: string, input: AggregateInput): number[] {
    const range = input.range ? { startFieldId: input.range.fieldId, from: input.range.from, to: input.range.to } : undefined;
    return this.query(tableId, { viewId: input.viewId, extraFilters: input.filters, search: input.search, range, limit: 0 }).ids;
  }

  aggregate(tableId: string, input: AggregateInput): AggregateResult {
    const fields = this.fieldMap(tableId);
    const err = validateAggregate(fields, input);
    if (err) throw new UserError(err);
    const { viewId, filters, search, groupBy, metrics, fanOut, range, sort, limit, other } = input;
    const key = tableId + " " + stableJson({ viewId, filters, search, groupBy, metrics, fanOut, range, sort, limit, other });
    const hit = this.aggCache.get(key);
    if (hit) {
      this.aggCache.delete(key);
      this.aggCache.set(key, hit);
      return hit;
    }
    const ids = this.aggIds(tableId, input);
    const agg = new Aggregator(fields, input, (f, r) => this.rawFromRow(f, r), this.userName);
    for (let i = 0; i < ids.length; i += 1000) agg.add(this.getRows(tableId, ids.slice(i, i + 1000), { paths: false }));
    const result = agg.result();
    this.aggCache.set(key, result);
    if (this.aggCache.size > AGG_CACHE_SIZE) this.aggCache.delete(this.aggCache.keys().next().value!);
    return result;
  }

  /** Records counted in one aggregate group, in view order. Uses the aggregate's own grouping so the list matches its number. */
  aggregateRecords(tableId: string, input: AggregateInput, key: GroupKey[], max = 500): { ids: number[]; truncated: boolean } {
    const fields = this.fieldMap(tableId);
    const err = validateAggregate(fields, input);
    if (err) throw new UserError(err);
    const other = Array.isArray(key) && key.length === 1 && key[0] === OTHER_KEY;
    if (!Array.isArray(key) || (!other && key.length !== (input.groupBy?.length ?? 0))) throw new UserError("key must have one value per group field");
    // "Other" holds every record with a key outside the groups the aggregate kept.
    const kept = other ? new Set(this.aggregate(tableId, input).groups.filter(g => g.key[0] !== OTHER_KEY).map(g => JSON.stringify(g.key))) : null;
    const want = JSON.stringify(key);
    const agg = new Aggregator(fields, input, (f, r) => this.rawFromRow(f, r), this.userName);
    const ids = this.aggIds(tableId, input);
    const out: number[] = [];
    for (let i = 0; i < ids.length; i += 1000) {
      for (const r of this.getRows(tableId, ids.slice(i, i + 1000), { paths: false })) {
        const keys = agg.keysOf(r).map(k => JSON.stringify(k));
        if (!(kept ? keys.some(k => !kept.has(k)) : keys.includes(want))) continue;
        if (out.length === max) return { ids: out, truncated: true };
        out.push(r.id);
      }
    }
    return { ids: out, truncated: false };
  }
  /** Ids among `ids` whose current values match the filter, in the given order; all of them without a filter. */
  matchRows(tableId: string, filters: FilterSpec | undefined, ids: number[]): number[] {
    if (!ids.length) return [];
    const f = filterSql(filters, this.fieldMap(tableId), this.filterCtx());
    if (!f) return ids;
    const t = this.table(tableId);
    const hit = new Set(this.all<{ id: number }>(`SELECT id FROM ${t.phys} WHERE id IN (SELECT value FROM json_each(?)) AND ${f.sql}`, JSON.stringify(ids), ...f.params).map(r => r.id));
    return ids.filter(id => hit.has(id));
  }

  /** The same test against earlier versions of rows (data as stored JSON text), with the view filter SQL. */
  matchSnapshots(tableId: string, filters: FilterSpec | undefined, snaps: { id: number; data: string; createdAt: number; updatedAt: number }[]): number[] {
    if (!snaps.length) return [];
    // Path lookups are not part of a snapshot; they are tested as they are now.
    const f = filterSql(filters, this.fieldMap(tableId), this.filterCtx());
    if (!f) return snaps.map(s => s.id);
    const json = "[" + snaps.map(s => `{"id":${s.id},"data":${s.data},"c":${s.createdAt},"u":${s.updatedAt}}`).join(",") + "]";
    const hit = new Set(
      this.all<{ id: number }>(
        `WITH s AS (SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.data') AS data, json_extract(value, '$.c') AS created_at, json_extract(value, '$.u') AS updated_at FROM json_each(?)) SELECT id FROM s WHERE ${f.sql}`,
        json, ...f.params,
      ).map(r => r.id),
    );
    return snaps.map(s => s.id).filter(id => hit.has(id));
  }
  /**
   * Rows whose date cell (its YYYY-MM-DD prefix) lies in [from, to], ordered by the cell and id; for date triggers.
   * `after` continues from the last row of the previous page.
   */
  dateValues(tableId: string, fieldId: string, from: string, to: string | null, limit: number, after?: { value: string; id: number }): { id: number; value: string }[] {
    const t = this.c.tables.get(tableId);
    if (!t || !isSafeId(fieldId)) return [];
    const e = `json_extract(data, '$.${fieldId}')`;
    const where = [`substr(${e}, 1, 10) >= ?`];
    const params: unknown[] = [from];
    if (to) {
      where.push(`substr(${e}, 1, 10) <= ?`);
      params.push(to);
    }
    if (after) {
      where.push(`(${e} > ? OR (${e} = ? AND id > ?))`);
      params.push(after.value, after.value, after.id);
    }
    const rows = this.all<{ id: number; v: string }>(`SELECT id, ${e} v FROM ${t.phys} WHERE ${where.join(" AND ")} ORDER BY ${e}, id LIMIT ?`, ...params, limit);
    return rows.map(r => ({ id: r.id, value: r.v }));
  }





  // ---------- path lookups ----------

  /** Why a path lookup cannot produce values, or null. */
  pathProblem(fieldId: string): string | null {
    const f = this.field(fieldId);
    return f.type === "pathLookup" ? pathFieldProblem(f, [...this.c.fields.values()], new Set(this.c.tables.keys())) : null;
  }

  private pathPlan(f: Field): PathPlan | null {
    const plans = this.c.pathPlans;
    if (!plans.has(f.id)) {
      const o = f.options;
      const edges = !this.pathProblem(f.id) ? allowedEdges([...this.c.fields.values()], f.tableId, o.targetTableId!, o.pathDirection ?? "dependents", o.excludeLinkFieldIds) : [];
      const plan = edges.length ? planOf(edges, f.tableId, o.targetTableId!, o.maxDepth) : null;
      if (plan && edges.some(e => e.keys && ![e.keys.from, e.keys.to].every(k => this.keyReady(k.slice(2))))) plan.pending = true;
      plans.set(f.id, plan);
    }
    return plans.get(f.id)!;
  }

  private checkPathLookup(tableId: string, o: FieldOptions) {
    if (!o.targetTableId || !this.c.tables.has(o.targetTableId)) throw new UserError("Choose a target table");
    const target = this.fieldMap(o.targetTableId);
    for (const c of o.targetFilter?.conditions ?? []) {
      const f = target.get(c?.fieldId);
      if (!f || f.type === "pathLookup") throw new UserError("Target conditions must use fields of the target table, other than path lookups");
    }
    const links = new Set([...this.c.fields.values()].filter(f => f.type === "link" || f.options.match).map(f => f.id));
    o.excludeLinkFieldIds = (o.excludeLinkFieldIds ?? []).filter(id => links.has(id));
    if (!allowedEdges([...this.c.fields.values()], tableId, o.targetTableId, o.pathDirection ?? "dependents", o.excludeLinkFieldIds).length) {
      throw new UserError(`No links lead from this table to ${this.table(o.targetTableId).name} in that direction`);
    }
  }

  /** Target records that match the field's target conditions, among `ids` (all of them without conditions). */
  private matchingTargets(f: Field, ids: number[]): Set<number> {
    return new Set(this.matchRows(f.options.targetTableId!, f.options.targetFilter, ids));
  }

  /** Fills path lookup cells of rows read from the table: linked-record values, at most 100 per cell. */
  private fillPaths(tableId: string, rows: Row[]) {
    const fields = this.fieldsOf(tableId).filter(f => f.type === "pathLookup");
    if (!fields.length || !rows.length) return;
    // One walker per read: link lookups are shared between rows, and the time limit covers the whole page.
    const reach = new Reach(this, this.pathLimits);
    const titles = new Map<string, Set<number>>();
    const cells: { row: Row; f: Field; ids: number[] }[] = [];
    for (const f of fields) {
      const plan = this.pathPlan(f);
      if (!plan) continue;
      const found = rows.map(r => {
        const w = reach.walk(plan, new Map([[tableId, [r.id]]]));
        return { row: r, ids: [...(w.reached.get(plan.target) ?? [])], truncated: w.truncated || !!plan.pending };
      });
      const ok = f.options.targetFilter ? this.matchingTargets(f, [...new Set(found.flatMap(x => x.ids))]) : null;
      for (const x of found) {
        const hits = (ok ? x.ids.filter(id => ok.has(id)) : x.ids).sort((a, b) => a - b);
        if (hits.length > PATH_CELL_MAX || x.truncated) (x.row.paths ??= {})[f.id] = { total: hits.length, ...(x.truncated ? { incomplete: true } : {}) };
        const shown = hits.slice(0, PATH_CELL_MAX);
        if (!shown.length) continue;
        cells.push({ row: x.row, f, ids: shown });
        const set = titles.get(plan.target) ?? titles.set(plan.target, new Set()).get(plan.target)!;
        for (const id of shown) set.add(id);
      }
    }
    const text = new Map<string, string>();
    for (const [t, ids] of titles) for (const [id, s] of this.titlesOf(t, [...ids])) text.set(nodeKey(t, id), s);
    for (const { row, f, ids } of cells) row.cells[f.id] = ids.map(id => ({ id, t: text.get(nodeKey(f.options.targetTableId!, id)) ?? "" }));
  }

  /** Fills `row.matches`: for each field set to match another table, the records with an equal value, at most 100. */
  private fillMatches(tableId: string, rows: Row[]) {
    if (!rows.length) return;
    for (const { source, target } of this.c.matches) {
      if (source.tableId !== tableId || !this.keyReady(source.id) || !this.keyReady(target.id)) continue;
      const found = new Map<number, number[]>();
      // Many rows can share a value, so the cap is applied in SQL rather than after reading every pair.
      const sql = `SELECT k, v FROM (SELECT s.id k, t.id v, row_number() OVER (PARTITION BY s.id ORDER BY t.id) n FROM ${keyTableOf(source.id)} s JOIN ${keyTableOf(target.id)} t ON t.v = s.v WHERE s.id IN (SELECT value FROM json_each(?))) WHERE n <= ${PATH_CELL_MAX} ORDER BY k, v`;
      for (const r of this.all<{ k: number; v: number }>(sql, JSON.stringify(rows.map(r => r.id)))) {
        (found.get(r.k) ?? found.set(r.k, []).get(r.k)!).push(r.v);
      }
      if (!found.size) continue;
      const titles = this.titlesOf(target.tableId, [...new Set([...found.values()].flat())]);
      for (const row of rows) {
        const hits = found.get(row.id);
        if (hits) (row.matches ??= {})[source.id] = hits.map(id => ({ id, t: titles.get(id) ?? "" }));
      }
    }
  }

  /** Primary field text of records, as link cells show it. */
  private titlesOf(tableId: string, ids: number[]): Map<number, string> {
    const out = new Map<number, string>();
    const t = this.table(tableId);
    for (let i = 0; i < ids.length; i += 1000) {
      for (const r of this.all(`SELECT * FROM ${t.phys} WHERE id IN (SELECT value FROM json_each(?))`, JSON.stringify(ids.slice(i, i + 1000)))) {
        const rec = this.parseRec(r);
        out.set(rec.id, this.primaryText(tableId, rec));
      }
    }
    return out;
  }

  /**
   * Source records whose path lookup is not empty, for "is empty" / "is not empty" filters. One walk backwards from the
   * matching target records answers the whole column. A walk cut short by a limit is refused rather than returned:
   * a partial set would show used records as unused.
   */
  private pathSourceIds(f: Field): number[] {
    const hit = this.pathCache.get(f.id);
    if (hit) return hit;
    const plan = this.pathPlan(f);
    if (!plan) throw unprocessable(`"${f.name}" cannot be filtered: ${this.pathProblem(f.id)}`);
    if (plan.pending) throw unprocessable(`"${f.name}" is still being prepared. Try again in a moment.`);
    const t = this.table(plan.target);
    const cond = filterSql(f.options.targetFilter, this.fieldMap(plan.target));
    const seeds = this.all<{ id: number }>(`SELECT id FROM ${t.phys}${cond ? " WHERE " + cond.sql : ""}`, ...(cond?.params ?? [])).map(r => r.id);
    const w = new Reach(this, this.pathLimits, false).walk(plan, new Map([[plan.target, seeds]]), { backward: true });
    if (w.truncated) throw unprocessable(`"${f.name}" reaches too many records to filter on. Add target conditions or leave some links out of its paths.`);
    const ids = [...(w.reached.get(plan.source) ?? [])];
    this.pathCache.set(f.id, ids);
    return ids;
  }

  /** Tables with path lookups that pass through a table this write changed; open views of them reload, since path values are not pushed with rows. */
  pathTablesAffected(result: MutationResult): string[] {
    const changed = new Set([...result.changes.map(c => c.tableId), ...result.deleted.map(d => d.tableId)]);
    const out = new Set<string>(result.unfilled ?? []);
    if (!changed.size) return [...out];
    // Rows created or deleted, or one of these fields written; results without field details count as any change.
    const valuesChanged = (tableId: string, fieldIds: string[]) => {
      if (!changed.has(tableId)) return false;
      if (result.deleted.some(d => d.tableId === tableId) || !result.fields) return true;
      const f = result.fields[tableId] ?? [];
      return f.includes("__new") || fieldIds.some(id => f.includes(id));
    };
    for (const f of this.c.fields.values()) {
      if (f.type !== "pathLookup" || out.has(f.tableId)) continue;
      const plan = this.pathPlan(f);
      if (!plan) continue;
      // An edit to the source table alone changes no path: its link edits also change the linked table's rows.
      // The source counts only when a walk can come back into it (a self-link or a loop), or when it leaves through a
      // value match, whose values live in the source rows.
      const matchKeys = (plan.forward.get(plan.source) ?? []).flatMap(st => (st.keys ? [st.keys.at.slice(2)] : []));
      const tables = [plan.target, ...plan.backward.keys(), ...[...plan.forward.keys()].filter(t => t !== plan.source)];
      if (tables.some(t => changed.has(t)) || (matchKeys.length && valuesChanged(plan.source, matchKeys))) out.add(f.tableId);
    }
    // Matched cells show records of the matched table, by their value and title.
    for (const m of this.c.matches) if (valuesChanged(m.target.tableId, [m.target.id, this.table(m.target.tableId).primaryFieldId])) out.add(m.source.tableId);
    return [...out];
  }

  private filterCtx(): FilterContext {
    return { pathIds: f => this.pathSourceIds(f), refuse: message => { throw unprocessable(message); } };
  }

  /** One shortest chain of linked records from a record to one of its path lookup results, or null when there is none. */
  explainPath(fieldId: string, rowId: number, targetId: number): { tableId: string; id: number; t: string; fieldId?: string }[] | null {
    const f = this.field(fieldId);
    if (f.type !== "pathLookup") throw new UserError("Not a path lookup field");
    const plan = this.pathPlan(f);
    if (!plan || !this.getRows(f.tableId, [rowId], { paths: false }).length) return null;
    if (f.options.targetFilter && !this.matchingTargets(f, [targetId]).has(targetId)) return null;
    const start = nodeKey(f.tableId, rowId), goal = nodeKey(plan.target, targetId);
    const w = new Reach(this, this.pathLimits).walk(plan, new Map([[f.tableId, [rowId]]]), { parents: true, stopAt: goal });
    const hops = hopsTo(w, start, goal);
    if (!hops) return null;
    return hops.map(h => ({ ...h, t: this.titlesOf(h.tableId, [h.id]).get(h.id) ?? "" }));
  }

  /** Rows with every field, in view order, used by CSV / JSON export and the public API. */
  *iterateRows(tableId: string, viewId?: string, batch = 1000): Generator<Row[]> {
    const ids = this.query(tableId, { viewId, limit: 0 }).ids;
    for (let i = 0; i < ids.length; i += batch) yield this.getRows(tableId, ids.slice(i, i + batch));
  }

  exportCsv(tableId: string, viewId?: string): string {
    const view = viewId ? this.view(viewId) : undefined;
    const hidden = new Set(view?.config.hidden ?? []);
    const fields = this.orderedFields(tableId, view).filter(f => !hidden.has(f.id));
    const esc = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const lines = [fields.map(f => esc(f.name)).join(",")];
    for (const rows of this.iterateRows(tableId, viewId)) {
      for (const r of rows) {
        lines.push(fields.map(f => esc(displayCell(f, this.rawFromRow(f, r), { userName: this.userName }))).join(","));
      }
    }
    return lines.join("\r\n");
  }

  orderedFields(tableId: string, view?: View): Field[] {
    const list = this.fieldsOf(tableId);
    const t = this.table(tableId);
    const order = view?.config.fieldOrder ?? [];
    const pos = new Map(order.map((id, i) => [id, i]));
    return [...list].sort((a, b) => {
      if (a.id === t.primaryFieldId) return -1;
      if (b.id === t.primaryFieldId) return 1;
      const pa = pos.get(a.id), pb = pos.get(b.id);
      if (pa !== undefined && pb !== undefined) return pa - pb;
      if (pa !== undefined) return -1;
      if (pb !== undefined) return 1;
      return a.ord < b.ord ? -1 : a.ord > b.ord ? 1 : 0;
    });
  }

  rawFromRow(f: Field, r: Row): unknown {
    if (f.type === "createdTime") return r.createdAt;
    if (f.type === "modifiedTime") return r.updatedAt;
    if (f.type === "autonumber") return r.id;
    return r.cells[f.id];
  }

  // ---------- rows: transaction machinery ----------

  private key(tableId: string, id: number) {
    return tableId + ":" + id;
  }

  private load(tx: Tx, tableId: string, id: number): RowRec | undefined {
    const k = this.key(tableId, id);
    const hit = tx.rows.get(k);
    if (hit) return hit;
    const t = this.table(tableId);
    const r = this.one(`SELECT * FROM ${t.phys} WHERE id = ?`, id);
    if (!r) return undefined;
    const rec = this.parseRec(r);
    tx.rows.set(k, rec);
    return rec;
  }

  private prefetch(tx: Tx, tableId: string, ids: Iterable<number>) {
    const t = this.table(tableId);
    const need = [...new Set(ids)].filter(id => !tx.rows.has(this.key(tableId, id)));
    for (let i = 0; i < need.length; i += 100) {
      const chunk = need.slice(i, i + 100);
      for (const r of this.all(`SELECT * FROM ${t.phys} WHERE id IN (${chunk.map(() => "?").join(",")})`, ...chunk)) {
        const rec = this.parseRec(r);
        tx.rows.set(this.key(tableId, rec.id), rec);
      }
    }
  }

  private noteField(tx: Tx, k: string, fieldId: string) {
    let s = tx.fields.get(k);
    if (!s) tx.fields.set(k, (s = new Set()));
    s.add(fieldId);
  }

  private markChanged(tx: Tx, tableId: string, id: number, fieldId: string, force = false) {
    const k = this.key(tableId, id);
    let p = tx.pending.get(k);
    if (!p) {
      p = { tableId, id, changed: new Set(), force: new Set() };
      tx.pending.set(k, p);
      tx.queue.push(k);
    }
    (force ? p.force : p.changed).add(fieldId);
    if (!force && fieldId !== "__new") this.noteField(tx, k, fieldId);
    const rec = tx.rows.get(k);
    if (rec && !force) rec.dirty = true;
    let set = tx.changedRows.get(tableId);
    if (!set) tx.changedRows.set(tableId, (set = new Set()));
    set.add(id);
  }

  private cellRaw(f: Field, r: RowRec): unknown {
    if (f.type === "createdTime") return r.created_at;
    if (f.type === "modifiedTime") return r.updated_at;
    if (f.type === "autonumber") return r.id;
    return r.data[f.id];
  }

  primaryText(tableId: string, r: RowRec): string {
    const f = this.c.fields.get(this.table(tableId).primaryFieldId);
    if (!f) return "";
    return displayCell(f, this.cellRaw(f, r), { userName: this.userName }).slice(0, 200);
  }

  private coerceCtx(tx: Tx, typecast: boolean): CoerceContext {
    return {
      typecast,
      onNewChoice: (field, _choice: Choice) => {
        this.sql.exec("UPDATE _fields SET options = ? WHERE id = ?", JSON.stringify(field.options), field.id);
        tx.schemaDirty = true;
      },
      findLinked: (field, text) => {
        const lt = field.options.linkedTableId;
        if (!lt) return null;
        const t = this.c.tables.get(lt);
        const pf = t && this.c.fields.get(t.primaryFieldId);
        if (!t || !pf || !isSafeId(pf.id)) return null;
        const hit = this.one<{ id: number }>(`SELECT id FROM ${t.phys} WHERE lower(json_extract(data, '$.${pf.id}')) = lower(?) LIMIT 1`, text);
        if (hit) return { id: hit.id, t: text };
        if (!typecast) return null;
        // Like Airtable typecast: unknown names create a new linked record, within the plan's record limit.
        const max = this.recordLimit?.();
        if (max) {
          tx.linkRoom ??= Math.max(0, max.limit - this.totalRows());
          if (tx.linkRoom <= 0 && tx.softLinks) return null;
          if (tx.linkRoom <= 0) throw limitError(`This plan allows ${max.limit.toLocaleString("en-US")} records per base; new linked records cannot be added`, { key: "records", limit: max.limit, upgradeUrl: max.upgradeUrl });
          tx.linkRoom--;
        }
        const id = this.insertRow(tx, lt, { [pf.id]: coerceCell(pf, text) }, undefined);
        return { id, t: text };
      },
      linkText: (field, id) => {
        const lt = field.options.linkedTableId;
        if (!lt) return null;
        const r = this.load(tx, lt, id);
        return r ? this.primaryText(lt, r) : null;
      },
      findUser: text => {
        const s = text.trim().toLowerCase();
        for (const m of this.c.members.values()) if (m.id === text || m.email.toLowerCase() === s || m.name.toLowerCase() === s) return m.id;
        return null;
      },
    };
  }

  private insertRow(tx: Tx, tableId: string, data: Record<string, unknown>, actor: Actor | undefined, opts: { id?: number; ord?: string; createdAt?: number; createdBy?: string | null } = {}): number {
    const t = this.table(tableId);
    const ts = now();
    const ord = opts.ord ?? generateKeyBetween(this.maxOrd(tableId), null);
    const createdAt = opts.createdAt ?? ts;
    const createdBy = opts.createdBy ?? actor?.userId ?? null;
    let id: number;
    if (opts.id !== undefined) {
      if (this.one(`SELECT 1 x FROM ${t.phys} WHERE id = ?`, opts.id)) throw new UserError(`Record ${opts.id} already exists`);
      this.sql.exec(`INSERT INTO ${t.phys} (id, ord, data, created_at, updated_at, created_by, updated_by) VALUES (?, ?, '{}', ?, ?, ?, ?)`, opts.id, ord, createdAt, ts, createdBy, actor?.userId ?? null);
      id = opts.id;
    } else {
      id = this.one<{ id: number }>(`INSERT INTO ${t.phys} (ord, data, created_at, updated_at, created_by, updated_by) VALUES (?, '{}', ?, ?, ?, ?) RETURNING id`, ord, createdAt, ts, createdBy, actor?.userId ?? null)!.id;
    }
    const rec: RowRec = { id, ord, data: {}, created_at: createdAt, updated_at: ts, created_by: createdBy, updated_by: actor?.userId ?? null, dirty: true, touched: true };
    tx.rows.set(this.key(tableId, id), rec);
    for (const [fid, v] of Object.entries(data)) if (v !== undefined) rec.data[fid] = v;
    this.markChanged(tx, tableId, id, "__new");
    for (const f of this.fieldsOf(tableId)) if (f.type === "createdTime" || f.type === "autonumber") this.markChanged(tx, tableId, id, f.id);
    return id;
  }

  private maxOrdCache = new Map<string, string | null>();
  private maxOrd(tableId: string): string | null {
    if (this.maxOrdCache.has(tableId)) return this.maxOrdCache.get(tableId)!;
    const r = this.one<{ o: string | null }>(`SELECT max(ord) o FROM ${this.table(tableId).phys}`);
    return r?.o ?? null;
  }

  /** Writes link cells on both sides and keeps the pair table in sync. */
  private setLinks(tx: Tx, tableId: string, rec: RowRec, field: Field, next: LinkValue[]) {
    const { linkTable, linkSide, linkedTableId, inverseFieldId } = field.options;
    if (!linkTable || !linkedTableId || !linkSide) return;
    const me = linkSide, other = linkSide === "a" ? "b" : "a";
    const old = (Array.isArray(rec.data[field.id]) ? rec.data[field.id] : []) as LinkValue[];
    const oldIds = new Set(old.map(v => v.id));
    this.prefetch(tx, linkedTableId, next.map(v => v.id));
    const valid: LinkValue[] = [];
    for (const v of next) {
      const target = this.load(tx, linkedTableId, v.id);
      if (target) valid.push({ id: v.id, t: this.primaryText(linkedTableId, target) });
    }
    const newIds = new Set(valid.map(v => v.id));
    const added = valid.filter(v => !oldIds.has(v.id)).map(v => v.id);
    const removed = [...oldIds].filter(id => !newIds.has(id));
    for (const id of added) this.sql.exec(`INSERT OR IGNORE INTO ${linkTable} (${me}, ${other}) VALUES (?, ?)`, rec.id, id);
    for (const id of removed) this.sql.exec(`DELETE FROM ${linkTable} WHERE ${me} = ? AND ${other} = ?`, rec.id, id);
    if (valid.length) rec.data[field.id] = valid;
    else delete rec.data[field.id];
    if (!same(old, valid)) this.markChanged(tx, tableId, rec.id, field.id);
    const inverse = inverseFieldId ? this.c.fields.get(inverseFieldId) : undefined;
    if (!inverse) return;
    const myText = this.primaryText(tableId, rec);
    for (const id of added) {
      const o = this.load(tx, linkedTableId, id);
      if (!o) continue;
      const cell = (Array.isArray(o.data[inverse.id]) ? o.data[inverse.id] : []) as LinkValue[];
      if (!cell.some(v => v.id === rec.id)) {
        o.data[inverse.id] = [...cell, { id: rec.id, t: myText }];
        this.markChanged(tx, linkedTableId, id, inverse.id);
      }
    }
    for (const id of removed) {
      const o = this.load(tx, linkedTableId, id);
      if (!o) continue;
      const cell = ((Array.isArray(o.data[inverse.id]) ? o.data[inverse.id] : []) as LinkValue[]).filter(v => v.id !== rec.id);
      if (cell.length) o.data[inverse.id] = cell;
      else delete o.data[inverse.id];
      this.markChanged(tx, linkedTableId, id, inverse.id);
    }
  }

  private computeValue(tx: Tx, tableId: string, f: Field, r: RowRec, ts: Date): unknown {
    if (f.type === "lookup" || f.type === "rollup") {
      const link = f.options.linkFieldId ? this.c.fields.get(f.options.linkFieldId) : undefined;
      const target = f.options.targetFieldId ? this.c.fields.get(f.options.targetFieldId) : undefined;
      if (!link || !target || !link.options.linkedTableId) return undefined;
      const ids = ((Array.isArray(r.data[link.id]) ? r.data[link.id] : []) as LinkValue[]).map(v => v.id);
      if (!ids.length) return f.type === "rollup" ? emptyValue(aggregate(f.options.fn ?? "sum", [])) : undefined;
      this.prefetch(tx, link.options.linkedTableId, ids);
      const values: Value[] = [];
      for (const id of ids) {
        const tr = this.load(tx, link.options.linkedTableId, id);
        if (!tr) continue;
        const raw = this.cellRaw(target, tr);
        if (f.type === "lookup" && target.type === "attachment") {
          if (Array.isArray(raw)) values.push(...(raw as Value[]));
          continue;
        }
        const v = formulaValue(target, raw, { userName: this.userName });
        if (Array.isArray(v)) values.push(...v);
        else if (f.type === "rollup" || v !== null) values.push(v);
      }
      if (f.type === "lookup") return values.length ? values : undefined;
      return emptyValue(aggregate(f.options.fn ?? "sum", values));
    }
    if (f.type === "formula") {
      const comp = this.c.compiled.get(f.id);
      if (!comp) return undefined;
      const fields = this.c.fields;
      const v = evaluate(comp.ast, {
        get: fid => {
          const ref = fields.get(fid);
          return ref ? formulaValue(ref, this.cellRaw(ref, r), { userName: this.userName }) : null;
        },
        recordId: r.id,
        createdTime: new Date(r.created_at).toISOString(),
        modifiedTime: new Date(r.updated_at).toISOString(),
        now: ts,
      });
      return emptyValue(v);
    }
    return undefined;
  }

  /** Recomputes dependent fields for every pending row, following links across tables. */
  private propagate(tx: Tx) {
    const ts = new Date();
    while (tx.queue.length) {
      const k = tx.queue.shift()!;
      const p = tx.pending.get(k);
      tx.pending.delete(k);
      if (!p) continue;
      if (++tx.processed > MAX_PROPAGATION) throw new UserError("Change affects too many records");
      const r = this.load(tx, p.tableId, p.id);
      if (!r) continue;
      const changed = p.changed;
      if (r.touched) for (const f of this.fieldsOf(p.tableId)) if (f.type === "modifiedTime") changed.add(f.id);
      for (const f of this.c.computeOrder.get(p.tableId) ?? []) {
        const deps = f.type === "formula" ? this.c.compiled.get(f.id)?.deps ?? [] : f.options.linkFieldId ? [f.options.linkFieldId] : [];
        if (!p.force.has(f.id) && !changed.has("__new") && !deps.some(d => changed.has(d))) continue;
        const next = this.computeValue(tx, p.tableId, f, r, ts);
        if (!same(next, r.data[f.id])) {
          if (next === undefined) delete r.data[f.id];
          else r.data[f.id] = next;
          changed.add(f.id);
          this.noteField(tx, k, f.id);
          r.dirty = true;
          let set = tx.changedRows.get(p.tableId);
          if (!set) tx.changedRows.set(p.tableId, (set = new Set()));
          set.add(r.id);
        }
      }
      // Push changes into records that link to this one.
      const primaryId = this.table(p.tableId).primaryFieldId;
      const primaryChanged = changed.has(primaryId) || changed.has("__new");
      for (const link of this.c.incoming.get(p.tableId) ?? []) {
        const dependents = (this.c.byTable.get(link.tableId) ?? []).filter(
          f => (f.type === "lookup" || f.type === "rollup") && f.options.linkFieldId === link.id && f.options.targetFieldId && changed.has(f.options.targetFieldId),
        );
        if (!primaryChanged && !dependents.length) continue;
        const { linkTable, linkSide } = link.options;
        if (!linkTable || !linkSide) continue;
        const me = linkSide, other = linkSide === "a" ? "b" : "a";
        const ids = this.all<{ id: number }>(`SELECT ${me} id FROM ${linkTable} WHERE ${other} = ?`, r.id).map(x => x.id);
        if (!ids.length) continue;
        this.prefetch(tx, link.tableId, ids);
        const text = primaryChanged ? this.primaryText(p.tableId, r) : "";
        for (const id of ids) {
          const lr = this.load(tx, link.tableId, id);
          if (!lr) continue;
          if (primaryChanged) {
            const cell = (Array.isArray(lr.data[link.id]) ? lr.data[link.id] : []) as LinkValue[];
            const i = cell.findIndex(v => v.id === r.id);
            if (i >= 0 && cell[i].t !== text) {
              const next = cell.slice();
              next[i] = { id: r.id, t: text };
              lr.data[link.id] = next;
              this.markChanged(tx, link.tableId, id, link.id);
            }
          }
          for (const d of dependents) this.markChanged(tx, link.tableId, id, d.id, true);
        }
      }
    }
  }

  private flush(tx: Tx, actor: Actor | undefined): MutationResult {
    const ts = now();
    const out: MutationResult = { changes: [], deleted: [] };
    const byTable = new Map<string, RowRec[]>();
    const fieldSets = new Map<string, Set<string>>();
    for (const [k, r] of tx.rows) {
      if (!r.dirty) continue;
      const tableId = k.slice(0, k.lastIndexOf(":"));
      if (!this.c.tables.has(tableId)) continue;
      const t = this.table(tableId);
      if (r.touched) {
        r.updated_at = r.isNew ? r.updated_at : ts;
        r.updated_by = actor?.userId ?? r.updated_by;
        this.sql.exec(`UPDATE ${t.phys} SET data = ?, updated_at = ?, updated_by = ? WHERE id = ?`, JSON.stringify(r.data), r.updated_at, r.updated_by, r.id);
      } else {
        this.sql.exec(`UPDATE ${t.phys} SET data = ? WHERE id = ?`, JSON.stringify(r.data), r.id);
      }
      r.dirty = false;
      const changed = (fieldSets.get(tableId) ?? fieldSets.set(tableId, new Set()).get(tableId)!);
      if (!r.orig) changed.add("__new");
      for (const f of tx.fields.get(k) ?? []) changed.add(f);
      const keyed = this.c.keyed.get(tableId);
      if (keyed) this.writeKeys(keyed, r, tx.fields.get(k));
      const list = byTable.get(tableId) ?? [];
      list.push(r);
      byTable.set(tableId, list);
    }
    for (const [tableId, list] of byTable) out.changes.push({ tableId, rows: this.decorate(tableId, list.map(r => this.toRow(r, this.fieldsOf(tableId)))) });
    for (const [tableId, ids] of tx.deleted) out.deleted.push({ tableId, ids });
    // Kept off the wire: results are sent to clients as they are.
    Object.defineProperty(out, "fields", { value: Object.fromEntries([...fieldSets].map(([t, f]) => [t, [...f]])), enumerable: false });
    if (tx.schemaDirty) {
      this.bumpVersion();
      out.schema = this.schema();
    }
    this.maxOrdCache.clear();
    return out;
  }

  /** Rewrites the keys of a written row's matched columns that changed (all of them for a new row). */
  private writeKeys(keyed: { fieldId: string }[], r: RowRec, changed: Set<string> | undefined) {
    for (const { fieldId } of keyed) {
      if (r.orig && !changed?.has(fieldId)) continue;
      const kt = keyTableOf(fieldId);
      this.sql.exec(`DELETE FROM ${kt} WHERE id = ?`, r.id);
      const v = matchKey(r.data[fieldId]);
      if (v) this.sql.exec(`INSERT INTO ${kt} (v, id) VALUES (?, ?)`, v, r.id);
    }
  }

  private applyCells(tx: Tx, tableId: string, rec: RowRec, cells: Cells, ctx: CoerceContext) {
    const fields = this.fieldMap(tableId);
    const links: [Field, unknown][] = [];
    for (const [fid, v] of Object.entries(cells)) {
      const f = fields.get(fid);
      if (!f || COMPUTED_TYPES.has(f.type)) continue;
      if (f.type === "link") {
        links.push([f, v]);
        continue;
      }
      const next = coerceCell(f, v, ctx);
      if (same(next, rec.data[fid])) continue;
      if (next === undefined) delete rec.data[fid];
      else rec.data[fid] = next;
      rec.touched = true;
      this.markChanged(tx, tableId, rec.id, fid);
    }
    for (const [f, v] of links) {
      const next = (coerceCell(f, v, ctx) as LinkValue[] | undefined) ?? [];
      const before = JSON.stringify(rec.data[f.id] ?? []);
      this.setLinks(tx, tableId, rec, f, next);
      if (JSON.stringify(rec.data[f.id] ?? []) !== before) rec.touched = true;
    }
  }

  private run(actor: Actor | undefined, fn: (tx: Tx) => void): MutationResult {
    let out!: MutationResult;
    let direct = false;
    this.storage.transactionSync(() => {
      const tx = new Tx();
      fn(tx);
      this.propagate(tx);
      out = this.flush(tx, actor);
      direct = !!actor && !tx.noTriggers;
      // Trigger checks below run inside the transaction and must see path lookups as this write left them.
      this.pathCache.clear();
      if (this.onWrite) this.onWrite(this.written(tx, actor ?? { userId: "system", name: "System" }, !!actor && !tx.noTriggers && !this.writeCtx.silent, !actor || tx.noTriggers));
    });
    this.clearAggCache();
    // Read after the commit, so writes never pay for path lookups. Only a person's own edits are filled; jobs, imports and
    // batches big enough to reload leave their tables to the reload that pathTablesAffected asks for.
    for (const c of out.changes) {
      if (!this.fieldsOf(c.tableId).some(f => f.type === "pathLookup") && !this.c.matches.some(m => m.source.tableId === c.tableId)) continue;
      if (direct && c.rows.length <= BROADCAST_LIMIT) {
        this.fillPaths(c.tableId, c.rows);
        this.fillMatches(c.tableId, c.rows);
      } else (out.unfilled ??= []).push(c.tableId);
    }
    return out;
  }

  private written(tx: Tx, actor: Actor, fire: boolean, bulk: boolean): WriteInfo {
    const rows: WrittenRow[] = [];
    for (const [k, r] of tx.rows) {
      if (!r.touched) continue;
      rows.push({ tableId: k.slice(0, k.lastIndexOf(":")), id: r.id, isNew: !r.orig, before: r.orig ?? null, changed: tx.fields.get(k) ?? new Set() });
    }
    return { actor, rows, chain: this.writeCtx.chain, fire, bulk, deleted: [...tx.deleted].map(([tableId, ids]) => ({ tableId, ids })) };
  }

  // ---------- rows: mutations ----------

  createRows(actor: Actor, tableId: string, inputs: RowInput[], opts: { afterId?: number; beforeId?: number; typecast?: boolean; noTriggers?: boolean; noLimit?: boolean } = {}): MutationResult {
    const t = this.table(tableId);
    if (!opts.noLimit) this.checkRoom(inputs.length);
    const created: number[] = [];
    const out = this.run(actor, tx => {
      tx.noTriggers = !!opts.noTriggers;
      let lo: string | null = this.maxOrd(tableId), hi: string | null = null;
      if (opts.afterId !== undefined || opts.beforeId !== undefined) {
        const anchorId = (opts.afterId ?? opts.beforeId)!;
        const anchor = this.one<{ ord: string }>(`SELECT ord FROM ${t.phys} WHERE id = ?`, anchorId);
        if (anchor) {
          if (opts.afterId !== undefined) {
            lo = anchor.ord;
            hi = this.one<{ ord: string }>(`SELECT ord FROM ${t.phys} WHERE ord > ? ORDER BY ord LIMIT 1`, anchor.ord)?.ord ?? null;
          } else {
            hi = anchor.ord;
            lo = this.one<{ ord: string }>(`SELECT ord FROM ${t.phys} WHERE ord < ? ORDER BY ord DESC LIMIT 1`, anchor.ord)?.ord ?? null;
          }
        }
      }
      const need = inputs.filter(i => !i.ord).length;
      const keys = need ? generateNKeysBetween(lo, hi, need) : [];
      let k = 0;
      const ctx = this.coerceCtx(tx, opts.typecast ?? false);
      for (const input of inputs) {
        const id = this.insertRow(tx, tableId, {}, actor, { id: input.id, ord: input.ord ?? keys[k++], createdAt: input.createdAt, createdBy: input.createdBy });
        created.push(id);
        const rec = tx.rows.get(this.key(tableId, id))!;
        rec.isNew = true;
        if (input.cells) this.applyCells(tx, tableId, rec, input.cells, ctx);
      }
    });
    out.created = created;
    return out;
  }

  updateRows(actor: Actor, tableId: string, updates: { id: number; cells: Cells }[], opts: { typecast?: boolean; noTriggers?: boolean } = {}): MutationResult {
    this.table(tableId);
    return this.run(actor, tx => {
      tx.noTriggers = !!opts.noTriggers;
      this.prefetch(tx, tableId, updates.map(u => u.id));
      const ctx = this.coerceCtx(tx, opts.typecast ?? false);
      for (const u of updates) {
        const rec = this.load(tx, tableId, u.id);
        if (!rec) continue;
        this.applyCells(tx, tableId, rec, u.cells ?? {}, ctx);
      }
    });
  }

  moveRow(actor: Actor, tableId: string, id: number, afterId: number | null, beforeId: number | null): MutationResult {
    const t = this.table(tableId);
    const ordOf = (rid: number | null) => (rid === null ? null : this.one<{ ord: string }>(`SELECT ord FROM ${t.phys} WHERE id = ?`, rid)?.ord ?? null);
    let lo = ordOf(afterId), hi = ordOf(beforeId);
    if (lo && !hi) hi = this.one<{ ord: string }>(`SELECT ord FROM ${t.phys} WHERE ord > ? AND id <> ? ORDER BY ord LIMIT 1`, lo, id)?.ord ?? null;
    if (hi && !lo) lo = this.one<{ ord: string }>(`SELECT ord FROM ${t.phys} WHERE ord < ? AND id <> ? ORDER BY ord DESC LIMIT 1`, hi, id)?.ord ?? null;
    if (lo && hi && lo >= hi) throw new UserError("Invalid position");
    const ord = generateKeyBetween(lo, hi);
    return this.run(actor, tx => {
      const rec = this.load(tx, tableId, id);
      if (!rec) throw new UserError("Record not found");
      this.sql.exec(`UPDATE ${t.phys} SET ord = ? WHERE id = ?`, ord, id);
      rec.ord = ord;
      rec.dirty = true;
      let set = tx.changedRows.get(tableId);
      if (!set) tx.changedRows.set(tableId, (set = new Set()));
      set.add(id);
    });
  }

  deleteRows(actor: Actor, tableId: string, ids: number[]): MutationResult {
    const t = this.table(tableId);
    return this.run(actor, tx => {
      this.prefetch(tx, tableId, ids);
      const links = this.fieldsOf(tableId).filter(f => f.type === "link");
      const gone: number[] = [];
      for (const id of ids) {
        const rec = this.load(tx, tableId, id);
        if (!rec) continue;
        for (const f of links) this.setLinks(tx, tableId, rec, f, []);
        gone.push(id);
      }
      for (let i = 0; i < gone.length; i += 100) {
        const chunk = gone.slice(i, i + 100);
        this.sql.exec(`DELETE FROM ${t.phys} WHERE id IN (${chunk.map(() => "?").join(",")})`, ...chunk);
        for (const k of this.c.keyed.get(tableId) ?? []) this.sql.exec(`DELETE FROM ${keyTableOf(k.fieldId)} WHERE id IN (${chunk.map(() => "?").join(",")})`, ...chunk);
      }
      for (const id of gone) {
        const k = this.key(tableId, id);
        tx.rows.delete(k);
        tx.pending.delete(k);
      }
      if (gone.length) tx.deleted.set(tableId, gone);
    });
  }

  // ---------- schema: tables ----------

  init(baseId: string) {
    if (this.initialized) return;
    this.setMeta("baseId", baseId);
    this.setMeta("version", "1");
    this.invalidate();
  }

  createTable(actor: Actor | undefined, input: { name: string; fields?: FieldInput[]; emptyRows?: number }): { tableId: string; result: MutationResult } {
    const name = this.uniqueTableName(input.name.trim() || "Table");
    const id = newTableId();
    const phys = "t_" + this.nextSeq("table");
    const last = this.one<{ o: string | null }>("SELECT max(ord) o FROM _tables")?.o ?? null;
    let result!: MutationResult;
    this.storage.transactionSync(() => {
      this.sql.exec(`CREATE TABLE ${phys} (id INTEGER PRIMARY KEY AUTOINCREMENT, ord TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, created_by TEXT, updated_by TEXT)`);
      this.sql.exec(`CREATE INDEX ${phys}_ord ON ${phys} (ord)`);
      const fieldInputs: FieldInput[] = input.fields?.length
        ? input.fields
        : [
            { name: "Name", type: "text" },
            { name: "Notes", type: "longText" },
            { name: "Status", type: "singleSelect", options: { choices: defaultChoices(["Todo", "In progress", "Done"]) } },
          ];
      const first = fieldInputs[0];
      if (!first || (COMPUTED_TYPES.has(first.type) && first.type !== "formula") || NOT_PRIMARY.has(first.type)) throw new UserError("The primary field cannot be this type");
      // Names are unique per table, compared without case, as everywhere else.
      const used = new Set<string>();
      const names = fieldInputs.map(f => {
        const base = String(f.name ?? "").trim() || "Field";
        let n = base, k = 2;
        while (used.has(n.toLowerCase())) n = `${base} ${k++}`;
        used.add(n.toLowerCase());
        return n;
      });
      const primaryId = newFieldId();
      this.sql.exec("INSERT INTO _tables (id, name, ord, primary_field_id, phys) VALUES (?, ?, ?, ?, ?)", id, name, generateKeyBetween(last, null), primaryId, phys);
      let ord: string | null = null;
      fieldInputs.forEach((f, i) => {
        ord = generateKeyBetween(ord, null);
        const fid = i === 0 ? primaryId : newFieldId();
        this.sql.exec(
          "INSERT INTO _fields (id, table_id, name, type, options, description, ord) VALUES (?, ?, ?, ?, ?, ?, ?)",
          fid, id, names[i], f.type, JSON.stringify(this.normalizeOptions(f.type, f.options ?? {})), f.description ?? null, ord,
        );
      });
      this.sql.exec("INSERT INTO _views (id, table_id, name, type, config, ord) VALUES (?, ?, ?, ?, ?, ?)", newViewId(), id, "Grid view", "grid", "{}", "a0");
      this.bumpVersion();
      for (const f of this.fieldsOf(id)) if (f.options.match) this.checkMatch(f.id, f.type, f.options.match);
      this.syncKeys();
    });
    this.runInlineJobs();
    const n = input.emptyRows ?? (input.fields?.length ? 0 : 3);
    // The blank rows of a new table are placeholders, not counted against a plan's record limit.
    result = n ? this.createRows(actor ?? { userId: "", name: "" }, id, Array.from({ length: n }, () => ({})), { noLimit: true }) : { changes: [], deleted: [] };
    result.schema = this.schema();
    return { tableId: id, result };
  }

  private uniqueTableName(name: string, except?: string): string {
    const names = new Set([...this.c.tables.values()].filter(t => t.id !== except).map(t => t.name.toLowerCase()));
    let n = name, i = 2;
    while (names.has(n.toLowerCase())) n = `${name} ${i++}`;
    return n;
  }

  private uniqueFieldName(tableId: string, name: string, except?: string): string {
    const names = new Set(this.fieldsOf(tableId).filter(f => f.id !== except).map(f => f.name.toLowerCase()));
    let n = name, i = 2;
    while (names.has(n.toLowerCase())) n = `${name} ${i++}`;
    return n;
  }

  updateTable(tableId: string, patch: { name?: string; primaryFieldId?: string }): Schema {
    const t = this.table(tableId);
    if (patch.name !== undefined) {
      const name = this.uniqueTableName(patch.name.trim() || t.name, tableId);
      this.sql.exec("UPDATE _tables SET name = ? WHERE id = ?", name, tableId);
    }
    if (patch.primaryFieldId && patch.primaryFieldId !== t.primaryFieldId) {
      const f = this.field(patch.primaryFieldId);
      if (f.tableId !== tableId || NOT_PRIMARY.has(f.type)) throw new UserError("This field cannot be the primary field");
      this.sql.exec("UPDATE _tables SET primary_field_id = ? WHERE id = ?", f.id, tableId);
      this.bumpVersion();
      this.refreshLinkTitles(tableId);
    }
    this.bumpVersion();
    return this.schema();
  }

  /** Rewrites the cached titles in every link cell pointing at this table (after a primary field change). */
  private refreshLinkTitles(tableId: string) {
    for (const link of this.c.incoming.get(tableId) ?? []) this.enqueueJob("relink", `Updating ${link.name}`, { tableId: link.tableId, fieldId: link.id, cursor: 0 }, this.rowCount(link.tableId));
  }

  deleteTable(tableId: string): Schema {
    const t = this.table(tableId);
    if (this.c.tables.size <= 1) throw new UserError("A base needs at least one table");
    this.storage.transactionSync(() => {
      for (const link of this.c.incoming.get(tableId) ?? []) if (link.tableId !== tableId) this.deleteFieldInner(link.id, true);
      for (const f of this.fieldsOf(tableId)) if (f.type === "link" && f.options.linkTable) this.sql.exec(`DROP TABLE IF EXISTS ${f.options.linkTable}`);
      this.sql.exec(`DROP TABLE IF EXISTS ${t.phys}`);
      this.sql.exec("DELETE FROM _fields WHERE table_id = ?", tableId);
      this.sql.exec("DELETE FROM _views WHERE table_id = ?", tableId);
      this.sql.exec("DELETE FROM _tables WHERE id = ?", tableId);
      this.bumpVersion();
      this.syncKeys();
    });
    return this.schema();
  }

  /** Bytes of all attachments in cells (each file counted where it appears). */
  /** A file this base stored in R2, with its real size. */
  noteFile(key: string, size: number, now: number) {
    this.sql.exec("INSERT INTO _files (key, size, created_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET size = excluded.size", key, Math.max(0, size), now);
  }

  /**
   * Bytes of this base's files for the workspace's storage count, and the files to delete from R2.
   * A file counts while a cell refers to it (once, however many cells do) and for a day after upload, so uploads
   * that were never attached cannot be repeated for free. A file no cell has referred to for a week is swept.
   * Files from before this table existed are counted by their cell size, never below zero.
   */
  storageScan(now: number): { bytes: number; sweep: string[] } {
    const referenced = new Map<string, number>();
    for (const f of this.c.fields.values()) {
      if (f.type !== "attachment" || !isSafeId(f.id)) continue;
      const t = this.c.tables.get(f.tableId);
      if (!t) continue;
      for (const r of this.all<{ k: unknown; s: unknown }>(`SELECT json_extract(j.value, '$.key') k, json_extract(j.value, '$.size') s FROM ${t.phys}, json_each(json_extract(data, '$.${f.id}')) j`)) {
        if (typeof r.k === "string" && !referenced.has(r.k)) referenced.set(r.k, Number(r.s));
      }
    }
    const files = new Map(this.all<{ key: string; size: number; created_at: number; unref_since: number | null }>("SELECT key, size, created_at, unref_since FROM _files").map(r => [r.key, r]));
    let bytes = 0;
    for (const [key, cellSize] of referenced) {
      const known = files.get(key);
      bytes += known ? known.size : Math.min(Math.max(0, cellSize || 0), MAX_FILE_BYTES);
    }
    const sweep: string[] = [];
    for (const f of files.values()) {
      if (referenced.has(f.key)) {
        if (f.unref_since !== null) this.sql.exec("UPDATE _files SET unref_since = NULL WHERE key = ?", f.key);
        continue;
      }
      if (f.created_at > now - DAY_MS) bytes += f.size;
      if (f.unref_since === null) this.sql.exec("UPDATE _files SET unref_since = ? WHERE key = ?", now, f.key);
      else if (f.unref_since < now - 7 * DAY_MS) sweep.push(f.key);
    }
    return { bytes, sweep };
  }

  /** Files deleted from R2 after a sweep. */
  filesSwept(keys: string[]) {
    for (const k of keys) this.sql.exec("DELETE FROM _files WHERE key = ?", k);
  }

  /** Throws the plan's limit error when `n` more records do not fit in the base. */
  checkRoom(n: number) {
    const max = this.recordLimit?.();
    if (!max || n <= 0) return;
    const room = Math.max(0, max.limit - this.totalRows());
    if (n > room) throw limitError(`This plan allows ${max.limit.toLocaleString("en-US")} records per base; ${room.toLocaleString("en-US")} more can be added`, { key: "records", limit: max.limit, upgradeUrl: max.upgradeUrl });
  }

  /** Records in all tables of the base. */
  totalRows(): number {
    let n = 0;
    for (const t of this.c.tables.values()) n += this.one<{ n: number }>(`SELECT count(*) n FROM ${t.phys}`)!.n;
    return n;
  }

  rowCount(tableId: string): number {
    return this.one<{ n: number }>(`SELECT count(*) n FROM ${this.table(tableId).phys}`)!.n;
  }

  // ---------- schema: fields ----------

  private normalizeOptions(type: FieldType, o: FieldOptions): FieldOptions {
    const out: FieldOptions = {};
    switch (type) {
      case "button":
        out.label = String(o.label ?? "").trim().slice(0, 40) || "Run";
        if (o.color) out.color = String(o.color).slice(0, 20);
        if (o.automationId) out.automationId = String(o.automationId);
        break;
      case "number":
        if (o.precision !== undefined) out.precision = Math.max(0, Math.min(8, Math.round(Number(o.precision))));
        if (o.format) out.format = o.format;
        if (o.symbol) out.symbol = String(o.symbol).slice(0, 4);
        break;
      case "singleSelect":
      case "multiSelect":
        {
          const seen = new Set<string>();
          for (const c of o.choices ?? []) {
            const n = String(c?.name ?? "").trim();
            if (!n) continue;
            if (seen.has(n.toLowerCase())) throw new UserError(`The option "${n}" appears twice`);
            seen.add(n.toLowerCase());
          }
        }
        out.choices = (o.choices ?? []).filter(c => c && String(c.name ?? "").trim()).map((c, i) => ({
          id: isSafeId(c.id) ? c.id : newChoiceId(),
          name: String(c.name).trim(),
          color: c.color || COLORS[i % COLORS.length],
        }));
        break;
      case "date":
        out.includeTime = !!o.includeTime;
        break;
      case "user":
        out.multiple = !!o.multiple;
        break;
      case "link":
        Object.assign(out, { linkedTableId: o.linkedTableId, inverseFieldId: o.inverseFieldId, linkTable: o.linkTable, linkSide: o.linkSide });
        if (typeof o.dependsOn === "boolean") out.dependsOn = o.dependsOn;
        if (o.pathRole === "none" || o.pathRole === "dependency") out.pathRole = o.pathRole;
        break;
      case "pathLookup":
        out.targetTableId = typeof o.targetTableId === "string" ? o.targetTableId : undefined;
        out.pathDirection = o.pathDirection === "dependencies" ? "dependencies" : "dependents";
        out.excludeLinkFieldIds = Array.isArray(o.excludeLinkFieldIds) ? [...new Set(o.excludeLinkFieldIds.filter(x => typeof x === "string"))] : [];
        if (o.targetFilter?.conditions?.length) out.targetFilter = { conjunction: o.targetFilter.conjunction === "or" ? "or" : "and", conditions: o.targetFilter.conditions };
        if (o.maxDepth !== undefined && o.maxDepth !== null) {
          const d = Number(o.maxDepth);
          if (!Number.isInteger(d) || d < 1 || d > MAX_PATH_DEPTH) throw new UserError(`The depth must be a whole number from 1 to ${MAX_PATH_DEPTH}`);
          out.maxDepth = d;
        }
        break;
      case "lookup":
      case "rollup":
        out.linkFieldId = o.linkFieldId;
        out.targetFieldId = o.targetFieldId;
        if (type === "rollup") out.fn = o.fn ?? "sum";
        if (o.format) out.format = o.format;
        if (o.precision !== undefined) out.precision = o.precision;
        break;
      case "formula":
        out.formula = o.formula ?? "";
        if (o.format) out.format = o.format;
        if (o.precision !== undefined) out.precision = o.precision;
        break;
    }
    // Kept on any type, so a match survives a round trip through a type that cannot match.
    const m = o.match;
    if (m && typeof m.fieldId === "string") {
      out.match = { fieldId: m.fieldId };
      if (typeof m.dependsOn === "boolean") out.match.dependsOn = m.dependsOn;
      if (m.pathRole === "none" || m.pathRole === "dependency") out.match.pathRole = m.pathRole;
    }
    if (isAiOutputType(type) && o.ai) {
      try {
        out.ai = normalizeAi(o.ai);
      } catch (e) {
        throw new UserError(e instanceof Error ? e.message : String(e));
      }
    }
    return out;
  }

  /** Validates computed field configuration and fills derived options. */
  private prepareComputed(tableId: string, type: FieldType, options: FieldOptions, selfId: string): FieldOptions {
    if (options.ai) this.checkAi(tableId, options, selfId);
    if (type === "lookup" || type === "rollup") {
      const link = options.linkFieldId ? this.c.fields.get(options.linkFieldId) : undefined;
      if (!link || link.type !== "link" || link.tableId !== tableId) throw new UserError("Choose a link field in this table");
      const target = options.targetFieldId ? this.c.fields.get(options.targetFieldId) : undefined;
      if (!target || target.tableId !== link.options.linkedTableId) throw new UserError("Choose a field from the linked table");
      if (target.type === "pathLookup") throw new UserError("Path lookups cannot be looked up or rolled up");
      if (type === "rollup") options.resultType = rollupResultType(options.fn ?? "sum", target);
      else options.resultType = "array";
    }
    if (type === "pathLookup") this.checkPathLookup(tableId, options);
    if (type === "formula") {
      const refs = this.fieldRefs(this.fieldsOf(tableId).filter(f => f.id !== selfId));
      try {
        const comp = compileFormula(options.formula ?? "", refs);
        if (!comp.ast) throw new UserError("Formula is empty");
        options.formula = comp.stored;
        options.resultType = comp.resultType;
        // Reject cycles through other formulas.
        const seen = new Set<string>();
        const walk = (ids: string[]) => {
          for (const id of ids) {
            if (id === selfId) throw new UserError("Formula refers to itself");
            if (seen.has(id)) continue;
            seen.add(id);
            const c = this.c.compiled.get(id);
            if (c) walk(c.deps);
            // An AI field in the chain re-queues when its inputs change, so it closes a loop too.
            const ai = this.c.fields.get(id);
            if (ai?.options.ai) walk(aiDeps(ai));
          }
        };
        walk(comp.deps);
      } catch (e) {
        if (e instanceof FormulaError) throw new UserError(e.message);
        throw e;
      }
    }
    return options;
  }

  /** References of an AI field must be fields of its table; image fields must be attachments; no cycles. */
  private checkAi(tableId: string, options: FieldOptions, selfId: string) {
    const ai = options.ai!;
    const fields = this.fieldMap(tableId);
    for (const id of promptRefIds(ai.prompt)) {
      if (id === selfId) throw new UserError("An AI field cannot refer to itself");
      if (!fields.has(id)) throw new UserError("The prompt refers to a field that does not exist");
      if (fields.get(id)!.type === "pathLookup") throw new UserError("Prompts cannot refer to path lookups");
    }
    for (const id of ai.imageFieldIds ?? []) if (fields.get(id)?.type !== "attachment") throw new UserError("Image fields must be attachment fields");
    const others = this.fieldsOf(tableId).filter(f => f.options.ai && f.id !== selfId);
    if (selfId !== "fldPreview" && others.length >= AI_LIMITS.fieldsPerTable) throw new UserError("A table can have at most 20 AI fields");
    const seen = new Set<string>();
    const walk = (ids: string[]) => {
      for (const id of ids) {
        if (id === selfId) throw new UserError("AI fields cannot refer to each other in a circle");
        if (seen.has(id)) continue;
        seen.add(id);
        const f = this.c.fields.get(id);
        if (f) walk(this.inputsOf(f));
      }
    };
    walk(aiDeps({ options }));
  }

  /** A field as it would be saved, without saving it (AI preview). */
  draftField(tableId: string, input: { type: FieldType; options: FieldOptions }): Field {
    this.table(tableId);
    const options = this.prepareComputed(tableId, input.type, this.normalizeOptions(input.type, input.options ?? {}), "fldPreview");
    if (!options.ai) throw new UserError("Write a prompt and choose an AI service");
    return { id: "fldPreview", tableId, name: "Preview", type: input.type, options, ord: "" };
  }

  /** Fields whose changes recompute or re-queue this one: formula references, a lookup's or rollup's link and target, an AI field's prompt and images. */
  private inputsOf(f: Field): string[] {
    if (f.options.ai) return aiDeps(f);
    if (f.type === "formula") return this.c.compiled.get(f.id)?.deps ?? [];
    if (f.type === "lookup" || f.type === "rollup") return [f.options.linkFieldId, f.options.targetFieldId].filter((x): x is string => !!x);
    return [];
  }

  aiFields(tableId: string): Field[] {
    return this.fieldsOf(tableId).filter(f => !!f.options.ai);
  }

  allFields(): Field[] {
    return [...this.c.fields.values()];
  }

  /** Why an AI field cannot run, or null. The service is checked by the engine. */
  aiBroken(f: Field): string | null {
    return aiFieldProblem(f, this.fieldsOf(f.tableId));
  }

  /** A cell as text for prompts, the way the grid shows it. */
  displayText(tableId: string, row: Row, fieldId: string): string {
    const f = this.c.fields.get(fieldId);
    if (!f || f.tableId !== tableId) return "";
    const raw = f.type === "createdTime" ? row.createdAt : f.type === "modifiedTime" ? row.updatedAt : f.type === "autonumber" ? row.id : row.cells[f.id];
    return displayCell(f, raw, { userName: this.userName });
  }

  createField(tableId: string, input: FieldInput): { fieldId: string; schema: Schema } {
    this.table(tableId);
    const id = newFieldId();
    const name = this.uniqueFieldName(tableId, input.name?.trim() || "Field");
    let options = this.normalizeOptions(input.type, input.options ?? {});
    const last = this.one<{ o: string | null }>("SELECT max(ord) o FROM _fields WHERE table_id = ?", tableId)?.o ?? null;
    this.storage.transactionSync(() => {
      if (input.type === "link") options = this.createLinkPair(tableId, id, input.options?.linkedTableId, options);
      options = this.prepareComputed(tableId, input.type, options, id);
      if (options.match) this.checkMatch(id, input.type, options.match);
      this.sql.exec(
        "INSERT INTO _fields (id, table_id, name, type, options, description, ord) VALUES (?, ?, ?, ?, ?, ?, ?)",
        id, tableId, name, input.type, JSON.stringify(options), input.description ?? null, generateKeyBetween(last, null),
      );
      this.bumpVersion();
      this.syncKeys();
      if (input.type === "lookup" || input.type === "rollup" || input.type === "formula") this.enqueueJob("recompute", `Computing ${name}`, { tableId, fieldIds: [id], cursor: 0 }, this.rowCount(tableId));
    });
    this.runInlineJobs();
    return { fieldId: id, schema: this.schema() };
  }

  /** `dir` carries dependsOn and pathRole as given for the new field; the inverse gets the mirror values. */
  private createLinkPair(tableId: string, fieldId: string, linkedTableId: string | undefined, dir: FieldOptions = {}): FieldOptions {
    if (!linkedTableId || !this.c.tables.has(linkedTableId)) throw new UserError("Choose a table to link to");
    const lt = "l_" + this.nextSeq("link");
    this.sql.exec(`CREATE TABLE ${lt} (a INTEGER NOT NULL, b INTEGER NOT NULL, PRIMARY KEY (a, b)) WITHOUT ROWID`);
    this.sql.exec(`CREATE INDEX ${lt}_b ON ${lt} (b, a)`);
    const inverseId = newFieldId();
    const last = this.one<{ o: string | null }>("SELECT max(ord) o FROM _fields WHERE table_id = ?", linkedTableId)?.o ?? null;
    const invName = this.uniqueFieldName(linkedTableId, this.table(tableId).name);
    const invOptions: FieldOptions = { linkedTableId: tableId, inverseFieldId: fieldId, linkTable: lt, linkSide: "b", ...mirrorDirection(dir) };
    this.sql.exec(
      "INSERT INTO _fields (id, table_id, name, type, options, description, ord) VALUES (?, ?, ?, 'link', ?, NULL, ?)",
      inverseId, linkedTableId, invName, JSON.stringify(invOptions), generateKeyBetween(last, null),
    );
    return { linkedTableId, inverseFieldId: inverseId, linkTable: lt, linkSide: "a", ...directionOf(dir) };
  }

  updateField(fieldId: string, patch: { name?: string; type?: FieldType; options?: FieldOptions; description?: string }): Schema {
    const old = this.field(fieldId);
    const t = this.table(old.tableId);
    const type = patch.type ?? old.type;
    if (fieldId === t.primaryFieldId && NOT_PRIMARY.has(type)) throw new UserError("The primary field cannot be this type");
    this.storage.transactionSync(() => {
      if (patch.name !== undefined) this.sql.exec("UPDATE _fields SET name = ? WHERE id = ?", this.uniqueFieldName(old.tableId, patch.name.trim() || old.name, fieldId), fieldId);
      if (patch.description !== undefined) this.sql.exec("UPDATE _fields SET description = ? WHERE id = ?", patch.description, fieldId);
      if (patch.type === undefined && patch.options === undefined) {
        this.bumpVersion();
        return;
      }
      const typeChanged = type !== old.type;
      let options = this.normalizeOptions(type, { ...(typeChanged ? { match: old.options.match } : old.options), ...(patch.options ?? {}) });
      if (old.type === "link" && (typeChanged || (patch.options?.linkedTableId && patch.options.linkedTableId !== old.options.linkedTableId))) {
        this.dropLinkPair(old);
        if (type === "link") options = this.createLinkPair(old.tableId, fieldId, patch.options?.linkedTableId, options);
      } else if (type === "link" && typeChanged) {
        options = this.createLinkPair(old.tableId, fieldId, patch.options?.linkedTableId, options);
      } else if (type === "link") {
        options = { ...old.options, ...directionOf(options) };
        const inv = old.options.inverseFieldId ? this.c.fields.get(old.options.inverseFieldId) : undefined;
        if (inv && (options.dependsOn !== old.options.dependsOn || options.pathRole !== old.options.pathRole)) {
          // Both sides of a pair always agree on who depends on whom.
          const own = { dependsOn: options.dependsOn ?? old.options.linkSide === "a", pathRole: options.pathRole };
          options = { ...options, ...directionOf(own) };
          this.sql.exec("UPDATE _fields SET options = ? WHERE id = ?", JSON.stringify({ ...inv.options, dependsOn: undefined, pathRole: undefined, ...mirrorDirection(own) }), inv.id);
        }
      }
      options = this.prepareComputed(old.tableId, type, options, fieldId);
      // A match kept as it was may be broken on purpose (its column changed type); other edits still save.
      if (patch.options?.match && JSON.stringify(options.match) !== JSON.stringify(old.options.match)) this.checkMatch(fieldId, type, options.match!);
      this.sql.exec("UPDATE _fields SET type = ?, options = ? WHERE id = ?", type, JSON.stringify(options), fieldId);
      this.bumpVersion();
      const rows = this.rowCount(old.tableId);
      const name = this.field(fieldId).name;
      if (type === "lookup" || type === "rollup" || type === "formula") {
        const configChanged = typeChanged || JSON.stringify(options) !== JSON.stringify(old.options);
        if (configChanged) this.enqueueJob("recompute", `Computing ${name}`, { tableId: old.tableId, fieldIds: [fieldId], cursor: 0 }, rows);
      } else if (type === "pathLookup") {
        // Computed on read: nothing to rewrite.
      } else if (typeChanged || (type === "link" && old.type === "link")) {
        this.enqueueJob("convert", `Converting ${name}`, { tableId: old.tableId, fieldId, from: old, cursor: 0 }, rows);
      } else if ((type === "singleSelect" || type === "multiSelect") && options.choices) {
        // Removed choices: clear cells that still point at them.
        const kept = new Set(options.choices.map(c => c.id));
        if ((old.options.choices ?? []).some(c => !kept.has(c.id))) this.enqueueJob("convert", `Updating ${name}`, { tableId: old.tableId, fieldId, from: old, cursor: 0 }, rows);
        // Renamed choices change formula inputs and link titles.
        else if ((old.options.choices ?? []).some(c => options.choices!.find(n => n.id === c.id)?.name !== c.name)) this.enqueueDependents(old.tableId, fieldId, rows);
      } else if (type === "number" && JSON.stringify(options) !== JSON.stringify(old.options) && options.precision !== old.options.precision) {
        this.enqueueJob("convert", `Updating ${name}`, { tableId: old.tableId, fieldId, from: old, cursor: 0 }, rows);
      }
      // After the conversion jobs, so new keys are read from converted values.
      this.syncKeys();
    });
    this.runInlineJobs();
    return this.schema();
  }

  private checkMatch(fieldId: string, type: FieldType, m: MatchOptions) {
    if (!MATCH_TYPES.has(type)) throw new UserError("Only text, email, URL and phone fields can match another table");
    if (m.fieldId === fieldId) throw new UserError("A field cannot match itself");
    const target = this.c.fields.get(m.fieldId);
    if (!target || !MATCH_TYPES.has(target.type)) throw new UserError("Choose a text, email, URL or phone field to match");
  }

  /** Whether a field's key table holds every row yet. */
  keyReady(fieldId: string): boolean {
    const f = this.c.fields.get(fieldId);
    return !!f && !!this.c.keyed.get(f.tableId)?.some(k => k.fieldId === fieldId && k.ready);
  }

  /**
   * Brings key tables in line with the matches that work: drops the ones no longer needed (a broken match keeps no keys)
   * and creates the missing ones, filled by a job that runs inline for small tables. Called after every schema change.
   */
  private syncKeys() {
    const want = keyedFieldIds([...this.c.fields.values()]);
    const have = new Set(this.all<{ field_id: string }>("SELECT field_id FROM _keys").map(r => r.field_id));
    let changed = false;
    for (const id of have) {
      if (want.has(id)) continue;
      this.sql.exec(`DROP TABLE IF EXISTS ${keyTableOf(id)}`);
      this.sql.exec("DELETE FROM _keys WHERE field_id = ?", id);
      this.sql.exec("DELETE FROM _jobs WHERE kind = 'keys' AND json_extract(payload, '$.fieldId') = ?", id);
      changed = true;
    }
    for (const id of want) {
      if (have.has(id) || !isSafeId(id)) continue;
      const f = this.field(id);
      const kt = keyTableOf(id);
      this.sql.exec(`CREATE TABLE ${kt} (v TEXT NOT NULL, id INTEGER NOT NULL)`);
      this.sql.exec(`CREATE INDEX ${kt}_v ON ${kt} (v, id)`);
      this.sql.exec(`CREATE INDEX ${kt}_id ON ${kt} (id)`);
      this.sql.exec("INSERT INTO _keys (field_id, ready) VALUES (?, 0)", id);
      this.enqueueJob("keys", `Indexing ${f.name}`, { tableId: f.tableId, fieldId: id, cursor: 0 }, this.rowCount(f.tableId));
      changed = true;
    }
    if (changed) this.invalidate();
  }

  private enqueueDependents(tableId: string, fieldId: string, rows: number) {
    this.enqueueJob("touch", "Updating dependent fields", { tableId, fieldId, cursor: 0 }, rows);
  }

  private dropLinkPair(f: Field) {
    const inv = f.options.inverseFieldId ? this.c.fields.get(f.options.inverseFieldId) : undefined;
    if (inv) this.deleteFieldInner(inv.id, false);
    if (f.options.linkTable) this.sql.exec(`DROP TABLE IF EXISTS ${f.options.linkTable}`);
  }

  deleteField(fieldId: string): Schema {
    const f = this.field(fieldId);
    if (this.table(f.tableId).primaryFieldId === fieldId) throw new UserError("The primary field cannot be deleted");
    this.storage.transactionSync(() => {
      this.deleteFieldInner(fieldId, true);
      this.syncKeys();
    });
    this.runInlineJobs();
    return this.schema();
  }

  private deleteFieldInner(fieldId: string, withInverse: boolean) {
    const f = this.c.fields.get(fieldId);
    if (!f) return;
    if (f.type === "link" && withInverse) this.dropLinkPair(f);
    this.sql.exec("DELETE FROM _fields WHERE id = ?", fieldId);
    // Lookups / rollups through this field become broken; formulas referencing it stop computing.
    const removed = new Set([fieldId]);
    for (const other of this.c.fields.values()) {
      if (other.id === fieldId) continue;
      if ((other.type === "lookup" || other.type === "rollup") && (other.options.linkFieldId === fieldId || other.options.targetFieldId === fieldId)) {
        this.sql.exec("DELETE FROM _fields WHERE id = ?", other.id);
        removed.add(other.id);
      }
    }
    for (const v of this.c.views.values()) {
      for (const id of removed) if (this.c.fields.get(id)?.tableId === v.tableId) this.cleanViewConfig(v, id);
    }
    this.bumpVersion();
    // Keys of deleted fields stay in row JSON (ignored on read) so deletion is instant.
  }

  /** Removes every reference to a deleted field from a view's config. */
  private cleanViewConfig(v: View, fieldId: string) {
    {
      const cfg = v.config;
      let dirty = false;
      if (cfg.filters?.conditions.some(c => c.fieldId === fieldId)) { cfg.filters.conditions = cfg.filters.conditions.filter(c => c.fieldId !== fieldId); dirty = true; }
      if (cfg.sorts?.some(s => s.fieldId === fieldId)) { cfg.sorts = cfg.sorts.filter(s => s.fieldId !== fieldId); dirty = true; }
      if (cfg.groupFieldId === fieldId) { delete cfg.groupFieldId; dirty = true; }
      for (const k of ["coverFieldId", "dateFieldId", "endDateFieldId", "durationFieldId", "laneFieldId", "dependencyFieldId"] as const) if (cfg[k] === fieldId) { delete cfg[k]; dirty = true; }
      if (cfg.groups?.some(g => g.fieldId === fieldId)) { cfg.groups = cfg.groups.filter(g => g.fieldId !== fieldId); dirty = true; }
      if (cfg.summaries && fieldId in cfg.summaries) { delete cfg.summaries[fieldId]; dirty = true; }
      if (cfg.form?.fields?.some(x => x.fieldId === fieldId)) { cfg.form.fields = cfg.form.fields.filter(x => x.fieldId !== fieldId); dirty = true; }
      if (dirty) this.sql.exec("UPDATE _views SET config = ? WHERE id = ?", JSON.stringify(cfg), v.id);
    }
  }

  // ---------- schema: views ----------

  createView(tableId: string, input: { name: string; type: ViewType; config?: ViewConfig }): { viewId: string; schema: Schema } {
    this.table(tableId);
    const id = newViewId();
    const last = this.one<{ o: string | null }>("SELECT max(ord) o FROM _views WHERE table_id = ?", tableId)?.o ?? null;
    const config: ViewConfig = input.config ?? {};
    if (input.type === "kanban" && !config.groupFieldId) config.groupFieldId = this.fieldsOf(tableId).find(f => f.type === "singleSelect")?.id;
    if ((input.type === "calendar" || input.type === "timeline") && !config.dateFieldId) {
      const dates = this.fieldsOf(tableId).filter(isDateField);
      config.dateFieldId = (dates.find(f => f.type === "date") ?? dates[0])?.id;
    }
    if (input.type === "calendar") config.calendarMode ??= "month";
    if (input.type === "timeline") {
      if (!config.laneFieldId) config.laneFieldId = this.fieldsOf(tableId).find(f => f.type === "singleSelect")?.id;
      config.timelineScale ??= "week";
    }
    if (input.type === "form" && !config.form) config.form = { title: this.table(tableId).name, fields: this.fieldsOf(tableId).filter(f => !COMPUTED_TYPES.has(f.type)).map(f => ({ fieldId: f.id })) };
    this.sql.exec("INSERT INTO _views (id, table_id, name, type, config, ord) VALUES (?, ?, ?, ?, ?, ?)", id, tableId, input.name.trim() || "View", input.type, JSON.stringify(config), generateKeyBetween(last, null));
    this.bumpVersion();
    return { viewId: id, schema: this.schema() };
  }

  updateView(viewId: string, patch: { name?: string; config?: ViewConfig; replace?: boolean }): Schema {
    const v = this.view(viewId);
    if (patch.name !== undefined) this.sql.exec("UPDATE _views SET name = ? WHERE id = ?", patch.name.trim() || v.name, viewId);
    if (patch.config) {
      const merged: Record<string, unknown> = patch.replace ? { ...patch.config } : { ...v.config, ...patch.config };
      // A null clears a setting.
      for (const k of Object.keys(merged)) if (merged[k] === null) delete merged[k];
      const config = merged as ViewConfig;
      this.sql.exec("UPDATE _views SET config = ? WHERE id = ?", JSON.stringify(config), viewId);
    }
    this.bumpVersion();
    return this.schema();
  }

  deleteView(viewId: string): Schema {
    const v = this.view(viewId);
    if ([...this.c.views.values()].filter(x => x.tableId === v.tableId).length <= 1) throw new UserError("A table needs at least one view");
    this.sql.exec("DELETE FROM _views WHERE id = ?", viewId);
    this.bumpVersion();
    return this.schema();
  }

  // ---------- schema: dashboards ----------

  dashboard(id: string): Dashboard {
    const d = this.c.dashboards.get(id);
    if (!d) throw new UserError("Dashboard not found");
    return d;
  }

  schemaLike() {
    const c = this.c;
    return { tables: [...c.tables.values()], views: [...c.views.values()], fields: [...c.fields.values()] };
  }

  private checked(w: Widget, source = true): Widget {
    const err = checkWidget(w, this.schemaLike(), { source });
    if (err) throw new UserError(err);
    return w;
  }

  /** A new widget from caller input: its own id, default size, placed below the existing widgets unless positioned. */
  private newWidget(existing: Widget[], input: WidgetInput): Widget {
    const bottom = existing.reduce((m, w) => Math.max(m, w.y + w.h), 0);
    const clean = Object.fromEntries(Object.entries(input).filter(([k, v]) => k !== "id" && v !== null && v !== undefined));
    return this.checked({ title: "", x: 0, y: bottom, ...defaultSize(input.type), ...clean, id: newWidgetId() } as Widget);
  }

  private saveWidgets(id: string, widgets: Widget[]): Schema {
    if (widgets.length > MAX_WIDGETS) throw new UserError(`A dashboard holds at most ${MAX_WIDGETS} widgets`);
    this.sql.exec("UPDATE _dashboards SET config = ? WHERE id = ?", JSON.stringify({ widgets }), id);
    this.bumpVersion(true);
    return this.schema();
  }

  createDashboard(input: { name: string; widgets?: WidgetInput[] }): { dashboardId: string; schema: Schema } {
    const widgets: Widget[] = [];
    for (const w of input.widgets ?? []) widgets.push(this.newWidget(widgets, w));
    if (widgets.length > MAX_WIDGETS) throw new UserError(`A dashboard holds at most ${MAX_WIDGETS} widgets`);
    const id = newDashboardId();
    const last = this.one<{ o: string | null }>("SELECT max(ord) o FROM _dashboards")?.o ?? null;
    this.sql.exec("INSERT INTO _dashboards (id, name, ord, config) VALUES (?, ?, ?, ?)", id, input.name?.trim() || "Dashboard", generateKeyBetween(last, null), JSON.stringify({ widgets }));
    this.bumpVersion(true);
    return { dashboardId: id, schema: this.schema() };
  }

  updateDashboard(id: string, patch: { name?: string; ord?: string }): Schema {
    const d = this.dashboard(id);
    if (patch.name !== undefined) this.sql.exec("UPDATE _dashboards SET name = ? WHERE id = ?", patch.name.trim() || d.name, id);
    if (patch.ord !== undefined) this.sql.exec("UPDATE _dashboards SET ord = ? WHERE id = ?", String(patch.ord), id);
    this.bumpVersion(true);
    return this.schema();
  }

  deleteDashboard(id: string): Schema {
    this.dashboard(id);
    this.sql.exec("DELETE FROM _dashboards WHERE id = ?", id);
    this.bumpVersion(true);
    return this.schema();
  }

  addWidget(dashboardId: string, input: WidgetInput): { widgetId: string; schema: Schema } {
    const d = this.dashboard(dashboardId);
    const w = this.newWidget(d.widgets, input);
    return { widgetId: w.id, schema: this.saveWidgets(d.id, [...d.widgets, w]) };
  }

  /** Merges a patch into one widget; other widgets are untouched, so editors working on different widgets do not collide. */
  updateWidget(dashboardId: string, widgetId: string, patch: WidgetPatch): Schema {
    const d = this.dashboard(dashboardId);
    const i = d.widgets.findIndex(w => w.id === widgetId);
    if (i < 0) throw new UserError("Widget not found");
    const next: Record<string, unknown> = { ...d.widgets[i] };
    for (const [k, v] of Object.entries(patch ?? {})) {
      if (k === "id") continue;
      if (v === null) delete next[k];
      else next[k] = v;
    }
    const w = this.checked(next as unknown as Widget, SOURCE_KEYS.some(k => k in (patch ?? {})));
    return this.saveWidgets(d.id, d.widgets.map((x, j) => (j === i ? w : x)));
  }

  removeWidget(dashboardId: string, widgetId: string): Schema {
    const d = this.dashboard(dashboardId);
    return this.saveWidgets(d.id, d.widgets.filter(w => w.id !== widgetId));
  }

  /** Moves and resizes widgets; only positions change, and ids no longer on the dashboard are ignored. */
  setLayout(dashboardId: string, items: LayoutItemInput[]): Schema {
    const d = this.dashboard(dashboardId);
    const pos = new Map((Array.isArray(items) ? items : []).map(p => [p.id, p]));
    const widgets = d.widgets.map(w => {
      const p = pos.get(w.id);
      return p ? this.checked({ ...w, x: p.x, y: p.y, w: p.w, h: p.h }, false) : w;
    });
    return this.saveWidgets(d.id, widgets);
  }


  // ---------- batch jobs ----------

  enqueueJob(kind: string, label: string, payload: unknown, total: number) {
    this.sql.exec("INSERT INTO _jobs (kind, label, payload, total, created_at) VALUES (?, ?, ?, ?, ?)", kind, label, JSON.stringify(payload), total, now());
    this.jobsQueued = true;
  }

  jobsQueued = false;

  hasJobs(): boolean {
    return !!this.one("SELECT 1 x FROM _jobs LIMIT 1");
  }

  /**
   * Fills a key table from existing rows, one batch per step. Rows written meanwhile keep their own keys through
   * `flush`; a batch replaces the keys of its rows, so each record ends with exactly one up-to-date key.
   */
  private keysJobStep(jobId: number, p: { tableId: string; fieldId: string; cursor: number }): { result?: MutationResult; finished?: { tableId?: string }; more: boolean } {
    const kt = keyTableOf(p.fieldId);
    const rows = this.all<{ id: number; v: string | null }>(`SELECT id, json_extract(data, '$.${p.fieldId}') v FROM ${this.table(p.tableId).phys} WHERE id > ? ORDER BY id LIMIT ?`, p.cursor, JOB_BATCH);
    this.storage.transactionSync(() => {
      for (const r of rows) {
        this.sql.exec(`DELETE FROM ${kt} WHERE id = ?`, r.id);
        const v = matchKey(r.v);
        if (v) this.sql.exec(`INSERT INTO ${kt} (v, id) VALUES (?, ?)`, v, r.id);
      }
      if (rows.length) this.sql.exec("UPDATE _jobs SET payload = ?, done = done + ? WHERE id = ?", JSON.stringify({ ...p, cursor: rows[rows.length - 1].id }), rows.length, jobId);
      if (rows.length < JOB_BATCH) {
        this.sql.exec("DELETE FROM _jobs WHERE id = ?", jobId);
        this.sql.exec("UPDATE _keys SET ready = 1 WHERE field_id = ?", p.fieldId);
      }
    });
    if (rows.length === JOB_BATCH) return { more: true };
    this.invalidate();
    return { result: { changes: [], deleted: [], unfilled: this.tablesUsingKeys(p.fieldId) }, more: this.hasJobs() };
  }

  /** Tables whose path lookups or matched cells read a key table: they reload once it is filled. */
  private tablesUsingKeys(fieldId: string): string[] {
    const out = new Set(this.c.matches.filter(m => m.source.id === fieldId || m.target.id === fieldId).map(m => m.source.tableId));
    const kt = keyTableOf(fieldId);
    for (const f of this.c.fields.values()) {
      const plan = f.type === "pathLookup" ? this.pathPlan(f) : null;
      if (plan && [...plan.forward.values()].some(steps => steps.some(st => st.keys?.at === kt || st.keys?.to === kt))) out.add(f.tableId);
    }
    return [...out];
  }

  /** Small tables are processed inside the request; large ones are left for the alarm. */
  private runInlineJobs() {
    let guard = 0;
    while (guard++ < 50) {
      const job = this.one<{ id: number; total: number; kind: string }>("SELECT id, total, kind FROM _jobs ORDER BY id LIMIT 1");
      if (!job || job.kind === "airtable" || job.total > INLINE_JOB_ROWS) return;
      this.runJobStep();
    }
  }

  /** Runs one batch of the oldest job. Returns rows changed, so the caller can broadcast. */
  runJobStep(): { result?: MutationResult; finished?: { tableId?: string }; more: boolean } {
    const job = this.one<{ id: number; kind: string; payload: string; done: number }>("SELECT id, kind, payload, done FROM _jobs ORDER BY id LIMIT 1");
    if (!job || job.kind === "airtable") return { more: !!job };
    const p = JSON.parse(job.payload) as { tableId: string; fieldIds?: string[]; fieldId?: string; from?: Field; cursor: number };
    if (!this.c.tables.has(p.tableId)) {
      this.sql.exec("DELETE FROM _jobs WHERE id = ?", job.id);
      return { more: this.hasJobs() };
    }
    const t = this.table(p.tableId);
    if (job.kind === "keys") return this.keysJobStep(job.id, p as { tableId: string; fieldId: string; cursor: number });
    const ids = this.all<{ id: number }>(`SELECT id FROM ${t.phys} WHERE id > ? ORDER BY id LIMIT ?`, p.cursor, JOB_BATCH).map(r => r.id);
    let result: MutationResult | undefined;
    if (ids.length) {
      result = this.run(undefined, tx => {
        this.prefetch(tx, p.tableId, ids);
        if (job.kind === "recompute") {
          const fids = (p.fieldIds ?? []).filter(id => this.c.fields.has(id));
          for (const id of ids) for (const fid of fids) this.markChanged(tx, p.tableId, id, fid, true);
        } else if (job.kind === "convert") {
          this.convertBatch(tx, p.tableId, ids, p.from!, p.fieldId!);
        } else if (job.kind === "touch") {
          for (const id of ids) this.markChanged(tx, p.tableId, id, p.fieldId!);
        } else if (job.kind === "relink") {
          const link = this.c.fields.get(p.fieldId!);
          if (link?.options.linkedTableId) {
            const lt = link.options.linkedTableId;
            for (const id of ids) {
              const rec = this.load(tx, p.tableId, id)!;
              const cell = (Array.isArray(rec.data[link.id]) ? rec.data[link.id] : []) as LinkValue[];
              if (!cell.length) continue;
              this.prefetch(tx, lt, cell.map(v => v.id));
              const next = cell.map(v => {
                const target = this.load(tx, lt, v.id);
                return { id: v.id, t: target ? this.primaryText(lt, target) : v.t };
              });
              if (!same(next, cell)) {
                rec.data[link.id] = next;
                this.markChanged(tx, p.tableId, id, link.id);
              }
            }
          }
        }
      });
      p.cursor = ids[ids.length - 1];
      this.sql.exec("UPDATE _jobs SET payload = ?, done = done + ? WHERE id = ?", JSON.stringify(p), ids.length, job.id);
    }
    if (ids.length < JOB_BATCH) {
      this.sql.exec("DELETE FROM _jobs WHERE id = ?", job.id);
      return { result, finished: { tableId: p.tableId }, more: this.hasJobs() };
    }
    return { result, more: true };
  }

  peekJob(): { id: number; kind: string; payload: string } | undefined {
    return this.one("SELECT id, kind, payload FROM _jobs ORDER BY id LIMIT 1");
  }

  private convertBatch(tx: Tx, tableId: string, ids: number[], from: Field, fieldId: string) {
    tx.softLinks = true;
    const to = this.c.fields.get(fieldId);
    if (!to) return;
    const ctx = this.coerceCtx(tx, true);
    for (const id of ids) {
      const rec = this.load(tx, tableId, id);
      if (!rec) continue;
      const raw = rec.data[fieldId];
      if (raw === undefined && to.type !== "link") continue;
      let input: unknown;
      if (from.type === to.type && (to.type === "singleSelect" || to.type === "multiSelect")) input = raw;
      else if (from.type === "link" && to.type === "link") input = [];
      else if (to.type === "multiSelect" || to.type === "link" || (to.type === "user" && to.options.multiple)) {
        const fv = formulaValue(from, raw, { userName: this.userName });
        input = Array.isArray(fv) ? fv.map(x => (x === null ? "" : String(x))) : fv;
      } else if (to.type === "number" || to.type === "checkbox" || to.type === "date") {
        input = formulaValue(from, raw, { userName: this.userName });
      } else {
        input = displayCell(from, raw, { userName: this.userName });
      }
      if (to.type === "link") {
        // Data still holds the old cell; clear it before rebuilding links from text.
        delete rec.data[fieldId];
        const next = (coerceCell(to, input, ctx) as LinkValue[] | undefined) ?? [];
        this.setLinks(tx, tableId, rec, to, next);
        continue;
      }
      const next = coerceCell(to, input, ctx);
      if (!same(next, raw)) {
        if (next === undefined) delete rec.data[fieldId];
        else rec.data[fieldId] = next;
        this.markChanged(tx, tableId, id, fieldId);
      }
    }
  }

  /** Rows touched per table, to decide between pushing rows and asking clients to reload. */
  static broadcastPlan(result: MutationResult): { rows: { tableId: string; rows: Row[] }[]; reload: string[] } {
    const rows: { tableId: string; rows: Row[] }[] = [];
    const reload: string[] = [];
    for (const c of result.changes) {
      if (c.rows.length > BROADCAST_LIMIT) reload.push(c.tableId);
      else rows.push(c);
    }
    return { rows, reload };
  }
}

/** The grid group key of a field as SQL: a day for values with a time, 0 or 1 for checkboxes, the stored value otherwise. */
function groupKeyExpr(f: Field, offsetMinutes: number): string {
  const shift = `'${offsetMinutes >= 0 ? "+" : "-"}${Math.abs(Math.trunc(offsetMinutes))} minutes'`;
  if (f.type === "createdTime") return `strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', ${shift})`;
  if (f.type === "modifiedTime") return `strftime('%Y-%m-%d', updated_at / 1000, 'unixepoch', ${shift})`;
  if (groupsByDay(f)) return `strftime('%Y-%m-%d', ${valueExpr(f)}, ${shift})`;
  if (f.type === "checkbox") return `CASE WHEN ${valueExpr(f)} THEN 1 ELSE 0 END`;
  return valueExpr(f);
}

function emptyValue(v: Value): unknown {
  if (v === null || v === "" || (Array.isArray(v) && v.length === 0)) return undefined;
  if (typeof v === "number" && !Number.isFinite(v)) return "#ERROR!";
  return v;
}

function valueTypeOf(f: Field): FieldRef["type"] {
  switch (f.type) {
    case "number":
    case "autonumber":
      return "number";
    case "date":
    case "createdTime":
    case "modifiedTime":
      return "date";
    case "checkbox":
      return "boolean";
    case "multiSelect":
    case "link":
    case "lookup":
    case "attachment":
      return "array";
    case "formula":
    case "rollup":
      return f.options.resultType ?? "text";
    default:
      return "text";
  }
}

function rollupResultType(fn: string, target: Field): FieldOptions["resultType"] {
  if (["sum", "avg", "count", "counta", "countall"].includes(fn)) return "number";
  if (fn === "min" || fn === "max") return valueTypeOf(target) === "date" ? "date" : "number";
  if (fn === "and" || fn === "or") return "boolean";
  if (fn === "arrayunique" || fn === "arraycompact") return "array";
  return "text";
}

/** The direction settings of a link field's options, without empty keys. */
function directionOf(o: FieldOptions): FieldOptions {
  const out: FieldOptions = {};
  if (typeof o.dependsOn === "boolean") out.dependsOn = o.dependsOn;
  if (o.pathRole) out.pathRole = o.pathRole;
  return out;
}

/** The inverse field's direction settings for the given ones of its pair. */
function mirrorDirection(o: FieldOptions): FieldOptions {
  const out: FieldOptions = {};
  if (typeof o.dependsOn === "boolean") out.dependsOn = !o.dependsOn;
  if (o.pathRole) out.pathRole = o.pathRole;
  return out;
}

function unprocessable(message: string): UserError {
  const e = new UserError(message);
  e.status = 422;
  return e;
}

export function defaultChoices(names: string[]): Choice[] {
  return names.map((name, i) => ({ id: newChoiceId(), name, color: COLORS[i % COLORS.length] }));
}
