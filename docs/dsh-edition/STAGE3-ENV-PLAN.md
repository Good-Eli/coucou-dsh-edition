# Этап 3 — план окружения сборки

**Дата:** 2026-11-11  
**Статус:** на выполнение. Установка компонентов, требующих прав администратора, — только
после подтверждения пользователя в Windows (UAC).

## 1. Что уже есть

| Компонент | Состояние |
|---|---|
| Windows | Windows NT 10.0.26300.0, x64 |
| Пользователь | `LEGION-OF-ELI\vsiof`; в токене песочницы группа Administrators — deny-only (нужен UAC) |
| Git | 2.53.0 + Git Credential Manager 2.7.0 |
| Node.js | **нет в PATH**; внутри DSH есть Node 24.21.0 без npm |
| Rust | **нет** (`cargo`, `rustc`, `rustup` отсутствуют) |
| Visual Studio / MSVC | **нет** (`vswhere.exe`, `VS 2022`, Windows SDK отсутствуют) |
| WebView2 | есть, 157.0.4341.42/46 |
| GitHub CLI | нет |
| winget | алиас есть, но не отвечает в песочнице — не используем |
| Диск | ~134 ГБ свободно |
| Сеть | в песочнице TLS/соединения не работают; вне песочницы GitHub/nodejs/npm доступны. `static.rust-lang.org` не проходит TLS — используем зеркало |

## 2. Компоненты к установке

### 2.1 Rust stable (per-user, без администратора)

- **Зачем:** `cargo build`, `cargo test`, сборка Tauri-бэкенда.
- **Источник:** `rustup-init.exe` из `C:\LocalAI\сoucou\rustup-init.exe`.
  SHA-256 `38027D51D69A5D05493627A0634DBEA52D6CD793C8F072D2373D3F4163EEC7DB`
  совпал с зеркалами rsproxy и USTC (12 839 424 байт).
- **Цепочка инструментов:** `stable-x86_64-pc-windows-msvc`, профиль `minimal`
  (rustc, cargo, rust-std, rustup; без docs/clippy/rustfmt).
- **Зеркало:** `RUSTUP_DIST_SERVER=https://rsproxy.cn`,
  `RUSTUP_UPDATE_ROOT=https://rsproxy.cn/rustup` — официальный `static.rust-lang.org`
  недоступен по TLS.
- **Куда:** `%USERPROFILE%\.cargo`, `%USERPROFILE%\.rustup`; PATH пользователя
  дополняется `%USERPROFILE%\.cargo\bin`.
- **Размер:** ~1.2–1.5 ГБ.
- **Откат:** `rustup self uninstall -y`; удалить `%USERPROFILE%\.cargo`,
  `%USERPROFILE%\.rustup`, убрать запись из PATH пользователя.

### 2.2 Node.js 24.22.3 LTS + npm (per-user, без администратора)

- **Зачем:** `npm install`, `npm test`, `npm run build`, `npm run tauri`; npm входит в zip.
- **Источник:** `https://nodejs.org/dist/v24.22.3/node-v24.22.3-win-x64.zip`,
  SHA-256 сверяется по `SHASUMS256.txt`.
- **Куда:** `%LOCALAPPDATA%\Programs\nodejs\node-v24.22.3-win-x64`; PATH пользователя
  дополняется этой папкой.
- **Размер:** ~80 МБ (zip ~30 МБ).
- **Откат:** удалить папку, убрать PATH.
- **Почему не Node из DSH:** в его дистрибутиве нет npm (`node_modules\npm` отсутствует).

### 2.3 GitHub CLI 2.103.3 (per-user, без администратора)

- **Зачем:** интерактивный `gh auth login` (device/browser flow), создание приватного
  репозитория, push. Токены не запрашиваются и не пишутся в файлы.
- **Источник:** `gh_2.103.3_windows_amd64.zip` (15 197 187 байт,
  `sha256:98d0cfa794721665d7973dd728c78aff7bd836d58f10f6d7a03568eccb0a22e0`).
- **Куда:** `%LOCALAPPDATA%\Programs\gh\bin`; PATH пользователя.
- **Откат:** удалить папку и PATH.
- **Альтернатива:** Git Credential Manager уже есть; но создание репозитория удобнее через gh.

### 2.4 Microsoft C++ Build Tools 2022 + Windows SDK (нужен администратор)

- **Зачем:** MSVC `link.exe` и Windows SDK — обязательны для
  `x86_64-pc-windows-msvc` и Tauri.
- **Источник:** `https://aka.ms/vs/17/release/vs_BuildTools.exe` (bootstrapper Microsoft),
  проверка Authenticode перед запуском.
- **Компоненты:** workload `Microsoft.VisualStudio.Workload.VCTools` +
  `--includeRecommended` (MSVC x64/x86, Windows 11 SDK, CMake-компоненты по умолчанию).
- **Куда:** `C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools`.
- **Размер:** ~5–7 ГБ.
- **Права:** UAC; запуск только после подтверждения пользователя.
- **Откат:** удаление через Visual Studio Installer / «Программы и компоненты».
- **Не устанавливаем:** полную Visual Studio, .NET workload, другие языки.

### 2.5 Что не устанавливаем

| Компонент | Почему не нужен |
|---|---|
| pnpm | Coucou использует npm и `package-lock.json`; pnpm в проекте не требуется |
| CMake/Ninja отдельно | входит в recommended-компоненты Build Tools; отдельных шагов сборки нет |
| Python | не нужен для Coucou; Python есть в DSH |
| WiX/NSIS вручную | Tauri скачивает свои упаковщики при `tauri build` |
| winget-пакеты | алиас не работает в песочнице; ставим официальные zip/exe напрямую |
| Полная Visual Studio | избыточна |

## 3. Порядок и проверки

1. Node.js + npm → `node -v`, `npm -v`.
2. GitHub CLI → `gh --version`.
3. Rust → `rustc -V`, `cargo -V`.
4. MSVC (после UAC) → `vswhere -latest -products * -requires
   Microsoft.VisualStudio.Component.VC.Tools.x86.x64`.
5. Оригинальный Coucou 0.5.9 (тег `windows-v0.5.9`, отдельная папка):
   - `npm ci` (или `npm install`), `npm test`, `npm run build`;
   - `cargo test -p coucou-hook` и `cargo build` (после MSVC);
   - `npm run tauri build -- --debug` или `cargo build` для проверки линковки.

## 4. Риски

| Риск | Смягчение |
|---|---|
| `static.rust-lang.org` недоступен | зеркало rsproxy; хэш rustup-init сверен с двумя зеркалами |
| MSVC требует UAC и много места | отдельное подтверждение; ~7 ГБ; откат через VS Installer |
| TLS в песочнице | установка и загрузки — только вне песочницы |
| PATH пользователя меняется | точечно добавляются две папки; откат описан |
| Долгая установка Build Tools | фоновая задача с логом, не блокирует frontend-проверки |

## 5. Откат целиком

- `rustup self uninstall -y`, удалить `%USERPROFILE%\.cargo` и `.rustup`.
- Удалить `%LOCALAPPDATA%\Programs\nodejs` и `%LOCALAPPDATA%\Programs\gh`.
- Удалить добавленные записи из PATH пользователя (реестр `HKCU\Environment`).
- Build Tools — «Программы и компоненты» → Visual Studio Build Tools 2022 → Удалить.

Ни один из шагов не трогает установленный Coucou, его данные, DSH и его профиль.
