import Foundation
import Testing
@testable import remarka_tap

private func sine(freq: Double, rate: Double, seconds: Double, amp: Float = 1) -> [Float] {
    let n = Int(rate * seconds)
    return (0..<n).map { amp * Float(sin(2 * Double.pi * freq * Double($0) / rate)) }
}

/// Частота по переходам через ноль в установившемся режиме.
private func zeroCrossingFreq(_ x: ArraySlice<Float>, rate: Double) -> Double {
    var crossings = 0
    var prev = x.first ?? 0
    for v in x.dropFirst() {
        if (prev < 0 && v >= 0) || (prev >= 0 && v < 0) { crossings += 1 }
        prev = v
    }
    return Double(crossings) / 2 / (Double(x.count) / rate)
}

private func rms(_ x: ArraySlice<Float>) -> Double {
    guard !x.isEmpty else { return 0 }
    return (x.reduce(0.0) { $0 + Double($1 * $1) } / Double(x.count)).squareRoot()
}

@Test func downsample48kTo16kKeepsToneAndLength() {
    let r = Resampler(inRate: 48000, outRate: 16000)
    var out: [Float] = []
    r.process(sine(freq: 1000, rate: 48000, seconds: 2), into: &out)
    r.flush(into: &out)
    #expect(abs(out.count - 32000) <= 2)
    let steady = out[4000..<28000]
    #expect(abs(zeroCrossingFreq(steady, rate: 16000) - 1000) < 5)
    let peak = steady.map { abs($0) }.max() ?? 0
    #expect(abs(peak - 1) < 0.02)
    #expect(abs(rms(steady) - 0.7071) < 0.01)
}

@Test func downsampleRejectsAliasing() {
    // 10 кГц выше Найквиста выхода (8 кГц) — должно быть подавлено не хуже −40 дБ.
    let r = Resampler(inRate: 48000, outRate: 16000)
    var out: [Float] = []
    r.process(sine(freq: 10000, rate: 48000, seconds: 1), into: &out)
    r.flush(into: &out)
    let steady = out[2000..<14000]
    #expect(rms(steady) < 0.01)
}

@Test func resample44100To16000() {
    let r = Resampler(inRate: 44100, outRate: 16000)
    var out: [Float] = []
    r.process(sine(freq: 1000, rate: 44100, seconds: 2), into: &out)
    r.flush(into: &out)
    #expect(abs(out.count - 32000) <= 3)
    let steady = out[4000..<28000]
    #expect(abs(zeroCrossingFreq(steady, rate: 16000) - 1000) < 5)
    let peak = steady.map { abs($0) }.max() ?? 0
    #expect(abs(peak - 1) < 0.03)
}

@Test func upsample8kTo16k() {
    let r = Resampler(inRate: 8000, outRate: 16000)
    var out: [Float] = []
    r.process(sine(freq: 500, rate: 8000, seconds: 1), into: &out)
    r.flush(into: &out)
    #expect(abs(out.count - 16000) <= 2)
    let steady = out[2000..<14000]
    #expect(abs(zeroCrossingFreq(steady, rate: 16000) - 500) < 5)
}

@Test func chunkedProcessingMatchesWhole() {
    let input = sine(freq: 700, rate: 48000, seconds: 0.5)
    let whole = Resampler(inRate: 48000, outRate: 16000)
    var a: [Float] = []
    whole.process(input, into: &a)
    whole.flush(into: &a)

    let chunked = Resampler(inRate: 48000, outRate: 16000)
    var b: [Float] = []
    var i = 0
    var size = 1
    while i < input.count {
        let end = min(input.count, i + size)
        chunked.process(Array(input[i..<end]), into: &b)
        i = end
        size = (size * 7 + 3) % 977 + 1
    }
    chunked.flush(into: &b)
    #expect(a.count == b.count)
    for (x, y) in zip(a, b) { #expect(abs(x - y) < 1e-5) }
}

@Test func impulseTimingIsPreserved() {
    // Импульс на 0,1 с входа должен оказаться на 0,1 с выхода (таймкоды не сдвигаются).
    var input = [Float](repeating: 0, count: 48000)
    input[4800] = 1
    let r = Resampler(inRate: 48000, outRate: 16000)
    var out: [Float] = []
    r.process(input, into: &out)
    r.flush(into: &out)
    var best = 0
    for (i, v) in out.enumerated() where abs(v) > abs(out[best]) { best = i }
    #expect(abs(best - 1600) <= 1)
}

@Test func identityPassthrough() {
    let r = Resampler(inRate: 16000, outRate: 16000)
    var out: [Float] = []
    let input: [Float] = [0.1, -0.2, 0.3]
    r.process(input, into: &out)
    r.flush(into: &out)
    #expect(out == input)
}
