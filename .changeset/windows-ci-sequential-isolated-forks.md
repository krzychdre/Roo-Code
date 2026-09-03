---
"tumble-code": patch
---

The Windows CI unit test job no longer times out. Its vitest pool ran all test files in one process without per-file isolation (singleFork), so leaked globals, stray timers and unbounded heap growth accumulated until whole test files froze at the 20 second limit. Test files now still run one at a time on Windows CI but each in a fresh process. The memory background writers also bail out early when auto memory is disabled, which removes the "autoDream trigger failed" noise from the Task test logs.
