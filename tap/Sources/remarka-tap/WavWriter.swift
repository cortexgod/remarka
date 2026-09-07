import Foundation

struct WavError: Error, CustomStringConvertible {
    let message: String
    var description: String { message }
}

/// WAV PCM int16 моно. Заголовок пишется сразу с нулевыми размерами, периодически и при стопе
/// переписывается с актуальными — если процесс убьют, файл всё равно будет читаемым.
final class WavWriter {
    let path: String
    let sampleRate: Int
    private var file: UnsafeMutablePointer<FILE>?
    private(set) var framesWritten: UInt64 = 0
    private var framesAtLastPatch: UInt64 = 0

    static let headerSize = 44

    init(path: String, sampleRate: Int) throws {
        self.path = path
        self.sampleRate = sampleRate
        guard let f = fopen(path, "wb") else {
            throw WavError(message: "не удалось открыть файл «\(path)»: \(String(cString: strerror(errno)))")
        }
        file = f
        let header = WavWriter.header(dataBytes: 0, sampleRate: UInt32(sampleRate))
        guard fwrite(header, 1, header.count, f) == header.count else {
            throw WavError(message: "не удалось записать заголовок WAV: \(String(cString: strerror(errno)))")
        }
    }

    deinit {
        if let f = file { fclose(f) }
    }

    /// 44-байтный заголовок RIFF/WAVE, PCM 16 бит, 1 канал.
    static func header(dataBytes: UInt32, sampleRate: UInt32) -> [UInt8] {
        var h: [UInt8] = []
        h.reserveCapacity(headerSize)
        func u32(_ v: UInt32) { h += [UInt8(v & 0xff), UInt8((v >> 8) & 0xff), UInt8((v >> 16) & 0xff), UInt8((v >> 24) & 0xff)] }
        func u16(_ v: UInt16) { h += [UInt8(v & 0xff), UInt8((v >> 8) & 0xff)] }
        h += Array("RIFF".utf8)
        u32(36 &+ dataBytes)
        h += Array("WAVE".utf8)
        h += Array("fmt ".utf8)
        u32(16)
        u16(1)                 // PCM
        u16(1)                 // моно
        u32(sampleRate)
        u32(sampleRate * 2)    // байт/с
        u16(2)                 // блок
        u16(16)                // бит
        h += Array("data".utf8)
        u32(dataBytes)
        return h
    }

    func write(_ samples: [Int16]) throws {
        guard let f = file, !samples.isEmpty else { return }
        let written = samples.withUnsafeBufferPointer { buf in
            fwrite(buf.baseAddress!, MemoryLayout<Int16>.size, buf.count, f)
        }
        guard written == samples.count else {
            throw WavError(message: "ошибка записи WAV: \(String(cString: strerror(errno)))")
        }
        framesWritten += UInt64(written)
    }

    var dataBytes: UInt32 {
        UInt32(min(framesWritten * 2, UInt64(UInt32.max - 44)))
    }

    var durationSec: Double { Double(framesWritten) / Double(sampleRate) }

    /// Переписать размеры в заголовке (не чаще чем раз в секунду данных, если `force == false`).
    func patchHeader(force: Bool = false) {
        guard let f = file else { return }
        if !force && framesWritten - framesAtLastPatch < UInt64(sampleRate) { return }
        framesAtLastPatch = framesWritten
        let header = WavWriter.header(dataBytes: dataBytes, sampleRate: UInt32(sampleRate))
        fflush(f)
        if fseeko(f, 0, SEEK_SET) == 0 {
            _ = fwrite(header, 1, header.count, f)
            fflush(f)
        }
        fseeko(f, 0, SEEK_END)
    }

    func finalize() throws {
        guard let f = file else { return }
        patchHeader(force: true)
        file = nil
        if fclose(f) != 0 {
            throw WavError(message: "не удалось закрыть WAV: \(String(cString: strerror(errno)))")
        }
    }
}
