# Сборка: звуки

## Почему звуков не было

Это дефект **процесса сборки**, а не решения. `vite.config.ts` копирует 29 WAV из
`../NotchBuddy/Resources/sounds` в `dist/sounds` и предупреждает, если папки нет:

```
[plugin coucou-shared-sounds] sounds not found at
C:\LocalAI\build\coucou-dsh\NotchBuddy\Resources\sounds — the build will ship without audio
```

В репозитории звуки есть (29 файлов, 3.74 МБ). Но моя команда сборки копировала в
зеркало только `windows/`:

```
robocopy ...\windows ...\build\coucou-dsh\windows /MIR
```

`NotchBuddy/` в зеркало не попадала, поэтому Vite не находил WAV и собирал
приложение без звука. Оригинальный Coucou и релизная сборка upstream этим не
затронуты — только моё зеркало.

## Что сделано

1. Скопировал `NotchBuddy/Resources/sounds/*.wav` в зеркало.
2. Пересобрал фронтенд: `dist/sounds` — 29 файлов, предупреждение исчезло.
3. Пересобрал `.exe`.

Важная деталь: Tauri встраивает `dist` в бинарник на этапе компиляции, но cargo
не отслеживает изменения в `dist`. После копирования звуков обычная пересборка
ничего не меняла — размер `.exe` оставался 31.55 МБ. Понадобилось тронуть
`src-tauri/src/lib.rs`, чтобы крейт перекомпилировался и забрал новый `dist`.

Проверка встраивания: в бинарнике присутствуют `index.html`, `island-`, `pop.wav`,
`sounds`; размер вырос до 33.09 МБ (+1.54 МБ, что соответствует 3.74 МБ WAV в
сжатом виде).

## Для повторной сборки

Копировать нужно обе папки:

```powershell
robocopy <repo>\windows <build>\windows /MIR /XD target node_modules .git
robocopy <repo>\NotchBuddy\Resources\sounds <build>\NotchBuddy\Resources\sounds
```

И после `npm run build` — тронуть `src-tauri/src/lib.rs`, иначе cargo не увидит
новый `dist`.

## Проверено

- предупреждение о звуках при сборке исчезло;
- `dist/sounds` содержит 29 файлов;
- WAV присутствуют в `.exe`;
- `soundEnabled: true`, `soundVolume: 0.2` в настройках;
- приложение запускается и работает.

**Не проверено:** слышны ли звуки на слух. Проверить это программно я не могу —
нужен человек за динамиками.
