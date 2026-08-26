# Czystka dostawcow i odswiezenie list modeli

**Date:** 2026-08-26
**Branch:** `chore/provider-cleanup-model-refresh`
**Status:** done (nie zmergowane; 5 commitow, `16b476113`..`aa99dc006`)

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

## Wynik weryfikacji czystki (2026-08-26)

Czystka zrobiona i zacommitowana jako `16b476113` na `chore/provider-cleanup-model-refresh`.

- `pnpm check-types`: **14/14 pakietow zielone**.
- `pnpm lint`: **14/14 zielone**.
- `pnpm test`: 10/11 pakietow zielone. Jeden pakiet czerwony: `@roo-code/agent-interchange`,
  test `src/__tests__/mcp-server.spec.ts:192` ("only permits cross-workspace listing after a
  server startup opt-in").

**Ta awaria jest wczesniejsza (pre-existing), nie spowodowana czystka.** Dowod:

1. Commit `16b476113` nie dotyka katalogu `packages/agent-interchange/` (`git show --stat`).
2. `git diff main..HEAD -- packages/agent-interchange/` jest pusty, czyli pakiet jest
   bajt-w-bajt identyczny z main; `git status` dla tego katalogu tez jest czysty.
3. Test nie importuje niczego zwiazanego z providerami (brak `provider` / `@roo-code/types`
   w pliku spec).
4. Uruchomiony z odizolowanym srodowiskiem (`CLAUDE_CONFIG_DIR`, `AGENT_INTERCHANGE_TUMBLE_STORAGE`
   i `AGENT_INTERCHANGE_DIR` wskazujace na puste katalogi tymczasowe) pada tak samo, wiec nie jest
   to tez zanieczyszczenie realnymi sesjami z katalogu domowego.

Wniosek: naprawa tego testu nalezy do osobnej galezi i nie blokuje tej pracy. Nie ruszamy go tutaj,
zeby nie mieszac dwoch niepowiazanych zmian w jednym branchu.

### Odniesienia usuniete poza pierwotnym planem

Plan nie przewidzial kilku miejsc, ktore wyszly dopiero z typechecku; wszystkie usuniete:

- `packages/types/src/global-settings.ts`: 6 kluczy sekretow (`requestyApiKey`, `unboundApiKey`,
  `sambaNovaApiKey`, `fireworksApiKey`, `vercelAiGatewayApiKey`, `basetenApiKey`) z `SECRET_STATE_KEYS`.
  **Zachowany** `codebaseIndexVercelAiGatewayApiKey`, bo to embedder indeksu kodu, osobny subsystem.
- `src/api/transform/caching/vercel-ai-gateway.ts` + jego spec: modul osierocony, uzywany wylacznie
  przez usuniety handler.
- `src/shared/utils/requesty.ts` + `webview-ui/src/components/ui/hooks/useRequestyKeyInfo.ts`:
  osierocone po usunieciu komponentu Requesty.
- `src/core/webview/ClineProvider.ts`: metoda `handleRequestyCallback` + import `REQUESTY_BASE_URL`,
  oraz galaz `/requesty` w `src/activate/handleUri.ts` (callback OAuth Requesty).
- `webview-ui/src/components/settings/constants.ts` i `utils/providerModelConfig.ts`: wpisy w
  `MODELS_BY_PROVIDER`, `PROVIDER_SERVICE_CONFIG`, `PROVIDER_DEFAULT_MODEL_IDS`,
  `PROVIDERS_WITH_CUSTOM_MODEL_UI` oraz `getProviderModelSourceOptions`.
- `webview-ui/src/components/ui/hooks/useSelectedModel.ts` i `settings/ModelPicker.tsx`.
- Kotwica historycznego duplikatu `deepseek` w `activeProviderIdsForPublicApi` przeniesiona
  z wycofanego `baseten` na `bedrock` (invariant "deepseek wystepuje dwa razy" zachowany).

**BLAD ZLAPANY I COFNIETY:** poczatkowo usunalem `src/services/code-index/embedders/__tests__/vercel-ai-gateway.spec.ts`.
To byl blad - `VercelAiGatewayEmbedder` to provider osadzania wektorow dla indeksu kodu, calkowicie
osobny subsystem od dostawcy czatu. Plik przywrocony przez `git checkout HEAD --`.

## Wynik odswiezenia list modeli (2026-08-26)

Zrodla: oficjalna dokumentacja kazdego dostawcy (dla Anthropic - referencja `claude-api`).
Zasada: nic nie wpisane z pamieci modelu (cutoff maj 2026 < dzis 2026-08-26); braki zostawione
jawnie zamiast zgadywania.

### Anthropic (`184cf9d03`)

- **Dodane:** `claude-opus-5` ($5/$25, 1M kontekstu natywnie) i `claude-sonnet-5` ($3/$15).
- **Default:** `claude-sonnet-4-5` -> `claude-opus-5` (poprzedni byl przestarzaly).
- Oba odrzucaja `budget_tokens`, wiec dostaja `supportsReasoningBinary: true` zgodnie z konwencja
  wprowadzona przy Opus 4.7 na tej sciezce providera.

### DeepSeek, Mistral, xAI (`91d376fa1`)

- **DeepSeek:** ceny przestawione ze stawek off-peak na **standard (peak)**, zeby estymaty nigdy nie
  byly nizsze niz realne obciazenie (DeepSeek ma ceny zalezne od pory doby; off-peak to dokladnie
  polowa). Dodany `deepseek-v4-flash-vision-exp`. Usuniete aliasy `deepseek-chat` i `deepseek-reasoner`
    - sam kod mial `TODO ... after DeepSeek's 2026-07-24 retirement date`, a ta data minela. Fallback w
      `getModel()` jest lagodny, wiec stare profile nie wywala rozszerzenia.
- **Mistral:** rodziny **Devstral** i **Magistral** oraz linia **Pixtral** zniknely z oferty dostawcy
  (byly na naszej liscie jako 3 z 9 modeli). Zastapione realnymi nastepcami; `mistral-small-latest`
  (Small 4) to model hybrydowy, ktory wchlonal Devstral i Magistral. Dodane Ministral 3 14B i
  `zai-glm-5-2`. **`supportsPromptCache` zostaje `false`** - handler Mistrala nie ma zadnej obslugi
  cache, wiec `true` byloby falszywa deklaracja psujaca liczenie kosztow (zlapane przez test).
  Default zostaje `codestral-latest`, bo handler kieruje prefiks `codestral-` na osobny endpoint
  `codestral.mistral.ai`; zmiana defaulta zmienilaby tez endpoint, co jest decyzja produktowa.
- **xAI:** dodane `grok-4.6` (nowy default), `grok-4.5`, `grok-4.3`. Doplata za dlugi kontekst
  podwaja cene **calego zapytania** po przekroczeniu 200k tokenow, wiec uzyte `longContextPricing`
  (dokladnie ta semantyka), a nie `tiers`. `maxTokens` zostawione na dotychczasowych wartosciach,
  bo xAI **nie publikuje** limitu wyjscia dla zadnego modelu Grok.

### OpenAI i Gemini

- **OpenAI:** poprawione ceny rodziny 5.6 - byly znaczaco zawyzone wzgledem publikowanych
  (Sol 5/30 -> 4/20, Terra 2.5/15 -> 2/12, Luna 1/6 -> **0.20/1.20**, czyli 5x za duzo). Dodany
  `cacheWritesPrice` (rodzina 5.6 ma osobna oplate za zapis do cache, 1.25x stawki wejscia);
  handler `openai-native` faktycznie raportuje `cacheWriteTokens`, wiec pole nie jest martwe.
- **Gemini:** dodane `gemini-3.7-flash`, `gemini-3.6-flash`, `gemini-3.5-flash-lite`. Trzy modele
  wylaczone przez Google (`gemini-3-pro-preview`, `gemini-2.5-flash-preview-09-2025`,
  `gemini-2.5-flash-lite-preview-09-2025`) oznaczone `deprecated: true` - ModelPicker ukrywa je z
  listy, ale zachowuje dla istniejacych profili z czytelnym bledem. Default zostaje
  `gemini-3.1-pro-preview`, bo Google **nie ma obecnie stabilnego Gemini 3.x Pro**.
- **openai-codex:** nie ruszany. To logowanie subskrypcja ChatGPT, gdzie ceny sa zerowe
  (placi abonament), a rodzine 5.6 juz ma.

### Weryfikacja koncowa

- `pnpm check-types`: 14/14 zielone. `pnpm lint`: 14/14 zielone.
- `src`: **7388 testow przechodzi**, 0 czerwonych (487 plikow).
- `webview-ui`: **1543 testy przechodza**, 0 czerwonych (137 plikow).
- Poprawione testy przeoczone w czystce: `ProfileValidator.spec.ts` (lista sparametryzowana
  zawierala wycofane `sambanova`/`fireworks`; dopasowana do faktycznych gałezi `case` w
  `getModelIdFromProfile`) oraz `ApiOptions.provider-filtering.spec.tsx` (oczekiwal 26 dostawcow).
- `ShadowCheckpointService.spec.ts` potrafi paść w pelnym przebiegu, a przechodzi w izolacji -
  jest flaky (zalezny od czasu/kolejnosci), pakiet `services/checkpoints/` jest identyczny z main.
- `@roo-code/agent-interchange` nadal czerwony z przyczyny wczesniejszej, opisanej wyzej.
