# Czystka dostawcow i odswiezenie list modeli

**Date:** 2026-08-26
**Branch:** `chore/provider-cleanup-model-refresh`
**Status:** planned

## Cel

Dwie powiazane zmiany w jednym branchu:

1. **Czystka:** wycofac 7 dostawcow (przeniesienie z `active` do `retired`), zgodnie z ustaleniem z uzytkownikiem.
2. **Odswiezenie list modeli:** zaktualizowac statyczne listy modeli u 7 glownych dostawcow, ktorzy zostaja.

## Uzasadnienie (decyzja uzytkownika 2026-08-26)

Wycofywani (redundantni / niszowi):

- `poe`, `unbound`, `requesty`, `vercel-ai-gateway` - niszowi brokerzy agregujacy cudze modele, pokrywaja sie z OpenRouter i LiteLLM, ktore zostaja jako standardy.
- `baseten`, `sambanova`, `fireworks` - platformy wnioskowania (ang. inference platform), ktorych modele sa i tak dostepne przez OpenRouter; samodzielna integracja rzadko daje przewage.

Zostaja (core): `anthropic`, `openai-native`, `openai-codex`, `gemini`, `vertex`, `bedrock`, `xai`, `deepseek`, `mistral`, `moonshot`, `minimax`, `qwen-code`, `zai`, `openrouter`, `litellm`, `ollama`, `lmstudio`, `vscode-lm`, `openai` (OpenAI Compatible), `fake-ai` (ukryty testowy), `gemini-cli` (ukryty).

## Wzorzec wycofania (potwierdzony z historii)

PR #126 (`6792f2a0b`, "Refactor/provider simplification") utworzyl rejestr `providerRegistry` i oznaczyl 8 dostawcow (`cerebras`, `chutes`, `deepinfra`, `doubao`, `featherless`, `groq`, `huggingface`, `io-intelligence`) jako `retired`. Weryfikacja w kodzie: wycofani dostawcy NIE maja zadnych plikow pomocniczych (brak handlerow, schematow, konfigow, komponentow UI, fetcherow, testow). Pozostaje TYLKO wpis w `providerRegistry` z `lifecycle: "retired"` (bez `label`, `displayOrder`, `modelSource`). Funkcja `classifyProvider()` zwraca `"retired"`, a `buildApiHandler()` rzuca `ProviderUnavailableError`. To jest wzorzec do powielenia: calkowite usuniecie plikow pomocniczych, zostawienie samego wpisu w rejestrze.

## Zasieg zmian - czystka (warstwa po warstwie)

### Warstwa 1: rejestr i typy (`packages/types`)

- `src/provider-registry.ts`: przeniesc 7 wpisow z sekcji `active` do sekcji `retired` (na koncu, po istniejacych 8). Usunac z nich `label`, `displayOrder`, `modelSource`, `featured`. Pozostawic samo `{ id, lifecycle: "retired" }`.
- `src/model-source.ts`: usunac `poe`, `unbound`, `requesty`, `vercel-ai-gateway` z `modelSourceIds` i z `modelSources` (to sa 4 z 7 wycofywanych, ktore mialy dynamiczne zrodlo modeli; `baseten`, `sambanova`, `fireworks` mieli listy statyczne i nie sa w model-source).
- `src/provider-settings.ts`: usunac schematy `poeSchema`, `requestySchema`, `unboundSchema`, `sambaNovaSchema`, `fireworksSchema`, `vercelAiGatewaySchema`, `basetenSchema` oraz ich wpisy w `providerSettingsSchemaDiscriminated` i flat `providerSettingsSchema`.
- `src/provider-config/configs.ts`: usunac `poeConfigSchema`, `requestyConfigSchema`, `unboundConfigSchema`, `basetenConfigSchema`, `fireworksConfigSchema`, `vercelAiGatewayConfigSchema`, `sambaNovaConfigSchema`.
- `src/provider-config/index.ts`: usunac importy, wpisy w `providerConfigSchemas` oraz w dyskryminowanej unii configu.
- `src/provider-profile.ts`: usunac mapowania pol profilu (`poe`, `requesty`, `unbound`, `baseten`, `sambanova`, `fireworks`, `vercel-ai-gateway`).
- `src/providers/{poe,unbound,requesty,vercel-ai-gateway,baseten,sambanova,fireworks}.ts`: usunac pliki (statyczne listy modeli / typy).
- `src/providers/index.ts`: usunac eksporty.

### Warstwa 2: runtime (`src/api`)

- `src/api/providers/{poe,unbound,requesty,vercel-ai-gateway,baseten,sambanova,fireworks}.ts`: usunac pliki handlerow.
- `src/api/providers/index.ts`: usunac eksporty handlerow (`PoeHandler`, `RequestyHandler`, `SambaNovaHandler`, `UnboundHandler`, `FireworksHandler`, `VercelAiGatewayHandler`, `BasetenHandler`).
- `src/api/providers/fetchers/{poe,unbound,requesty,vercel-ai-gateway}.ts`: usunac pliki fetcherow (`baseten`, `sambanova`, `fireworks` nie mialy fetcherow).
- `src/api/providers/fetchers/modelSourceRegistry.ts`: usunac wpisy dla `poe`, `requesty`, `unbound`, `vercel-ai-gateway` oraz odpowiadajace im galezie w funkcji wyboru fetchera.
- `src/api/runtime-provider-registry.ts`: usunac importy 7 handlerow i wpisy w `runtimeProviderFactoriesById`.

### Warstwa 3: shared i walidacja (`src/shared`)

- `src/shared/api.ts`: usunac `vercel-ai-gateway`, `poe`, `requesty`, `unbound` z unii `providerModels` (linia 27) oraz z mapy `providerModelInfo` (linie 168-172).
- `src/shared/ProfileValidator.ts`: usunac case'y `sambanova`, `fireworks`, `requesty`, `unbound` (linie 64-65, 78-81) i ewentualnie inne dla `poe`, `baseten`, `vercel-ai-gateway`.

### Warstwa 4: UI webview (`webview-ui`)

- `webview-ui/src/components/settings/provider-ui-registry.tsx`: usunac 7 wpisow z unii typow (linie 56-76) i 7 rejestracji `simpleForm` (linie 128-292).
- `webview-ui/src/components/settings/providers/{Poe,Unbound,Requesty,RequestyBalanceDisplay,SambaNova,Fireworks,VercelAiGateway,Baseten}.tsx`: usunac pliki komponentow.
- Sprawdzic `ApiOptions.tsx` i `constants.ts` pod katem resztkowych odniesien.

### Warstwa 5: CLI (`apps/cli`)

- `apps/cli/src/types/types.ts`: usunac `"vercel-ai-gateway"` z `supportedProviders` (linia 9).
- `apps/cli/src/lib/utils/provider.ts`: usunac mapowanie env `vercel-ai-gateway` (linia 10) i case w builderze configu (linie 46-48).
- `apps/cli/src/lib/utils/context-window.ts`: usunac case'y `requesty`, `unbound`, `vercel-ai-gateway` (linie 47-53).

### Warstwa 6: testy

Usunac specy dla wycofywanych dostawcow:

- `src/api/providers/__tests__/{poe,sambanova,requesty,fireworks,vercel-ai-gateway}.spec.ts`
- `src/shared/utils/__tests__/requesty.spec.ts`
- `src/api/transform/caching/__tests__/vercel-ai-gateway.spec.ts`
- `src/api/providers/fetchers/__tests__/{poe,requesty,vercel-ai-gateway}.spec.ts`
- `src/services/code-index/embedders/__tests__/vercel-ai-gateway.spec.ts`

Zaktualizowac testy uzywajace pelnej listy providerow:

- `packages/types/src/__tests__/provider-registry.spec.ts` (liczby active/retired)
- `src/api/__tests__/runtime-provider-registry.spec.ts`
- `webview-ui/src/components/settings/__tests__/ApiOptions.provider-filtering.spec.tsx` i `provider-ui-registry.spec.tsx`
- `src/shared/__tests__/ProfileValidator.spec.ts`, `checkExistApiConfig.spec.ts`
- `packages/types/src/__tests__/provider-config.spec.ts`, `provider-profile.spec.ts`, `model-source.spec.ts`

### Warstwa 7: changeset

- Dodac `.changeset/provider-cleanup.md` z `minor` (usuniecie dostawcow to zmiana semantyczna; stare profile dostaja `retired` zamiast bledu, wiec jest graceful degradation).

## Zasieg zmian - odswiezenie list modeli

Pliki w `packages/types/src/providers/` dla 7 glownych dostawcow. Stan obecny (baseline):

| Dostawca      | Najnowszy model w liscie                                 | Plik              |
| ------------- | -------------------------------------------------------- | ----------------- |
| anthropic     | `claude-fable-5`, `claude-opus-4-8`, `claude-sonnet-4-6` | `anthropic.ts`    |
| openai-native | `gpt-5.6-sol/terra/luna`, `gpt-5.5-pro`                  | `openai.ts`       |
| openai-codex  | `gpt-5.6-sol/terra/luna`                                 | `openai-codex.ts` |
| gemini        | `gemini-3.5-flash`, `gemini-3.1-pro-preview`             | `gemini.ts`       |
| xai           | `grok-4.20`, `grok-code-fast-1`                          | `xai.ts`          |
| deepseek      | `deepseek-v4-flash`, `deepseek-v4-pro`                   | `deepseek.ts`     |
| mistral       | `magistral-medium-latest`, `devstral-medium-latest`      | `mistral.ts`      |

Cutoff wiedzy modelu piszacego to maj 2026; dzis 2026-08-26. Listy wygladaja juz swiezo, ale moga istniec nowsze modele wydane po maju. Dla kazdego z 7 dostawcow weryfikacja przez dokumentacje / changelog dostawcy (kontekst7 lub crawl oficjalnej strony docs) i ewentualne dodanie nowych modeli oraz korekta `contextWindow` / `maxTokens` / `description` / `supportedParameters`. Zasada: nie usuwac modeli legacy (zostaja dla zgodnosci starych profili), dodac nowe na gorze, oznaczyc deprecacje w `description` tam gdzie dostawca to komunikuje.

## Kolejnosc wykonania

1. Utworzyc branch `chore/provider-cleanup-model-refresh` z main.
2. Zrobic czystke warstwowo (1 -> 6), commit po kazdej warstwie (lub po логicznych paczkach) zeby zachowac bisectability.
3. Odbudowac `packages/types` (`pnpm --filter @roo-code/types build`) i uruchomic typecheck, zeby zlapac wszystkie resztkowe odniesienia (kompilator wskaze kazde uzycie usunietego eksportu).
4. Usunac testy / zaktualizowac testy (warstwa 6).
5. Odswiezyc listy modeli (7 plikow), osobny commit.
6. Changeset.
7. Pelne weryfikacje: `pnpm typecheck`, `pnpm test` (lub przynajmniej zbiorka affected), `pnpm lint` / knip, budowanie VSIX.

## Ryzyka i uwagi

- **Migracja starych profili:** istniejace profile uzytkownikow z wycofywanym dostawca nadal sa rozpoznawane (ID zostaje w rejestrze jako `retired`), `classifyProvider` zwraca `"retired"`, `buildApiHandler` rzuca czytelny blad. Nie psujemy ustawien.
- **`activeProviderIdsForPublicApi`:** zawiera historyczny duplikat `deepseek`; nie ruszamy. Wycofani nie sa w tej tablicy.
- **CLI:** `vercel-ai-gateway` byl jedynym z wycofywanych na liscie `supportedProviders` CLI; po usunieciu lista ma 4 pozycje. Sprawdzic czy CLI nie ma hardcoded logiki zakladajacej >=5.
- **`RequestyBalanceDisplay.tsx`:** dodatkowy komponent UI powiazany z Requesty (wyswietlanie salda); usunac razem z `Requesty.tsx`.
- **Knip:** po usunieciu plikow knip moze zglosic nie uzywane eksporty (lub odwrotnie, brakujace); uruchomic knip na koncu.
- **Znane wczesniejsze awarie testow:** zapisane w pameci `project_cloud_web_gui_stack.md` - jesli te same testy nadal sa flaky, rozroznic od naszych zmian.
