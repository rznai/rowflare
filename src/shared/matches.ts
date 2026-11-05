// Value matches: a text-like field set to match a field of another table connects records whose values are equal,
// without a link. Path lookups walk them like links; the worker keeps one key table per field taking part.
import type { Field, FieldType } from "./types";

export const MATCH_TYPES: ReadonlySet<FieldType> = new Set(["text", "email", "url", "phone"]);

/** The value compared on both sides: trimmed and lowercased. Blank values match nothing. */
export function matchKey(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const k = v.trim().toLowerCase();
  return k ? k : null;
}

/** Why a field's match connects nothing, or null (also null when the field has no match). */
export function matchProblem(f: Field, fields: Field[]): string | null {
  const m = f.options.match;
  if (!m) return null;
  if (!MATCH_TYPES.has(f.type)) return "This column is no longer text";
  if (m.fieldId === f.id) return "A column cannot match itself";
  const target = fields.find(x => x.id === m.fieldId);
  if (!target) return "Its column was deleted";
  if (!MATCH_TYPES.has(target.type)) return "Its column is no longer text";
  return null;
}

/** Fields with a match that works, and the fields they match. */
export function validMatches(fields: Field[]): { source: Field; target: Field }[] {
  const byId = new Map(fields.map(f => [f.id, f]));
  const out: { source: Field; target: Field }[] = [];
  for (const f of fields) if (f.options.match && !matchProblem(f, fields)) out.push({ source: f, target: byId.get(f.options.match.fieldId)! });
  return out;
}

/** Every field that needs a key table: both sides of each working match. */
export function keyedFieldIds(fields: Field[]): Set<string> {
  const out = new Set<string>();
  for (const { source, target } of validMatches(fields)) out.add(source.id).add(target.id);
  return out;
}

export function keyTableOf(fieldId: string): string {
  return "k_" + fieldId;
}
