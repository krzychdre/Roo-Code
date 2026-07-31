"""How well a session went — measured, not guessed.

Tokens and cost say what a run consumed; they say nothing about whether it went
well. A run that burned 200k tokens because it worked steadily and a run that
burned 200k because it kept failing, re-reading the same files and having to be
corrected look identical on the metrics page.

Every signal here is a **deterministic marker** in the stored conversation —
never a keyword scan of tool output. That discipline is deliberate and is the
same one ``scripts/agent-bench/collect.py`` follows: test logs say "error" and
"failed" constantly, so counting the word would report noise. What is counted:

  request       an ``api_req_started`` — one model turn
  error         a ``say: error`` or an ``ask: mistake_limit_reached``
  retry         an ``api_req_retry_delayed`` — the provider pushed back
  intervention  a mid-run ``user_feedback`` — you had to step in
  completion_reply
                a ``user_feedback`` while an ``attempt_completion`` was awaiting
                an answer — you replied instead of letting the result stand
  condense      a ``condense_context`` — the run outgrew its context window
  tool          a tool or command invocation
  completion    a ``completion_result`` — the run reached an end

One further marker is stored here without being a quality signal: ``resume``,
the confirmation prompt written when a task is reopened from history. It is
classified alongside the rest because classification happens once per message,
in one place; what it is *for* is bounding the session span (see
services/task_summary), since a marker written hours after the work stopped
would otherwise be counted as the moment the task ended.

Repeated work is measured from ``tool_path``: the file each tool call touched is
stored alongside the message, so re-reading is ``total - distinct`` in the same
rollup aggregate rather than a scan.

As with services/task_summary, classification happens once per message at write
time and the task-level figures are a SUM over indexed columns, so showing them
in a list costs nothing.

There is deliberately no weighted 0-100 score. The weights would be invented,
and a single number hides which of these actually happened. The grade below is
three states with stated rules, shown next to the counts it was derived from.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Iterable, Optional

# Marker stored on each message. NULL for the vast majority — plain assistant
# text, reasoning, output and so on carry no quality signal.
KIND_REQUEST = "request"
KIND_ERROR = "error"
KIND_RETRY = "retry"
KIND_INTERVENTION = "intervention"
KIND_COMPLETION_REPLY = "completion_reply"
KIND_CONDENSE = "condense"
KIND_TOOL = "tool"
KIND_COMPLETION = "completion"
# Not a quality signal — no counter counts it and the grade never sees it. It
# marks the rows that say "the user reopened this task": a `resume_task` ask is
# the confirmation prompt the extension writes on resume, hours or days after
# the run itself stopped. Stored as a kind so services/task_summary can exclude
# them from the session span on an indexed column, without reading message text.
KIND_RESUME = "resume"

# Asks that are a resume prompt rather than part of the conversation. The
# extension takes the same view of them: TaskResumption.cleanupStaleMessages()
# splices trailing ones off the history, and taskMetadata skips them when
# looking for the last real message.
_RESUME_ASKS = {"resume_task", "resume_completed_task"}

# `say` values that count as a failure the harness itself reported.
_ERROR_SAYS = {"error", "diff_error", "rooignore_error", "api_req_failed"}
# `ask` values likewise.
_ERROR_ASKS = {"mistake_limit_reached"}
# A message of one of these kinds means the run moved on, so any
# attempt_completion before it is no longer awaiting an answer.
_RESETS_AWAITING = {"api_req_started", "text", "tool"}


def _kind_of(msg: dict) -> Optional[str]:
    """The quality marker for a message, ignoring completion-awaiting context.

    ``classify_message`` layers the sequence-dependent completion-reply rule
    on top.
    """
    if not isinstance(msg, dict):
        return None
    say = msg.get("say")
    ask = msg.get("ask")

    if ask in _RESUME_ASKS:
        return KIND_RESUME
    if ask in _ERROR_ASKS:
        return KIND_ERROR
    if say in _ERROR_SAYS:
        return KIND_ERROR
    if say == "api_req_retry_delayed":
        return KIND_RETRY
    if say == "api_req_started":
        return KIND_REQUEST
    if say == "condense_context":
        return KIND_CONDENSE
    if say in ("user_feedback", "user_feedback_diff"):
        return KIND_INTERVENTION
    if say == "completion_result":
        return KIND_COMPLETION
    if say in ("tool", "command") or ask in ("tool", "command", "use_mcp_server"):
        return KIND_TOOL
    return None


def tool_path_of(msg: dict) -> Optional[str]:
    """The file a tool call touched, for measuring repeated work.

    Stored per message so "how often did it re-read the same file?" is
    ``count - count(distinct)`` in the rollup, with no scan and no set held in
    memory. Only tool messages carry one.
    """
    if not isinstance(msg, dict):
        return None
    if _kind_of(msg) != KIND_TOOL:
        return None
    text = msg.get("text")
    if not isinstance(text, str) or not text.strip().startswith("{"):
        return None
    try:
        obj = json.loads(text)
    except (json.JSONDecodeError, TypeError):
        return None
    if not isinstance(obj, dict):
        return None
    path = obj.get("path")
    if not isinstance(path, str) or not path.strip():
        return None
    tool = obj.get("tool")
    # Keyed by tool as well as path: reading a file and then editing it is not
    # repeated work, whereas reading it twice is.
    return f"{tool}:{path}" if isinstance(tool, str) else path


def classify_message(msg: dict, awaiting_completion: bool = False) -> Optional[str]:
    """The marker for a message, given whether a completion is awaiting an answer.

    The only sequence-dependent rule: a ``user_feedback`` that arrives while an
    ``attempt_completion`` is on the table is a reply to that *result*, not an
    ordinary mid-run correction.

    Deliberately NOT called a rejection, and deliberately kept out of the grade.
    Replying to a finished result covers both "that is wrong, try again" and
    "good, now also do this" — ``scripts/agent-bench/collect.py`` makes the same
    point about its ``rej_completion`` column: pushback *or* follow-up, not a
    defect count. On the live corpus this fires 160 times against 104 mid-run
    corrections, and counting it as friction moved 17 of 236 runs out of
    "clean" on a reading the data does not support.
    """
    kind = _kind_of(msg)
    if kind == KIND_INTERVENTION and awaiting_completion:
        return KIND_COMPLETION_REPLY
    return kind


def awaiting_after(msg: dict, previous: bool) -> bool:
    """Whether a completion is awaiting an answer after this message.

    Set by an ``attempt_completion`` (as either the say or the ask); cleared as
    soon as the run does anything else — another request, more text, a tool.
    """
    if not isinstance(msg, dict):
        return previous
    say, ask = msg.get("say"), msg.get("ask")
    if say == "completion_result" or ask == "completion_result":
        return True
    if say in _RESETS_AWAITING or ask in _RESETS_AWAITING:
        return False
    return previous


def classify_conversation(messages: Iterable[dict]) -> list[tuple[Optional[str], Optional[str]]]:
    """(kind, tool_path) for each message, in order. Used by the backfill path.

    Sequence order matters for the completion-reply rule, so this walks the
    whole conversation rather than mapping over it.
    """
    out: list[tuple[Optional[str], Optional[str]]] = []
    awaiting = False
    for msg in messages:
        out.append((classify_message(msg, awaiting), tool_path_of(msg)))
        awaiting = awaiting_after(msg, awaiting)
    return out


# --- grading ---------------------------------------------------------------

GRADE_CLEAN = "clean"
GRADE_FRICTION = "friction"
GRADE_UNFINISHED = "unfinished"

GRADE_LABELS = {
    GRADE_CLEAN: "Clean",
    GRADE_FRICTION: "Friction",
    GRADE_UNFINISHED: "Unfinished",
}


@dataclass(frozen=True)
class Quality:
    """A task's quality signals, plus what they add up to."""

    requests: int = 0
    errors: int = 0
    retries: int = 0
    interventions: int = 0
    completion_replies: int = 0
    condense: int = 0
    tools: int = 0
    tool_paths: int = 0
    distinct_tool_paths: int = 0
    completed: bool = False

    @property
    def repeated_work(self) -> int:
        """Tool calls that touched a file this run had already touched the same way."""
        return max(0, self.tool_paths - self.distinct_tool_paths)

    @property
    def friction_events(self) -> int:
        """Everything that went other than smoothly, as one count.

        ``completion_replies`` is excluded on purpose — see ``classify_message``.
        Answering a finished result is as often "now also do this" as it is
        "that is wrong", so folding it in here would grade ordinary follow-up
        work as friction.
        """
        return (
            self.errors
            + self.retries
            + self.interventions
            + self.condense
            + self.repeated_work
        )

    @property
    def grade(self) -> str:
        """Three states, each from a stated rule — no invented weighting.

        unfinished  the run never produced a result
        clean       it finished with nothing going wrong along the way
        friction    it finished, but something did
        """
        if not self.completed:
            return GRADE_UNFINISHED
        return GRADE_CLEAN if self.friction_events == 0 else GRADE_FRICTION

    @property
    def grade_label(self) -> str:
        return GRADE_LABELS[self.grade]

    def reasons(self) -> list[str]:
        """Plain-language account of what happened during the run.

        Shown next to the grade so the badge is never a verdict the reader has
        to take on trust. Everything that fed the grade comes first; the
        completion replies are appended after, because they are context rather
        than a reason for the grade (see ``friction_events``).
        """
        out = []
        if not self.completed:
            out.append("no result was reached")
        if self.interventions:
            out.append(
                f"{self.interventions} correction{'' if self.interventions == 1 else 's'} from you"
            )
        if self.errors:
            out.append(f"{self.errors} error{'' if self.errors == 1 else 's'}")
        if self.retries:
            out.append(f"{self.retries} provider retr{'y' if self.retries == 1 else 'ies'}")
        if self.condense:
            out.append(
                f"context condensed {self.condense} time{'' if self.condense == 1 else 's'}"
            )
        if self.repeated_work:
            out.append(f"{self.repeated_work} repeated tool call{'' if self.repeated_work == 1 else 's'}")
        if not out:
            out.append("nothing went wrong")
        if self.completion_replies:
            out.append(
                f"you replied to {self.completion_replies} finished "
                f"result{'' if self.completion_replies == 1 else 's'}"
            )
        return out


def quality_of(task) -> Quality:
    """Read the stored per-task figures off a Task row."""
    return Quality(
        requests=task.q_requests or 0,
        errors=task.q_errors or 0,
        retries=task.q_retries or 0,
        interventions=task.q_interventions or 0,
        completion_replies=task.q_completion_replies or 0,
        condense=task.q_condense or 0,
        tools=task.q_tools or 0,
        tool_paths=task.q_tool_paths or 0,
        distinct_tool_paths=task.q_distinct_tool_paths or 0,
        completed=bool(task.q_completed),
    )
