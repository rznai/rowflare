// Expanded record: every field with its full editor, previous / next navigation and record actions.
import { useEffect, useState } from "react";
import type { Field, LinkValue, Row, View } from "../../shared/types";
import { COMPUTED_TYPES } from "../../shared/types";
import { BaseClient, primaryText, useBase } from "./client";
import { FieldValueEditor, formatDate } from "./editors";
import { matchMissText, pathMore, rawValue } from "./cells";
import { FieldIcon, Icon, Modal, Spinner } from "../ui";
import { toast, toastError } from "../toast";
import { runButtonField } from "../auto/button";
import { AI_STATE_TEXT } from "../ai/aiCell";
import { matchProblem } from "../../shared/matches";

export default function RecordModal({ client, view, rowId, onClose, onNavigate, onOpenRecord }: { client: BaseClient; view: View; rowId: number; onClose: () => void; onNavigate: (id: number) => void; onOpenRecord?: (tableId: string, id: number) => void }) {
  useBase(client);
  const tableId = view.tableId;
  const row = client.row(tableId, rowId);
  const ids = client.viewState(view.id)?.ids ?? [];
  const idx = ids.indexOf(rowId);
  useEffect(() => {
    if (!row) client.ensureRows(tableId, [rowId]);
  }, [row, client, tableId, rowId]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [contenteditable]")) return;
      if ((e.key === "ArrowDown" || e.key === "j") && idx >= 0 && idx < ids.length - 1) onNavigate(ids[idx + 1]);
      if ((e.key === "ArrowUp" || e.key === "k") && idx > 0) onNavigate(ids[idx - 1]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [idx, ids, onNavigate]);

  const fields = client.orderedFields(view);
  const title = row ? primaryText(client, tableId, row) || "Unnamed record" : "Loading";
  const ctx = { members: client.members, searchLinked: (t: string, q: string) => client.searchRecords(t, q), upload: (f: File) => client.uploadAttachment(f) };

  return (
    <Modal
      width={720}
      onClose={onClose}
      title={
        <div className="row record-head">
          <button className="icon-btn" disabled={idx <= 0} onClick={() => onNavigate(ids[idx - 1])} aria-label="Previous record"><Icon name="chevron" className="flip" /></button>
          <button className="icon-btn" disabled={idx < 0 || idx >= ids.length - 1} onClick={() => onNavigate(ids[idx + 1])} aria-label="Next record"><Icon name="chevron" /></button>
          <span className="record-title">{title}</span>
        </div>
      }
      footer={
        row && (
          <div className="row record-foot">
            <span className="muted small grow">
              Created {formatDate(row.createdAt, true)}{row.createdBy ? ` by ${client.memberName(row.createdBy)}` : ""} · Updated {formatDate(row.updatedAt, true)}
            </span>
            {client.writable && (
              <button
                className="btn btn-sm btn-danger"
                onClick={() => {
                  const next = ids[idx + 1] ?? ids[idx - 1];
                  client.deleteRows(tableId, [rowId]);
                  toast("Record deleted", "info", { label: "Undo", run: () => client.undo() });
                  if (next !== undefined) onNavigate(next);
                  else onClose();
                }}
              >
                <Icon name="trash" size={14} /> Delete
              </button>
            )}
          </div>
        )
      }
    >
      {!row ? (
        <div className="center-page"><Spinner /></div>
      ) : (
        <div className="record-fields">
          {fields.map(f => (
            <div key={f.id} className="record-field">
              <label className="field-label row">
                <FieldIcon type={f.type} size={13} /> {f.name}
                {COMPUTED_TYPES.has(f.type) && f.type !== "button" && <span className="muted small">computed</span>}
                {f.options.ai && <span className="muted small" style={{ marginLeft: 6 }}>AI</span>}
              </label>
              {f.description && <div className="muted small field-help">{f.description}</div>}
              {f.type === "button" ? (
                <div>
                  <button className="btn btn-sm" style={{ background: f.options.color ?? "var(--chip)" }} disabled={client.buttonBusy.has(`${f.id}:${rowId}`)} onClick={() => runButtonField(client, f, rowId)}>
                    {client.buttonBusy.has(`${f.id}:${rowId}`) ? "Running..." : f.options.label || "Run"}
                  </button>
                </div>
              ) : f.type === "pathLookup" ? (
                <PathValues client={client} field={f} row={row} onOpen={onOpenRecord} />
              ) : (
                <>
                  <FieldValueEditor
                    field={f}
                    value={rawValue(f, row)}
                    readOnly={!client.writable}
                    compact
                    ctx={ctx}
                    onChange={(v, opts) => client.updateCells(tableId, [{ id: rowId, cells: { [f.id]: v } }], { typecast: opts?.typecast })}
                  />
                  {f.options.match && <MatchValues client={client} field={f} row={row} onOpen={onOpenRecord} />}
                </>
              )}
              {f.options.ai && (
                <div className="row small ai-record-state">
                  {row.ai?.[f.id] && <span className={row.ai[f.id].s === "error" ? "err" : "muted"}>{row.ai[f.id].s === "error" ? row.ai[f.id].e ?? AI_STATE_TEXT.error : AI_STATE_TEXT[row.ai[f.id].s]}</span>}
                  {client.writable && (
                    <button className="link-btn" onClick={() => client.aiGenerate(tableId, f.id, { rowIds: [rowId] }).catch(e => toast(String(e.message ?? e), "error"))}>
                      Regenerate
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

/** Path lookup results as records to open, each with the chain of links that reaches it. */
function PathValues({ client, field, row, onOpen }: { client: BaseClient; field: Field; row: Row; onOpen?: (tableId: string, id: number) => void }) {
  const [why, setWhy] = useState<{ id: number; text: string } | null>(null);
  const list = (row.cells[field.id] as LinkValue[] | undefined) ?? [];
  const more = pathMore(row, field.id, list);
  const target = field.options.targetTableId!;
  const arrow = field.options.pathDirection === "dependencies" ? " → " : " ← ";
  const explain = async (id: number) => {
    if (why?.id === id) return setWhy(null);
    try {
      const path = await client.explainPath(field.id, row.id, id);
      const same = (fieldId?: string) => {
        const f = fieldId ? client.schema.fields.find(x => x.id === fieldId) : undefined;
        return f && f.type !== "link" ? ` (same ${f.name})` : "";
      };
      const text = path ? path.map((h, i) => (i === 0 ? h.t || "Unnamed record" : `${client.table(h.tableId)?.name ?? ""}: ${h.t || "Unnamed record"}${same(h.fieldId)}`)).join(arrow) : "No chain leads there any more.";
      setWhy({ id, text });
    } catch (e) {
      toastError(e);
    }
  };
  if (!list.length) return <span className="muted">{more ?? "-"}</span>;
  return (
    <div className="path-values">
      {list.map(v => (
        <div key={v.id} className="path-value">
          <button type="button" className="chip chip-btn" style={{ background: "var(--link-chip)" }} disabled={!onOpen} onClick={() => onOpen?.(target, v.id)} title="Open record">
            <span className="chip-text">{v.t || "Unnamed record"}</span>
          </button>
          <button type="button" className="link-btn small" onClick={() => explain(v.id)}>Why</button>
          {why?.id === v.id && <div className="muted small path-why">{why.text}</div>}
        </div>
      ))}
      {more && <div className="muted small">{more === "Incomplete" ? "Incomplete: the search hit its limit. Add target conditions or leave links out to see every record." : more}</div>}
    </div>
  );
}

/** The records of another table holding the same value as a field set to match it. */
function MatchValues({ client, field, row, onOpen }: { client: BaseClient; field: Field; row: Row; onOpen?: (tableId: string, id: number) => void }) {
  const target = client.schema.fields.find(x => x.id === field.options.match?.fieldId);
  if (!target || matchProblem(field, client.schema.fields)) return null;
  const list = row.matches?.[field.id] ?? [];
  if (!list.length) return row.cells[field.id] ? <div className="muted small">{matchMissText(client, target)}</div> : null;
  return (
    <div className="path-values match-values">
      {list.map(v => (
        <button key={v.id} type="button" className="chip chip-btn" style={{ background: "var(--link-chip)" }} disabled={!onOpen} onClick={() => onOpen?.(target.tableId, v.id)} title="Open record">
          <span className="chip-text">{v.t || "Unnamed record"}</span>
        </button>
      ))}
    </div>
  );
}
