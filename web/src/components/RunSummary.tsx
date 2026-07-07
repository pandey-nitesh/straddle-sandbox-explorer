import { useState } from "react";
import { PrimaryButton } from "./AppShell";
import { EvidenceRows, type EvidenceRow } from "./EvidenceCard";
import { formatElapsed } from "./format";

/**
 * Summary strip (design §6.5): mono suite line (`3/5 passed · 11:42 elapsed`)
 * + report download; expands to per-scenario assertion rows reusing the §6.2
 * evidence-row pattern. Dumb view model — the report blob fetch lives behind
 * the onDownloadReport callback.
 */
export interface ScenarioAssertions {
  id: string;
  /** Row heading, e.g. "C. Reversal". */
  label: string;
  rows: EvidenceRow[];
}

export interface RunSummaryProps {
  passed: number;
  total: number;
  elapsedMs: number;
  scenarios?: ScenarioAssertions[];
  onDownloadReport?: () => void;
  downloadDisabled?: boolean;
}

export function RunSummary({
  passed,
  total,
  elapsedMs,
  scenarios = [],
  onDownloadReport,
  downloadDisabled,
}: RunSummaryProps) {
  const [open, setOpen] = useState(false);
  const suiteLine = `${passed}/${total} passed · ${formatElapsed(elapsedMs)} elapsed`;
  const expandable = scenarios.length > 0;

  return (
    <div className="flex-1">
      {open && expandable && (
        <div className="mb-3 space-y-3">
          {scenarios.map((scenario) => (
            <div key={scenario.id}>
              <div className="text-xs font-medium text-fg-secondary">
                {scenario.label}
              </div>
              <EvidenceRows rows={scenario.rows} />
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center justify-between gap-4">
        <button
          type="button"
          aria-expanded={open}
          disabled={!expandable}
          onClick={() => setOpen((o) => !o)}
          className="wire-quote text-left text-fg-secondary disabled:text-fg-muted"
        >
          {suiteLine}
        </button>
        <PrimaryButton
          onClick={onDownloadReport}
          disabled={downloadDisabled === true || onDownloadReport === undefined}
        >
          Download report.json
        </PrimaryButton>
      </div>
    </div>
  );
}
