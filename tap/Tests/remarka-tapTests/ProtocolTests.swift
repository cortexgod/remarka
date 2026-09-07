import Foundation
import Testing
@testable import remarka_tap

@Test func eventLinesAreValidJson() throws {
    let lines = [
        Events.readyLine(),
        Events.levelLine(db: -31.24),
        Events.stoppedLine(durationSec: 12.3456, path: "/tmp/встреча \"1\"/system.wav"),
        Events.errorLine("Нет разрешения\nвторая строка\ttab \\ back"),
    ]
    for line in lines {
        #expect(!line.contains("\n"))
        let obj = try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any]
        #expect(obj != nil)
    }
    let level = try JSONSerialization.jsonObject(with: Data(lines[1].utf8)) as! [String: Any]
    #expect(level["event"] as? String == "level")
    #expect(abs((level["db"] as! Double) - (-31.2)) < 1e-9)
    let stopped = try JSONSerialization.jsonObject(with: Data(lines[2].utf8)) as! [String: Any]
    #expect(stopped["path"] as? String == "/tmp/встреча \"1\"/system.wav")
    #expect(abs((stopped["duration_sec"] as! Double) - 12.346) < 1e-9)
    let err = try JSONSerialization.jsonObject(with: Data(lines[3].utf8)) as! [String: Any]
    #expect(err["message"] as? String == "Нет разрешения\nвторая строка\ttab \\ back")
}

@Test func levelLineClampsNonFinite() {
    #expect(Events.levelLine(db: .nan) == #"{"event":"level","db":0}"#)
}

@Test func parsesFullArgumentSet() throws {
    let o = try parseArgs(["--out", "/tmp/x.wav", "--rate", "16000", "--exclude-pid", "12", "34",
                           "--exclude-pid", "56", "--level-interval-ms", "250", "--duration", "5"])
    #expect(o.outPath == "/tmp/x.wav")
    #expect(o.rate == 16000)
    #expect(o.excludePIDs == [12, 34, 56])
    #expect(o.levelIntervalMs == 250)
    #expect(o.durationSec == 5)
    #expect(o.checkPermission)
}

@Test func defaultsAndValidation() throws {
    let o = try parseArgs(["--out", "a.wav"])
    #expect(o.rate == 16000 && o.levelIntervalMs == 200 && o.excludePIDs.isEmpty && o.durationSec == nil)
    #expect(throws: ArgsError.self) { try parseArgs([]) }
    #expect(throws: ArgsError.self) { try parseArgs(["--out"]) }
    #expect(throws: ArgsError.self) { try parseArgs(["--out", "a.wav", "--rate", "abc"]) }
    #expect(throws: ArgsError.self) { try parseArgs(["--out", "a.wav", "--exclude-pid", "x"]) }
    #expect(throws: ArgsError.self) { try parseArgs(["--out", "a.wav", "--bogus"]) }
    #expect(try parseArgs(["--help"]).showHelp)
}
