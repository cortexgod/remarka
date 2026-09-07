import CoreAudio
import Foundation

// remarka-tap — сайдкар Ремарки: системный звук macOS → WAV моно int16 (CONTRACTS.md §7).
// Вся логика состояния — на главной очереди (dispatchMain), аудио — в TapCapture/Recorder.

let options: Options
do {
    options = try parseArgs(Array(CommandLine.arguments.dropFirst()))
} catch {
    Events.error("Неверные аргументы: \(error)")
    fputs(usageText, stderr)
    exit(1)
}
if options.showHelp {
    print(usageText)
    exit(0)
}
if options.showVersion {
    print("remarka-tap \(remarkaTapVersion)")
    exit(0)
}

signal(SIGPIPE, SIG_IGN)

guard #available(macOS 14.2, *) else {
    Events.error("Захват системного звука требует macOS 14.2 или новее (Core Audio Process Taps).")
    exit(1)
}

@available(macOS 14.2, *)
final class App {
    let options: Options
    private var capture: TapCapture?
    private var recorder: Recorder?
    private var wav: WavWriter?
    private var levelTimer: DispatchSourceTimer?
    private var watchdog: DispatchWorkItem?
    private var permissionTimeout: DispatchWorkItem?
    private var ready = false
    private var finishing = false
    private var signalSources: [DispatchSourceSignal] = []
    private let permission = AudioCapturePermission()

    init(options: Options) {
        self.options = options
    }

    // MARK: - Запуск

    func run() {
        installSignalHandlers()
        startStdinWatcher()
        guard options.checkPermission else {
            logErr("проверка разрешения TCC пропущена (--no-tcc-check)")
            startCapture()
            return
        }
        guard permission.isAvailable else {
            logErr("предупреждение: TCC.framework недоступен, разрешение не проверяем; без него в файле будет тишина")
            startCapture()
            return
        }
        switch permission.preflight() {
        case .granted:
            logErr("разрешение «Запись системного звука» есть")
            startCapture()
        case .denied:
            fail(permissionDeniedMessage())
        case .unknown, .unavailable:
            let app = responsibleAppHint()
            logErr("разрешение ещё не выдано — запрашиваем (диалог macOS будет от имени «\(app)»)")
            let timeout = DispatchWorkItem { [weak self] in
                self?.fail("Не дождались ответа на запрос разрешения «Запись системного звука» (3 минуты). Разрешите его в Системных настройках → Конфиденциальность и безопасность → Запись экрана и системного звука для «\(app)» и запустите запись заново.")
            }
            permissionTimeout = timeout
            DispatchQueue.main.asyncAfter(deadline: .now() + 180, execute: timeout)
            let launched = permission.request { [weak self] granted in
                DispatchQueue.main.async {
                    guard let self = self else { return }
                    self.permissionTimeout?.cancel()
                    self.permissionTimeout = nil
                    if granted {
                        logErr("разрешение выдано")
                        self.startCapture()
                    } else {
                        self.fail(self.permissionRefusedMessage())
                    }
                }
            }
            if !launched {
                timeout.cancel()
                logErr("предупреждение: TCCAccessRequest недоступен, продолжаем без запроса")
                startCapture()
            }
        }
    }

    private func permissionDeniedMessage() -> String {
        let app = responsibleAppHint()
        return "Нет разрешения на запись системного звука: для «\(app)» оно выключено. Включите его в Системных настройках → Конфиденциальность и безопасность → Запись экрана и системного звука и запустите запись заново."
    }

    private func permissionRefusedMessage() -> String {
        let app = responsibleAppHint()
        return "macOS не выдала разрешение на запись системного звука для «\(app)». Либо в диалоге нажали «Не разрешать», либо диалог не показан: у приложения-родителя нет NSAudioCaptureUsageDescription в Info.plist (тогда запрос отклоняется молча). Проверьте Системные настройки → Конфиденциальность и безопасность → Запись экрана и системного звука."
    }

    private func startCapture() {
        guard !finishing else { return }
        do {
            let wav = try WavWriter(path: options.outPath, sampleRate: Int(options.rate))
            self.wav = wav
            let ring = FloatRing(capacity: 192_000 * 10)
            let capture = try TapCapture(config: .init(excludePIDs: options.excludePIDs, name: "Ремарка"), ring: ring)
            self.capture = capture
            let recorder = Recorder(ring: ring, inputRate: capture.sampleRate, outRate: options.rate, wav: wav)
            recorder.onError = { [weak self] error in
                self?.fail("Ошибка записи файла: \(error)")
            }
            self.recorder = recorder
            capture.onFirstBuffer = { [weak self] in
                DispatchQueue.main.async { self?.handleReady() }
            }
            recorder.start()
            try capture.start()
            logErr("захват запущен: \(Int(capture.sampleRate)) Гц → \(Int(options.rate)) Гц, файл \(options.outPath)")
            let wd = DispatchWorkItem { [weak self] in
                guard let self = self, !self.ready else { return }
                self.fail("Устройство захвата запущено, но за 5 секунд не пришло ни одного буфера звука.")
            }
            watchdog = wd
            DispatchQueue.main.asyncAfter(deadline: .now() + 5, execute: wd)
        } catch {
            fail("Не удалось запустить захват системного звука: \(error)")
        }
    }

    private func handleReady() {
        guard !ready, !finishing else { return }
        ready = true
        watchdog?.cancel()
        watchdog = nil
        Events.ready()

        let interval = DispatchTimeInterval.milliseconds(options.levelIntervalMs)
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + interval, repeating: interval, leeway: .milliseconds(10))
        timer.setEventHandler { [weak self] in
            guard let self = self, let rec = self.recorder, !self.finishing else { return }
            Events.level(db: rec.takeLevelDb())
        }
        timer.resume()
        levelTimer = timer

        if let d = options.durationSec {
            DispatchQueue.main.asyncAfter(deadline: .now() + d) { [weak self] in
                self?.stop(reason: "истёк --duration")
            }
        }
    }

    // MARK: - Остановка

    func stop(reason: String) {
        guard !finishing else { return }
        finishing = true
        logErr("останавливаемся: \(reason)")
        teardown()
        guard ready, let rec = recorder else {
            if let w = wav { try? w.finalize() }
            Events.error("Запись остановлена до старта (\(reason)).")
            exit(1)
        }
        do {
            let duration = try rec.finish()
            logErr("записано \(Events.number(duration, decimals: 2)) с")
            Events.stopped(durationSec: duration, path: options.outPath)
            exit(0)
        } catch {
            Events.error("Ошибка при завершении записи: \(error)")
            exit(1)
        }
    }

    func fail(_ message: String) {
        guard !finishing else { return }
        finishing = true
        teardown()
        if let rec = recorder {
            _ = try? rec.finish()
        } else if let w = wav {
            try? w.finalize()
        }
        Events.error(message)
        exit(1)
    }

    private func teardown() {
        levelTimer?.cancel()
        levelTimer = nil
        watchdog?.cancel()
        watchdog = nil
        permissionTimeout?.cancel()
        permissionTimeout = nil
        capture?.stop()
    }

    // MARK: - Сигналы и stdin

    private func installSignalHandlers() {
        for sig in [SIGINT, SIGTERM] {
            signal(sig, SIG_IGN)
            let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
            src.setEventHandler { [weak self] in
                self?.stop(reason: sig == SIGINT ? "SIGINT" : "SIGTERM")
            }
            src.resume()
            signalSources.append(src)
        }
    }

    private func startStdinWatcher() {
        var st = stat()
        let isPipe = fstat(STDIN_FILENO, &st) == 0 && ((st.st_mode & S_IFMT) == S_IFIFO || (st.st_mode & S_IFMT) == S_IFSOCK)
        let t = Thread { [weak self] in
            while let line = readLine(strippingNewline: true) {
                let cmd = line.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                if cmd == "stop" || cmd == "q" || cmd == "quit" {
                    DispatchQueue.main.async { self?.stop(reason: "команда stop из stdin") }
                    return
                }
            }
            // EOF: если stdin — канал от родителя, родитель ушёл или закрыл его → останавливаемся.
            if isPipe {
                DispatchQueue.main.async { self?.stop(reason: "stdin закрыт") }
            }
        }
        t.name = "remarka-tap.stdin"
        t.start()
    }
}

let app = App(options: options)
DispatchQueue.main.async { app.run() }
dispatchMain()
