---
"tumble-code": patch
---

The system prompt's operating system line is resolved once per session instead of on every request. On Windows the lookup shells out synchronously to `wmic` (or to PowerShell where wmic no longer exists) to tell desktop and Server editions apart, which froze the extension host for seconds before each API call. The Task unit tests that were meant to stub the system prompt now stub the method the API loop actually calls, so they no longer build the real prompt (and no longer hit that shell-out on Windows CI).
