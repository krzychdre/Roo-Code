---
"tumble-code": patch
---

A failed task history store initialization no longer stays broken until the window is reloaded. Previously one transient I/O error at startup (for example a briefly full disk on a Remote SSH server) made every task operation and the whole state refresh fail forever; the extension now retries the store initialization on the next use (with a short cooldown to avoid hammering a permanently broken file system), and while the store is down the UI keeps working with an empty task history instead of throwing, with the failure reason still shown in the storage error banner. Once storage works again the task history recovers without a window reload.
