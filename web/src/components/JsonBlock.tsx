import { useState, type ComponentProps } from "react";
import {
  JsonView,
  allExpanded,
  collapseAllNested,
} from "react-json-view-lite";
import "react-json-view-lite/dist/index.css";

/**
 * Inset JSON tree for structured wire evidence. Bodies are verbatim testimony:
 * formatted, collapsible, and expandable, without summarizing or rewriting
 * the redacted values.
 */
export interface JsonBlockProps {
  value: unknown;
  label?: string;
  className?: string;
}

type JsonViewStyle = NonNullable<ComponentProps<typeof JsonView>["style"]>;

const JSON_VIEW_STYLE = {
  container: "sse-json-tree",
  basicChildStyle: "sse-json-row",
  label: "sse-json-label",
  clickableLabel: "sse-json-label sse-json-clickable",
  nullValue: "sse-json-null",
  undefinedValue: "sse-json-null",
  numberValue: "sse-json-number",
  stringValue: "sse-json-string",
  booleanValue: "sse-json-boolean",
  otherValue: "sse-json-other",
  punctuation: "sse-json-punctuation",
  expandIcon: "sse-json-expander sse-json-expand",
  collapseIcon: "sse-json-expander sse-json-collapse",
  collapsedContent: "sse-json-collapsed",
  childFieldsContainer: "sse-json-children",
  ariaLables: {
    collapseJson: "Collapse JSON node",
    expandJson: "Expand JSON node",
  },
  stringifyStringValues: true,
  noQuotesForStringValues: false,
  quotesForFieldNames: true,
} satisfies JsonViewStyle;

type JsonViewData = Record<string, unknown> | unknown[];
type ExpandMode = "all" | "nested";

function toJsonViewData(value: unknown): JsonViewData {
  if (Array.isArray(value)) return value;
  if (typeof value === "object" && value !== null) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) return parsed;
      if (typeof parsed === "object" && parsed !== null) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Fall through to the primitive wrapper below.
    }
  }
  return { value };
}

export function JsonBlock({ value, label, className = "" }: JsonBlockProps) {
  const [expandMode, setExpandMode] = useState<ExpandMode>("all");
  const data = toJsonViewData(value);
  const shouldExpandNode =
    expandMode === "all" ? allExpanded : collapseAllNested;

  return (
    <div
      tabIndex={0}
      aria-label={label}
      className={`max-h-96 overflow-auto rounded-inset bg-surface-inset p-3 font-mono text-xs leading-[1.6] text-fg ${className}`}
    >
      <div className="mb-2 flex items-center justify-end gap-1">
        <button
          type="button"
          aria-pressed={expandMode === "all"}
          onClick={() => setExpandMode("all")}
          className="chip-transition rounded-inset border border-edge bg-surface-card px-2 py-0.5 text-[0.6875rem] font-medium text-fg-secondary hover:border-edge-strong"
        >
          Expand all
        </button>
        <button
          type="button"
          aria-pressed={expandMode === "nested"}
          onClick={() => setExpandMode("nested")}
          className="chip-transition rounded-inset border border-edge bg-surface-card px-2 py-0.5 text-[0.6875rem] font-medium text-fg-secondary hover:border-edge-strong"
        >
          Collapse nested
        </button>
      </div>
      <JsonView
        key={expandMode}
        data={data}
        style={JSON_VIEW_STYLE}
        shouldExpandNode={shouldExpandNode}
        clickToExpandNode
        {...(label !== undefined
          ? { "aria-label": `${label} tree` }
          : { "aria-label": "JSON tree" })}
      />
    </div>
  );
}
