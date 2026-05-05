import { useCallback, useEffect, useState } from "react";

import {
  fetchSessionTurns,
  replayFrom,
  type ChatMessage,
  type MessageBlock,
  type SessionSummary,
} from "../api.js";
import { downloadFile, exportJSON, exportMarkdown } from "../replay-export.js";

interface ReplayViewProps {
  session: SessionSummary;
  /**
   * Called after a successful "Replay from here" so the parent can
   * switch back to the live graph view (the spec says the graph tab
   * should take over again so the user sees the rerun executing).
   */
  onReplayed: () => void;
}

/**
 * Time-travel inspector for a single session.
 *
 * Loads the session's full message history once on mount. Shows a
 * timeline of dots — one per turn — at the top, with the focused turn
 * rendered in the body. Left/Right arrow keys step between turns;
 * `Enter` triggers "Replay from here". Export buttons download the
 * conversation as JSON or Markdown.
 */
export function ReplayView({ session, onReplayed }: ReplayViewProps) {
  const [turns, setTurns] = useState<ChatMessage[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeIndex, setActiveIndex] = useState(0);
  const [replaying, setReplaying] = useState(false);
  const [replayError, setReplayError] = useState<string | null>(null);

  // Load turns on mount / when the picked session changes.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setActiveIndex(0);

    void (async () => {
      try {
        const payload = await fetchSessionTurns(session.id);
        if (cancelled) return;
        setTurns(payload.turns);
      } catch (err) {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return (): void => {
      cancelled = true;
    };
  }, [session.id]);

  const goPrev = useCallback(() => {
    setActiveIndex((i) => Math.max(0, i - 1));
  }, []);
  const goNext = useCallback(() => {
    setActiveIndex((i) => Math.min(Math.max(0, turns.length - 1), i + 1));
  }, [turns.length]);

  const handleReplay = useCallback(async () => {
    setReplayError(null);
    setReplaying(true);
    try {
      await replayFrom(session.id, activeIndex);
      onReplayed();
    } catch (err) {
      setReplayError(err instanceof Error ? err.message : String(err));
    } finally {
      setReplaying(false);
    }
  }, [activeIndex, onReplayed, session.id]);

  // Keyboard nav scoped to this view.
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      // Don't hijack typing in inputs.
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
        return;
      }
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        goPrev();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        goNext();
      }
    };
    window.addEventListener("keydown", handler);
    return (): void => window.removeEventListener("keydown", handler);
  }, [goPrev, goNext]);

  const onExportJson = useCallback(() => {
    downloadFile(`${session.id}.json`, exportJSON(session, turns), "application/json");
  }, [session, turns]);
  const onExportMd = useCallback(() => {
    downloadFile(`${session.id}.md`, exportMarkdown(session, turns), "text/markdown");
  }, [session, turns]);

  if (loading) {
    return <div className="replay replay--state">Loading session…</div>;
  }
  if (loadError !== null) {
    return (
      <div className="replay replay--state replay--error">
        Failed to load session: {loadError}
      </div>
    );
  }
  if (turns.length === 0) {
    return (
      <div className="replay replay--state">
        This session has no recorded turns yet.
      </div>
    );
  }

  return (
    <div className="replay">
      <div className="replay__header">
        <div className="replay__title">
          <span className="replay__id" title={session.id}>{session.id.slice(0, 8)}</span>
          <span className="replay__agent">{session.agent_name}</span>
          <span className="replay__model">{session.model}</span>
        </div>
        <div className="replay__actions">
          <button type="button" className="replay__btn" onClick={onExportJson}>
            Export JSON
          </button>
          <button type="button" className="replay__btn" onClick={onExportMd}>
            Export Markdown
          </button>
          <button
            type="button"
            className="replay__btn replay__btn--primary"
            onClick={(): void => {
              void handleReplay();
            }}
            disabled={replaying}
          >
            {replaying ? "Replaying…" : "Replay from here"}
          </button>
        </div>
      </div>

      <Timeline turns={turns} active={activeIndex} onPick={setActiveIndex} />

      <div className="replay__nav">
        <button
          type="button"
          className="replay__btn replay__btn--small"
          onClick={goPrev}
          disabled={activeIndex === 0}
        >
          ← Prev
        </button>
        <span className="replay__nav-label">
          Turn {activeIndex} of {turns.length - 1}
          <span className="replay__nav-hint"> · ←/→ to navigate</span>
        </span>
        <button
          type="button"
          className="replay__btn replay__btn--small"
          onClick={goNext}
          disabled={activeIndex === turns.length - 1}
        >
          Next →
        </button>
      </div>

      {replayError !== null ? (
        <div className="replay__inline-error" role="alert">
          {replayError}
        </div>
      ) : null}

      <TurnDetail turn={turns[activeIndex]} index={activeIndex} />
    </div>
  );
}

interface TimelineProps {
  turns: ChatMessage[];
  active: number;
  onPick: (index: number) => void;
}

/**
 * Top timeline — one dot per turn. Dots are coloured by role so a
 * conversation reads at a glance: blue user, green assistant, gray
 * tool/system.
 */
function Timeline({ turns, active, onPick }: TimelineProps) {
  return (
    <ol className="replay__timeline" role="list">
      {turns.map((turn, i) => (
        <li key={i}>
          <button
            type="button"
            className={
              "replay__dot replay__dot--" +
              roleClass(turn.role) +
              (i === active ? " replay__dot--active" : "")
            }
            onClick={(): void => onPick(i)}
            aria-label={`Turn ${i} (${turn.role})`}
            aria-current={i === active}
            title={`Turn ${i} · ${turn.role}`}
          >
            <span className="replay__dot-index">{i}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}

function roleClass(role: ChatMessage["role"]): string {
  return role === "user" ? "user" : role === "assistant" ? "assistant" : "tool";
}

interface TurnDetailProps {
  turn: ChatMessage | undefined;
  index: number;
}

/**
 * Body of the replay view — renders one turn in full.
 *
 * Tool calls and tool results render as expandable cards (collapsed by
 * default to keep the page scannable, expandable on click).
 */
function TurnDetail({ turn, index }: TurnDetailProps) {
  if (!turn) {
    return <div className="turn-detail turn-detail--empty">No turn selected.</div>;
  }
  const tokenCount =
    (turn.usage?.input_tokens ?? 0) + (turn.usage?.output_tokens ?? 0);
  return (
    <article className="turn-detail">
      <header className="turn-detail__header">
        <span className={`turn-detail__role turn-detail__role--${roleClass(turn.role)}`}>
          {turn.role}
        </span>
        <span className="turn-detail__index">Turn {index}</span>
        {tokenCount > 0 ? (
          <span className="turn-detail__tokens">
            {tokenCount} token{tokenCount === 1 ? "" : "s"}
            {turn.usage?.input_tokens !== undefined ||
            turn.usage?.output_tokens !== undefined ? (
              <span className="turn-detail__tokens-detail">
                {" "}
                ({turn.usage?.input_tokens ?? 0} in / {turn.usage?.output_tokens ?? 0} out)
              </span>
            ) : null}
          </span>
        ) : null}
      </header>
      <div className="turn-detail__body">
        {typeof turn.content === "string" ? (
          <pre className="turn-detail__text">{turn.content}</pre>
        ) : (
          turn.content.map((block, i) => <BlockView key={i} block={block} />)
        )}
      </div>
    </article>
  );
}

function BlockView({ block }: { block: MessageBlock }) {
  if (block.type === "text") {
    return <pre className="turn-detail__text">{block.text}</pre>;
  }
  if (block.type === "tool_use") {
    return (
      <ExpandableCard
        kind="tool-call"
        title={`Tool call: ${block.name}`}
        body={JSON.stringify(block.input, null, 2)}
      />
    );
  }
  // tool_result
  return (
    <ExpandableCard
      kind={block.is_error === true ? "tool-error" : "tool-result"}
      title={block.is_error === true ? "Tool error" : "Tool result"}
      body={
        typeof block.content === "string"
          ? block.content
          : JSON.stringify(block.content, null, 2)
      }
    />
  );
}

function ExpandableCard({
  kind,
  title,
  body,
}: {
  kind: "tool-call" | "tool-result" | "tool-error";
  title: string;
  body: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`turn-block turn-block--${kind}`}>
      <button
        type="button"
        className="turn-block__toggle"
        onClick={(): void => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="turn-block__chevron">{open ? "▾" : "▸"}</span>
        <span className="turn-block__title">{title}</span>
      </button>
      {open ? <pre className="turn-block__body">{body}</pre> : null}
    </div>
  );
}
