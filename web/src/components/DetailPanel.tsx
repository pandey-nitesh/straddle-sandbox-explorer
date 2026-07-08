import { useState } from "react";
import { NotePanel, NoteTerm, type NoteContent } from "./Note";

/**
 * P1 identity + paykey panel (design §6.2 / spec Wave 5 item 3). Rows are
 * flat label/value pairs; a row may carry a learning note (design §6.6) —
 * the value becomes its own dotted-underline trigger.
 */
export interface DetailRow {
  label: string;
  value: string;
  /** Learning note for the row's value (absent = Explain off). */
  note?: NoteContent;
}

export interface DetailPanelProps {
  identityRows: DetailRow[];
  paykeyRows: DetailRow[];
}

function Rows({
  rows,
  openNoteLabel,
  onToggleNote,
}: {
  rows: DetailRow[];
  openNoteLabel: string | null;
  onToggleNote: (label: string) => void;
}) {
  if (rows.length === 0) {
    return <p className="text-xs text-fg-muted">No evidence captured yet.</p>;
  }
  return (
    <dl className="space-y-2">
      {rows.map((row) => (
        <div
          key={`${row.label}:${row.value}`}
          className="grid grid-cols-[92px_1fr] gap-x-2"
        >
          <dt className="text-xs text-fg-muted">{row.label}</dt>
          <dd className="wire-quote min-w-0 text-fg">
            {row.note !== undefined ? (
              <NoteTerm
                open={openNoteLabel === row.label}
                onToggle={() => onToggleNote(row.label)}
                subject={row.label}
                className="block max-w-full truncate"
              >
                {row.value}
              </NoteTerm>
            ) : (
              <span className="block truncate">{row.value}</span>
            )}
            {row.note !== undefined && openNoteLabel === row.label && (
              <NotePanel note={row.note} />
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function DetailPanel({ identityRows, paykeyRows }: DetailPanelProps) {
  // One note open at a time across both sections, keyed by row label.
  const [openNoteLabel, setOpenNoteLabel] = useState<string | null>(null);
  const toggle = (label: string) =>
    setOpenNoteLabel((current) => (current === label ? null : label));
  return (
    <div className="space-y-3">
      <section>
        <h3 className="pane-header mb-2">Identity</h3>
        <Rows
          rows={identityRows}
          openNoteLabel={openNoteLabel}
          onToggleNote={toggle}
        />
      </section>
      <section>
        <h3 className="pane-header mb-2">Paykey</h3>
        <Rows
          rows={paykeyRows}
          openNoteLabel={openNoteLabel}
          onToggleNote={toggle}
        />
      </section>
    </div>
  );
}
