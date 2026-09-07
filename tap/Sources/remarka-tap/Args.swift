import Foundation

let remarkaTapVersion = "0.1.0"

/// Параметры командной строки (см. docs/CONTRACTS.md §7).
struct Options: Equatable {
    var outPath: String = ""
    var rate: Double = 16000
    var excludePIDs: [pid_t] = []
    var levelIntervalMs: Int = 200
    /// Автостоп через N секунд — только для проверок; в продукте не используется.
    var durationSec: Double? = nil
    /// Проверять разрешение TCC «Запись системного звука» до создания тапа.
    var checkPermission: Bool = true
    var showHelp = false
    var showVersion = false
}

struct ArgsError: Error, CustomStringConvertible {
    let message: String
    var description: String { message }
}

let usageText = """
remarka-tap \(remarkaTapVersion) — захват системного звука macOS (Core Audio Process Taps, macOS 14.2+)

Использование:
  remarka-tap --out FILE.wav [--rate 16000] [--exclude-pid PID ...] [--level-interval-ms 200]
              [--duration SEC] [--no-tcc-check]

  --out FILE.wav          куда писать WAV (моно, int16); каталог должен существовать
  --rate N                частота дискретизации файла, Гц (по умолчанию 16000)
  --exclude-pid PID ...   не захватывать звук этих процессов (свой pid исключается всегда)
  --level-interval-ms N   период событий level, мс (по умолчанию 200)
  --duration SEC          остановиться автоматически через SEC секунд (для проверок)
  --no-tcc-check          не проверять разрешение TCC заранее (отладка)
  --help, --version

Остановка: SIGINT, SIGTERM или строка `stop` в stdin (закрытие stdin-канала тоже останавливает).
stdout — только JSON lines: {"event":"ready"} / {"event":"level","db":-31.2} /
{"event":"stopped","duration_sec":12.3,"path":"…"} / {"event":"error","message":"…"} (+ exit 1).
Диагностика — в stderr.
"""

func parseArgs(_ args: [String]) throws -> Options {
    var o = Options()
    var i = 0

    func value(_ flag: String) throws -> String {
        i += 1
        guard i < args.count, !args[i].hasPrefix("--") else {
            throw ArgsError(message: "\(flag): нужно значение")
        }
        return args[i]
    }

    while i < args.count {
        let a = args[i]
        switch a {
        case "--out":
            o.outPath = try value(a)
        case "--rate":
            let v = try value(a)
            guard let r = Double(v), r >= 8000, r <= 192_000 else {
                throw ArgsError(message: "--rate: ожидается число от 8000 до 192000, получено «\(v)»")
            }
            o.rate = r
        case "--exclude-pid":
            var any = false
            while i + 1 < args.count, !args[i + 1].hasPrefix("--") {
                i += 1
                guard let p = Int32(args[i]), p > 0 else {
                    throw ArgsError(message: "--exclude-pid: ожидается pid, получено «\(args[i])»")
                }
                o.excludePIDs.append(p)
                any = true
            }
            if !any { throw ArgsError(message: "--exclude-pid: нужно значение") }
        case "--level-interval-ms":
            let v = try value(a)
            guard let n = Int(v), n >= 20, n <= 10_000 else {
                throw ArgsError(message: "--level-interval-ms: ожидается число от 20 до 10000, получено «\(v)»")
            }
            o.levelIntervalMs = n
        case "--duration":
            let v = try value(a)
            guard let d = Double(v), d > 0 else {
                throw ArgsError(message: "--duration: ожидается положительное число секунд, получено «\(v)»")
            }
            o.durationSec = d
        case "--no-tcc-check":
            o.checkPermission = false
        case "--help", "-h":
            o.showHelp = true
        case "--version", "-V":
            o.showVersion = true
        default:
            throw ArgsError(message: "неизвестный аргумент «\(a)»")
        }
        i += 1
    }

    if !o.showHelp && !o.showVersion && o.outPath.isEmpty {
        throw ArgsError(message: "нужен --out FILE.wav")
    }
    return o
}
