/**
 * Inset JSON block with muted line numbers — the numbered-snippet motif from
 * Straddle's own homepage (design §6.3). Bodies are verbatim testimony:
 * formatted, never summarized, recolored, or prettified beyond indentation.
 * JSON 0.75rem/1.6 per the §4 type scale.
 */
export function JsonBlock({ value }: { value: unknown }) {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const lines = (text ?? String(value)).split("\n");
  return (
    <pre className="overflow-x-auto rounded-inset bg-surface-inset p-3 font-mono text-xs leading-[1.6] text-fg">
      {lines.map((line, i) => (
        <div key={i}>
          <span
            aria-hidden="true"
            className="mr-3 inline-block w-6 select-none text-right text-fg-muted"
          >
            {i + 1}
          </span>
          {line}
        </div>
      ))}
    </pre>
  );
}
