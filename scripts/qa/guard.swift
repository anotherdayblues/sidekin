// Run acceptance commands without exporting clipboard contents or changing the pasteboard.
import AppKit
import Foundation

typealias Board = [[NSPasteboard.PasteboardType: Data]]
func snapshot() -> Board? {
    let pb = NSPasteboard.general
    let count = pb.changeCount
    guard let items = pb.pasteboardItems ?? (pb.types?.isEmpty != false ? [] : nil) else { return nil }
    var result = Board()
    for item in items {
        var formats = [NSPasteboard.PasteboardType: Data]()
        for type in item.types {
            guard let data = item.data(forType: type) else { return nil }
            formats[type] = data
        }
        result.append(formats)
    }
    return count == pb.changeCount ? result : nil
}
let env = ProcessInfo.processInfo.environment
guard let path=env["QA"] else { exit(71) }
let root=URL(fileURLWithPath:path).standardizedFileURL.resolvingSymlinksInPath()
let executable=URL(fileURLWithPath:CommandLine.arguments[0]).standardizedFileURL.resolvingSymlinksInPath()
let runs=root.deletingLastPathComponent()
let source=runs.deletingLastPathComponent().appendingPathComponent("scripts/qa/guard.swift")
guard executable.deletingLastPathComponent().path==root.path, runs.lastPathComponent=="runs",
      FileManager.default.fileExists(atPath:source.path) else {exit(71)}
guard root.lastPathComponent.hasPrefix("companion-456.") else{exit(71)}
if FileManager.default.fileExists(atPath:root.appendingPathComponent("STOP").path){exit(72)}
let generation = NSPasteboard.general.changeCount
guard let baseline = snapshot(), CommandLine.arguments.count > 1 else { exit(71) }
let child = Process()
child.executableURL = URL(fileURLWithPath: "/usr/bin/env")
child.arguments = Array(CommandLine.arguments.dropFirst())
var isolated = env
for key in ["TMPDIR","TMP","TEMP"]{isolated[key]=root.appendingPathComponent("tmp").path}
isolated["PYTHONDONTWRITEBYTECODE"]="1"
isolated["COMPANION_QA_GUARDED"]="1"
child.environment=isolated
try child.run()
func mismatch() -> Never {
    if child.isRunning { child.terminate() }
    FileHandle.standardError.write(Data("STOP: clipboard changed; no restoration attempted.\n".utf8))
    if let root = ProcessInfo.processInfo.environment["QA"] {
        FileManager.default.createFile(atPath: root + "/STOP", contents: Data("clipboard mismatch".utf8))
    }
    exit(72)
}
while child.isRunning {
    if NSPasteboard.general.changeCount != generation { mismatch() }
    Thread.sleep(forTimeInterval: 0.1)
}
if NSPasteboard.general.changeCount != generation || snapshot() != baseline { mismatch() }
exit(child.terminationStatus)
