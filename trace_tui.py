"""Terminal waterfall viewer for a Glean conversation trace.

Loads a trace JSON (from a file argument or stdin), reconstructs spans from the
message stream, and shows a waterfall on the left with per-span details on the
right.

    python3 trace_tui.py trace.json
    python3 fetch_trace.py <chat_id> | python3 trace_tui.py

Requires Textual (see requirements.txt).
"""

import argparse
import json
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone

from rich.markup import escape
from rich.text import Text
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, VerticalScroll
from textual.widgets import DataTable, Footer, Header, Static


# Waterfall bar width, in characters, inside the timeline column.
BAR_WIDTH = 34

# Span "kinds" derived from stepId / fragments, with a display colour.
KIND_STYLES = {
    "user": "bold cyan",
    "tool": "bold magenta",
    "reasoning": "green",
    "message": "yellow",
    "other": "white",
}


def parse_ts(value):
    """Parse Glean's message timestamp, e.g. '2026-09-22 18:17:23.934237 +0000 UTC'."""
    if not value:
        return None
    cleaned = value.replace(" UTC", "").strip()
    for fmt in ("%Y-%m-%d %H:%M:%S.%f %z", "%Y-%m-%d %H:%M:%S %z"):
        try:
            return datetime.strptime(cleaned, fmt)
        except ValueError:
            continue
    return None


@dataclass
class Span:
    key: str
    step_id: str
    kind: str
    start: datetime
    end: datetime
    statuses: list = field(default_factory=list)
    messages: list = field(default_factory=list)

    @property
    def duration_s(self) -> float:
        return (self.end - self.start).total_seconds()


def classify(step_id: str, author: str, fragment_keys: set) -> str:
    if author == "USER":
        return "user"
    if step_id.startswith("call_") or {
        "action",
        "actionExecutionRequest",
        "skillActionNotification",
    } & fragment_keys:
        return "tool"
    if step_id.startswith("rs_"):
        return "reasoning"
    if fragment_keys & {"text"}:
        return "message"
    return "other"


def build_spans(trace: dict) -> list:
    chat = trace.get("chatResult", {}).get("chat", {})
    messages = chat.get("messages", [])

    groups = {}
    order = []
    for msg in messages:
        key = msg.get("stepRunId") or f"seq-{msg.get('sequenceId')}-{msg.get('messageId')}"
        if key not in groups:
            groups[key] = []
            order.append(key)
        groups[key].append(msg)

    spans = []
    for key in order:
        group = groups[key]
        times = [t for t in (parse_ts(m.get("ts")) for m in group) if t]
        if not times:
            continue
        frag_keys = set()
        for m in group:
            for frag in m.get("fragments", []):
                frag_keys |= set(frag.keys())
        step_id = next((m.get("stepId") for m in group if m.get("stepId")), "") or ""
        author = group[0].get("author", "")
        spans.append(
            Span(
                key=key,
                step_id=step_id,
                kind=classify(step_id, author, frag_keys),
                start=min(times),
                end=max(times),
                statuses=[m.get("stepStatusEvent") for m in group],
                messages=group,
            )
        )

    spans.sort(key=lambda s: s.start)
    return spans


def short_label(span: Span) -> str:
    if span.kind == "user":
        return "USER message"
    sid = span.step_id or "(no step id)"
    if sid.startswith("call_"):
        return sid  # tool call ids are short already
    if len(sid) > 30:
        sid = sid[:27] + "…"
    return sid


def waterfall_bar(span: Span, t0: datetime, total: float) -> Text:
    if total <= 0:
        total = 1.0
    offset = (span.start - t0).total_seconds() / total
    length = span.duration_s / total
    lead = max(0, min(BAR_WIDTH - 1, round(offset * BAR_WIDTH)))
    fill = max(1, round(length * BAR_WIDTH))
    fill = min(fill, BAR_WIDTH - lead)
    style = KIND_STYLES.get(span.kind, "white")
    bar = Text(" " * lead)
    bar.append("█" * fill, style=style)
    bar.append(" " * (BAR_WIDTH - lead - fill))
    return bar


def render_details(span: Span, t0: datetime) -> str:
    # Escape every dynamic value: fragment text and JSON can contain '[' which
    # Rich would otherwise try to parse as console markup.
    esc = escape
    offset = (span.start - t0).total_seconds()
    statuses = " → ".join(s for s in span.statuses if s) or "—"
    lines = [
        f"[b]{esc(short_label(span))}[/b]",
        "",
        f"[dim]kind[/dim]        {esc(span.kind)}",
        f"[dim]step id[/dim]     {esc(span.step_id or '—')}",
        f"[dim]run id[/dim]      {esc(span.key)}",
        f"[dim]start[/dim]       +{offset:.3f}s  ({span.start.isoformat()})",
        f"[dim]duration[/dim]    {span.duration_s:.3f}s",
        f"[dim]statuses[/dim]    {esc(statuses)}",
        f"[dim]messages[/dim]    {len(span.messages)}",
        "",
        "[b]Fragments & metadata[/b]",
    ]
    for i, msg in enumerate(span.messages):
        seq = msg.get("sequenceId")
        mtype = msg.get("messageType")
        status = msg.get("stepStatusEvent")
        header = f"— message {i + 1}  seq={seq}  type={mtype}"
        if status:
            header += f"  status={status}"
        lines.append("")
        lines.append(f"[cyan]{esc(header)}[/cyan]")
        for frag in msg.get("fragments", []):
            for fk, fv in frag.items():
                if fk == "text":
                    text = fv.strip()
                    if text:
                        lines.append(f"  [yellow]text[/yellow]: {esc(text)}")
                else:
                    dump = json.dumps(fv, indent=2, ensure_ascii=False)
                    dump = "\n".join("    " + esc(ln) for ln in dump.splitlines())
                    lines.append(f"  [magenta]{esc(fk)}[/magenta]:\n{dump}")
    return "\n".join(lines)


class TraceViewer(App):
    CSS = """
    #body { height: 1fr; }
    #waterfall { width: 55%; border-right: solid $accent; }
    #details { width: 45%; padding: 0 1; }
    DataTable { height: 1fr; }
    """

    BINDINGS = [
        Binding("q", "quit", "Quit"),
        Binding("j,down", "cursor_down", "Down", show=False),
        Binding("k,up", "cursor_up", "Up", show=False),
    ]

    def __init__(self, trace: dict, source: str):
        super().__init__()
        self.trace = trace
        self.source = source
        self.spans = build_spans(trace)
        self.t0 = self.spans[0].start if self.spans else datetime.now(timezone.utc)
        end = max((s.end for s in self.spans), default=self.t0)
        self.total = (end - self.t0).total_seconds() or 1.0

    def compose(self) -> ComposeResult:
        yield Header(show_clock=False)
        with Horizontal(id="body"):
            yield DataTable(id="waterfall", cursor_type="row", zebra_stripes=True)
            with VerticalScroll(id="details"):
                yield Static("", id="detail-body")
        yield Footer()

    def on_mount(self) -> None:
        chat = self.trace.get("chatResult", {}).get("chat", {})
        name = chat.get("name") or "trace"
        self.title = f"Glean trace · {name}"
        self.sub_title = f"{len(self.spans)} spans · {self.total:.1f}s · {self.source}"

        table = self.query_one(DataTable)
        table.add_column("timeline", width=BAR_WIDTH + 2)
        table.add_column("span")
        table.add_column("dur", width=9)
        for span in self.spans:
            table.add_row(
                waterfall_bar(span, self.t0, self.total),
                Text(short_label(span), style=KIND_STYLES.get(span.kind, "white")),
                Text(f"{span.duration_s:6.2f}s", style="dim"),
            )
        if self.spans:
            table.focus()
            self._show(0)

    def _show(self, index: int) -> None:
        if 0 <= index < len(self.spans):
            self.query_one("#detail-body", Static).update(
                render_details(self.spans[index], self.t0)
            )

    def on_data_table_row_highlighted(self, event: DataTable.RowHighlighted) -> None:
        self._show(event.cursor_row)


def load_trace(path: str | None) -> tuple[dict, str]:
    if path and path != "-":
        with open(path, encoding="utf-8") as fh:
            return json.load(fh), path
    if sys.stdin.isatty():
        raise SystemExit(
            "No trace given. Pass a file (python3 trace_tui.py trace.json) "
            "or pipe one in (fetch_trace.py <id> | trace_tui.py)."
        )
    return json.load(sys.stdin), "stdin"


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Waterfall TUI for a Glean conversation trace.",
    )
    parser.add_argument(
        "trace",
        nargs="?",
        help="Trace JSON file (defaults to stdin; use '-' for stdin explicitly)",
    )
    args = parser.parse_args()

    trace, source = load_trace(args.trace)
    TraceViewer(trace, source).run()


if __name__ == "__main__":
    main()
