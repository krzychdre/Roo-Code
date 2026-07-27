---
"tumble-code": patch
---

Suppress celebration sound when reopening a completed task from history

Previously, opening a completed task from the history list replayed the
"task completed" celebration sound because the rehydrated `clineMessages`
already end in the original `completion_result` ask, which the ChatView
sound effect treated as a fresh completion. The sound now only plays when
the `completion_result` is genuinely new — i.e. the active task did not
just switch and the last-message timestamp advanced within the same task.
