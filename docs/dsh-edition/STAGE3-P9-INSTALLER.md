# Шаг 8: установщик моста. И удаление оригинала

**Дата:** 2026-11-13  
**Точка отката:** `9c73be963f7af27c32320ff718d1724f6f1158ba`

## 1. Оригинальный Coucou и старый мост удалены

Сначала выяснил, что удалять. Старый `dsh-bridge` — отдельный адаптер
(`bridge.js` + `zstd-frame.js`), который кормил пилюли **оригинального** Coucou
через пайп `coucou-<sid>`. Мой форк его не использует: у него свой плагин
`dsh-plugin/bridge.mjs` и свой пайп.

**Важно:** штатный `uninstall.exe` не годится — мой плагин живёт внутри папки
оригинала, в `%LOCALAPPDATA%\Coucou\dsh\`. Деинсталлятор снёс бы его и сломал
форк. Поэтому удалял выборочно.

### Что удалено

```
bin\                    (старый coucou-hook.exe)
dsh-bridge\             (bridge.js, start-bridge.ps1, start-bridge-hidden.vbs, zstd-frame.js)
Flow\                   (prefs.json)
inbox\
coucou.exe              32.9 МБ
coucou-hook.exe
coucou.log, dsh-bridge.log, recap.json
uninstall.exe, Uninstall Coucou.lnk
```

Плюс:

- ключ автозапуска `Coucou` (`...\coucou.exe --autostart`);
- ключ автозапуска `CoucouDshBridge` (`wscript.exe ... start-bridge-hidden.vbs`);
- запись деинсталлятора `HKCU\...\Uninstall\Coucou`;
- ярлык в меню «Пуск».

### Что сохранено

- `%LOCALAPPDATA%\Coucou\dsh\` — мой плагин, `pipe-host.mjs`, `secure-pipe.mjs`,
  `state-acl.mjs` и папка состояния. Без этого форк теряет интеграцию.
- `%APPDATA%\Coucou\settings.json` — настройки оригинала (не мешают, форк
  использует `Coucou-dsh-test`).

### Резервная копия

`C:\LocalAI\t\pre-delete-20261113-183528\` — 26 файлов, 32.4 МБ: обе папки
(`LocalAppData-Coucou`, `Roaming-Coucou`), `Run.reg`, список ключей деинсталляции.

Манифест удалённого: `C:\LocalAI\t\deleted-manifest.txt`.

### Проверено

```
C:\...\Coucou\coucou.exe     → False
C:\...\Coucou\dsh-bridge     → False
C:\...\Coucou\uninstall.exe  → False
Run\Coucou, Run\CoucouDshBridge → пусто
```

Форк после удаления запускался и подключался: `dsh: connected (version
0.2.2-rc.1, approvals on, 4 session(s))`.

## 2. Шаг 8: установщик моста

Новый модуль `src-tauri/src/dsh/install.rs` и секция в настройках
(страница «Агенты» → «DeepSeek Harness»).

| Что | Как |
|---|---|
| Кнопка «Установить» | пишет три модуля в `%LOCALAPPDATA%\Coucou\dsh\plugin\` и добавляет одну запись в `cordis.patch.yml` |
| Кнопка «Удалить» | убирает запись, модули оставляет |
| Бэкап | перед каждой правкой — `backups/cordis.patch.yml.<ts>.bak` |
| Статус | «Подключён» / «Установлен, DSH не запущен» / «Не установлен» / причина, если профиля нет |

Плагин **встроен в бинарник** (`include_str!`), поэтому установленная копия
всегда совпадает с версией приложения.

### Главное в правке профиля

Файл — пользовательский, и в том же списке `insert` лежит чужая запись
(`plusvibe-search-adapter`). Поэтому файл **не переписывается**: он правится
построчно, трогаются только строки записи моста, всё остальное остаётся
байт-в-байт.

10 тестов, включая `the_real_profile_survives_a_round_trip`, который берёт
**настоящий** `cordis.patch.yml` с этой машины и проверяет, что после
«удалить → установить» ни одна чужая строка не потерялась.

Этот тест сразу поймал дефект в самом тесте (фильтр считал строку `name:`
принадлежащей не мосту) — то есть проверка работает.

## 3. Что сломалось по моей вине

**Мост сейчас не работает.** Чтобы проверить установщик, я удалил запись моста
из профиля руками. DSH следит за файлом, выгрузил плагин — и при восстановлении
файла плагин поднялся, но упал:

```
16:30:07 info bridge start (protocol=1 build=6)
16:30:08 info pipe: host ready
16:30:08 info pipe: client attached
16:30:08 warn pipe: rejected a client (protocol or token mismatch)
16:30:08 error pipe: host exited (code 5)
```

С тех пор плагин не перезапускался.

**Перезапустить DSH я не могу: я работаю внутри него.** Попытка остановить
процесс DSH убила бы эту самую сессию — что и произошло в одной из проб
(задание завершилось с ошибкой раннера).

### Что нужно от вас

Перезапустить DeepSeek Harness. После этого плагин загрузится из профиля
(запись там есть, файлы на месте), и остров подключится сам — форк опрашивает
пайп каждые 6 секунд.

Проверить после перезапуска: `%LOCALAPPDATA%\Coucou\dsh\state\bridge.log`
должен получить свежие строки `bridge start` и `Coucou connected`.

## 4. Тесты

| Набор | Результат |
|---|---|
| `cargo test --release -p coucou` | **626 passed, 0 failed, 6 ignored** |
| `npm test` | **588 / 588** |
| `npx tsc --noEmit` | 0 ошибок |

## 5. Чего не проверил

- **Кнопки установщика в живом интерфейсе.** Окно настроек открыть не удалось:
  клики уходили в SolidWorks (остров был в режиме `taskbarLeft`, я кликал не
  туда). Логика установки проверена тестами, включая настоящий профиль, но
  нажатие кнопки глазами я не видел.
- **Мост после перезапуска DSH** — проверить не могу по причине из §3.

## 6. Git

Новые файлы: `src-tauri/src/dsh/install.rs`, `src/settings/dsh.ts`.
Изменены: `dsh/mod.rs`, `lib.rs`, `core/bridge.ts`, `settings/main.ts`,
`i18n/extra.json`.
