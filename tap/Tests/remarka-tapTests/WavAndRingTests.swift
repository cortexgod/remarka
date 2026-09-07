import Foundation
import Testing
@testable import remarka_tap

private func le32(_ b: [UInt8], _ o: Int) -> UInt32 {
    UInt32(b[o]) | UInt32(b[o + 1]) << 8 | UInt32(b[o + 2]) << 16 | UInt32(b[o + 3]) << 24
}
private func le16(_ b: [UInt8], _ o: Int) -> UInt16 {
    UInt16(b[o]) | UInt16(b[o + 1]) << 8
}

@Test func wavHeaderFields() {
    let h = WavWriter.header(dataBytes: 1000, sampleRate: 16000)
    #expect(h.count == 44)
    #expect(String(bytes: h[0..<4], encoding: .ascii) == "RIFF")
    #expect(le32(h, 4) == 1036)
    #expect(String(bytes: h[8..<12], encoding: .ascii) == "WAVE")
    #expect(String(bytes: h[12..<16], encoding: .ascii) == "fmt ")
    #expect(le32(h, 16) == 16)
    #expect(le16(h, 20) == 1)
    #expect(le16(h, 22) == 1)
    #expect(le32(h, 24) == 16000)
    #expect(le32(h, 28) == 32000)
    #expect(le16(h, 32) == 2)
    #expect(le16(h, 34) == 16)
    #expect(String(bytes: h[36..<40], encoding: .ascii) == "data")
    #expect(le32(h, 40) == 1000)
}

@Test func wavWriterProducesReadableFile() throws {
    let path = NSTemporaryDirectory() + "remarka-tap-test-\(UUID().uuidString).wav"
    defer { try? FileManager.default.removeItem(atPath: path) }
    let w = try WavWriter(path: path, sampleRate: 16000)
    let samples: [Int16] = (0..<16000).map { Int16(truncatingIfNeeded: $0 * 3 - 20000) }
    try w.write(Array(samples[0..<7000]))
    w.patchHeader(force: true)
    try w.write(Array(samples[7000...]))
    #expect(w.framesWritten == 16000)
    #expect(abs(w.durationSec - 1.0) < 1e-9)
    try w.finalize()

    let data = try Data(contentsOf: URL(fileURLWithPath: path))
    let bytes = [UInt8](data)
    #expect(bytes.count == 44 + 32000)
    #expect(le32(bytes, 40) == 32000)
    #expect(le32(bytes, 4) == 36 + 32000)
    let body = bytes[44...].withUnsafeBufferPointer { buf -> [Int16] in
        buf.withMemoryRebound(to: Int16.self) { Array($0) }
    }
    #expect(body == samples)
}

@Test func ringRoundTripAndWrap() {
    let ring = FloatRing(capacity: 1024)
    var out: [Float] = []
    for round in 0..<10 {
        let chunk = (0..<700).map { Float(round * 1000 + $0) }
        chunk.withUnsafeBufferPointer { ring.write($0.baseAddress!, count: $0.count) }
        #expect(ring.available == 700)
        out.removeAll()
        let (n, change) = ring.take(into: &out, limit: 10_000)
        #expect(n == 700)
        #expect(change == nil)
        #expect(out == chunk)
    }
    #expect(ring.dropped == 0)
}

@Test func ringDropsOnOverflowAndCounts() {
    let ring = FloatRing(capacity: 1024)
    let chunk = [Float](repeating: 1, count: 1500)
    chunk.withUnsafeBufferPointer { ring.write($0.baseAddress!, count: $0.count) }
    #expect(ring.available == 1024)
    #expect(ring.dropped == 476)
}

@Test func ringRateMarkersSplitReads() {
    let ring = FloatRing(capacity: 4096)
    let a = [Float](repeating: 1, count: 100)
    let b = [Float](repeating: 2, count: 50)
    a.withUnsafeBufferPointer { ring.write($0.baseAddress!, count: $0.count) }
    ring.markRate(44100)
    b.withUnsafeBufferPointer { ring.write($0.baseAddress!, count: $0.count) }

    var out: [Float] = []
    var r = ring.take(into: &out, limit: 10_000)
    #expect(r.count == 100 && r.rateChange == nil && out.allSatisfy { $0 == 1 })
    out.removeAll()
    r = ring.take(into: &out, limit: 10_000)
    #expect(r.count == 0 && r.rateChange == 44100)
    r = ring.take(into: &out, limit: 10_000)
    #expect(r.count == 50 && r.rateChange == nil && out.allSatisfy { $0 == 2 })
    r = ring.take(into: &out, limit: 10_000)
    #expect(r.count == 0 && r.rateChange == nil)
}
