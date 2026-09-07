# remarka-tap — захват системного звука (macOS 14.4+)

Сайдкар Ремарки: пишет звук всех приложений (Zoom, Teams, браузер…) в WAV 16 кГц моно int16 через
**Core Audio Process Taps** — без виртуальных драйверов и без разрешения «Запись экрана».
Контракт — `docs/CONTRACTS.md` §7.

```
remarka-tap --out FILE.wav [--rate 16000] [--exclude-pid PID ...] [--level-interval-ms 200]
            [--duration SEC] [--no-tcc-check]
```

stdout — только JSON lines:

```
{"event":"ready"}                                  запись пошла (пришёл первый буфер)
{"event":"level","db":-31.2}                       раз в --level-interval-ms, дБFS −60…0
{"event":"stopped","duration_sec":12.3,"path":"…"} после остановки, exit 0
{"event":"error","message":"…"}                    любая ошибка, exit 1
```

Остановка: `SIGINT`, `SIGTERM`, строка `stop` в stdin, а также закрытие stdin, если это канал
(родитель умер → сайдкар не остаётся сиротой). Диагностика — в stderr, по-русски.

## Как устроено

```
CATapDescription(monoGlobalTapButExcludeProcesses: [свой pid, --exclude-pid …])
  → AudioHardwareCreateProcessTap            (macOS 14.2+; формат тапа: Float32, 1 канал, частота устройства вывода)
  → AudioHardwareCreateAggregateDevice       (только тап в kAudioAggregateDeviceTapListKey, private, tapautostart = false)
  → AudioDeviceCreateIOProcIDWithBlock       (моно-микс → кольцевой буфер)
  → рабочий поток: ресемплер (полифазный FIR, окно Кайзера) → int16 → WAV
```

Решения, которые стоит знать:

- **В агрегате только тап, без устройства вывода.** Если добавить устройство вывода как саб-устройство
  (как в некоторых примерах), во вход агрегата попадают и его входные потоки — у AirPods это микрофон.
  Тап-только агрегат тактируется сам, коллбэки идут на частоте устройства вывода и в тишине (проверено).
- **`tapautostart = false`.** Иначе устройство стартовало бы только с первым звуком, и таймкоды
  в `system.wav` разъехались бы с `mic.wav`. Сейчас файл идёт непрерывно с момента `ready`, в тишине — нули.
- **Ресемплер свой**, а не AVAudioConverter: детерминированный, покрыт тестами, выходной сэмпл `n`
  соответствует входному времени `n·(in/out)` без сдвига (тест `impulseTimingIsPreserved`).
- Заголовок WAV переписывается раз в секунду данных — если процесс убьют по SIGKILL, файл останется читаемым.
- Смена формата/частоты у тапа (переключили вывод на другое устройство) отслеживается слушателями
  `kAudioDevicePropertyNominalSampleRate` / `kAudioTapPropertyFormat`; ресемплер пересоздаётся на лету.
  Проверить на живом переключении устройств пока не удалось (на тестовой машине одно устройство вывода).
- При появлении новых аудиоклиентов (`kAudioHardwarePropertyProcessObjectList`) список исключений
  пересчитывается: если Ремарка стала аудиоклиентом после старта тапа, её звук всё равно исключится.

## Разрешение «Запись системного звука» — самое важное

Тапы защищены TCC-сервисом `kTCCServiceAudioCapture` (в Системных настройках это
**Конфиденциальность и безопасность → Запись экрана и системного звука**, отдельный список от «Микрофон»).

Ключевые факты, проверенные на macOS 15.1:

1. **Без разрешения Core Audio не возвращает ошибку.** `AudioHardwareCreateProcessTap`, агрегат и
   `AudioDeviceStart` отрабатывают `noErr`, буферы приходят с нужной частотой — но в них **ровно нули**.
   Поэтому «файл есть, а в нём тишина» = «нет разрешения», а не «никто не говорил».
2. **Разрешение привязано к «ответственному» процессу**, а не к самому `remarka-tap`. Для бандла
   Ремарка.app это Ремарка.app (диалог: «Ремарка хочет записывать системный звук», текст —
   `NSAudioCaptureUsageDescription` из её Info.plist). При запуске из терминала — Terminal/iTerm,
   из IDE — IDE, в `npm run tauri dev` — тот, кто запустил cargo.
3. **Если у ответственного приложения нет `NSAudioCaptureUsageDescription`, TCC отклоняет запрос молча**,
   без диалога и без записи «отказано» в настройках. Так ведёт себя, например, запуск из Claude Code
   (ответственный процесс — `claude`, у него нет этого ключа). Симптом — тишина в файле.
4. Публичного API «есть ли разрешение» нет. `remarka-tap` спрашивает TCC напрямую через приватный
   `TCC.framework` (`TCCAccessPreflight` / `TCCAccessRequest`, через `dlsym`, как делает AudioCap):
   - `granted` → пишем;
   - `denied` → `{"event":"error","message":"Нет разрешения на запись системного звука: для «X» оно выключено…"}`, exit 1;
   - `unknown` → `TCCAccessRequest` показывает системный диалог (ждём до 3 минут); отказ или молчаливое
     отклонение → `error` с объяснением и именем приложения «X», к которому привязано разрешение;
   - символы не нашлись (когда-нибудь Apple их уберёт) → предупреждение в stderr и работаем без проверки.
   `--no-tcc-check` отключает всё это (для отладки).
5. В сам бинарник вшит `Info.plist` (`-sectcreate __TEXT __info_plist`, см. `tap/Info.plist`) с
   `CFBundleIdentifier = com.remarka.app.tap` и `NSAudioCaptureUsageDescription` — на случай, когда
   `remarka-tap` сам оказывается ответственным процессом (запуск через launchd/`open`). Подпись ad-hoc
   со стабильным идентификатором делает `build.sh`.

Что нужно от оболочки (Rust/Tauri): в `Info.plist` бандла — `NSAudioCaptureUsageDescription` (уже в
CONTRACTS §6.2). Больше ничего: ни entitlements, ни `Screen Recording`.

Что наблюдалось при автоматической проверке (без человека у экрана, macOS 15.1):

| Как запущен | Ответственный процесс | Что сделал TCC | Что выдал remarka-tap |
|---|---|---|---|
| из Claude Code (`claude.app`, без `NSAudioCaptureUsageDescription`) | `claude` | отклонил мгновенно, без диалога; в настройках ничего не появилось | `error` «macOS не выдала разрешение… для «claude»», exit 1 |
| из тестового бандла с `NSAudioCaptureUsageDescription` (`open App.app`, сайдкар — дочерний процесс, как в Ремарке) | бандл | запрос не вернулся за 3 минуты — диалог ждал ответа | `error` «Не дождались ответа на запрос разрешения…», exit 1 |
| `--no-tcc-check` без разрешения | — | тап создан, `noErr`, буферы идут | `ready`, `level` −60, файл 16 кГц с нулями |

Лог `tccd` обычному пользователю не виден (`log show --predicate 'process == "tccd"'` пуст), так что
единственный надёжный индикатор без приватного API — RMS файла.

Сбросить выданное/отклонённое разрешение для проверки диалога заново (делает пользователь сам):

```
tccutil reset AudioCapture com.remarka.app        # бандл Ремарки
tccutil reset AudioCapture com.apple.Terminal     # если проверяли из Terminal
```

## Сборка

```
tap/build.sh
```

`swiftc -O -swift-version 5 -target arm64-apple-macos14.4` (+ попытка `x86_64-apple-macos14.4`) →

```
src-tauri/binaries/remarka-tap-aarch64-apple-darwin   arm64 (сайдкар Tauri)
src-tauri/binaries/remarka-tap-x86_64-apple-darwin    x86_64 (если тулчейн умеет; на CLT 16 — умеет)
tap/.build/swiftc/remarka-tap-universal               lipo из обоих, для ручных проверок
```

Tauri требует по чистому срезу на каждый target triple (при `--target universal-apple-darwin` он сам
делает `lipo`), поэтому в `binaries/` лежат не универсальные файлы. `NO_X86=1 tap/build.sh` — только arm64.

`Package.swift` — для редактирования и тестов: `cd tap && swift test` (swift-testing, XCTest не нужен;
работает на одних Command Line Tools). Тесты: ресемплер (тон 1 кГц 48→16 и 44.1→16 кГц, подавление
10 кГц ≥ 40 дБ, чанки любой длины = целиком, импульс не сдвигается), WAV-заголовок и файл,
кольцевой буфер (перенос, переполнение, маркеры частоты), JSON-события, разбор аргументов.

## Проверить руками

1. Собрать: `tap/build.sh`.
2. В **Terminal.app** (не из IDE — см. п. 2–3 выше) запустить звук и захват:

   ```
   say -v Milena "Проверка захвата системного звука для Ремарки" &
   src-tauri/binaries/remarka-tap-aarch64-apple-darwin --out /tmp/system.wav --duration 6
   ```

   При первом запуске macOS покажет «Terminal хочет записывать системный звук» — нажать «Разрешить».
   Если диалога нет и в stdout `error` с «не выдала разрешение» — включить Terminal вручную в
   Системные настройки → Конфиденциальность и безопасность → Запись экрана и системного звука.
3. Ожидаемый stdout:

   ```
   {"event":"ready"}
   {"event":"level","db":-27.4}
   …
   {"event":"stopped","duration_sec":6.012,"path":"/tmp/system.wav"}
   ```

4. Проверить файл (16 кГц, моно, int16, ненулевой сигнал):

   ```
   engine/.venv/bin/python -c "
   import soundfile as sf, numpy as np
   x, sr = sf.read('/tmp/system.wav'); print(sr, len(x)/sr, 20*np.log10(np.sqrt(np.mean(x**2))+1e-9))"
   ```

   RMS около −20…−35 дБFS при играющем `say`; ровно `-180` (нули) — нет разрешения.

5. Остановка по стопу: `echo stop | …` или `kill -TERM <pid>` — в обоих случаях приходит `stopped`, exit 0.

Как это выглядит из приложения: Ремарка.app запускает сайдкар с `--exclude-pid <свой pid>`,
держит stdin открытым (закрытие = стоп), читает stdout построчно, по `stopped` берёт `duration_sec`,
stderr пишет в лог встречи. Между `AudioDeviceStart` и `ready` проходит ~10 мс; таймер записи
на стороне Rust лучше стартовать по `ready`.

## Известные ограничения

- Windows — не здесь (там WASAPI loopback в Rust).
- Нет разделения по приложениям: пишется всё, кроме исключённых pid (это и нужно продукту).
- Проверка разрешения — через приватный API; при его исчезновении сайдкар продолжит работать,
  но не сможет отличить «нет разрешения» от «тишина».
