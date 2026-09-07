import Foundation

/// Рабочий поток: кольцо → ресемплер → уровень → int16 → WAV.
final class Recorder {
    private let ring: FloatRing
    private let outRate: Double
    private let wav: WavWriter
    private var resampler: Resampler
    private var inputRate: Double

    private let stateLock = NSLock()
    private var stopRequested = false
    private var levelSumSq: Double = 0
    private var levelCount: Int = 0
    private var failure: Error?

    private var thread: Thread?
    private let finished = DispatchSemaphore(value: 0)
    private var tmpIn: [Float] = []
    private var tmpOut: [Float] = []
    private var tmpI16: [Int16] = []

    /// Ошибка записи (диск и т. п.) — вызывается на главной очереди.
    var onError: ((Error) -> Void)?

    init(ring: FloatRing, inputRate: Double, outRate: Double, wav: WavWriter) {
        self.ring = ring
        self.outRate = outRate
        self.wav = wav
        self.inputRate = inputRate
        self.resampler = Resampler(inRate: inputRate, outRate: outRate)
        tmpIn.reserveCapacity(1 << 16)
        tmpOut.reserveCapacity(1 << 15)
        tmpI16.reserveCapacity(1 << 15)
    }

    var framesWritten: UInt64 { wav.framesWritten }
    var durationSec: Double { wav.durationSec }
    var path: String { wav.path }

    func start() {
        let t = Thread { [weak self] in
            self?.loop()
        }
        t.name = "remarka-tap.recorder"
        t.qualityOfService = .userInitiated
        thread = t
        t.start()
    }

    /// Уровень с момента прошлого вызова, дБFS в диапазоне −60…0. Нет данных → −60.
    func takeLevelDb() -> Double {
        stateLock.lock()
        let ss = levelSumSq
        let n = levelCount
        levelSumSq = 0
        levelCount = 0
        stateLock.unlock()
        guard n > 0, ss > 0 else { return -60 }
        let rms = (ss / Double(n)).squareRoot()
        let db = 20 * log10(rms)
        return max(-60, min(0, db))
    }

    /// Остановить поток, дописать хвост, закрыть файл. Возвращает длительность записи в секундах.
    func finish() throws -> Double {
        stateLock.lock()
        let already = stopRequested
        stopRequested = true
        stateLock.unlock()
        if !already, thread != nil {
            finished.wait()
        }
        // Остаток из кольца и хвост ресемплера.
        try drain()
        tmpOut.removeAll(keepingCapacity: true)
        resampler.flush(into: &tmpOut)
        try writeOut()
        try wav.finalize()
        let dropped = ring.dropped
        if dropped > 0 {
            logErr("предупреждение: кольцевой буфер переполнялся, потеряно сэмплов: \(dropped)")
        }
        return wav.durationSec
    }

    private func loop() {
        while true {
            stateLock.lock()
            let stop = stopRequested
            stateLock.unlock()
            if stop { break }
            do {
                try drain()
                wav.patchHeader()
            } catch {
                stateLock.lock()
                if failure == nil { failure = error }
                stateLock.unlock()
                DispatchQueue.main.async { [weak self] in self?.onError?(error) }
                break
            }
            Thread.sleep(forTimeInterval: 0.03)
        }
        finished.signal()
    }

    private func drain() throws {
        while true {
            tmpIn.removeAll(keepingCapacity: true)
            let (n, rateChange) = ring.take(into: &tmpIn, limit: 1 << 16)
            if let r = rateChange {
                tmpOut.removeAll(keepingCapacity: true)
                resampler.flush(into: &tmpOut)
                try writeOut()
                inputRate = r
                resampler = Resampler(inRate: r, outRate: outRate)
                logErr("ресемплер пересоздан: \(Int(r)) → \(Int(outRate)) Гц")
                continue
            }
            if n == 0 { break }
            tmpOut.removeAll(keepingCapacity: true)
            resampler.process(tmpIn, into: &tmpOut)
            try writeOut()
        }
    }

    /// tmpOut (float, outRate) → уровень + int16 → файл.
    private func writeOut() throws {
        guard !tmpOut.isEmpty else { return }
        var ss = 0.0
        tmpI16.removeAll(keepingCapacity: true)
        for v in tmpOut {
            ss += Double(v * v)
            let c = max(-1, min(1, v))
            tmpI16.append(Int16((c * 32767).rounded()))
        }
        stateLock.lock()
        levelSumSq += ss
        levelCount += tmpOut.count
        stateLock.unlock()
        try wav.write(tmpI16)
        tmpOut.removeAll(keepingCapacity: true)
    }
}
