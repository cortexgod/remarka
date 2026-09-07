import CoreAudio
import Foundation

struct CAError: Error, CustomStringConvertible {
    let what: String
    let status: OSStatus
    var description: String { "\(what): \(fourCC(status))" }
}

/// OSStatus как четырёхбуквенный код Core Audio, если он печатный: 'nope' (1852797029).
func fourCC(_ status: OSStatus) -> String {
    let u = UInt32(bitPattern: status)
    let bytes = [UInt8((u >> 24) & 0xff), UInt8((u >> 16) & 0xff), UInt8((u >> 8) & 0xff), UInt8(u & 0xff)]
    if bytes.allSatisfy({ $0 >= 0x20 && $0 < 0x7f }), let s = String(bytes: bytes, encoding: .ascii) {
        return "'\(s)' (\(status))"
    }
    return "\(status)"
}

enum CA {
    static let systemObject = AudioObjectID(kAudioObjectSystemObject)

    static func address(_ selector: AudioObjectPropertySelector,
                        scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal,
                        element: AudioObjectPropertyElement = kAudioObjectPropertyElementMain) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: element)
    }

    static func get<T>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector,
                       scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal,
                       qualifier: UnsafeRawPointer? = nil, qualifierSize: UInt32 = 0,
                       initial: T, what: String) throws -> T {
        var addr = address(selector, scope: scope)
        var value = initial
        var size = UInt32(MemoryLayout<T>.size)
        let status = withUnsafeMutablePointer(to: &value) { ptr in
            AudioObjectGetPropertyData(object, &addr, qualifierSize, qualifier, &size, ptr)
        }
        guard status == noErr else { throw CAError(what: what, status: status) }
        return value
    }

    static func getString(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, what: String) throws -> String {
        var addr = address(selector)
        var value: Unmanaged<CFString>? = nil
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        let status = withUnsafeMutablePointer(to: &value) { ptr in
            AudioObjectGetPropertyData(object, &addr, 0, nil, &size, ptr)
        }
        guard status == noErr, let v = value else { throw CAError(what: what, status: status) }
        return v.takeRetainedValue() as String
    }

    static func getObjectIDs(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector,
                             scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal,
                             what: String) throws -> [AudioObjectID] {
        var addr = address(selector, scope: scope)
        var size: UInt32 = 0
        var status = AudioObjectGetPropertyDataSize(object, &addr, 0, nil, &size)
        guard status == noErr else { throw CAError(what: what, status: status) }
        let count = Int(size) / MemoryLayout<AudioObjectID>.stride
        if count == 0 { return [] }
        var ids = [AudioObjectID](repeating: 0, count: count)
        status = ids.withUnsafeMutableBufferPointer { buf in
            AudioObjectGetPropertyData(object, &addr, 0, nil, &size, buf.baseAddress!)
        }
        guard status == noErr else { throw CAError(what: what, status: status) }
        return Array(ids.prefix(Int(size) / MemoryLayout<AudioObjectID>.stride))
    }

    static func defaultOutputDevice() throws -> AudioObjectID {
        try get(systemObject, kAudioHardwarePropertyDefaultOutputDevice,
                initial: AudioObjectID(0), what: "устройство вывода по умолчанию")
    }

    static func deviceUID(_ device: AudioObjectID) throws -> String {
        try getString(device, kAudioDevicePropertyDeviceUID, what: "UID устройства")
    }

    static func objectName(_ object: AudioObjectID) -> String? {
        try? getString(object, kAudioObjectPropertyName, what: "имя объекта")
    }

    /// Объект процесса Core Audio для pid. nil — процесс не является аудиоклиентом (исключать нечего).
    static func processObject(forPID pid: pid_t) -> AudioObjectID? {
        var p = pid
        let result: AudioObjectID? = withUnsafePointer(to: &p) { ptr in
            try? get(systemObject, kAudioHardwarePropertyTranslatePIDToProcessObject,
                     qualifier: UnsafeRawPointer(ptr), qualifierSize: UInt32(MemoryLayout<pid_t>.size),
                     initial: AudioObjectID(0), what: "pid → объект процесса")
        }
        guard let id = result, id != AudioObjectID(kAudioObjectUnknown) else { return nil }
        return id
    }

    static func inputStreams(of device: AudioObjectID) throws -> [AudioObjectID] {
        try getObjectIDs(device, kAudioDevicePropertyStreams, scope: kAudioObjectPropertyScopeInput,
                         what: "входные потоки устройства")
    }

    static func virtualFormat(of stream: AudioObjectID) throws -> AudioStreamBasicDescription {
        try get(stream, kAudioStreamPropertyVirtualFormat, initial: AudioStreamBasicDescription(),
                what: "формат потока")
    }

    static func nominalSampleRate(of device: AudioObjectID) throws -> Double {
        try get(device, kAudioDevicePropertyNominalSampleRate, initial: Double(0), what: "частота устройства")
    }

    static func describe(_ f: AudioStreamBasicDescription) -> String {
        let fmt = fourCC(OSStatus(bitPattern: f.mFormatID))
        let flags = f.mFormatFlags
        let kind = (flags & kAudioFormatFlagIsFloat) != 0 ? "float" : ((flags & kAudioFormatFlagIsSignedInteger) != 0 ? "int" : "raw")
        let layout = (flags & kAudioFormatFlagIsNonInterleaved) != 0 ? "non-interleaved" : "interleaved"
        return "\(fmt) \(Int(f.mSampleRate)) Гц, \(f.mChannelsPerFrame) кан., \(f.mBitsPerChannel) бит \(kind), \(layout), \(f.mBytesPerFrame) байт/кадр"
    }
}

/// Как лежат сэмплы в буферах тапа.
enum SampleKind {
    case float32, int16, int32

    init?(_ f: AudioStreamBasicDescription) {
        guard f.mFormatID == kAudioFormatLinearPCM else { return nil }
        let isFloat = (f.mFormatFlags & kAudioFormatFlagIsFloat) != 0
        let isSigned = (f.mFormatFlags & kAudioFormatFlagIsSignedInteger) != 0
        let isBigEndian = (f.mFormatFlags & kAudioFormatFlagIsBigEndian) != 0
        guard !isBigEndian else { return nil }
        switch (isFloat, isSigned, f.mBitsPerChannel) {
        case (true, _, 32): self = .float32
        case (false, true, 16): self = .int16
        case (false, true, 32): self = .int32
        default: return nil
        }
    }

    var bytesPerSample: Int {
        switch self {
        case .float32, .int32: return 4
        case .int16: return 2
        }
    }
}
