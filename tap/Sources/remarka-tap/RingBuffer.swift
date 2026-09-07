import Foundation
import os

/// Кольцевой буфер float-сэмплов между IO-коллбэком Core Audio (писатель) и рабочим потоком
/// (читатель). Секция под os_unfair_lock — несколько инструкций; аллокаций внутри нет.
/// Маркеры смены частоты: писатель отмечает позицию, с которой приходят сэмплы с другой частотой,
/// читатель получает их отдельным результатом `take`.
final class FloatRing {
    private var storage: [Float]
    private let capacity: Int
    private var head = 0 // индекс записи
    private var tail = 0 // индекс чтения
    private var count = 0
    private var totalWritten: UInt64 = 0
    private var totalRead: UInt64 = 0
    private var droppedSamples: UInt64 = 0
    private var markers: [(offset: UInt64, rate: Double)] = []
    private let lockPtr: UnsafeMutablePointer<os_unfair_lock>

    init(capacity: Int) {
        self.capacity = max(1024, capacity)
        storage = [Float](repeating: 0, count: self.capacity)
        lockPtr = UnsafeMutablePointer<os_unfair_lock>.allocate(capacity: 1)
        lockPtr.initialize(to: os_unfair_lock())
    }

    deinit {
        lockPtr.deinitialize(count: 1)
        lockPtr.deallocate()
    }

    /// Сколько сэмплов потеряно из-за переполнения (читатель не успевал).
    var dropped: UInt64 {
        os_unfair_lock_lock(lockPtr)
        defer { os_unfair_lock_unlock(lockPtr) }
        return droppedSamples
    }

    var available: Int {
        os_unfair_lock_lock(lockPtr)
        defer { os_unfair_lock_unlock(lockPtr) }
        return count
    }

    var written: UInt64 {
        os_unfair_lock_lock(lockPtr)
        defer { os_unfair_lock_unlock(lockPtr) }
        return totalWritten
    }

    /// Писатель. При переполнении лишнее отбрасывается (и считается), чтобы не блокировать аудиопоток.
    func write(_ src: UnsafePointer<Float>, count n: Int) {
        guard n > 0 else { return }
        os_unfair_lock_lock(lockPtr)
        defer { os_unfair_lock_unlock(lockPtr) }
        let free = capacity - count
        let toWrite = min(n, free)
        if toWrite < n { droppedSamples += UInt64(n - toWrite) }
        if toWrite > 0 {
            storage.withUnsafeMutableBufferPointer { dst in
                let first = min(toWrite, capacity - head)
                dst.baseAddress!.advanced(by: head).update(from: src, count: first)
                if toWrite > first {
                    dst.baseAddress!.update(from: src.advanced(by: first), count: toWrite - first)
                }
            }
            head = (head + toWrite) % capacity
            count += toWrite
            totalWritten += UInt64(toWrite)
        }
    }

    /// Писатель: с текущей позиции сэмплы идут с новой частотой.
    func markRate(_ rate: Double) {
        os_unfair_lock_lock(lockPtr)
        defer { os_unfair_lock_unlock(lockPtr) }
        markers.append((offset: totalWritten, rate: rate))
    }

    /// Читатель. Сначала проверяет, не стоит ли маркер смены частоты на текущей позиции чтения:
    /// тогда возвращает (0, rate) и снимает маркер. Иначе дописывает в `out` до `limit` сэмплов,
    /// не пересекая следующий маркер. (0, nil) — данных нет.
    func take(into out: inout [Float], limit: Int) -> (count: Int, rateChange: Double?) {
        os_unfair_lock_lock(lockPtr)
        defer { os_unfair_lock_unlock(lockPtr) }
        var boundary = count
        if let m = markers.first {
            if m.offset <= totalRead {
                markers.removeFirst()
                return (0, m.rate)
            }
            boundary = min(boundary, Int(m.offset - totalRead))
        }
        let n = min(limit, boundary)
        guard n > 0 else { return (0, nil) }
        storage.withUnsafeBufferPointer { src in
            let first = min(n, capacity - tail)
            out.append(contentsOf: UnsafeBufferPointer(start: src.baseAddress!.advanced(by: tail), count: first))
            if n > first {
                out.append(contentsOf: UnsafeBufferPointer(start: src.baseAddress!, count: n - first))
            }
        }
        tail = (tail + n) % capacity
        count -= n
        totalRead += UInt64(n)
        return (n, nil)
    }
}
