---
"tumble-code": minor
---

- **Provider cleanup.** Seven redundant AI providers were retired: Poe, Unbound, Requesty and Vercel AI Gateway, which were niche brokers overlapping with OpenRouter and LiteLLM, plus Baseten, SambaNova and Fireworks, inference platforms whose models are reachable through OpenRouter anyway. An existing profile pointing at one of them still loads and reports that the provider is no longer supported, instead of failing outright.
- **New and updated models.** Added Claude Opus 5 and Claude Sonnet 5, with Opus 5 replacing the superseded Sonnet 4.5 as the Anthropic default; Gemini 3.7 Flash, 3.6 Flash and 3.5 Flash-Lite; Grok 4.6, 4.5 and 4.3, with 4.6 as the new xAI default; DeepSeek's experimental vision model; and Mistral Small 4, Medium 3.5, Large 3, Ministral 3 and the Z.ai GLM 5.2 passthrough.
- **Corrected model pricing.** GPT-5.6 Sol, Terra and Luna were priced well above their published rates, Luna by five times, which overstated every cost estimate on that family; DeepSeek was priced at its off-peak rates, which understated them. Both now follow the published standard rates.
- **Models retired by their providers.** Mistral's Devstral, Magistral and Pixtral entries are replaced by their actual successors now that Mistral has shut them down, three Gemini models Google has shut down are hidden from the model picker while existing profiles still resolve, and two DeepSeek compatibility aliases past their retirement date were dropped.
