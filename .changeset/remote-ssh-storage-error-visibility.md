---
"tumble-code": patch
---

Storage failures are no longer silent. When the task history store or a provider profile save fails (for example a full disk, an exceeded quota or a read-only file system, which is easy to hit in Remote SSH windows where the storage lives on the server), the extension now shows a persistent red banner with the underlying cause above the chat and in the settings view, with a "Show logs" shortcut that opens the extension's Output channel. The banner disappears once storage works again. Error toasts for saving, renaming and loading provider profiles and for opening a task now also include the actual failure reason instead of a generic message.
