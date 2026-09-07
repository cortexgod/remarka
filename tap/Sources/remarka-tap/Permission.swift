import Foundation

/// Разрешение TCC «Запись системного звука» (kTCCServiceAudioCapture).
///
/// Публичного API для проверки нет. Без разрешения Core Audio НЕ возвращает ошибку:
/// тап создаётся, буферы приходят, но в них нули (проверено на macOS 15.1). Поэтому перед
/// созданием тапа мы спрашиваем TCC напрямую через приватный TCC.framework — так же, как это
/// делает AudioCap. Всё через dlsym: если символов нет, работаем без проверки.
enum PermissionState {
    case granted, denied, unknown, unavailable
}

final class AudioCapturePermission {
    private typealias PreflightFn = @convention(c) (CFString, CFDictionary?) -> Int32
    private typealias RequestFn = @convention(c) (CFString, CFDictionary?, @escaping @convention(block) (Bool) -> Void) -> Void

    private static let service = "kTCCServiceAudioCapture" as CFString
    private let preflightFn: PreflightFn?
    private let requestFn: RequestFn?

    init() {
        var preflight: PreflightFn? = nil
        var request: RequestFn? = nil
        if let handle = dlopen("/System/Library/PrivateFrameworks/TCC.framework/Versions/A/TCC", RTLD_NOW) {
            if let sym = dlsym(handle, "TCCAccessPreflight") {
                preflight = unsafeBitCast(sym, to: PreflightFn.self)
            }
            if let sym = dlsym(handle, "TCCAccessRequest") {
                request = unsafeBitCast(sym, to: RequestFn.self)
            }
        }
        preflightFn = preflight
        requestFn = request
    }

    var isAvailable: Bool { preflightFn != nil && requestFn != nil }

    func preflight() -> PermissionState {
        guard let fn = preflightFn else { return .unavailable }
        switch fn(Self.service, nil) {
        case 0: return .granted
        case 1: return .denied
        default: return .unknown
        }
    }

    /// Показывает системный диалог (если TCC решит его показать) и возвращает ответ в completion.
    /// Диалог приписывается «ответственному» процессу — приложению, которое запустило remarka-tap.
    func request(completion: @escaping (Bool) -> Void) -> Bool {
        guard let fn = requestFn else { return false }
        fn(Self.service, nil, completion)
        return true
    }
}

// MARK: - Кому приписано разрешение

private func parentPID(of pid: pid_t) -> pid_t? {
    var info = kinfo_proc()
    var size = MemoryLayout<kinfo_proc>.stride
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
    guard sysctl(&mib, UInt32(mib.count), &info, &size, nil, 0) == 0, size > 0 else { return nil }
    return info.kp_eproc.e_ppid
}

private func processPath(_ pid: pid_t) -> String? {
    var buf = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN)) // PROC_PIDPATHINFO_MAXSIZE
    let n = proc_pidpath(pid, &buf, UInt32(buf.count))
    guard n > 0 else { return nil }
    return String(cString: buf)
}

/// Эвристика: ближайший предок-приложение (.app) — обычно именно к нему TCC привязывает разрешение
/// (Ремарка.app в продукте, Terminal/IDE при ручном запуске). Нужна только для понятных сообщений.
func responsibleAppHint() -> String {
    var pid = getppid()
    var fallback: String? = nil
    var hops = 0
    while pid > 1, hops < 16 {
        hops += 1
        if let path = processPath(pid) {
            if let range = path.range(of: ".app/") {
                let appPath = String(path[..<range.upperBound].dropLast())
                if let bundle = Bundle(path: appPath) {
                    for key in ["CFBundleDisplayName", "CFBundleName"] {
                        if let name = bundle.object(forInfoDictionaryKey: key) as? String, !name.isEmpty {
                            return name
                        }
                    }
                }
                return ((appPath as NSString).lastPathComponent as NSString).deletingPathExtension
            }
            if fallback == nil { fallback = (path as NSString).lastPathComponent }
        }
        guard let next = parentPID(of: pid) else { break }
        pid = next
    }
    return fallback ?? "родительский процесс"
}
