import Foundation

/// Потоковый ресемплер произвольного отношения частот: полифазный FIR (окно Кайзера, sinc)
/// с интерполяцией между фазами. 48 000 → 16 000: ~144 отвода, ФНЧ на 0,9·8 кГц, ≈70 дБ подавления.
/// Выходной сэмпл n соответствует входному времени n·(inRate/outRate) — без сдвига (важно для таймкодов).
final class Resampler {
    let inRate: Double
    let outRate: Double
    let taps: Int
    private let phases = 256
    private let table: [Float]      // (phases + 1) × taps
    private var buffer: [Float]
    private var readPos: Double
    private let step: Double
    private let identity: Bool
    private var flushed = false

    init(inRate: Double, outRate: Double) {
        precondition(inRate > 0 && outRate > 0)
        self.inRate = inRate
        self.outRate = outRate
        identity = abs(inRate - outRate) < 1e-6
        step = inRate / outRate

        let ratio = max(1.0, inRate / outRate)
        var n = Int((48.0 * ratio).rounded(.up))
        n = max(32, min(4096, n))
        if n % 2 == 1 { n += 1 }
        taps = n

        if identity {
            table = []
            buffer = []
            readPos = 0
        } else {
            table = Resampler.makeTable(taps: n, phases: phases, inRate: inRate, outRate: outRate)
            buffer = [Float](repeating: 0, count: n / 2 - 1)
            readPos = Double(n / 2 - 1)
        }
    }

    /// Модифицированная функция Бесселя I0 (ряд Тейлора).
    private static func besselI0(_ x: Double) -> Double {
        var sum = 1.0
        var term = 1.0
        let y = x * x / 4
        var k = 1.0
        while term > 1e-12 * sum {
            term *= y / (k * k)
            sum += term
            k += 1
            if k > 500 { break }
        }
        return sum
    }

    private static func makeTable(taps: Int, phases: Int, inRate: Double, outRate: Double) -> [Float] {
        let beta = 7.0
        let cutoffHz = 0.90 * min(inRate, outRate) / 2
        let fc = cutoffHz / inRate // циклов на входной сэмпл
        let half = Double(taps / 2)
        let i0beta = besselI0(beta)
        var table = [Float](repeating: 0, count: (phases + 1) * taps)
        for p in 0...phases {
            let f = Double(p) / Double(phases)
            var row = [Double](repeating: 0, count: taps)
            var sum = 0.0
            for j in 0..<taps {
                let tau = Double(j - taps / 2 + 1) - f
                let x = tau / half
                var w = 0.0
                if abs(x) < 1 {
                    w = besselI0(beta * (1 - x * x).squareRoot()) / i0beta
                }
                let arg = 2 * fc * tau
                let sinc = arg == 0 ? 1.0 : sin(Double.pi * arg) / (Double.pi * arg)
                let h = 2 * fc * sinc * w
                row[j] = h
                sum += h
            }
            let g = sum != 0 ? 1 / sum : 1
            for j in 0..<taps {
                table[p * taps + j] = Float(row[j] * g)
            }
        }
        return table
    }

    /// Пропустить входные сэмплы; выход дописывается в `out`.
    func process(_ input: [Float], into out: inout [Float]) {
        precondition(!flushed, "ресемплер уже закрыт")
        if identity {
            out.append(contentsOf: input)
            return
        }
        buffer.append(contentsOf: input)
        produce(into: &out)
    }

    /// Дописать хвост (нули) и выдать всё, что осталось. После этого ресемплер не используется.
    func flush(into out: inout [Float]) {
        guard !flushed else { return }
        flushed = true
        if identity { return }
        buffer.append(contentsOf: [Float](repeating: 0, count: taps / 2))
        produce(into: &out)
    }

    private func produce(into out: inout [Float]) {
        let n = taps
        let halfN = n / 2
        let count = buffer.count
        let ph = Double(phases)
        buffer.withUnsafeBufferPointer { x in
            table.withUnsafeBufferPointer { t in
                while true {
                    let i = Int(readPos)
                    if i + halfN >= count { break }
                    let frac = readPos - Double(i)
                    let pf = frac * ph
                    let p = min(Int(pf), phases - 1)
                    let pfrac = Float(pf - Double(p))
                    let rowA = t.baseAddress!.advanced(by: p * n)
                    let rowB = rowA.advanced(by: n)
                    let src = x.baseAddress!.advanced(by: i - halfN + 1)
                    var accA: Float = 0
                    var accB: Float = 0
                    for j in 0..<n {
                        let s = src[j]
                        accA += rowA[j] * s
                        accB += rowB[j] * s
                    }
                    out.append(accA + (accB - accA) * pfrac)
                    readPos += step
                }
            }
        }
        let drop = Int(readPos) - halfN + 1
        if drop > 0 {
            buffer.removeFirst(min(drop, buffer.count))
            readPos -= Double(drop)
        }
    }
}
