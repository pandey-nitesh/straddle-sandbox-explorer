export interface CopyValueButtonProps {
  value: string;
  label: string;
}

export function CopyValueButton({ value, label }: CopyValueButtonProps) {
  return (
    <button
      type="button"
      aria-label={`Copy ${label}: ${value}`}
      title={`Copy ${label}`}
      className="chip-transition shrink-0 rounded-inset border border-edge bg-surface-card px-2 py-1 text-[0.6875rem] font-medium text-fg-muted hover:border-edge-strong hover:text-fg"
      onClick={() => {
        void navigator.clipboard.writeText(value);
      }}
    >
      Copy
    </button>
  );
}
