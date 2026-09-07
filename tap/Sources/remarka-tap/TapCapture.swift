import CoreAudio
import Foundation

/// Core Audio Process Tap → агрегатное устройство → IO-коллбэк → моно float в FloatRing.
///
/// Композиция агрегата — только тап, без саб-устройства вывода: так во входных потоках агрегата
/// нет микрофона гарнитуры (AirPods — одно устройство и на вход, и на выход), а тактирование
/// берётся от тапа (проверено: коллбэки идут на частоте устройства вывода даже в тишине).
/// `tapautostart = false` — устройство работает с момента старта и в тишине пишет нули,
/// поэтому таймкоды в файле совпадают с моментом события `ready`.
@available(macOS 14.2, *)
final class TapCapture {
    struct Config {
        var excludePIDs: [pid_t]
        var name: String
    }

    let ring: FloatRing
    private(set) var tapID: AudioObjectID = 0
    private(set) var aggregateID: AudioObjectID = 0
    private var procID: AudioDeviceIOProcID?
    private let queue = DispatchQueue(label: "app.remarka.tap.io", qos: .userInteractive)
    private let description: CATapDescription
    private let config: Config
    private(set) var format: AudioStreamBasicDescription
    private var sampleKind: SampleKind
    private var scratch: [Float] = [Float](repeating: 0, count: 1 << 15)
    private var firstBufferSeen = false
    private var listenersInstalled = false
    private var started = false

    /// Вызывается один раз, на IO-очереди, при первом буфере.
    var onFirstBuffer: (() -> Void)?

    var sampleRate: Double { format.mSampleRate }

    init(config: Config, ring: FloatRing) throws {
        self.config = config
        self.ring = ring

        // Исключаем свой процесс и переданные pid — те, что уже стали аудиоклиентами.
        let excluded = TapCapture.excludedObjects(for: [getpid()] + config.excludePIDs)
        logErr("исключаем процессы: pid \(([getpid()] + config.excludePIDs).map(String.init).joined(separator: ", ")) → объекты \(excluded)")

        let desc = CATapDescription(monoGlobalTapButExcludeProcesses: excluded)
        desc.uuid = UUID()
        desc.name = config.name
        desc.isPrivate = true
        desc.muteBehavior = .unmuted
        description = desc

        var tap: AudioObjectID = 0
        let st = AudioHardwareCreateProcessTap(desc, &tap)
        guard st == noErr, tap != 0 else {
            throw CAError(what: "не удалось создать process tap", status: st)
        }
        tapID = tap

        var fmt = try CA.get(tapID, kAudioTapPropertyFormat, initial: AudioStreamBasicDescription(), what: "формат тапа")
        logErr("формат тапа: \(CA.describe(fmt))")
        let tapUID = (try? CA.getString(tapID, kAudioTapPropertyUID, what: "UID тапа")) ?? desc.uuid.uuidString

        let composition: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Ремарка: системный звук",
            kAudioAggregateDeviceUIDKey: "app.remarka.tap.aggregate." + UUID().uuidString,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: false,
            kAudioAggregateDeviceTapListKey: [
                [kAudioSubTapUIDKey: tapUID, kAudioSubTapDriftCompensationKey: true],
            ],
        ]
        var agg: AudioObjectID = 0
        let ast = AudioHardwareCreateAggregateDevice(composition as CFDictionary, &agg)
        guard ast == noErr, agg != 0 else {
            AudioHardwareDestroyProcessTap(tap)
            tapID = 0
            throw CAError(what: "не удалось создать агрегатное устройство с тапом", status: ast)
        }
        aggregateID = agg

        // Формат, в котором данные реально придут в IO-коллбэк, — у входного потока агрегата.
        if let streams = try? CA.inputStreams(of: agg), let first = streams.first,
           let streamFormat = try? CA.virtualFormat(of: first) {
            logErr("входных потоков агрегата: \(streams.count); формат потока: \(CA.describe(streamFormat))")
            if streams.count > 1 {
                logErr("предупреждение: во входе агрегата больше одного потока — смешиваем все в моно")
            }
            fmt = streamFormat
        }
        guard let kind = SampleKind(fmt) else {
            AudioHardwareDestroyAggregateDevice(agg)
            AudioHardwareDestroyProcessTap(tap)
            aggregateID = 0
            tapID = 0
            throw CAError(what: "неподдерживаемый формат тапа: \(CA.describe(fmt))", status: -1)
        }
        format = fmt
        sampleKind = kind
    }

    static func excludedObjects(for pids: [pid_t]) -> [AudioObjectID] {
        var seen = Set<AudioObjectID>()
        var result: [AudioObjectID] = []
        for pid in pids {
            if let obj = CA.processObject(forPID: pid), !seen.contains(obj) {
                seen.insert(obj)
                result.append(obj)
            }
        }
        return result
    }

    func start() throws {
        guard !started else { return }
        var proc: AudioDeviceIOProcID? = nil
        let st = AudioDeviceCreateIOProcIDWithBlock(&proc, aggregateID, queue) { [weak self] _, inData, _, _, _ in
            self?.handleIO(inData)
        }
        guard st == noErr, let p = proc else {
            throw CAError(what: "не удалось создать IO-процедуру", status: st)
        }
        procID = p
        installListeners()
        let sst = AudioDeviceStart(aggregateID, p)
        guard sst == noErr else {
            AudioDeviceDestroyIOProcID(aggregateID, p)
            procID = nil
            throw CAError(what: "не удалось запустить агрегатное устройство", status: sst)
        }
        started = true
    }

    func stop() {
        if let p = procID {
            if started { AudioDeviceStop(aggregateID, p) }
            AudioDeviceDestroyIOProcID(aggregateID, p)
            procID = nil
        }
        started = false
        // Дождаться, пока IO-очередь допишет уже поставленные блоки в кольцо.
        queue.sync {}
        if aggregateID != 0 {
            AudioHardwareDestroyAggregateDevice(aggregateID)
            aggregateID = 0
        }
        if tapID != 0 {
            AudioHardwareDestroyProcessTap(tapID)
            tapID = 0
        }
    }

    // MARK: - Слушатели изменений

    private func installListeners() {
        guard !listenersInstalled else { return }
        listenersInstalled = true
        // Смена частоты/формата (например, переключение вывода на AirPods): перечитать формат,
        // отметить в кольце позицию, с которой идёт новая частота.
        var rateAddr = CA.address(kAudioDevicePropertyNominalSampleRate)
        AudioObjectAddPropertyListenerBlock(aggregateID, &rateAddr, queue) { [weak self] _, _ in
            self?.refreshFormat()
        }
        var tapFmtAddr = CA.address(kAudioTapPropertyFormat)
        AudioObjectAddPropertyListenerBlock(tapID, &tapFmtAddr, queue) { [weak self] _, _ in
            self?.refreshFormat()
        }
        // Появились новые аудиоклиенты: возможно, исключаемый процесс только что стал таковым.
        var procAddr = CA.address(kAudioHardwarePropertyProcessObjectList)
        AudioObjectAddPropertyListenerBlock(CA.systemObject, &procAddr, queue) { [weak self] _, _ in
            self?.refreshExclusions()
        }
    }

    private func refreshFormat() {
        var fmt: AudioStreamBasicDescription? = nil
        if let streams = try? CA.inputStreams(of: aggregateID), let first = streams.first {
            fmt = try? CA.virtualFormat(of: first)
        }
        if fmt == nil { fmt = try? CA.get(tapID, kAudioTapPropertyFormat, initial: AudioStreamBasicDescription(), what: "формат тапа") }
        guard let f = fmt, let kind = SampleKind(f) else { return }
        if f.mSampleRate != format.mSampleRate || f.mChannelsPerFrame != format.mChannelsPerFrame
            || f.mFormatFlags != format.mFormatFlags || f.mBitsPerChannel != format.mBitsPerChannel {
            logErr("формат тапа изменился: \(CA.describe(f))")
            let rateChanged = f.mSampleRate != format.mSampleRate
            format = f
            sampleKind = kind
            if rateChanged { ring.markRate(f.mSampleRate) }
        }
    }

    private func refreshExclusions() {
        let wanted = TapCapture.excludedObjects(for: [getpid()] + config.excludePIDs)
        let current = description.processes
        guard Set(wanted) != Set(current) else { return }
        description.processes = wanted
        var addr = CA.address(kAudioTapPropertyDescription)
        var desc: CATapDescription = description
        let st = withUnsafePointer(to: &desc) { ptr in
            AudioObjectSetPropertyData(tapID, &addr, 0, nil, UInt32(MemoryLayout<CATapDescription>.size), ptr)
        }
        logErr("обновили список исключений тапа → \(wanted): \(fourCC(st))")
    }

    // MARK: - IO

    private func handleIO(_ inData: UnsafePointer<AudioBufferList>) {
        let abl = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inData))
        let bufferCount = abl.count
        guard bufferCount > 0 else { return }
        let bps = sampleKind.bytesPerSample
        let b0 = abl[0]
        let ch0 = max(1, Int(b0.mNumberChannels))
        let frames = Int(b0.mDataByteSize) / (bps * ch0)
        guard frames > 0 else { return }

        if !firstBufferSeen {
            firstBufferSeen = true
            onFirstBuffer?()
        }

        // Быстрый путь: один моно float-буфер (обычный формат mono-тапа).
        if bufferCount == 1, ch0 == 1, sampleKind == .float32, let p = b0.mData?.assumingMemoryBound(to: Float.self) {
            ring.write(p, count: frames)
            return
        }

        if scratch.count < frames {
            scratch = [Float](repeating: 0, count: frames * 2)
        }
        scratch.withUnsafeMutableBufferPointer { s in
            for i in 0..<frames { s[i] = 0 }
            var totalChannels = 0
            for b in abl {
                let ch = max(1, Int(b.mNumberChannels))
                guard let raw = b.mData else { continue }
                let n = min(frames, Int(b.mDataByteSize) / (bps * ch))
                totalChannels += ch
                switch sampleKind {
                case .float32:
                    let p = raw.assumingMemoryBound(to: Float.self)
                    for i in 0..<n {
                        var acc: Float = 0
                        for c in 0..<ch { acc += p[i * ch + c] }
                        s[i] += acc
                    }
                case .int16:
                    let p = raw.assumingMemoryBound(to: Int16.self)
                    let g: Float = 1 / 32768
                    for i in 0..<n {
                        var acc: Float = 0
                        for c in 0..<ch { acc += Float(p[i * ch + c]) * g }
                        s[i] += acc
                    }
                case .int32:
                    let p = raw.assumingMemoryBound(to: Int32.self)
                    let g: Float = 1 / 2147483648
                    for i in 0..<n {
                        var acc: Float = 0
                        for c in 0..<ch { acc += Float(p[i * ch + c]) * g }
                        s[i] += acc
                    }
                }
            }
            if totalChannels > 1 {
                let g = 1 / Float(totalChannels)
                for i in 0..<frames { s[i] *= g }
            }
            ring.write(s.baseAddress!, count: frames)
        }
    }
}
