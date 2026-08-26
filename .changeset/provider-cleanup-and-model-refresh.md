---
"tumble-code": minor
---

Retire seven redundant AI providers and refresh the model lists of the rest.

Poe, Unbound, Requesty and Vercel AI Gateway were niche brokers overlapping with
OpenRouter and LiteLLM, and Baseten, SambaNova and Fireworks were inference
platforms whose models are reachable through OpenRouter anyway. All seven are
now retired: existing profiles still parse and fail with the standard
"no longer supported" message instead of breaking.

Model lists are updated against current provider documentation:

- **Anthropic**: adds Claude Opus 5 and Claude Sonnet 5, and moves the default
  off the superseded Sonnet 4.5.
- **OpenAI**: corrects GPT-5.6 Sol, Terra and Luna pricing, which was well above
  the published rates (Luna by 5x).
- **Google Gemini**: adds Gemini 3.7 Flash, 3.6 Flash and 3.5 Flash-Lite, and
  flags three models Google has shut down so the picker hides them.
- **xAI**: adds Grok 4.6, 4.5 and 4.3, with 4.6 as the new default.
- **DeepSeek**: prices now follow the published standard rates rather than
  stale off-peak figures, adds the experimental vision model, and drops the two
  compatibility aliases past their retirement date.
- **Mistral**: replaces the retired Devstral, Magistral and Pixtral entries with
  their actual successors, including Mistral Small 4 and Ministral 3 14B.
