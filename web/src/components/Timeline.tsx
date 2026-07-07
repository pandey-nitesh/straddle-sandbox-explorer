import { EvidenceCard, type EvidenceCardProps } from "./EvidenceCard";
import { formatDelta, formatWallClock } from "./format";
import { useNow } from "./useNow";

/**
 * Lifecycle timeline (design §6.2): vertical 2px rail, one node per OBSERVED
 * transition — the UI never draws expected-but-unobserved states, because the
 * entire product claim is "this is what the API actually did".
 *
 * The provisional-paid node is the signature element: half-filled amber dot,
 * `paid — provisional`, "watching for reversal…", a 2s opacity pulse that
 * STOPS at terminal while the amber node STAYS (both transitions permanently
 * visible per FR-2). Note spec §18.1: live Scenario C never reaches `paid` —
 * this rendering is exercised by the mock client and replay.
 */
export type TimelineNodeKind =
  | "inflight"
  | "provisional"
  | "paid"
  | "failed"
  | "cancelled";

export interface TimelineNode {
  /** Stable key — the event `seq` works (gap-tolerant, spec §5). */
  id: string;
  kind: TimelineNodeKind;
  /** Wire status, verbatim lowercase as the API returns it (design §4). */
  status: string;
  /** ISO timestamp of the observation. */
  at: string;
  /** Elapsed since the previous node; omit on the first node. */
  elapsedMs?: number;
  /** Return code chip on terminal nodes — `R01`. */
  returnCode?: string;
  /** Captured reason, rendered underneath cancelled nodes. */
  reason?: string;
}

export type TimelineProps = {
  nodes: TimelineNode[];
  /** Run still in flight: the provisional dot pulses and a bottom in-flight
   *  node ticks a live `+m:ss`. */
  live?: boolean;
  /** Scenario E renders the evidence-row card instead of a rail (§6.2). */
  evidence?: EvidenceCardProps;
};

const DOT_BASE = "absolute top-0.5 -left-[27px] size-3 rounded-full";

function NodeDot({ kind, pulsing }: { kind: TimelineNodeKind; pulsing: boolean }) {
  switch (kind) {
    case "inflight":
      return <span data-testid="dot" className={`${DOT_BASE} bg-status-inflight`} />;
    case "provisional":
      // Half-filled amber dot (◍); the pulse class is present only while the
      // run is live — reduced-motion turns it into a static half-filled dot.
      return (
        <span
          data-testid="dot"
          className={`${DOT_BASE} border-2 border-status-provisional ${
            pulsing ? "animate-provisional-pulse" : ""
          }`}
          style={{
            background:
              "linear-gradient(90deg, var(--status-provisional) 50%, transparent 50%)",
          }}
        />
      );
    case "paid":
      return <span data-testid="dot" className={`${DOT_BASE} bg-status-paid`} />;
    case "failed":
      return <span data-testid="dot" className={`${DOT_BASE} bg-status-failed`} />;
    case "cancelled":
      // Hollow slate ring: gray-and-empty reads "deliberately stopped".
      return (
        <span
          data-testid="dot"
          className={`${DOT_BASE} border-2 border-status-cancelled bg-surface-card`}
        />
      );
  }
}

const LABEL_COLOR: Record<TimelineNodeKind, string> = {
  inflight: "text-status-inflight",
  provisional: "text-status-provisional",
  paid: "text-status-paid",
  failed: "text-status-failed",
  cancelled: "text-status-cancelled",
};

export function Timeline({ nodes, live = false, evidence }: TimelineProps) {
  const lastNode = nodes[nodes.length - 1];
  const now = useNow(live && evidence === undefined && lastNode !== undefined);

  if (evidence !== undefined) return <EvidenceCard {...evidence} />;

  if (nodes.length === 0) {
    return (
      <p className="text-sm text-fg-muted">
        No runs yet. Run scenario C to watch a payment settle and then
        un-settle.
      </p>
    );
  }

  return (
    <ol className="ml-1.5 space-y-5 border-l-2 border-edge pl-5">
      {nodes.map((node) => (
        <li key={node.id} className="animate-node-entry relative">
          <NodeDot kind={node.kind} pulsing={node.kind === "provisional" && live} />
          <div className="flex items-baseline gap-2">
            <span
              className={`wire-quote font-semibold ${LABEL_COLOR[node.kind]}`}
            >
              {node.kind === "provisional"
                ? `${node.status} — provisional`
                : node.status}
            </span>
            {node.kind === "paid" && (
              <span aria-label="terminal success" className="text-status-paid">
                ✓
              </span>
            )}
            {node.returnCode !== undefined && (
              <span className="wire-quote rounded-chip bg-status-failed/10 px-1.5 py-0.5 text-xs text-status-failed">
                {node.returnCode}
              </span>
            )}
            <span className="flex-1" />
            <span className="wire-quote shrink-0 text-xs text-fg-muted">
              {formatWallClock(node.at)}
            </span>
          </div>
          {node.elapsedMs !== undefined && (
            <div className="wire-quote mt-0.5 text-xs text-fg-muted">
              {formatDelta(node.elapsedMs)}
            </div>
          )}
          {node.kind === "provisional" && (
            <div className="mt-0.5 text-sm text-fg-secondary">
              watching for reversal…
            </div>
          )}
          {node.kind === "cancelled" && node.reason !== undefined && (
            <div className="mt-0.5 text-sm text-fg-secondary">{node.reason}</div>
          )}
        </li>
      ))}
      {/* In-flight bottom node: live ticking +m:ss since the last observation. */}
      {live && lastNode !== undefined && (
        <li className="relative" data-testid="inflight-tick">
          <span
            className={`${DOT_BASE} border-2 border-status-inflight bg-surface-card`}
          />
          <span className="wire-quote text-xs text-fg-muted">
            {formatDelta(now - new Date(lastNode.at).getTime())}
          </span>
        </li>
      )}
    </ol>
  );
}
