# Odświeżenie providera Z.ai: GLM-5.3, modele Turbo i korekta cen

Data: 2026-08-26
Gałąź: `feat/zai-model-refresh-glm-5-3` (odbita od `main`)

## Problem

Lista modeli Z.ai w `packages/types/src/providers/zai.ts` rozjechała się z ofertą
dostawcy. Weryfikacja wobec żywej dokumentacji (pobranej 2026-08-26) wykazała cztery
rozbieżności.

Źródła dowodowe:

- https://docs.z.ai/guides/overview/pricing (cennik linii międzynarodowej, USD)
- https://open.bigmodel.cn/pricing (cennik linii chińskiej, CNY)
- https://docs.z.ai/guides/llm/glm-5.3
- https://docs.z.ai/guides/llm/glm-5-turbo
- https://docs.z.ai/guides/vlm/glm-5v-turbo
- https://docs.z.ai/guides/capabilities/thinking (macierz obsługi `thinking` i `reasoning_effort`)

### 1. Brakujące modele

Dokumentacja wymienia trzy modele nieobecne w repo:

| Model          | Kontekst | Maks. wyjście | Modalność              |
| -------------- | -------- | ------------- | ---------------------- |
| `glm-5.3`      | 1M       | 128K          | tekst                  |
| `glm-5-turbo`  | 200K     | 128K          | tekst                  |
| `glm-5v-turbo` | 200K     | 128K          | obraz/wideo/plik/tekst |

`glm-5.3` jest obecnym flagowcem: ten sam model bazowy co `glm-5.2`, ale całość
zysku pochodzi z post-treningu (deklarowane +50% na Z.ai Code Bench).

### 2. Błędna cena `glm-5` na linii międzynarodowej

Repo podawało 0,6 / 2,2 USD za milion tokenów (kopia cennika `glm-4.6`), podczas gdy
cennik Z.ai podaje 1,0 / 3,2 USD przy cache read 0,2 USD.

### 3. Przestarzałe ceny linii chińskiej

Wpisy `glm-5`, `glm-5.1` i `glm-5.2` niosły ceny sprzed podwyżki. `glm-5.1` miał
wartości odpowiadające dawnym 4,8 / 16 / 0,9 CNY, a aktualny cennik to 6 / 24 / 1,3 CNY
w progu podstawowym.

### 4. Nieaktualny komentarz TODO przy `glm-5.2`

Komentarz twierdził, że cena jest tymczasowo skopiowana z `glm-5.1`. Cennik potwierdza,
że 1,4 / 4,4 / 0,26 USD to faktyczna cena `glm-5.2`, więc TODO było już nieprawdą.

## Pułapka techniczna: GLM-5.3 nie pozwala wyłączyć rozumowania

To jest istotna część zmiany, nie kosmetyka. Dokumentacja stwierdza wprost:

> GLM-5.3 no longer supports disabling thinking (an error will occur if the
> `thinking.type` parameter in the API request is set to `disabled`).

Tymczasem oba miejsca w kodzie, które składają żądanie do modeli GLM, bezwarunkowo
wysyłają `thinking: { type: "disabled" }`, gdy użytkownik wyłączy rozumowanie:

- `src/api/providers/zai.ts` w `createStreamWithThinking()` (dedykowany provider Z.ai)
- `src/api/providers/openai.ts` w `addGLMThinkingIfNeeded()` (generyczna ścieżka
  OpenAI-compatible, wykrywająca modele GLM po nazwie)

Samo dopisanie modelu do listy dałoby więc wpis, który wywala się błędem HTTP przy
wyłączonym rozumowaniu. Dodatkowo istnieje druga droga do tego samego błędu: zapisane
wcześniej w ustawieniach `reasoningEffort: "disable"` przechodziło przez istniejącą
gałąź awaryjną nietknięte, bo warunek podmiany brzmiał `raw !== "disable"`.

GLM-5.3 przyjmuje wyłącznie poziomy `low`, `high` i `max`, domyślnie `max`.
Poziom `medium`, którego używają starsze wpisy GLM, dla tego modelu jest błędem.

## Rozwiązanie

### Warstwa danych (`packages/types/src/providers/zai.ts`)

1. Dodanie `glm-5.3`, `glm-5-turbo` i `glm-5v-turbo` na obu liniach.
2. `glm-5.3` dostaje `supportsReasoningEffort: ["low", "high", "max"]`, czyli listę
   **bez** wartości `"disable"`. To jest nośnik informacji dla handlera, że tego modelu
   nie wolno prosić o wyłączenie rozumowania. Domyślny poziom to `"max"`.
3. Korekta cen wymienionych wyżej i usunięcie nieaktualnego TODO.
4. Zmiana modelu domyślnego z `glm-4.7` na `glm-5.3` na obu liniach.

Przeliczenie cennika chińskiego: kurs 7,0 CNY za dolara, wartość z progu
podstawowego (długość wejścia poniżej 32 tysięcy tokenów). Ta sama konwencja, którą
niosły dotychczasowe wpisy `glm-4.7` (2 / 8 / 0,4 CNY dawało dokładnie 0,29 / 1,14 / 0,057 USD).

### Warstwa transportu

`zai.ts`: wyliczenie `canDisableReasoning` z tablicy `supportsReasoningEffort`.
Gdy model nie dopuszcza wyłączenia, globalny przełącznik rozumowania oraz zapisana
wartość `"disable"` są ignorowane, a żądanie idzie z `thinking: { type: "enabled" }`
i domyślnym poziomem modelu.

`openai.ts`: analogiczne zabezpieczenie oparte na nazwie modelu, bo w tej ścieżce
metadane modelu pochodzą od użytkownika i mogą w ogóle nie mieć pola
`supportsReasoningEffort`.

## Świadomie pominięte

Linia chińska ma cennik progowy (inna stawka powyżej 32 tysięcy tokenów wejścia).
Repo ma już mechanizm `longContextPricing`, używany przez modele OpenAI i honorowany
w `src/shared/cost.ts`, więc dałoby się to odwzorować dokładnie. Nie robię tego w tej
zmianie, bo dotknęłoby to sposobu liczenia kosztu również dla modeli, które nie były
przedmiotem zgłoszenia. Zostaje jako osobna, samodzielna poprawka.

W `openai.ts` gałąź `useMediumOrHigher` nie zna poziomu `max`, więc dla GLM-5.3
wysyła `{ type: "enabled" }` bez `clear_thinking: false`. Parametr `clear_thinking`
jest udokumentowany dla GLM-4.7, a jego semantyka dla GLM-5.3 nie jest opisana, więc
nie zgaduję.

## Weryfikacja

- `packages/types`: kompilacja typów (`as const satisfies Record<string, ModelInfo>`
  wyłapuje literówki w polach).
- `src/api/providers/__tests__/zai.spec.ts`: testy dla nowych modeli, w tym dowód, że
  przy wyłączonym rozumowaniu GLM-5.3 nadal dostaje `thinking: { type: "enabled" }`.
- `src/api/providers/__tests__/openai.spec.ts`: ten sam dowód dla ścieżki
  OpenAI-compatible.
