---
"tumble-code": patch
---

The "Running" command row in the chat no longer opens its output automatically. Command output (which can run to thousands of lines for a diff or a test run) now starts collapsed and is opened with the chevron, exactly like the file read and diff rows, and the expanded state is remembered by the chat view instead of being lost when the row scrolls out of view. Collapsed output is not rendered at all, so long outputs no longer cost ANSI conversion work for rows nobody opened.
