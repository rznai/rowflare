// Field dialog settings for path lookups (target table, direction, target conditions, links used) and for the
// dependency direction of link fields, which path lookups follow.
import { useMemo } from "react";
import type { Field, FieldOptions, FilterSpec, PathDirection } from "../../shared/types";
import { allowedEdges, MAX_PATH_DEPTH, reachableTables } from "../../shared/paths";
import type { BaseClient } from "./client";
import { FilterEditor } from "./FilterEditor";

type Set = (p: Partial<FieldOptions>) => void;

export function LinkDependency({ client, tableId, opts, set }: { client: BaseClient; tableId: string; opts: FieldOptions; set: Set }) {
  // A new link is created from this table, which makes it the dependent side unless the user says otherwise.
  const depends = opts.dependsOn ?? (opts.linkSide ? opts.linkSide === "a" : true);
  const value = opts.pathRole === "none" ? "none" : depends ? "depends" : "dependedOn";
  const here = client.table(tableId)?.name ?? "this table";
  const there = client.table(opts.linkedTableId ?? "")?.name ?? "the linked table";
  return (
    <div>
      <label className="field-label">Dependency</label>
      <select
        className="input"
        value={value}
        aria-label="Dependency"
        onChange={e => {
          const v = e.target.value;
          set(v === "none" ? { pathRole: "none", dependsOn: depends } : { pathRole: "dependency", dependsOn: v === "depends" });
        }}
      >
        <option value="depends">This record depends on the linked record</option>
        <option value="dependedOn">The linked record depends on this record</option>
        <option value="none">Not a dependency</option>
      </select>
      <p className="muted small">
        {value === "none"
          ? "Path lookups never walk through this link."
          : value === "depends"
            ? `A ${here} record needs the ${there} records it links to. Path lookups follow this direction.`
            : `A ${there} record needs the ${here} records it links to. Path lookups follow this direction.`}
      </p>
    </div>
  );
}

export function PathLookupOptions({ client, tableId, opts, set }: { client: BaseClient; tableId: string; opts: FieldOptions; set: Set }) {
  const fields = client.schema.fields;
  const tableName = (id: string) => client.table(id)?.name ?? "Deleted table";
  const down = useMemo(() => reachableTables(fields, tableId, "dependents"), [fields, tableId]);
  const up = useMemo(() => reachableTables(fields, tableId, "dependencies"), [fields, tableId]);
  const targets = client.schema.tables.filter(t => down.has(t.id) || up.has(t.id) || t.id === opts.targetTableId);
  const target = opts.targetTableId;
  const both = !!target && down.has(target) && up.has(target);
  const dir: PathDirection = opts.pathDirection ?? (target && !down.has(target) && up.has(target) ? "dependencies" : "dependents");
  const exclude = opts.excludeLinkFieldIds ?? [];
  const candidates = useMemo(() => (target ? allowedEdges(fields, tableId, target, dir) : []), [fields, tableId, target, dir]);
  const used = useMemo(() => new Set(target ? allowedEdges(fields, tableId, target, dir, exclude).map(e => e.fieldId) : []), [fields, tableId, target, dir, exclude]);
  const fieldName = (id: string) => fields.find(f => f.id === id);
  const targetFields = target ? client.fields(target).filter((f: Field) => f.type !== "pathLookup") : [];

  if (!targets.length) return <p className="muted small">No links lead from this table to another table yet. Add a "Link to another record" field, or set a text field to match values in another table, first.</p>;
  return (
    <div className="stack">
      <div>
        <label className="field-label">Collect records from</label>
        <select
          className="input"
          value={target ?? ""}
          aria-label="Target table"
          onChange={e => {
            const t = e.target.value || undefined;
            set({ targetTableId: t, pathDirection: t && !down.has(t) && up.has(t) ? "dependencies" : "dependents", excludeLinkFieldIds: [], targetFilter: undefined });
          }}
        >
          <option value="">Choose a table</option>
          {targets.map(t => <option key={t.id} value={t.id}>{t.name}{t.id === tableId ? " (this table)" : ""}</option>)}
        </select>
      </div>
      {target && both && (
        <div>
          <label className="field-label">Direction</label>
          <select className="input" value={dir} aria-label="Direction" onChange={e => set({ pathDirection: e.target.value as PathDirection, excludeLinkFieldIds: [] })}>
            <option value="dependents">Records that depend on this one</option>
            <option value="dependencies">Records this one depends on</option>
          </select>
        </div>
      )}
      {target && (
        <>
          <p className="muted small">
            {dir === "dependents"
              ? `Every ${tableName(target)} record that depends on this record, directly or through any chain of links.`
              : `Every ${tableName(target)} record this record depends on, directly or through any chain of links.`}{" "}
            Filter this field by "is empty" to find records with no such chain.
          </p>
          <div>
            <label className="field-label">Only {tableName(target)} records where</label>
            <FilterEditor
              fields={targetFields}
              spec={opts.targetFilter ?? { conjunction: "and", conditions: [] }}
              onChange={(next: FilterSpec) => set({ targetFilter: next.conditions.length ? next : undefined })}
              emptyText={`All ${tableName(target)} records count.`}
            />
          </div>
          <div>
            <label className="field-label">Links it walks through</label>
            <div className="path-links">
              {candidates.map(e => {
                const f = fieldName(e.fieldId);
                const on = !exclude.includes(e.fieldId) && !(e.inverseId && exclude.includes(e.inverseId));
                return (
                  <label key={e.fieldId} className={"row small" + (on && !used.has(e.fieldId) ? " muted" : "")}>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={ev => set({ excludeLinkFieldIds: ev.target.checked ? exclude.filter(id => id !== e.fieldId && id !== e.inverseId) : [...exclude, e.fieldId] })}
                    />
                    {e.keys && f?.options.match ? (
                      <>
                        {tableName(f.tableId)}.{f.name} = {tableName(fieldName(f.options.match.fieldId)?.tableId ?? "")}.{fieldName(f.options.match.fieldId)?.name} <span className="muted">same value</span>
                      </>
                    ) : (
                      <>
                        {tableName(e.from)}.{f?.name ?? "link"} <span className="muted">to {tableName(e.to)}</span>
                      </>
                    )}
                  </label>
                );
              })}
            </div>
            {!used.size && <div className="err small">No path to {tableName(target)} is left. Turn a link back on.</div>}
            <p className="muted small">Links added later that lead to {tableName(target)} are walked automatically.</p>
          </div>
          <details>
            <summary className="muted small">Advanced</summary>
            <label className="row small">
              At most
              <input
                className="input"
                style={{ width: 70 }}
                type="number"
                min={1}
                max={MAX_PATH_DEPTH}
                value={opts.maxDepth ?? ""}
                placeholder="any"
                aria-label="Most links in one chain"
                onChange={e => set({ maxDepth: e.target.value === "" ? undefined : Math.max(1, Math.min(MAX_PATH_DEPTH, Math.round(Number(e.target.value)))) })}
              />
              links in one chain
            </label>
          </details>
        </>
      )}
    </div>
  );
}
