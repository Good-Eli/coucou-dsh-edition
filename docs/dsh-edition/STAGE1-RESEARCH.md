# Coucou × DeepSeek Harness — Этап 1: техническое исследование

**Дата:** 2026-11-11  
**Статус:** Этап 1 завершён, Этап 2 — в отдельном файле `STAGE2-DESIGN.md`.  
**Что изменено:** ничего в исходниках, GitHub, установленном приложении и конфигурациях.
Разрешены только две технические вещи, без которых исследование не шло: (1) рабочей папке
`C:\LocalAI\сoucou` добавлено право полного доступа для текущего пользователя (иначе
песочница DSH не могла запускать команды; откат — командой из
`C:\LocalAI\coucou-acl-recovery\`), (2) в `.research/` скачаны копии исходников и распакован
`app.asar` DSH для чтения. Обе операции обратимы и не затрагивают приложения.

---

## 0. Резюме

1. **Coucou 0.5.9** — Tauri 2 (Rust + TypeScript без фреймворка). Остров — одно прозрачное
   always-on-top окно `island` (логически 720×320), привязанное к **верху по центру** выбранного
   монитора. Позиционирование снизу/слева/справа и перетаскивание в коде отсутствуют — это
   придётся добавлять (Этап 3), но вся математика мониторов, DPI и work area уже есть.
2. Разрешения в Coucou — это **релей** `coucou-hook.exe`, который агент запускает как свой hook.
   Релей открывает именованный канал `\\.\pipe\coucou-<SID>`, ждёт решения острова и печатает
   ответ в формате конкретного агента. **Без клика ничего не разрешается**, при отсутствии ответа
   релей молчит, и агент спрашивает в своём терминале.
3. **DSH 0.2.2-rc.1** — Electron-оболочка + отдельный Node-процесс хоста (`dsh-desktop-host`,
   это тот же `dsh --profile desktop`), ядро на Cordis-плагинах. Профиль —
   `%USERPROFILE%\.dsh\profiles\desktop` (`package.json` + `cordis.patch.yml`).
4. У DSH есть **штатная точка разрешений**: waterfall-событие `approval/request` с исходами
   `allowed-once | rejected | cancelled | unavailable`. Политики только `ask` и `never`.
   **Allow always не существует** — значит, кнопку «Allow always» показывать нельзя.
5. Запрос разрешения DSH **не содержит аргументов инструмента** (только имя, `callId`, причину).
   Аргументы (команда, файлы) нужно брать из ранее записанного `tool/call` по `callId`.
6. **ACP у DSH есть** (`dsh-acp`, ACP v1: `session/new`, `session/prompt`,
   `session/set_config_option`, `session/request_permission`, `session/update`…), но он
   **обслуживает только собственные сессии ACP-процесса** и не видит сессии настольного
   приложения. Плюс на этой машине нет CLI `dsh` — ACP-сервер запускать нечем, кроме
   внутренних путей `app.asar`.
7. Поэтому главный сценарий («видеть и подтверждать работу DSH в настольном приложении»)
   закрывается только **плагином внутри хоста DSH**, который через локальный канал отдаёт
   Coucou состояние, события, разрешения и переключение модели/усилия. ACP остаётся
   документированным стандартным путём для будущего режима «Coucou сам ведёт сессию».
8. Каталог моделей и усилий берётся из `ctx.llm.listProviders()/listModels()`; для
   `deepseek-account` усилия — `off/low/high/max`, имена и бейджи приходят из
   `GET https://api.deepseek.com/models`. Жёсткий список моделей не нужен.
9. Смена модели/усилия — `agent.model.select({provider, model, reasoningEffort})`: только
   выбранная сессия, только следующий неподготовленный шаг, глобальные настройки не меняются.
   ACP делает то же через `session/set_config_option`.
10. **Фактическую модель на стороне провайдера** DSH не знает и не сообщает. Это надо явно
    писать «не сообщается провайдером», а не выдавать выбранную за фактическую.
11. На машине уже работает **самодельный мост** `dsh-bridge` (автозапуск, только наблюдение,
    без разрешений), и он прямо сейчас кормит остров событиями этой сессии. Новую интеграцию
    нужно с ним развести, а не включать одновременно.
12. Для Этапа 3 **нет инструментов сборки**: не установлены Rust, MSVC Build Tools, npm.
    Есть Node 24.21 и pnpm внутри DSH. GitHub CLI и git-identity тоже нет. Это блокеры,
    которые нужно закрыть до начала разработки.

---

## 1. Метод и источники

Изучались:

| Источник | Версия / коммит | Как получен |
|---|---|---|
| `github.com/Louis-CFM/coucou` | `main` = `b1bc09de7f7c24a80bd8eca5729b8bee60f66402`, тег `windows-v0.5.9` = `74363634` | tarball GitHub, распакован в `.research/coucou-main` |
| Coucou, установленный | 0.5.9 (MSI `{8213F4CF-…}`), `%LOCALAPPDATA%\Coucou` | чтение файлов, реестра, лога |
| DSH desktop | 0.2.2-rc.1 (FileVersion 0.2.2.0) | `app.asar` распакован в `.research/dsh-asar` (20 519 файлов) |
| DSH runtime | Node 24.21.0, pnpm 11.28.5 | `resources/runtime/primary-runtime` |
| DSH user data | `%USERPROFILE%\.dsh` | профили, сессии, логи (без `.credentials.yaml`) |
| Рабочие логи | `%LOCALAPPDATA%\Coucou\coucou.log`, `dsh-bridge.log` | чтение |

Документация DSH — это README каждого пакета внутри `app.asar` (они подробные и
версионированы вместе с кодом). Ссылки ниже даются на распакованные пути
`.research/dsh-asar/dsh/node_modules/@deepseek-ai/...`.

Ограничение: ACP-сервер и SDK-сервер **не запускались** (нет CLI), их поведение изучено по
исходникам и README, а не по живому обмену. Это помечено в разделе «Риски».

---

## 2. Coucou

### 2.1 Репозиторий, лицензия, версии

- Лицензия кода — **MIT** (`LICENSE`, Copyright 2026 Louis Raillé). Форк, изменение и личное
  использование разрешены.
- Отдельный файл `LICENSE-ASSETS.md` **исключает из MIT** имена «Coucou» и «Mochi», персонажа,
  иконку, звуки и медиа. Публиковать форк под этими именем/иконкой/персонажем нельзя без
  письменного разрешения; для личной сборки ограничений нет, но **релизы форка** надо либо
  делать приватными, либо переименовывать продукт и заменять ассеты. Это влияет на
  архитектуру обновлений (раздел 2.7).
- Версия в `windows/package.json` и `src-tauri/tauri.conf.json` — **0.5.9**; установленная
  версия совпадает. Upstream-тег `windows-v0.5.9`.
- Структура: `NotchBuddy/` (macOS/iOS), `windows/` (Tauri, Windows+Linux), `android/`,
  `relay/`, `docs/`, `design/`. Нас интересует только `windows/`.

`windows/`:

```
src/                 фронтенд (TypeScript, без фреймворка)
  core/              состояние, мосты, диффы, настройки, обновления
  island/            конечный автомат острова, хуки агентов, интеграции
  views/             все карточки острова
  settings/          окно настроек
  mochi/             персонаж на Canvas
src-tauri/           Rust: окно, named pipe, хуки, API, поллеры
hook/                coucou-hook.exe — релей
tests/               43 файла node:test
scripts/             иконки, упаковка
```

### 2.2 Технологический стек и сборка

- **Tauri 2**, Rust-бэкенд, фронтенд собирается Vite 6 + TypeScript 5.6.
- `npm run build` = `tsc --noEmit && vite build`.
- `npm run tauri dev` — разработка; `npm run pack` = `tauri build && node scripts/pack.mjs`
  (NSIS + MSI, кладёт в `windows/release/`).
- Перед сборкой `predev`/`prebuild` собирают `coucou-hook` (`cargo build --release -p coucou-hook`),
  а `tauri.conf.json` кладёт `coucou-hook.exe` в ресурсы бандла.
- Идентификатор приложения: `fr.louisraille.coucou`; окно `island` — 240×6 стартово,
  `transparent`, `alwaysOnTop`, `skipTaskbar`, `focus:false`, `decorations:false`,
  `dragDropEnabled:false`.
- Настройки и данные — **не** в каталоге идентификатора, а жёстко в `%APPDATA%\Coucou`
  (`platform/windows.rs:60`) и `%LOCALAPPDATA%\Coucou` (`:68`). Это важно для side-by-side:
  две сборки будут делить настройки, канал и данные.

### 2.3 Остров: окно, геометрия, монитор, DPI

`src-tauri/src/island.rs`:

- `PANEL_W=720`, `PANEL_H=320` — полный размер окна; `STRIP_W=240`, `STRIP_H=6` — невидимая
  полоса «разбудить», когда остров скрыт.
- В развёрнутом виде окно 720×320 логических; когда остров свёрнут, фронтенд присылает
  фактический размер (`clamp_collapsed`), и окно ресайзится/позиционируется
  (`apply_geometry`, строки 428–469).
- Текущее позиционирование: **центр по горизонтали, верх монитора**:
  `x = monitor.x + (monitor.width - panelWidth)/2`, `y = monitor.y + top_inset(monitor)`,
  где `top_inset` учитывает панель задач сверху через `monitor.work_area()`.
- Монитор выбирается настройкой `screen`: `"primary"`, `"cursor"` или `at:<x>,<y>|name|WxH`
  (`DisplayId`, строки 183–215). Для мультимонитора уже есть `target_monitor`,
  `monitor_choices`, `pin_to_monitor`, учёт `scale_factor` при конвертации физических
  координат в логические.
- Клик-сквозность: поток опроса курсора (`PollGate`) решает, пропускать ли клик, по фигуре
  острова, которую присылает фронтенд (`IslandRect`); окно при этом остаётся прозрачным.

**Вывод:** для требования C нужно добавить режим размещения (bottom-left / bottom-right /
custom), смещения, перетаскивание и сохранение, а также изменить точку привязки контента
(остров должен «расти» вверх/вправо). Механика мониторов/DPI/work area уже готова.

### 2.4 Named pipe и протокол релея

`src-tauri/src/pipe.rs`:

- Windows: `\\.\pipe\coucou-<SID пользователя>` (`pipe_name()`, строки 70–74), один экземпляр
  на соединение, `first_pipe_instance(true)` — второй Coucou не перехватит канал.
- Клиент (релей) присылает **одну JSON-строку** с `hook_event_name` и полями события.
- Сервер эмитит в окно острова Tauri-событие `"hook"`.
- Для `PermissionRequest` сервер:
  1. даёт острову **800 мс** на подтверждение «карточка на экране» (`ACK_TIMEOUT`);
  2. затем ждёт клик до **108 с** (`DECISION_TIMEOUT`, чуть меньше 110 с релея);
  3. пишет в канал **ровно одну строку** `allow` / `deny` / `{"answers":…}`;
  4. если решения нет — **не пишет ничего**, а острову шлёт `approval-expired`.
- Есть отдельная ветка Antigravity `PreToolUse` (`agy_pre_tool`), где ответы `pending/allow/deny/ask`.

`hook/src/main.rs` + `hook/src/reply.rs`:

- Релей даёт соединению 300 мс и завершается, если Coucou закрыт/медленный.
- `reply::stdout()` — единственное место, где формируется ответ конкретному агенту;
  `takes_decisions()` перечисляет агентов, которым остров вообще может отвечать
  (`""` Claude Code, `codex`, `copilot`, `muse`, `claude-desktop`, `opencode`).
- Правило: **ничего разрешающего без клика**. Без решения — пусто, `{}` или `"ask"`.

### 2.5 Агенты, хуки и карточки разрешений

- `src/island/agents.ts` — каталог внешних агентов (`KNOWN_AGENTS`), цвета, `takesCard`,
  `validateAgent` (имя пилюли: строчные, цифры, дефис, ≤24 символов, `claude` зарезервирован).
- `src/island/hooks.ts` — приём событий:
  - `PermissionRequest` → карточка `approval` или `question`;
  - очередь максимум `MAX_PENDING=5`; таймаут карточки 110 с;
  - если тот же запрос уже показан — повторный ack;
  - `settledElsewhere()` снимает карточку, если ход закончился/пришёл `PostToolUse` по тому же
    инструменту;
  - `Stop` → `finished`, `StopFailure` → `error`, `SessionEnd` → убрать/обнулить пилюлю;
  - диффы Edit/MultiEdit/Write, шаги, звуки, бейджи.
- `src-tauri/src/hooks.rs` — установка хуков Claude Code: точный diff, датированная резервная
  копия, `fingerprint` (не перезаписывать файл, если он изменился между предпросмотром и
  записью), откат удаляет только свои записи. Таймаут `PermissionRequest` — 120 с.
- `src-tauri/src/agents.rs` (60 КБ) — установщики хуков для Codex, Copilot, Muse, Gemini,
  Antigravity, Cursor, OpenCode, Amp, Hermes; тот же `config_file`-механизм.
- `src/island/agents.ts` + `views` — внешний агент получает пилюлю `agent_<name>`; одна пилюля
  на агента, несколько сессий делят её (это ограничение уже известно).

**Вывод:** механизм «агент → пилюля → карточка» полностью подходит для DSH. Но чтобы получить
разрешения, DSH должен уметь вызвать релей и дождаться ответа; внешнего hook-механизма,
который понимает релей Coucou, у DSH нет, поэтому контракт релея для DSH не годится — нужен
отдельный канал (Этап 2).

### 2.6 Настройки

`src-tauri/src/settings.rs` — плоский JSON `%APPDATA%\Coucou\settings.json`, поля в camelCase,
недостающие берутся из `Default` (обратная совместимость). Ключевые для нас поля:
`sound_enabled`, `open_on_hover`, `active_integrations`, `main_pill`, `screen`, `autostart`,
`closed_island`, `agy_approvals_enabled` и т. д.

Фронтенд настроек: `src/settings/main.ts` (64 КБ) + `src/hub/` — страницы (`PageId`), секции;
`src/settings/agents.ts` — общий блок агентов с предпросмотром diff, бэкапом и подтверждением.

**Вывод:** добавление новых полей и новой страницы «DeepSeek Harness» — стандартная задача,
рисков для старых настроек нет, если новые поля имеют `Default` и не меняют семантику старых.

### 2.7 Обновления

`src-tauri/src/update.rs`:

- `RELEASES_URL = https://api.github.com/repos/Louis-CFM/coucou/releases?per_page=30`,
  `RELEASES_PAGE = https://github.com/Louis-CFM/coucou/releases`;
- теги только `windows-vX.Y.Z` / `linux-vX.Y.Z`, `windows-latest` игнорируется;
- скачивание только с `github.com`, `api.github.com`, `*.githubusercontent.com`, проверка
  SHA-256 из поля `digest` релиза;
- установка: `setup.exe /P /UPDATE /R` или `msiexec /i … /passive AUTOLAUNCHAPP=True`.

**Критично:** в форке нельзя оставлять этот URL — иначе приложение предложит и поставит
оригинальную сборку поверх модифицированной. Нужен свой источник (форк или отключённый
автоапдейт) и отказ от установки версий без нашего маркера.

### 2.8 Тесты

`windows/tests` — 43 файла `node:test` (хуки, fsm, диффы, настройки, обновления, i18n,
телефон, Spotify, whatsapp…). Запуск: `npm test` (`node --import ./tests/setup.mjs --test
"tests/**/*.test.mjs"`). `hooks.test.mjs` (39 КБ) — эталон для тестов разрешений.
Rust-тесты — внутри модулей (`#[cfg(test)]`), запускаются `cargo test`.

### 2.9 Что важно для нашей задачи (Coucou)

| Требование | Что уже есть | Что нужно |
|---|---|---|
| Состояние агента | пилюля, `AgentTask.state`, звуки | отдельный DSH-слой состояния |
| Активность | шаги, диффы, финальная строка | шаги/модель/сессия из DSH |
| Разрешения | карточка, очередь, ack, таймауты, fail-closed | новый источник запросов (DSH-мост) |
| Позиция | top-center, выбор монитора, DPI | режимы, смещения, drag, сохранение |
| Модель/усилие | нет | новая модель данных + UI + переключение |
| Настройки | страницы, секции, предпросмотр diff | страница DSH + установка плагина |
| Обновления | GitHub-релизы Louis-CFM | свой канал + защита от оригинала |

---

## 3. DeepSeek Harness

### 3.1 Что установлено и как устроено

- `%LOCALAPPDATA%\Programs\DeepSeek Harness\DeepSeek Harness.exe` — Electron-оболочка,
  версия **0.2.2-rc.1**.
- Внутри `resources/app.asar`:
  - `lib/main.js` — Electron main (окна, tray, обновления, `dsh://open`, политики);
  - `dsh/node_modules/@deepseek-ai/*` — **~300 пакетов** ядра DSH (agents, sessions, llm,
    tools, approval, web, acp, sdk, plugin-manager…);
  - `renderer/` — веб-клиент.
- **Хост — отдельный Node-процесс**: Electron запускает
  `dsh-desktop-host/lib/index.js` с `ELECTRON_RUN_AS_NODE=1`; тот вызывает
  `runProfile({ profile: "desktop", … })` через `loadProfileDirectory`. Фактически это
  `dsh` с профилем `desktop`; `cli.js` того же пакета — отдельный вход для CLI-команд
  Desktop. Веб-интерфейс общается с хостом по WebSocket/HTTP.
- Веб-сервер на `http://127.0.0.1:<port>` (сейчас `61720`) требует токен: без него
  `401 Unauthorized: dsh web authentication required; reopen the URL printed by dsh web`.
  Это закрывает путь «просто подключиться к API из Coucou».
- Node 24.21 и pnpm 11.28.5 лежат в `resources/runtime/primary-runtime/dependencies`;
  отдельного `dsh` в PATH **нет**, npm **нет**.

### 3.2 Профили, патчи, плагины

- Профиль: `%USERPROFILE%\.dsh\profiles\<name>` (`package.json` с `dsh.profile.bundles` +
  `cordis.patch.yml`).
- `desktop`: бандлы `@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`; пользовательский
  `cordis.patch.yml` уже используется (в нём модель `deepseek-account/deepseek-flash`,
  `reasoningEffort: max`, отключение некоторых UI-плагинов).
- Патч — YAML-массив: замена конфига по `id`, `disabled`, `insert` новых записей,
  `!!js`-выражения. Слои: бандлы → профильный патч → **домашний** патч (перекрывает
  профильный).
- Loader (`@cordisjs/plugin-loader`) импортирует запись по `name`: относительный спецификатор
  разрешается от файла конфигурации, поддерживаются абсолютные URL. Это позволяет добавить
  **локальный плагин** одной строкой `insert` без установки пакета и без правки
  `package.json`.
- HMR: в `desktop` не отключён, поэтому правка патча может примениться без перезапуска;
  для установки плагина это плюс, для предсказуемости — риск (нужен явный «применить»).
- `dsh-plugin-manager` управляет бандлами (пакетами с `dsh.bundle.patch`), а не отдельными
  локальными файлами; наш путь — именно строка `insert` в патче.

### 3.3 Сервисы Cordis, которые нужны мосту

| Сервис | Что даёт | Подтверждение |
|---|---|---|
| `ctx.agents` | `list()`, `get(id)`, `roots()`, `create()`, `resume()`; живой `Agent` | `dsh-agent/README.md:32` |
| `agent.model` | `current()` → `{provider, model, reasoningEffort?}`; `select({provider, model, reasoningEffort?})` | `dsh-agent/README.md:48–52` |
| `ctx.sessions` | журнал сессий, `session/event`, `session/created`, `session/disposed` | `dsh-session/README.md:28,34` |
| `ctx.approval` | `request()`, `setPolicy()`, `effectivePolicy()`; waterfall `approval/request` | `dsh-user-approval/lib/types/index.js:137–219` |
| `ctx.sessionProjections` | проекции состояния (в т.ч. `approvalState`, `modelSelection`) | `dsh-user-approval`, `dsh-session` |
| `ctx.llm` | `listProviders()`, `listModels(provider)`, `resolveModelInfo()` | `dsh-llm/README.md:28,59,89` |

### 3.4 События и журнал сессии

Журнал: `%USERPROFILE%\.dsh\sessions\<workspace>\<session>\session.v4.jsonl.zstd` —
append-only JSONL, каждый флаш — отдельный zstd-фрейм. В живой сессии (эта самая) записи:

```
tool/call, tool/result, job/registered, job/settled, step/start, step/end,
assistant/message, user/message, assistant/attempt, llm/retry, llm/retry-started,
permission/preset, sandbox/mode, approval/policy, agent-preset/selected,
approval/asked, approval/decided, command/run, command/done, session,
session/end-seed, model/selection, turn/start, system/message,
request/header, request/context, session/title, working-directory/change
```

Полезное для моста:

| Запись | Данные |
|---|---|
| `session` | `id`, `cwd`, `createdAt`, `agentPreset`, `delegationDepth` |
| `turn/start` / `turn/end` | `turn`, время, причина завершения/ошибка |
| `user/message` | `source.kind == "user"` — только настоящий ввод человека |
| `tool/call` | `callId`, `name`, `arguments` (JSON-строка) |
| `tool/result` | `toolCallId`, `isError`, содержимое |
| `model/selection` | `{provider, model, reasoningEffort}` |
| `request/header` | `config: {provider, model, reasoningEffort, maxTokens}` |
| `request/context` | `contextWindow` |
| `approval/asked` | `id`, `toolName`, `callId?`, `reason?` |
| `approval/decided` | `id`, `outcome` |
| `approval/policy` | `ask` / `never` |
| `sandbox/mode` | `read-only` / `workspace-write` / `danger-full-access` |

Это же множество событий доступно плагину через `session/event` без чтения файла.
Чтение журнала (как делает текущий мост) — надёжный, но **только наблюдательный** путь:
записать решение в журнал нельзя.

### 3.5 Approval seam (штатная система разрешений)

`@deepseek-ai/dsh-user-approval`:

- `ctx.approval.request({ agent, toolName, callId?, reason?, signal? })` → исход.
- Перед вызовом answerers проверяется политика сессии: `never` → детерминированный
  `rejected`, **до** любых слушателей (обойти нельзя).
- Answerer — waterfall-слушатель `approval/request`:
  `(req, next) => Promise<outcome>`; вернуть исход или вызвать `next()`.
- Исходы: `allowed-once`, `rejected`, `cancelled`, `unavailable`.
  **`allowed-once` — единственный вид разрешения.** «Allow always», запоминания правил,
  отзыва грантов и хранилища разрешений нет (`README.md:163–168`).
- При отсутствии/падении answerer — `unavailable`, то есть **fail-closed**.
- Запрос валиден только внутри открытого хода; отмена (`signal`) даёт `cancelled`,
  поздний ответ отбрасывается.
- В запросе **нет аргументов инструмента**: только `toolName`, `callId`, `reason`.
- Аудит: `approval/asked` и `approval/decided` пишутся в журнал сессии.
- В настольном приложении answerer — это веб-клиент: `dsh-client-ui-approval/lib/client.js`
  подписан на forward-событие `approval/request` через `ctx.remote.$on`; в хосте
  `dsh-api-remotes` объявляет его как waterfall. Значит, если наш плагин вернёт `next()`,
  карточку покажет штатный интерфейс DSH.

### 3.6 ACP

Пакет `@deepseek-ai/dsh-acp` (README — `.research/dsh-asar/dsh/node_modules/@deepseek-ai/dsh-acp/README.md`),
сервер stdio JSON-RPC, профиль `acp` (`dsh --profile acp`).

Поддерживаемые методы (ACP v1):

| Метод | Что даёт |
|---|---|
| `initialize` | ACP v1 + `session/list`, `session/resume`, `session/close`, MCP HTTP |
| `session/new` | новая **своя** сессия с абсолютным `cwd`, MCP, полным состоянием config options |
| `session/list` | страницы сохранённых корневых сессий (фильтр по `cwd`) |
| `session/resume` | восстановить сохранённую неактивную сессию |
| `session/close` | корректно закрыть |
| `session/set_config_option` | `model` или `reasoning_effort`, возвращает полное новое состояние |
| `session/prompt` | один prompt за раз (текст, resource links, изображения) |
| `session/cancel` | отмена |
| `session/update` | committed assistant/thought, tool lifecycle, config changes, usage |
| `session/request_permission` | запрос разрешения с одним allow/reject |

Что **не** поддерживается (важно): `session/load`, удаление, fork, дополнительные каталоги,
режимы, команды, планы, терминалы, клиентские файловые операции, elicitation. Заголовки
сессий ACP не отдаёт (title surface нет).

Формат config options:

- `id: "model"` — select, значения `provider/model` (opaque, из живого каталога), `name` —
  отображаемое имя модели, `group` — провайдер; `currentValue`.
- `id: "reasoning_effort"` — select, значения — id усилий **конкретной модели** плюс `""`
  (default провайдера), только если модель объявляет усилия.
- Смена применяется со следующего шага; уже подготовленный шаг и его ретраи сохраняют
  прежний выбор.

Разрешение в ACP:

```json
{
  "sessionId": "...",
  "toolCall": { "toolCallId": "call_…" },
  "options": [
    { "optionId": "allow-once", "name": "Allow once", "kind": "allow_once" },
    { "optionId": "reject-once", "name": "Reject", "kind": "reject_once" }
  ]
}
```

Обратите внимание: DSH присылает в `toolCall` **только `toolCallId`**, без title/rawInput.
Детали (название, аргументы, файлы) клиент узнаёт раньше из `session/update` → `tool_call`
(`rawInput`, `title`, `kind: "other"`) и сопоставляет по `toolCallId`.

Ограничения ACP для нашей задачи:

1. Он обслуживает **только сессии, созданные/возобновлённые через ACP**. Сессии настольного
   приложения он не видит и не может к ним подключиться.
2. На машине **нет CLI `dsh`**; запуск ACP-сервера возможен только через внутренние пути
   `app.asar`/Electron, что не является документированным способом и может сломаться при
   обновлении DSH.
3. Нет `session/load` и нет способа «показать сессию в настольном UI».
4. Профиль `acp` по умолчанию использует `deepseek-official/deepseek-v4-flash`; на этой машине
   рабочая учётная запись — `deepseek-account`, поэтому провайдера/модель пришлось бы
   переопределять.

### 3.7 SDK JSON-RPC

`@deepseek-ai/dsh-sdk-jsonrpc-server` — stdio JSON-RPC, профиль `sdk`. Умеет
`initialize` (provider/model/effort/maxTokens), `session/prompt`, `session/query`,
`session/wait`, `session/resume`, `shutdown`; при `initialize.approvalRequests: true`
пересылает `approval/request` клиенту (только `allowed-once|rejected|cancelled`) и
поддерживает user-questions. Ограничения: нет закрытия отдельной сессии и отмены prompt;
сессии живут до завершения процесса. Как и ACP — отдельный процесс, не настольные сессии.

### 3.8 API gateway

`@deepseek-ai/dsh-api-gateway` — внутренний типизированный RPC (WebSocket `/api/remote.mux`),
которым пользуется веб-клиент. Есть понятие peer: owner (браузер владельца) и non-owner;
для не-owner вызовы проходят через `dsh-api-remote-access` (политики, ресурсы).
Аутентификация веб-сервера — токен из URL, который печатает `dsh web`; без него 401.
Это **не документированный внешний API** и не подходит для стороннего приложения: чтобы стать
owner, нужно украсть токен у окна, а non-owner требует регистрации политики в хосте.

### 3.9 Каталог моделей и усилий

- `ctx.llm.listProviders()` → маршруты (например, `deepseek-account`).
- `ctx.llm.listModels(providerId)` → записи `{ id, name, description?, reasoning: {
  efforts: [{ id, name? }], defaultEffort? }, contextWindow, … }`.
- Для `deepseek-account` каталог приходит из `GET https://api.deepseek.com/models`
  с токеном аккаунта; при недоступности — встроенный каталог версии:
  `deepseek-flash` и `deepseek-v4-pro` (`dsh-llm-deepseek-account/README.md:32`).
- Имя модели и бейдж — из listing (`name`, `client_metadata["deepseek-harness"].badge`);
  `id` — идентификатор для API.
- Усилия для account-маршрута: **всегда `off`, `low`, `high`, `max`**; уровни из listing
  игнорируются (`README.md:36`). Для других адаптеров набор может быть иным — брать только
  из каталога.
- Провайдер в Catallog — это маршрут (`deepseek-account`), а не «DeepSeek»; отображаемое имя
  провайдера, если оно есть, берётся из записи провайдера, иначе показывается id.

### 3.10 Смена модели и усилия

- `agent.model.current()` — текущий выбор (pending → последний запрос → опции агента).
- `agent.model.select({ provider, model, reasoningEffort? })` — назначает выбор для
  следующего шага, подготовка которого ещё не началась. Если выбор равен текущему —
  no-op; изменение пишется в журнал как `model/selection`.
- Уже подготовленный шаг (и его ретраи) сохраняют прежний выбор — это надо показывать
  в UI как «выбрано, применится к следующему шагу».
- `agentDefaultModel.saveSelection()` меняет **глобальную** настройку новых агентов — нам
  это запрещено; используем только `agent.model.select()`.

### 3.11 «Фактическая» модель

DSH знает и журналирует только `provider` + `model` (id) + `reasoningEffort`. Ни ACP, ни
сеансовый журнал, ни каталог не сообщают, какую модель реально обслуживает провайдер за этим
id. Значит, в интерфейсе надо разделять:

- **выбрано пользователем/сессией** — `provider/model/effort` из `model/selection`;
- **фактически используется DSH** — то же самое, зафиксированное в `request/header` шага;
- **обслуживается провайдером** — **неизвестно**, явно писать «провайдер не сообщает».

### 3.12 Запуск, остановка, переход к сессии

- Запуск: `DeepSeek Harness.exe`; повторный запуск фокусирует существующее окно.
- Есть протокол `dsh://open` — фокусирует главное окно (`lib/main.js:21270–21274`).
- **Deep link на конкретную сессию отсутствует**: `dsh://open` не принимает id.
- Остановка: приложение корректно завершается через своё меню/подтверждение; внешнего
  документированного «quit» API нет. Если DSH запустил Coucou, он может управлять
  процессом; если DSH уже работал — только вежливое закрытие окна (WM_CLOSE), что вызовет
  штатный диалог подтверждения.

---

## 4. Матрица возможностей

| Возможность | Журнал + релей (текущий мост) | ACP | Плагин в хосте DSH | API gateway |
|---|---|---|---|---|
| Видеть **настольные** сессии | да (с задержкой) | нет | **да** | да, но нужен owner-токен |
| Состояние хода/шага | да | да (свои сессии) | **да** | да |
| Аргументы инструмента | да (из `tool/call`) | да (`tool_call.rawInput`) | **да** (кэш `tool/call`) | да |
| Разрешения: показать | нет | да | **да** | да |
| Разрешения: ответить | нет | да | **да** | да |
| Allow always | — | нет | **нет (не поддерживается)** | нет |
| Модель/усилие: читать | частично (журнал) | да | **да** | да |
| Модель/усилие: менять | нет | да | **да** (`agent.model.select`) | да |
| Создать/возобновить сессию | нет | да | нет (можно `agents.create`) | да |
| Открыть UI DSH | да (запуск) | — | да | — |
| Перейти к сессии | нет | нет | **нет** (нет deep link) | да (внутри UI) |
| Без правки профиля DSH | да | да | **нет** (нужна строка патча) | да |
| Устойчивость к обновлениям DSH | высокая | высокая | средняя (внутренние сервисы) | низкая |

---

## 5. Что уже установлено на машине

1. **Coucou 0.5.9** установлен в `%LOCALAPPDATA%\Coucou`, автозапуск
   `HKCU\…\Run\Coucou`, канал `\\.\pipe\coucou-<SID>` существует, в `coucou.log` идут
   события `hook …` — приложение запущено и принимает события.
2. **Самодельный мост** `%LOCALAPPDATA%\Coucou\dsh-bridge\`:
   - `bridge.js` читает журналы сессий DSH и вызывает `coucou-hook.exe --agent deepseek-harness`;
   - автозапуск `HKCU\…\Run\CoucouDshBridge` → `wscript.exe start-bridge-hidden.vbs`;
   - лог `dsh-bridge.log`, события в `coucou.log`;
   - **только наблюдение**, без Allow/Deny; несколько сессий делят одну пилюлю; задержка
     0.4–0.8 с; не работает из песочницы.
   - исходники этого моста — в
     `C:\Users\vsiof\OneDrive\Документы\deepseek-harness\default-workspace\tools\dsh-coucou-bridge\`
     (README, install/uninstall, тест).
   Это ценная заготовка и одновременно то, что нужно будет **аккуратно выключить** при
   включении новой интеграции, иначе события задвоятся.
3. **DSH desktop** запущен, веб-интерфейс `http://127.0.0.1:61720` отвечает 401 без токена.
4. **Инструменты сборки отсутствуют**: нет `cargo`, `rustc`, MSVC Build Tools, npm, gh CLI;
   git identity не настроена. Есть Node 24.21 и pnpm внутри DSH.
5. **Сеть**: внутри песочницы DSH TLS Windows (SChannel) не работает
   (`SEC_E_NO_CREDENTIALS`) — git с `http.sslBackend=openssl` и Node-fetch работают;
   без песочницы `curl` к GitHub/npm отвечает 200. Сборку и загрузку зависимостей придётся
   выполнять вне песочницы (или в сессии с полным доступом).
6. Свободно ~134 ГБ — достаточно для Rust + MSVC + артефактов.

---

## 6. Выводы Этапа 1

1. **Coucou пригоден для интеграции без переписывания**: пилюли, карточки, очередь,
   таймауты, fail-closed, настройки с предпросмотром diff и бэкапом уже есть.
2. **Штатный путь разрешений DSH — `approval/request`**; он не даёт аргументов и не умеет
   allow-always. Это ограничения DSH, а не Coucou, и их нельзя «дорисовать» в UI.
3. **ACP не решает главный сценарий**: он про сессии, которыми управляет ACP-клиент, а не про
   настольное приложение. Держать его как второй транспорт разумно, но начинать с него —
   значит не увидеть текущую работу пользователя.
4. **Плагин в хосте DSH** — единственный способ получить полный набор: состояние, активность,
   аргументы, разрешения, модель/усилие и переключение — для тех сессий, которые пользователь
   реально ведёт.
5. **Позиционирование острова** — самая «механическая» часть: математика мониторов и DPI уже
   есть, нужно добавить режимы, смещения, drag и сохранение, не трогая анимации.
6. **Обновления** — обязательная правка: иначе форк сам себе поставит оригинал.
7. **Сборка** — главный внешний блокер Этапа 3: тулчейна нет.

Проект Этапа 2 — в `STAGE2-DESIGN.md`.
