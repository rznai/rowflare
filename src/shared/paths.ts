// Table-level graph of link dependencies, used by path lookup fields on the server and in the field editor.
// Only metadata is read here; the record-level search lives in src/worker/base/reach.ts.
import { keyTableOf, validMatches } from "./matches";
import type { Field, PathDirection } from "./types";

/** One link pair or value match as a directed table-to-table step, oriented in the direction a path lookup walks. */
export interface PathEdge {
  /** The link field on the `from` side; the walk leaves a record through this field. For a match, the matching field. */
  fieldId: string;
  /** The other field of the pair. */
  inverseId?: string;
  /** Empty for a match. */
  linkTable: string;
  from: string;
  to: string;
  /** Pair-table column holding `from` records, and the one holding `to` records. */
  fromCol: "a" | "b";
  toCol: "a" | "b";
  /** For a match: the key tables of the field on the `from` side and of the one on the `to` side. */
  keys?: { from: string; to: string };
}

export const MAX_PATH_DEPTH = 64;

/** Whether records of this link field's table depend on the records it links to. Older links carry no flag: the side the link was created from depends. */
export function linkDependsOn(f: Pick<Field, "options">): boolean {
  return f.options.dependsOn ?? f.options.linkSide === "a";
}

/** Every link pair and value match that takes part in paths, as one edge in the walking direction. */
export function pathEdges(fields: Field[], direction: PathDirection): PathEdge[] {
  const out: PathEdge[] = [];
  const byId = new Map(fields.map(f => [f.id, f]));
  const seen = new Set<string>();
  for (const f of fields) {
    if (f.type !== "link" || !f.options.linkTable || !f.options.linkedTableId || !f.options.linkSide) continue;
    if (seen.has(f.options.linkTable)) continue;
    seen.add(f.options.linkTable);
    if (f.options.pathRole === "none") continue;
    const inv = f.options.inverseFieldId ? byId.get(f.options.inverseFieldId) : undefined;
    // Column a of the pair table holds records of the "a" field's table.
    const isA = f.options.linkSide === "a";
    const side = { a: isA ? f : inv, b: isA ? inv : f };
    const table = { a: isA ? f.tableId : f.options.linkedTableId, b: isA ? f.options.linkedTableId : f.tableId };
    const aDepends = side.a ? linkDependsOn(side.a) : !linkDependsOn(f);
    // Dependent to dependency, flipped for "dependents".
    const fromCol: "a" | "b" = aDepends === (direction === "dependencies") ? "a" : "b";
    const toCol = fromCol === "a" ? "b" : "a";
    const fromField = side[fromCol] ?? f;
    out.push({ fieldId: fromField.id, inverseId: side[toCol]?.id, linkTable: f.options.linkTable, from: table[fromCol], to: table[toCol], fromCol, toCol });
  }
  for (const { source, target } of validMatches(fields)) {
    const m = source.options.match!;
    if (m.pathRole === "none") continue;
    // Like a link created on the matching table: its records depend on the records they match.
    const forward = (m.dependsOn ?? true) === (direction === "dependencies");
    const [from, to] = forward ? [source, target] : [target, source];
    out.push({ fieldId: source.id, linkTable: "", from: from.tableId, to: to.tableId, fromCol: "a", toCol: "a", keys: { from: keyTableOf(from.id), to: keyTableOf(to.id) } });
  }
  return out;
}

/** Tables a walk from `source` can reach in at least one step. */
export function reachableTables(fields: Field[], source: string, direction: PathDirection): Set<string> {
  const edges = pathEdges(fields, direction);
  const out = new Set<string>();
  const queue = [source];
  while (queue.length) {
    const t = queue.shift()!;
    for (const e of edges) {
      if (e.from !== t || out.has(e.to)) continue;
      out.add(e.to);
      queue.push(e.to);
    }
  }
  return out;
}

/**
 * Edges that lie on some path from `source` to `target`, minus excluded pairs. Computed from the schema each time,
 * so a link added later that connects the two tables is used without editing the field.
 */
export function allowedEdges(fields: Field[], source: string, target: string, direction: PathDirection, exclude: string[] = []): PathEdge[] {
  const ex = new Set(exclude);
  const edges = pathEdges(fields, direction).filter(e => !ex.has(e.fieldId) && !(e.inverseId && ex.has(e.inverseId)));
  const walk = (start: string, next: (e: PathEdge) => [string, string]) => {
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length) {
      const t = queue.shift()!;
      for (const e of edges) {
        const [at, to] = next(e);
        if (at !== t || seen.has(to)) continue;
        seen.add(to);
        queue.push(to);
      }
    }
    return seen;
  };
  const fromSource = walk(source, e => [e.from, e.to]);
  const toTarget = walk(target, e => [e.to, e.from]);
  return edges.filter(e => fromSource.has(e.from) && toTarget.has(e.to));
}

/** Why a path lookup cannot produce values, or null. */
export function pathFieldProblem(f: Field, fields: Field[], tableIds: Set<string>): string | null {
  const o = f.options;
  if (!o.targetTableId || !tableIds.has(o.targetTableId)) return "Its target table was deleted";
  if (!allowedEdges(fields, f.tableId, o.targetTableId, o.pathDirection ?? "dependents", o.excludeLinkFieldIds).length) return "No links lead to its target table any more";
  const byId = new Map(fields.map(x => [x.id, x]));
  for (const c of o.targetFilter?.conditions ?? []) {
    const t = byId.get(c.fieldId);
    // Dropping the condition would collect records it was meant to leave out.
    if (!t || t.tableId !== o.targetTableId || t.type === "pathLookup") return "Its target conditions refer to a field that was deleted or changed";
  }
  return null;
}
