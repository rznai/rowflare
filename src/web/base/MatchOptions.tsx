// Field dialog settings for value matches: a text-like field whose values name records of another table.
import type { Field, FieldOptions } from "../../shared/types";
import { MATCH_TYPES, matchProblem } from "../../shared/matches";
import type { BaseClient } from "./client";

type Set = (p: Partial<FieldOptions>) => void;

export function MatchOptions({ client, tableId, field, opts, set }: { client: BaseClient; tableId: string; field?: Field; opts: FieldOptions; set: Set }) {
  const m = opts.match;
  const fields = client.schema.fields;
  const target = m ? fields.find(f => f.id === m.fieldId) : undefined;
  const matchTable = target?.tableId ?? "";
  const candidates = (tid: string) => client.fields(tid).filter((f: Field) => MATCH_TYPES.has(f.type) && f.id !== field?.id);
  const here = client.table(tableId)?.name ?? "this table";
  const there = target ? client.table(target.tableId)?.name ?? "the other table" : "the other table";
  const problem = m && field ? matchProblem({ ...field, options: { ...field.options, match: m } }, fields) : null;
  const depends = m?.dependsOn ?? true;
  const role = m?.pathRole === "none" ? "none" : depends ? "depends" : "dependedOn";
  const pickTable = (tid: string) => {
    if (!tid) return set({ match: undefined });
    const first = candidates(tid).find(f => client.table(tid)?.primaryFieldId === f.id) ?? candidates(tid)[0];
    set({ match: first ? { fieldId: first.id } : undefined });
  };
  return (
    <details className="match-options" open={!!m}>
      <summary className="muted small">Match values in another table</summary>
      <div className="stack">
        <p className="muted small">Each value opens the record of the other table with the same value (ignoring case and spaces), without a link. Path lookups walk through it like a link.</p>
        <div className="row">
          <select className="input" aria-label="Match table" value={matchTable} onChange={e => pickTable(e.target.value)}>
            <option value="">None</option>
            {client.schema.tables.filter(t => candidates(t.id).length).map(t => <option key={t.id} value={t.id}>{t.name}{t.id === tableId ? " (this table)" : ""}</option>)}
          </select>
          {target && (
            <select className="input" aria-label="Match field" value={m!.fieldId} onChange={e => set({ match: { ...m!, fieldId: e.target.value } })}>
              {candidates(target.tableId).map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          )}
        </div>
        {m && !target && <div className="err small">The column it matched was deleted.</div>}
        {problem && target && <div className="err small">{problem}.</div>}
        {target && (
          <div>
            <label className="field-label">Dependency</label>
            <select
              className="input"
              aria-label="Match dependency"
              value={role}
              onChange={e => {
                const v = e.target.value;
                set({ match: { fieldId: m!.fieldId, ...(v === "none" ? { pathRole: "none" as const } : { dependsOn: v === "depends" }) } });
              }}
            >
              <option value="depends">This record depends on the matched record</option>
              <option value="dependedOn">The matched record depends on this record</option>
              <option value="none">Not a dependency</option>
            </select>
            <p className="muted small">
              {role === "none"
                ? "Path lookups never walk through this match."
                : role === "depends"
                  ? `A ${here} record needs the ${there} record with its value. Path lookups follow this direction.`
                  : `A ${there} record needs the ${here} records with its value. Path lookups follow this direction.`}
            </p>
          </div>
        )}
        {m && !target && <button type="button" className="link-btn small" onClick={() => set({ match: undefined })}>Remove</button>}
      </div>
    </details>
  );
}
