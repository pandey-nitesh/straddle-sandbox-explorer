import type { ReactNode } from "react";

/**
 * Status chip (design §6.1): radius-chip, 0.75rem, 150ms color cross-fade.
 * Variants map straight onto the semantic token layer — the chip mirrors the
 * timeline's state so Scenario C's `watching` is visibly special even from
 * the list. Tokens only; no raw hexes (design §11).
 */
export type ChipVariant = "idle" | "running" | "passed" | "failed" | "watching";

const VARIANT_CLASSES: Record<ChipVariant, string> = {
  idle: "border border-edge-strong text-fg-muted",
  running: "bg-status-inflight text-white",
  passed: "bg-status-pass text-white",
  failed: "bg-status-fail text-white",
  watching: "bg-status-provisional text-white",
};

export function StatusChip({
  variant,
  children,
}: {
  variant: ChipVariant;
  children?: ReactNode;
}) {
  return (
    <span
      data-variant={variant}
      className={`chip-transition inline-flex items-center rounded-chip px-2 py-0.5 text-xs font-medium ${VARIANT_CLASSES[variant]}`}
    >
      {children ?? variant}
    </span>
  );
}
