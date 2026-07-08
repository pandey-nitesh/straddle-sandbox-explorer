import { useState } from "react";
import { NotePanel, NoteTerm, type NoteContent } from "./Note";
import { StatusChip, type ChipVariant } from "./StatusChip";

export interface RunOverviewRow {
  label: string;
  value: string;
  mono?: boolean;
  /** Learning note for the row's value (absent = Explain off). */
  note?: NoteContent;
}

export interface RunOverviewProps {
  label: string;
  purpose: string;
  flow?: readonly string[];
  chip: Exclude<ChipVariant, "idle">;
  chipLabel?: string;
  rows: RunOverviewRow[];
}

export function RunOverview({
  label,
  purpose,
  flow,
  chip,
  chipLabel,
  rows,
}: RunOverviewProps) {
  // One learning note open at a time, keyed by row label.
  const [openNoteLabel, setOpenNoteLabel] = useState<string | null>(null);
  return (
    <section className="mb-5 rounded-inset border border-edge bg-surface-inset p-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-fg">{label}</h3>
          <p className="mt-1 text-sm leading-5 text-fg-secondary">{purpose}</p>
        </div>
        <StatusChip variant={chip}>{chipLabel}</StatusChip>
      </div>
      {flow !== undefined && flow.length > 0 && (
        <div className="mt-3 rounded-inset border border-edge bg-surface-card p-3">
          <h4 className="pane-header mb-2">Flow</h4>
          <ol className="space-y-1.5">
            {flow.map((step, index) => (
              <li
                key={`${index}:${step}`}
                className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-2 text-xs leading-5 text-fg-secondary"
              >
                <span className="wire-quote text-fg-muted">{index + 1}</span>
                <span className="min-w-0 break-words">{step}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
      <dl className="mt-3 space-y-2">
        {rows.map((row) => (
          // dl children must directly contain the dt/dd groups — the note
          // panel joins the same grid as a spanning cell, never a sibling
          // wrapper (HTML conformance; audit finding).
          <div
            key={row.label}
            className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-2"
          >
            <dt className="text-xs text-fg-muted">{row.label}</dt>
            <dd
              className={`min-w-0 break-words text-xs text-fg ${
                row.mono === true ? "wire-quote" : ""
              }`}
            >
              {row.note !== undefined ? (
                // The value is its own note trigger (design §6.6).
                <NoteTerm
                  open={openNoteLabel === row.label}
                  onToggle={() =>
                    setOpenNoteLabel((current) =>
                      current === row.label ? null : row.label,
                    )
                  }
                  subject={row.value}
                  className="max-w-full whitespace-normal break-words"
                >
                  {row.value}
                </NoteTerm>
              ) : (
                row.value
              )}
              {row.note !== undefined && openNoteLabel === row.label && (
                <NotePanel note={row.note} />
              )}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
