import Foundation

/// JSON lines в stdout — единственное, что там появляется (см. CONTRACTS.md §7).
/// Строки собираются вручную: порядок ключей стабильный, числа без локали, всегда одна строка.
enum Events {
    private static let lock = NSLock()

    /// Экранирование строки по RFC 8259 (кавычки, обратный слэш, управляющие символы).
    static func jsonString(_ s: String) -> String {
        var out = "\""
        for u in s.unicodeScalars {
            switch u {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if u.value < 0x20 {
                    out += String(format: "\\u%04x", u.value)
                } else {
                    out.unicodeScalars.append(u)
                }
            }
        }
        return out + "\""
    }

    static func number(_ v: Double, decimals: Int) -> String {
        guard v.isFinite else { return "0" }
        return String(format: "%.\(decimals)f", v)
    }

    // Чистые функции для тестов.
    static func readyLine() -> String { #"{"event":"ready"}"# }
    static func levelLine(db: Double) -> String {
        #"{"event":"level","db":"# + number(db, decimals: 1) + "}"
    }
    static func stoppedLine(durationSec: Double, path: String) -> String {
        #"{"event":"stopped","duration_sec":"# + number(durationSec, decimals: 3)
            + #","path":"# + jsonString(path) + "}"
    }
    static func errorLine(_ message: String) -> String {
        #"{"event":"error","message":"# + jsonString(message) + "}"
    }

    static func emit(_ line: String) {
        lock.lock()
        defer { lock.unlock() }
        fputs(line + "\n", stdout)
        fflush(stdout)
    }

    static func ready() { emit(readyLine()) }
    static func level(db: Double) { emit(levelLine(db: db)) }
    static func stopped(durationSec: Double, path: String) { emit(stoppedLine(durationSec: durationSec, path: path)) }
    static func error(_ message: String) { emit(errorLine(message)) }
}

/// Диагностика — только в stderr, чтобы не ломать JSON-протокол stdout.
func logErr(_ message: String) {
    fputs("[remarka-tap] \(message)\n", stderr)
    fflush(stderr)
}
