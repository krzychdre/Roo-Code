<div align="center">
<sub>

<b>English</b> • [Català](locales/ca/CONTRIBUTING.md) • [Deutsch](locales/de/CONTRIBUTING.md) • [Español](locales/es/CONTRIBUTING.md) • [Français](locales/fr/CONTRIBUTING.md) • [हिंदी](locales/hi/CONTRIBUTING.md) • [Bahasa Indonesia](locales/id/CONTRIBUTING.md) • [Italiano](locales/it/CONTRIBUTING.md) • [日本語](locales/ja/CONTRIBUTING.md)

</sub>
<sub>

[한국어](locales/ko/CONTRIBUTING.md) • [Nederlands](locales/nl/CONTRIBUTING.md) • [Polski](locales/pl/CONTRIBUTING.md) • [Português (BR)](locales/pt-BR/CONTRIBUTING.md) • [Русский](locales/ru/CONTRIBUTING.md) • [Türkçe](locales/tr/CONTRIBUTING.md) • [Tiếng Việt](locales/vi/CONTRIBUTING.md) • [简体中文](locales/zh-CN/CONTRIBUTING.md) • [繁體中文](locales/zh-TW/CONTRIBUTING.md)

</sub>
</div>

# Contributing to Tumble Code

Tumble Code is a community-driven fork of [Roo Code](https://github.com/RooCodeInc/Roo-Code), and we deeply value every contribution. To streamline collaboration, we operate on an [Issue-First](#issue-first-approach) basis, meaning all [Pull Requests (PRs)](#submitting-a-pull-request) must first be linked to a GitHub Issue. Please review this guide carefully.

## Table of Contents

- [Before You Contribute](#before-you-contribute)
- [Finding & Planning Your Contribution](#finding--planning-your-contribution)
- [Development & Submission Process](#development--submission-process)
- [Legal](#legal)

## Before You Contribute

### 1. Code of Conduct

All contributors must adhere to our [Code of Conduct](./CODE_OF_CONDUCT.md).

### 2. Project Direction

Tumble Code inherits Roo Code's focus areas and extends them. Align your contributions with:

### Reliability First

- Ensure diff editing and command execution are consistently reliable.
- Reduce friction points that deter regular usage.
- Guarantee smooth operation across all locales and platforms.
- Expand robust support for a wide variety of AI providers and models.

### Enhanced User Experience

- Streamline the UI/UX for clarity and intuitiveness.
- Continuously improve the workflow to meet the high expectations developers have for daily-use tools.

### Leading on Agent Performance

- Establish comprehensive evaluation benchmarks (evals) to measure real-world productivity.
- Make it easy for everyone to easily run and interpret these evals.
- Ship improvements that demonstrate clear increases in eval scores.

Mention alignment with these areas in your PRs.

## Finding & Planning Your Contribution

### Types of Contributions

- **Bug Fixes:** Addressing code issues.
- **New Features:** Adding functionality.
- **Documentation:** Improving guides and clarity.

### Issue-First Approach

All contributions start with a GitHub Issue.

<!-- External issue-tracking guidance is hidden until contact channels are set up.
- **Check existing issues**: Search [GitHub Issues](https://github.com/krzychdre/tumble-code/issues).
- **Create an issue** describing:
    - **Enhancements:** plain-language description focused on user benefit.
    - **Bugs:** minimal repro + expected vs actual + version.
- **Want to work on it?** Comment "Claiming" on the issue to signal intent before opening a PR.
- **PRs must link to the issue.** Unlinked PRs may be closed.
-->

### Reporting Bugs

- Check for existing reports first.
- Create a new bug report with: - Clear, numbered reproduction steps - Expected vs actual result - Tumble Code version (required); API provider/model if relevant
      <!-- - **Security issues**: Report privately via [security advisories](https://github.com/krzychdre/tumble-code/security/advisories/new). -->

## Development & Submission Process

### Development Setup

1. **Fork & Clone:**

```
git clone https://github.com/YOUR_USERNAME/tumble-code.git
```

2. **Install Dependencies:**

```
pnpm install
```

3. **Debugging:** Open with VS Code (`F5`).

### Writing Code Guidelines

- One focused PR per feature or fix.
- Follow ESLint and TypeScript best practices.
- Write clear, descriptive commits referencing issues (e.g., `Fixes #123`).
- Provide thorough testing (`pnpm test`).
- Rebase onto the latest `main` branch before submission.

### KV-cache contract (any change the model can see)

Every request re-sends the whole system prompt. Providers avoid paying for it twice by caching
the request's key/value tensors ("KV cache") and reusing them up to the first byte that differs
from the cached request. llama.cpp does this locally, Z.ai/GLM and DeepSeek-style endpoints do it
remotely. One changed byte near the top throws away the cache for everything below it, so the
byte layout of the prompt is a performance feature, not cosmetics.

The prompt is assembled in [`src/core/prompts/system.ts`](src/core/prompts/system.ts) as two
lists:

- **Stable prefix** (`stableHead`): identity opener, markdown rules, tool-use protocol, output
  efficiency, objective, capabilities, system information, memory. These bytes are identical for
  every mode and every profile on one workspace and machine.
- **Variable tail** (`variableTail`): MCP availability, modes list, skills, rules, the mode's MODE
  section, user custom instructions, and last of all the deferred-tool catalog. These bytes may
  differ per mode, profile or user.

Four rules:

1. **A new section defaults to the TAIL.** It may only go into the stable head if it is proven to
   be independent of the mode, the model, the profile and the request, and it must never embed a
   timestamp, a random value, a set/map iteration order or a locale-dependent sort.
2. **A section that can change WITHIN one conversation goes at the very end of the tail.** Today
   that is the deferred-tool catalog, which shrinks on every `tools_load` call. Whatever is printed
   after such a section is re-prefilled every time it changes, so nothing should be.
3. **Do not reorder the head casually.** `src/core/prompts/__tests__/prefix-stability.spec.ts`
   asserts byte stability, section order and the measured cross-mode shared prefix; update its
   snapshot and its `MIN_SHARED_PREFIX_BYTES` floor only with a reason in the commit message.
4. **State the KV-cache effect in the commit message** of any PR that changes model-visible text
   (prompt sections, tool descriptions, tool schemas, tool ordering). Use one of:
    - `KV-cache: prefix-stable` - existing request prefixes are unchanged;
    - `KV-cache: append-only` - content is only added after everything already cached;
    - `KV-cache: one-time prefix invalidation` - existing conversations re-prefill once, with the
      reason why that is worth it.

### Submitting a Pull Request

- Begin as a **Draft PR** if seeking early feedback.
- Clearly describe your changes following the Pull Request Template.
- Link the issue in the PR description/title (e.g., "Fixes #123").
- Provide screenshots/videos for UI changes.
- Indicate if documentation updates are necessary.

### Pull Request Policy

- Must reference an open GitHub Issue.
- Unlinked PRs may be closed.
- PRs should pass CI tests, align with the project direction, and have clear documentation.

### Review Process

- Iterate promptly based on maintainer feedback.

## Legal

By contributing, you agree your contributions will be licensed under the Apache 2.0 License, consistent with Tumble Code's licensing (which inherits from the upstream Roo Code Apache 2.0 license).
