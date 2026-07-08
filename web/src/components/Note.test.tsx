import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { NotePanel, NoteTerm, type NoteContent } from "./Note";
import { Timeline, type TimelineNode } from "./Timeline";

afterEach(cleanup);

const NOTE: NoteContent = {
  term: "paid",
  short: "Terminal success — the debit settled.",
  source: "api-notes §8",
};

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <NoteTerm open={open} onToggle={() => setOpen(!open)} subject="paid">
        paid
      </NoteTerm>
      {open && <NotePanel note={NOTE} />}
    </div>
  );
}

describe("Note disclosure (design §6.6)", () => {
  it("is closed by default and opens on click with the prose and citation", () => {
    render(<Harness />);
    const term = screen.getByRole("button", { name: "Explain paid" });
    expect(term.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(/debit settled/)).toBeNull();

    fireEvent.click(term);
    expect(term.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(/debit settled/)).toBeDefined();
    expect(screen.getByText(/api-notes §8/)).toBeDefined();

    fireEvent.click(term);
    expect(screen.queryByText(/debit settled/)).toBeNull();
  });
});

describe("Timeline learning notes", () => {
  const nodes: TimelineNode[] = [
    { id: "1", kind: "inflight", status: "created", at: "2026-07-07T14:00:00Z" },
    {
      id: "2",
      kind: "failed",
      status: "failed",
      at: "2026-07-07T14:02:00Z",
      returnCode: "R01",
      statusNote: { short: "Terminal failure.", source: "api-notes §8" },
      codeNote: { short: "Insufficient funds.", source: "api-notes §5" },
    },
  ];

  it("makes annotated terms triggers and opens one panel at a time", () => {
    render(<Timeline nodes={nodes} />);
    const statusTerm = screen.getByRole("button", { name: "Explain failed" });
    const codeTerm = screen.getByRole("button", { name: "Explain R01" });

    fireEvent.click(statusTerm);
    expect(screen.getByText(/Terminal failure/)).toBeDefined();

    // Opening the code note closes the status note (one open at a time).
    fireEvent.click(codeTerm);
    expect(screen.getByText(/Insufficient funds/)).toBeDefined();
    expect(screen.queryByText(/Terminal failure/)).toBeNull();
  });

  it("renders no triggers when nodes carry no notes (Explain off)", () => {
    const bare = nodes.map(({ statusNote, codeNote, ...rest }) => rest);
    render(<Timeline nodes={bare} />);
    expect(screen.queryByRole("button", { name: /Explain/ })).toBeNull();
  });
});
