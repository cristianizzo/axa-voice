// aecio.swift — AUVoiceProcessingIO helper for Node
//
// Build:
//   swiftc -O aecio.swift -o aecio
//
// Protocol
//   stdin  : framed commands  [1 byte cmd][4 byte LE length][payload]
//              'A' = playback PCM16LE mono @ --rate      payload = samples
//              'F' = flush playback (barge-in)           payload = empty
//              'Q' = quit                                payload = empty
//   stdout : RAW PCM16LE mono microphone @ --mic-rate, continuous, no framing
//   stderr : one JSON object per line (events)
//
import AudioToolbox
import CoreAudio
import Darwin
import Foundation
import Synchronization

// ───────────────────────────────────────────────────────────── utilities

func fourCC(_ v: UInt32) -> String {
    let b = [UInt8((v >> 24) & 0xff), UInt8((v >> 16) & 0xff), UInt8((v >> 8) & 0xff), UInt8(v & 0xff)]
    let s = String(bytes: b, encoding: .ascii) ?? ""
    return s.allSatisfy { $0.isLetter || $0.isNumber || $0 == " " } ? s : "\(Int32(bitPattern: v))"
}

let errLock = NSLock()
func event(_ dict: [String: Any]) {
    guard let d = try? JSONSerialization.data(withJSONObject: dict) else { return }
    errLock.lock(); defer { errLock.unlock() }
    FileHandle.standardError.write(d)
    FileHandle.standardError.write(Data([0x0a]))
}
func fail(_ what: String, _ st: OSStatus) -> Never {
    event(["type": "error", "where": what, "status": Int(st), "code": fourCC(UInt32(bitPattern: st))])
    exit(1)
}
@discardableResult
func ck(_ st: OSStatus, _ what: String) -> OSStatus {
    if st != noErr { fail(what, st) }
    return st
}

// ───────────────────────────────────────────────────── lock-free SPSC ring
// Single producer, single consumer. Capacity is a power of two, in Int16 samples.
final class Ring: @unchecked Sendable {
    let mask: UInt64
    let cap: Int
    let buf: UnsafeMutablePointer<Int16>
    let wIdx = Atomic<UInt64>(0)
    let rIdx = Atomic<UInt64>(0)

    init(capacityFrames: Int) {
        var c = 1
        while c < capacityFrames { c <<= 1 }
        cap = c
        mask = UInt64(c - 1)
        buf = UnsafeMutablePointer<Int16>.allocate(capacity: c)
        buf.initialize(repeating: 0, count: c)
    }
    deinit { buf.deallocate() }

    var available: Int {                       // readable samples
        Int(wIdx.load(ordering: .acquiring) &- rIdx.load(ordering: .acquiring))
    }
    var freeSpace: Int { cap - available }

    /// Producer side. Returns samples actually written (drops the excess if full).
    @discardableResult
    func write(_ src: UnsafePointer<Int16>, _ count: Int) -> Int {
        let w = wIdx.load(ordering: .relaxed)
        let r = rIdx.load(ordering: .acquiring)
        let free = cap - Int(w &- r)
        let n = min(count, free)
        if n <= 0 { return 0 }
        let start = Int(w & mask)
        let first = min(n, cap - start)
        buf.advanced(by: start).update(from: src, count: first)
        if n > first { buf.update(from: src.advanced(by: first), count: n - first) }
        wIdx.store(w &+ UInt64(n), ordering: .releasing)
        return n
    }

    /// Consumer side. Returns samples actually read.
    @discardableResult
    func read(_ dst: UnsafeMutablePointer<Int16>, _ count: Int) -> Int {
        let r = rIdx.load(ordering: .relaxed)
        let w = wIdx.load(ordering: .acquiring)
        let n = min(count, Int(w &- r))
        if n <= 0 { return 0 }
        let start = Int(r & mask)
        let first = min(n, cap - start)
        dst.update(from: buf.advanced(by: start), count: first)
        if n > first { dst.advanced(by: first).update(from: buf, count: n - first) }
        rIdx.store(r &+ UInt64(n), ordering: .releasing)
        return n
    }

    /// Consumer side only. Discards everything currently queued; returns samples dropped.
    @discardableResult
    func dropAll() -> Int {
        let w = wIdx.load(ordering: .acquiring)
        let r = rIdx.load(ordering: .relaxed)
        rIdx.store(w, ordering: .releasing)
        return Int(w &- r)
    }
}

// ───────────────────────────────────────────────────────────── arguments
var rate: Double = 24000          // VPIO client rate, BOTH scopes (must match!)
var micRate: Double = 16000       // rate we emit on stdout (converted off the RT thread)
var bufferFrames: UInt32 = 0      // 0 = leave device default
var verbose = false
var bypassAEC = false
var disableAGC = false
var maxSlice: UInt32 = 512   // do NOT raise: it batches the callbacks
do {
    var i = 1
    let a = CommandLine.arguments
    while i < a.count {
        switch a[i] {
        case "--rate":          rate = Double(a[i+1])!; i += 2
        case "--mic-rate":      micRate = Double(a[i+1])!; i += 2
        case "--buffer-frames": bufferFrames = UInt32(a[i+1])!; i += 2
        case "--verbose":       verbose = true; i += 1
        case "--bypass":        bypassAEC = true; i += 1
        case "--no-agc":        disableAGC = true; i += 1
        case "--max-slice":     maxSlice = UInt32(a[i+1])!; i += 2
        default: i += 1
        }
    }
}

// ─────────────────────────────────────────────────────── shared RT state
let playRing = Ring(capacityFrames: Int(rate) * 4)   // 4 s of playback
let micRing  = Ring(capacityFrames: Int(rate) * 4)

let framesConsumed = Atomic<UInt64>(0)   // real playback frames handed to the unit
let flushRequest   = Atomic<UInt64>(0)   // bumped by stdin thread
let flushDone      = Atomic<UInt64>(0)   // echoed by render callback
let flushAtFrame   = Atomic<UInt64>(0)   // framesConsumed at the moment of flush
let flushReqTime   = Atomic<UInt64>(0)   // mach_absolute_time when stdin saw 'F'
let flushExecTime  = Atomic<UInt64>(0)   // mach_absolute_time when render callback flushed
let flushDropped   = Atomic<UInt64>(0)   // samples discarded by the flush
var machInfo = mach_timebase_info_data_t()
mach_timebase_info(&machInfo)
func machToMs(_ t: UInt64) -> Double {
    Double(t) * Double(machInfo.numer) / Double(machInfo.denom) / 1_000_000.0
}
let underruns      = Atomic<UInt64>(0)
let renderCalls    = Atomic<UInt64>(0)
let renderFrames   = Atomic<UInt64>(0)
let renderMaxGapNs = Atomic<UInt64>(0)
let renderLastTime = Atomic<UInt64>(0)
let inputCalls     = Atomic<UInt64>(0)
let inputFrames    = Atomic<UInt64>(0)
let running        = Atomic<Bool>(true)

// ─────────────────────────────────────────────────────── audio callbacks

// Preallocated buffer list for pulling mic audio (never allocate on the RT thread).
let micSlice = 4096
let micScratch = UnsafeMutablePointer<Int16>.allocate(capacity: micSlice)
let micABL = AudioBufferList.allocate(maximumBuffers: 1)

let inputCallback: AURenderCallback = { _, ioActionFlags, inTimeStamp, inBusNumber, inNumberFrames, _ in
    let n = Int(inNumberFrames)
    if n > micSlice { return noErr }
    micABL[0] = AudioBuffer(mNumberChannels: 1,
                            mDataByteSize: UInt32(n * 2),
                            mData: UnsafeMutableRawPointer(micScratch))
    let st = AudioUnitRender(gAudioUnit!, ioActionFlags, inTimeStamp,
                             inBusNumber, inNumberFrames, micABL.unsafeMutablePointer)
    if st != noErr { return st }
    _ = inputCalls.wrappingAdd(1, ordering: .relaxed)
    _ = inputFrames.wrappingAdd(UInt64(n), ordering: .relaxed)
    micRing.write(micScratch, n)
    return noErr
}

let renderCallback: AURenderCallback = { _, _, _, _, inNumberFrames, ioData in
    guard let ioData = ioData else { return noErr }
    let abl = UnsafeMutableAudioBufferListPointer(ioData)
    let n = Int(inNumberFrames)
    do {
        let now = mach_absolute_time()
        let prev = renderLastTime.exchange(now, ordering: .acquiringAndReleasing)
        if prev != 0 {
            let gap = now &- prev
            if gap > renderMaxGapNs.load(ordering: .relaxed) {
                renderMaxGapNs.store(gap, ordering: .releasing)
            }
        }
        _ = renderCalls.wrappingAdd(1, ordering: .relaxed)
        _ = renderFrames.wrappingAdd(UInt64(n), ordering: .relaxed)
    }

    // Barge-in: drop everything queued, before we pull this slice.
    let req = flushRequest.load(ordering: .acquiring)
    if req != flushDone.load(ordering: .relaxed) {
        let dropped = playRing.dropAll()
        flushDropped.store(UInt64(dropped), ordering: .releasing)
        flushExecTime.store(mach_absolute_time(), ordering: .releasing)
        flushAtFrame.store(framesConsumed.load(ordering: .relaxed), ordering: .releasing)
        flushDone.store(req, ordering: .releasing)
    }

    guard let first = abl.first, let base = first.mData else { return noErr }
    let got = playRing.read(base.assumingMemoryBound(to: Int16.self), n)
    if got < n {
        // Underrun (or intentionally silent): zero-fill the tail.
        base.assumingMemoryBound(to: Int16.self).advanced(by: got)
            .update(repeating: 0, count: n - got)
        if got == 0 { _ = underruns.wrappingAdd(1, ordering: .relaxed) }
    }
    if got > 0 { _ = framesConsumed.wrappingAdd(UInt64(got), ordering: .relaxed) }

    // Duplicate mono into any additional channels the unit asked for.
    if abl.count > 1 {
        for i in 1..<abl.count {
            if let d = abl[i].mData {
                d.assumingMemoryBound(to: Int16.self).update(
                    from: base.assumingMemoryBound(to: Int16.self), count: n)
            }
        }
    }
    return noErr
}

// ───────────────────────────────────────────────────────── set up the unit
var gAudioUnit: AudioUnit?

var acd = AudioComponentDescription(
    componentType: kAudioUnitType_Output,
    componentSubType: kAudioUnitSubType_VoiceProcessingIO,
    componentManufacturer: kAudioUnitManufacturer_Apple,
    componentFlags: 0, componentFlagsMask: 0)
guard let comp = AudioComponentFindNext(nil, &acd) else {
    event(["type": "error", "where": "AudioComponentFindNext", "message": "VPIO not present"]); exit(1)
}
ck(AudioComponentInstanceNew(comp, &gAudioUnit), "AudioComponentInstanceNew")
let au = gAudioUnit!

var enable: UInt32 = 1
ck(AudioUnitSetProperty(au, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Input,  1, &enable, 4),
   "EnableIO(input,bus1)")
ck(AudioUnitSetProperty(au, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Output, 0, &enable, 4),
   "EnableIO(output,bus0)")

// Optional: shrink the device buffer to cut barge-in latency.
if bufferFrames > 0 {
    var dev: AudioDeviceID = 0; var dsz = UInt32(4)
    AudioUnitGetProperty(au, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &dev, &dsz)
    var bf = bufferFrames
    var addr = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyBufferFrameSize,
                                          mScope: kAudioObjectPropertyScopeGlobal,
                                          mElement: kAudioObjectPropertyElementMain)
    let st = AudioObjectSetPropertyData(dev, &addr, 0, nil, 4, &bf)
    event(["type": "bufferFrameSize", "requested": Int(bufferFrames), "status": Int(st)])
}

// CLIENT formats. Both scopes MUST use the same sample rate or Initialize fails (-10875).
func clientASBD(_ sr: Double) -> AudioStreamBasicDescription {
    AudioStreamBasicDescription(
        mSampleRate: sr, mFormatID: kAudioFormatLinearPCM,
        mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
        mBytesPerPacket: 2, mFramesPerPacket: 1, mBytesPerFrame: 2,
        mChannelsPerFrame: 1, mBitsPerChannel: 16, mReserved: 0)
}
let asbdSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
var micFmt = clientASBD(rate)   // bus 1 / Output scope  = what WE READ
var spkFmt = clientASBD(rate)   // bus 0 / Input  scope  = what WE WRITE
ck(AudioUnitSetProperty(au, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Output, 1, &micFmt, asbdSize),
   "StreamFormat(mic client, bus1/Output)")
ck(AudioUnitSetProperty(au, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Input, 0, &spkFmt, asbdSize),
   "StreamFormat(playback client, bus0/Input)")

var maxFPS: UInt32 = maxSlice
ck(AudioUnitSetProperty(au, kAudioUnitProperty_MaximumFramesPerSlice, kAudioUnitScope_Global, 0, &maxFPS, 4),
   "MaximumFramesPerSlice")

var inCB = AURenderCallbackStruct(inputProc: inputCallback, inputProcRefCon: nil)
ck(AudioUnitSetProperty(au, kAudioOutputUnitProperty_SetInputCallback, kAudioUnitScope_Global, 0,
                        &inCB, UInt32(MemoryLayout<AURenderCallbackStruct>.size)),
   "SetInputCallback")

var outCB = AURenderCallbackStruct(inputProc: renderCallback, inputProcRefCon: nil)
ck(AudioUnitSetProperty(au, kAudioUnitProperty_SetRenderCallback, kAudioUnitScope_Input, 0,
                        &outCB, UInt32(MemoryLayout<AURenderCallbackStruct>.size)),
   "SetRenderCallback")

// Echo cancellation is on by default; AGC is optional.
var bypass: UInt32 = bypassAEC ? 1 : 0
let bypassStatus = AudioUnitSetProperty(au, kAUVoiceIOProperty_BypassVoiceProcessing,
                                        kAudioUnitScope_Global, 0, &bypass, 4)
var bypassReadback: UInt32 = 9; var bsz = UInt32(4)
AudioUnitGetProperty(au, kAUVoiceIOProperty_BypassVoiceProcessing, kAudioUnitScope_Global, 0,
                     &bypassReadback, &bsz)
var agc: UInt32 = disableAGC ? 0 : 1
let agcStatus = AudioUnitSetProperty(au, kAUVoiceIOProperty_VoiceProcessingEnableAGC,
                                     kAudioUnitScope_Global, 0, &agc, 4)
var agcReadback: UInt32 = 9; var asz = UInt32(4)
AudioUnitGetProperty(au, kAUVoiceIOProperty_VoiceProcessingEnableAGC, kAudioUnitScope_Global, 0,
                     &agcReadback, &asz)
event(["type": "aec", "bypassRequested": bypassAEC,
       "setStatus": Int(bypassStatus), "readback": Int(bypassReadback),
       "agcDisabled": disableAGC, "agcSetStatus": Int(agcStatus), "agcReadback": Int(agcReadback)])

ck(AudioUnitInitialize(au), "AudioUnitInitialize")

// ───────────────────────────────────── report the latency budget to Node
func devLatency() -> (dev: AudioDeviceID, latency: UInt32, safety: UInt32, buf: UInt32, stream: UInt32) {
    var dev: AudioDeviceID = 0; var sz = UInt32(4)
    AudioUnitGetProperty(au, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &dev, &sz)
    func u32(_ sel: AudioObjectPropertySelector) -> UInt32 {
        var a = AudioObjectPropertyAddress(mSelector: sel, mScope: kAudioObjectPropertyScopeOutput,
                                           mElement: kAudioObjectPropertyElementMain)
        var v: UInt32 = 0; var s = UInt32(4)
        AudioObjectGetPropertyData(dev, &a, 0, nil, &s, &v); return v
    }
    var streamLat: UInt32 = 0
    var sa = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreams,
                                        mScope: kAudioObjectPropertyScopeOutput,
                                        mElement: kAudioObjectPropertyElementMain)
    var ssz: UInt32 = 0
    if AudioObjectGetPropertyDataSize(dev, &sa, 0, nil, &ssz) == noErr, ssz >= 4 {
        var ids = [AudioStreamID](repeating: 0, count: Int(ssz) / 4)
        if AudioObjectGetPropertyData(dev, &sa, 0, nil, &ssz, &ids) == noErr, let s0 = ids.first {
            var la = AudioObjectPropertyAddress(mSelector: kAudioStreamPropertyLatency,
                                                mScope: kAudioObjectPropertyScopeGlobal,
                                                mElement: kAudioObjectPropertyElementMain)
            var v: UInt32 = 0; var vs = UInt32(4)
            AudioObjectGetPropertyData(s0, &la, 0, nil, &vs, &v); streamLat = v
        }
    }
    return (dev, u32(kAudioDevicePropertyLatency), u32(kAudioDevicePropertySafetyOffset),
            u32(kAudioDevicePropertyBufferFrameSize), streamLat)
}
let L = devLatency()
var auLatency: Float64 = 0; var alsz = UInt32(8)
AudioUnitGetProperty(au, kAudioUnitProperty_Latency, kAudioUnitScope_Global, 0, &auLatency, &alsz)

var hwRate: Float64 = 48000
do {
    var a = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyNominalSampleRate,
                                       mScope: kAudioObjectPropertyScopeGlobal,
                                       mElement: kAudioObjectPropertyElementMain)
    var s = UInt32(8); AudioObjectGetPropertyData(L.dev, &a, 0, nil, &s, &hwRate)
}
// Frames of *our* clock that are already committed to the speaker when we flush.
let outLatencyFrames = Double(L.latency + L.safety + L.buf + L.stream) * (rate / hwRate)

// ────────────────────────────────────────── mic 24k -> 16k converter thread
final class Resampler {
    var conv: AudioConverterRef?
    var pending: UnsafeMutablePointer<Int16>?
    var pendingCount: Int = 0
    var consumed = false

    init(from: Double, to: Double) {
        var src = clientASBD(from), dst = clientASBD(to)
        let st = AudioConverterNew(&src, &dst, &conv)
        if st != noErr { fail("AudioConverterNew", st) }
        var q = kAudioConverterQuality_Medium
        AudioConverterSetProperty(conv!, kAudioConverterSampleRateConverterQuality, 4, &q)
    }

    private static let inputProc: AudioConverterComplexInputDataProc = {
        _, ioNumberDataPackets, ioData, _, inUserData in
        let me = Unmanaged<Resampler>.fromOpaque(inUserData!).takeUnretainedValue()
        if me.consumed || me.pendingCount == 0 {
            ioNumberDataPackets.pointee = 0
            return 1   // no more input this round
        }
        let abl = UnsafeMutableAudioBufferListPointer(ioData)
        abl[0] = AudioBuffer(mNumberChannels: 1,
                             mDataByteSize: UInt32(me.pendingCount * 2),
                             mData: UnsafeMutableRawPointer(me.pending))
        ioNumberDataPackets.pointee = UInt32(me.pendingCount)
        me.consumed = true
        return noErr
    }

    /// Convert `count` samples; calls `sink` with the produced samples.
    func convert(_ src: UnsafeMutablePointer<Int16>, _ count: Int,
                 _ out: UnsafeMutablePointer<Int16>, _ outCap: Int,
                 _ sink: (UnsafeMutablePointer<Int16>, Int) -> Void) {
        pending = src; pendingCount = count; consumed = false
        let abl = AudioBufferList.allocate(maximumBuffers: 1)
        defer { free(abl.unsafeMutablePointer) }
        while true {
            var frames = UInt32(outCap)
            abl[0] = AudioBuffer(mNumberChannels: 1,
                                 mDataByteSize: UInt32(outCap * 2),
                                 mData: UnsafeMutableRawPointer(out))
            let st = AudioConverterFillComplexBuffer(
                conv!, Resampler.inputProc, Unmanaged.passUnretained(self).toOpaque(),
                &frames, abl.unsafeMutablePointer, nil)
            if frames > 0 { sink(out, Int(frames)) }
            if st != noErr || frames == 0 { break }
            if consumed { break }
        }
    }
}

let needResample = abs(micRate - rate) > 0.5
let resampler = needResample ? Resampler(from: rate, to: micRate) : nil

// Writer thread: drains micRing -> (resample) -> stdout. Never runs on the RT thread.
let writerThread = Thread {
    let chunk = 1024
    let inBuf  = UnsafeMutablePointer<Int16>.allocate(capacity: chunk)
    let outBuf = UnsafeMutablePointer<Int16>.allocate(capacity: chunk * 4)
    defer { inBuf.deallocate(); outBuf.deallocate() }
    func emit(_ p: UnsafeMutablePointer<Int16>, _ n: Int) {
        var off = 0
        let bytes = n * 2
        p.withMemoryRebound(to: UInt8.self, capacity: bytes) { raw in
            while off < bytes {
                let w = Darwin.write(1, raw.advanced(by: off), bytes - off)
                if w <= 0 { if errno == EINTR { continue }; running.store(false, ordering: .releasing); return }
                off += w
            }
        }
    }
    while running.load(ordering: .acquiring) {
        let n = micRing.read(inBuf, chunk)
        if n == 0 { usleep(2000); continue }
        if let rs = resampler {
            rs.convert(inBuf, n, outBuf, chunk * 4) { p, c in emit(p, c) }
        } else {
            emit(inBuf, n)
        }
    }
}
writerThread.stackSize = 512 * 1024
writerThread.start()

// Flush-ack thread: watches for the render callback to acknowledge a flush.
let ackThread = Thread {
    var lastAcked: UInt64 = 0
    var tick = 0
    while running.load(ordering: .acquiring) {
        tick += 1
        if tick % 250 == 0 {
            event(["type": "stats",
                   "micRingSamples": micRing.available,
                   "micRingMs": Double(micRing.available) / rate * 1000.0,
                   "playRingSamples": playRing.available,
                   "playRingMs": Double(playRing.available) / rate * 1000.0,
                   "framesConsumed": Int(framesConsumed.load(ordering: .relaxed)),
                   "underruns": Int(underruns.load(ordering: .relaxed)),
                   "renderCalls": Int(renderCalls.load(ordering: .relaxed)),
                   "renderAvgFrames": renderCalls.load(ordering: .relaxed) > 0
                        ? Double(renderFrames.load(ordering: .relaxed)) / Double(renderCalls.load(ordering: .relaxed)) : 0,
                   "renderMaxGapMs": machToMs(renderMaxGapNs.exchange(0, ordering: .acquiringAndReleasing)),
                   "inputCalls": Int(inputCalls.load(ordering: .relaxed)),
                   "inputAvgFrames": inputCalls.load(ordering: .relaxed) > 0
                        ? Double(inputFrames.load(ordering: .relaxed)) / Double(inputCalls.load(ordering: .relaxed)) : 0])
        }
        let done = flushDone.load(ordering: .acquiring)
        if done != lastAcked {
            lastAcked = done
            let consumedFrames = flushAtFrame.load(ordering: .acquiring)
            let heard = max(0.0, Double(consumedFrames) - outLatencyFrames)
            let reqT = flushReqTime.load(ordering: .acquiring)
            let exeT = flushExecTime.load(ordering: .acquiring)
            event(["type": "flushed",
                   "seq": Int(done),
                   "renderReactionMs": exeT > reqT ? machToMs(exeT &- reqT) : 0,
                   "droppedSamples": Int(flushDropped.load(ordering: .acquiring)),
                   "droppedMs": Double(flushDropped.load(ordering: .acquiring)) / rate * 1000.0,
                   "framesConsumed": Int(consumedFrames),
                   "outputLatencyFrames": Int(outLatencyFrames.rounded()),
                   "heardMs": (heard / rate) * 1000.0,
                   "consumedMs": (Double(consumedFrames) / rate) * 1000.0])
        }
        usleep(1000)
    }
}
ackThread.start()

ck(AudioOutputUnitStart(au), "AudioOutputUnitStart")

event(["type": "ready",
       "clientRate": rate,
       "micOutRate": micRate,
       "resampling": needResample,
       "hardwareRate": hwRate,
       "deviceID": Int(L.dev),
       "deviceLatencyFrames": Int(L.latency),
       "safetyOffsetFrames": Int(L.safety),
       "bufferFrames": Int(L.buf),
       "streamLatencyFrames": Int(L.stream),
       "auLatencySeconds": auLatency,
       "totalOutputLatencyFramesAtClientRate": Int(outLatencyFrames.rounded()),
       "totalOutputLatencyMs": (outLatencyFrames / rate) * 1000.0])

// ─────────────────────────────────────────────────── stdin command loop
func readExactly(_ n: Int, into p: UnsafeMutablePointer<UInt8>) -> Bool {
    var got = 0
    while got < n {
        let r = Darwin.read(0, p.advanced(by: got), n - got)
        if r == 0 { return false }
        if r < 0 { if errno == EINTR { continue }; return false }
        got += r
    }
    return true
}

let hdr = UnsafeMutablePointer<UInt8>.allocate(capacity: 5)
let payload = UnsafeMutablePointer<UInt8>.allocate(capacity: 1 << 20)
var flushSeq: UInt64 = 0

commandLoop: while running.load(ordering: .acquiring) {
    guard readExactly(5, into: hdr) else { break }
    let cmd = hdr[0]
    let len = Int(UInt32(hdr[1]) | UInt32(hdr[2]) << 8 | UInt32(hdr[3]) << 16 | UInt32(hdr[4]) << 24)
    if len > (1 << 20) { event(["type": "error", "where": "stdin", "message": "frame too large"]); break }
    if len > 0, !readExactly(len, into: payload) { break }

    switch cmd {
    case UInt8(ascii: "A"):
        let samples = len / 2
        if samples > 0 {
            payload.withMemoryRebound(to: Int16.self, capacity: samples) { p in
                let wrote = playRing.write(p, samples)
                if wrote < samples {
                    event(["type": "overflow", "dropped": samples - wrote])
                }
            }
        }
    case UInt8(ascii: "F"):
        flushSeq += 1
        flushReqTime.store(mach_absolute_time(), ordering: .releasing)
        flushRequest.store(flushSeq, ordering: .releasing)
    case UInt8(ascii: "Q"):
        break commandLoop
    default:
        event(["type": "error", "where": "stdin", "message": "unknown cmd \(cmd)"])
    }
}

running.store(false, ordering: .releasing)
AudioOutputUnitStop(au)
AudioUnitUninitialize(au)
AudioComponentInstanceDispose(au)
event(["type": "stopped",
       "framesConsumed": Int(framesConsumed.load(ordering: .acquiring)),
       "underruns": Int(underruns.load(ordering: .acquiring))])
