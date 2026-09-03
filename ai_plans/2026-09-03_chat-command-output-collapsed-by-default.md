# Wynik `execute_command` w czacie ma być domyślnie zwinięty

Data: 2026-09-03
Branch: `fix/chat-command-output-collapsed` (odgałęziony od `origin/main`, commit `912839e57`)

## Problem zgłoszony przez użytkownika

Wiersz "Running" (wykonanie polecenia przez narzędzie `execute_command`) pokazuje w czacie
od razu całe wyjście polecenia. Przy poleceniach typu `diff`, `grep -r` czy `pnpm test`
jest to setki lub tysiące linii i cały czat staje się nieczytelny. Pozostałe wiersze
narzędziowe (odczyt pliku, diff edycji, wyniki wyszukiwania) są domyślnie zwinięte i
rozwijają się ikonką szewronu. Wiersz polecenia ma się zachowywać tak samo.

## Dowód, skąd bierze się rozwinięte wyjście

- `webview-ui/src/components/chat/CommandExecution.tsx:53` (przed zmianą):
  `const [isExpanded, setIsExpanded] = useState(terminalShellIntegrationDisabled)`.
  Komponent startuje rozwinięty, jeśli integracja z terminalem VS Code jest wyłączona.
- To ustawienie ma w stanie wysyłanym do webview domyślną wartość `true`:
  `src/core/webview/ClineProvider.ts:2805` i `:3063`
  (`terminalShellIntegrationDisabled: ... ?? true`). Czyli przy domyślnej konfiguracji
  każdy wiersz polecenia jest rozwinięty od razu po zamontowaniu.
- Drugie źródło: status `"fallback"` (ponowienie polecenia przez `execa` po awarii integracji
  z terminalem, `src/core/tools/ExecuteCommandTool.ts:165` i `:258`) robił
  `setIsExpanded(true)` niezależnie od woli użytkownika.
- Stan był lokalny (`useState`), a nie w mapie `expandedRows` w `ChatView.tsx:166`, z której
  korzystają pozostałe wiersze (`ChatRow` dostaje `isExpanded` i `onToggleExpand`). Lista
  czatu jest wirtualizowana (Virtuoso montuje i odmontowuje wiersze podczas przewijania),
  więc lokalny stan i tak ginął przy każdym odmontowaniu.
- Nawet w stanie "zwiniętym" stara implementacja montowała całe wyjście w DOM
  (`OutputContainer` z klasą `max-h-0 overflow-hidden`), więc konwersja sekwencji ANSI
  (kody kolorów terminala) w `TerminalOutput` wykonywała się dla każdego wiersza, także
  tego, którego nikt nie otworzył.

## Zmiana

1. `CommandExecution` dostaje dwa opcjonalne propsy: `isExpanded` (domyślnie `false`)
   i `onToggleExpand`. Nie czyta już `terminalShellIntegrationDisabled`.
2. `ChatRow.tsx` (case `ask === "command"`) przekazuje `isExpanded` i `handleToggleExpand`,
   identycznie jak `CodeAccordion` w wierszach edycji pliku. Stan rozwinięcia żyje więc w
   `ChatView.expandedRows` i przeżywa wirtualizację.
3. Wyjście renderuje się tylko gdy `isExpanded && output.length > 0`, tak jak
   `CodeAccordion` renderuje treść tylko po rozwinięciu (`CodeAccordion.tsx:118`).
   Usunięty `OutputContainer` (memo + `max-h-0`).
4. Status `"fallback"` nie rozwija już wyjścia.
5. Przycisk szewronu dostaje `aria-label` (istniejące klucze
   `chat:commandExecution.expandOutput` / `collapseOutput`, obecne we wszystkich 17 locale)
   i `aria-expanded`, co też daje testom stabilny uchwyt.

## Świadomie pominięte

- Podgląd ostatnich N linii w stanie zwiniętym: użytkownik prosił o zachowanie takie jak w
  innych wierszach, czyli zwinięte całkowicie. Można dodać później osobną gałęzią.
- Automatyczne rozwijanie, gdy polecenie kończy się błędem: to samo uzasadnienie.
- Nie ruszam wiersza `command_output` (osobny typ wiadomości `say`), bo w tym trybie
  wyjście trafia do tego samego komponentu przez `COMMAND_OUTPUT_STRING`.

## Testy

`webview-ui/src/components/chat/__tests__/CommandExecution.spec.tsx`:

- usunięty test "should expand output when terminal shell integration is disabled",
- nowy blok `output collapsing`: domyślnie zwinięte i brak `terminal-output` w DOM,
  rozwinięte przez rodzica, klik szewronu woła `onToggleExpand` bez zmiany lokalnej,
  brak przycisku gdy nie ma wyjścia,
- testy, które sprawdzają treść wyjścia, dostały `isExpanded={true}`.

Uruchomienie:
`pnpm --filter @roo-code/vscode-webview test src/components/chat/__tests__/CommandExecution.spec.tsx`
