/**
 * Learning-layer note affordance (design §6.6): the annotated wire term is
 * itself the trigger — a dotted underline marks "explainable", click (not
 * hover — projectors, keyboards) expands an inline prose block. The term
 * doubles as the affordance so annotations cost zero layout width in the
 * app's tight panes. Appears instantly — the three-animation budget
 * (design §7) is untouched.
 *
 * Sites hold the open state (usually one open note per list) and render
 * `NoteTerm` in the row and `NotePanel` below it; the two-part split exists
 * because the panel must span the row's full width, not the term's.
 */

export interface NoteContent {
  /** The verbatim wire term being explained, rendered mono at the panel
   *  start — it also recovers values the row had to truncate. */
  term?: string;
  /** One-or-two-sentence prose explanation, our voice. */
  short: string;
  /** Optional longer prose. */
  detail?: string;
  /** api-notes.md citation, rendered muted mono after the prose. */
  source?: string;
}

export function NoteTerm({
  open,
  onToggle,
  subject,
  className = "",
  children,
}: {
  open: boolean;
  onToggle: () => void;
  /** Accessible name: `Explain ${subject}`. */
  subject: string;
  /** Visual classes of the term as it would render un-annotated. */
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={`Explain ${subject}`}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      // decoration-accent-strong at full opacity: the underline is the sole
      // "explainable" indicator, so it must clear WCAG 1.4.11's 3:1 (the
      // teal-700 fallback is ~5.5:1 on the app surfaces; design §6.6).
      className={`cursor-pointer text-left underline decoration-accent-strong decoration-dotted underline-offset-2 ${className}`}
    >
      {children}
    </button>
  );
}

export function NotePanel({ note }: { note: NoteContent }) {
  return (
    <div className="mt-1 rounded-inset bg-surface-inset px-2 py-1.5 text-xs leading-5 text-fg-secondary">
      {note.term !== undefined && (
        <span className="wire-quote break-all text-fg">{note.term} — </span>
      )}
      <span>{note.short}</span>
      {note.detail !== undefined && <span> {note.detail}</span>}
      {note.source !== undefined && (
        <span className="wire-quote text-fg-muted"> · {note.source}</span>
      )}
    </div>
  );
}
