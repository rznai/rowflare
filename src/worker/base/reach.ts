// Record-level search for path lookup fields: which records a record reaches through link pairs, in one direction.
// Nothing is materialized. The table-level edges come from src/shared/paths.ts; here they are walked layer by layer,
// one query per pair table (or pair of key tables, for a value match) and layer, so the walk can stop at its limits and
// remember how each record was reached.
import { MAX_PATH_DEPTH, type PathEdge } from "../../shared/paths";

export interface ReachLimits {
  /** Records one walk may visit. */
  nodes: number;
  /** Milliseconds a request may spend walking. The Durable Object clock stands still during SQL, so `nodes` is the real guard in production. */
  ms: number;
  depth: number;
}

export const REACH_LIMITS: ReachLimits = { nodes: 200_000, ms: 250, depth: MAX_PATH_DEPTH };

export interface ReachHost {
  all<T>(q: string, ...b: unknown[]): T[];
}

interface Step {
  linkTable: string;
  /** Column holding the record the walk is at, and the column holding where it goes. */
  at: "a" | "b";
  to: "a" | "b";
  next: string;
  fieldId: string;
  /** For a value match: the key table of the side the walk is at, and of the side it goes to. */
  keys?: { at: string; to: string };
}

export interface PathPlan {
  source: string;
  target: string;
  forward: Map<string, Step[]>;
  backward: Map<string, Step[]>;
  maxDepth?: number;
  /** A key table on the way is still being filled, so results may be missing. */
  pending?: boolean;
}

export function planOf(edges: PathEdge[], source: string, target: string, maxDepth?: number): PathPlan {
  const forward = new Map<string, Step[]>();
  const backward = new Map<string, Step[]>();
  const add = (m: Map<string, Step[]>, k: string, s: Step) => (m.get(k) ?? m.set(k, []).get(k)!).push(s);
  for (const e of edges) {
    if (e.keys) {
      if (![e.keys.from, e.keys.to].every(k => /^k_[A-Za-z0-9_]+$/.test(k))) continue;
      add(forward, e.from, { linkTable: "", at: "a", to: "a", next: e.to, fieldId: e.fieldId, keys: { at: e.keys.from, to: e.keys.to } });
      add(backward, e.to, { linkTable: "", at: "a", to: "a", next: e.from, fieldId: e.fieldId, keys: { at: e.keys.to, to: e.keys.from } });
      continue;
    }
    if (!/^l_\d+$/.test(e.linkTable)) continue;
    add(forward, e.from, { linkTable: e.linkTable, at: e.fromCol, to: e.toCol, next: e.to, fieldId: e.fieldId });
    add(backward, e.to, { linkTable: e.linkTable, at: e.toCol, to: e.fromCol, next: e.from, fieldId: e.fieldId });
  }
  return { source, target, forward, backward, maxDepth };
}

export interface Hop {
  tableId: string;
  id: number;
  /** The link field the walk left the previous record through. */
  fieldId?: string;
}

export interface Walk {
  /** Records reached in at least one step, by table. The start records are included only when a loop leads back to them. */
  reached: Map<string, Set<number>>;
  /** A limit stopped the walk before it was finished. */
  truncated: boolean;
  /** How each record was first reached, when asked for. */
  parents?: Map<string, Hop & { prev: string }>;
}

const key = (tableId: string, id: number) => tableId + ":" + id;

export class Reach {
  private adjacency = new Map<string, number[]>();
  private deadline: number;
  /** Records visited by every walk of this read together, so a page of rows cannot multiply the limit. */
  private spent = 0;

  constructor(private host: ReachHost, private limits: ReachLimits = REACH_LIMITS, private cacheAdjacency = true) {
    this.deadline = Date.now() + limits.ms;
  }

  /**
   * Breadth-first walk from `start` (records of one or more tables) along the plan's steps, or against them with `backward`.
   * `stopAt` ends the walk as soon as that record is reached (used to explain one result).
   */
  walk(plan: PathPlan, start: Map<string, number[]>, opts: { backward?: boolean; parents?: boolean; stopAt?: string } = {}): Walk {
    const steps = opts.backward ? plan.backward : plan.forward;
    const reached = new Map<string, Set<number>>();
    const parents = opts.parents ? new Map<string, Hop & { prev: string }>() : undefined;
    const depthCap = Math.min(plan.maxDepth ?? this.limits.depth, this.limits.depth);
    let frontier = start;
    for (let depth = 0; frontier.size; depth++) {
      if (depth >= depthCap) {
        // A depth the field asked for is an answer; the engine's own cap is, only if a record is left unvisited one step on.
        const capped = depthCap === this.limits.depth && plan.maxDepth === undefined;
        const more = capped && [...frontier].some(([t, ids]) => (steps.get(t) ?? []).some(step => this.neighbors(step, ids).some(([, to]) => !reached.get(step.next)?.has(to))));
        return { reached, truncated: more, parents };
      }
      const next = new Map<string, number[]>();
      for (const [tableId, ids] of frontier) {
        for (const step of steps.get(tableId) ?? []) {
          const seen = reached.get(step.next) ?? reached.set(step.next, new Set()).get(step.next)!;
          for (const [from, to] of this.neighbors(step, ids)) {
            if (seen.has(to)) continue;
            seen.add(to);
            (next.get(step.next) ?? next.set(step.next, []).get(step.next)!).push(to);
            const k = key(step.next, to);
            parents?.set(k, { tableId: step.next, id: to, fieldId: step.fieldId, prev: key(tableId, from) });
            if (opts.stopAt === k) return { reached, truncated: false, parents };
            if (++this.spent > this.limits.nodes) return { reached, truncated: true, parents };
          }
          if (Date.now() > this.deadline) return { reached, truncated: true, parents };
        }
      }
      frontier = next;
    }
    return { reached, truncated: false, parents };
  }

  /** Pairs (record the walk is at, record it moves to) for one step. */
  private neighbors(step: Step, ids: number[]): [number, number][] {
    const out: [number, number][] = [];
    // A value match pairs records whose keys are equal, through the value index of the key table it goes to.
    const sql = step.keys
      ? `SELECT s.id k, t.id v FROM ${step.keys.at} s JOIN ${step.keys.to} t ON t.v = s.v WHERE s.id IN (SELECT value FROM json_each(?))`
      : `SELECT ${step.at} k, ${step.to} v FROM ${step.linkTable} WHERE ${step.at} IN (SELECT value FROM json_each(?))`;
    if (!this.cacheAdjacency) {
      for (const r of this.host.all<{ k: number; v: number }>(sql, JSON.stringify(ids))) out.push([r.k, r.v]);
      return out;
    }
    const prefix = step.keys ? `${step.keys.at}>${step.keys.to}:` : `${step.linkTable}:${step.at}:`;
    const missing = ids.filter(id => !this.adjacency.has(prefix + id));
    if (missing.length) {
      for (const id of missing) this.adjacency.set(prefix + id, []);
      for (const r of this.host.all<{ k: number; v: number }>(sql, JSON.stringify(missing))) this.adjacency.get(prefix + r.k)!.push(r.v);
    }
    for (const id of ids) for (const v of this.adjacency.get(prefix + id)!) out.push([id, v]);
    return out;
  }
}

/** The hops from the start record to `targetKey`, start first, from a walk made with `parents`. */
export function hopsTo(w: Walk, startKey: string, targetKey: string): Hop[] | null {
  const out: Hop[] = [];
  let k = targetKey;
  const guard = new Set<string>();
  while (true) {
    const p = w.parents?.get(k);
    if (!p || guard.has(k)) return null;
    guard.add(k);
    out.unshift({ tableId: p.tableId, id: p.id, fieldId: p.fieldId });
    if (p.prev === startKey) break;
    k = p.prev;
  }
  const [t, id] = [startKey.slice(0, startKey.lastIndexOf(":")), Number(startKey.slice(startKey.lastIndexOf(":") + 1))];
  out.unshift({ tableId: t, id });
  return out;
}

export { key as nodeKey };
