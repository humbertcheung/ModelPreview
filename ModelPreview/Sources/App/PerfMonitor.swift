import Foundation
import AppKit
import IOKit
import Darwin

/// 应用资源占用采样：CPU%、内存(MB)、GPU%(全系统，与 Statistic 一致)。
/// 采样频率较低（默认 2 秒），避免自身开销影响被测数据。
final class PerfMonitor {
    struct Sample {
        let cpuPercent: Double?     // 应用进程 CPU 占用
        let memoryMB: Double?      // 应用进程物理内存
        let gpuPercent: Double?     // 全系统 GPU 利用率
        let gpuSource: String      // "system" / ""
    }

    private var lastCPU: Double = 0
    private var lastTime: Date = Date()
    private let pid: pid_t

    init(pid: pid_t = ProcessInfo.processInfo.processIdentifier) {
        self.pid = pid
    }

    /// CPU 占用（%）：基于 task_info 的用户态+内核态时间增量
    func cpuPercent() -> Double? {
        var info = task_basic_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_basic_info_data_t>.size / MemoryLayout<natural_t>.size)
        let kr = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_BASIC_INFO), $0, &count)
            }
        }
        guard kr == KERN_SUCCESS else { return nil }
        // time_value 为「秒 + 微秒」结构
        let total = Double(info.user_time.seconds) + Double(info.user_time.microseconds) / 1_000_000.0
                    + Double(info.system_time.seconds) + Double(info.system_time.microseconds) / 1_000_000.0
        let now = Date()
        let dt = now.timeIntervalSince(lastTime)
        guard dt > 0.05 else { return nil }
        let delta = total - lastCPU
        lastCPU = total
        lastTime = now
        let used = delta
        return max(0, min(100, used / dt * 100))
    }

    /// 物理内存占用（MB）：优先 phys_footprint（与活动监视器「内存」一致）
    func memoryMB() -> Double? {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        let kr = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        guard kr == KERN_SUCCESS else { return nil }
        let bytes = Int(info.phys_footprint)
        return Double(bytes) / 1_048_576.0
    }

    /// 全系统 GPU 利用率（%）。
    /// macOS 未提供按进程的 GPU 利用率公开接口，这里采用与 Statistic 相同的
    /// 「全系统」口径：读取 AGX/AMD 加速器的 PerformanceStatistics。
    /// 注：统计项随驱动/机型不同，取值可能缺失，此时显示「—」。
    func gpuPercent() -> Double? {
        var service: io_service_t = 0
        var iter: io_iterator_t = 0
        guard IOServiceGetMatchingServices(kIOMainPortDefault, IOServiceMatching("IOAccelerator"), &iter) == KERN_SUCCESS else { return nil }
        defer { IOObjectRelease(iter) }
        service = IOIteratorNext(iter)
        guard service != 0 else { return nil }
        defer { IOObjectRelease(service) }

        var props: Unmanaged<CFMutableDictionary>?
        guard IORegistryEntryCreateCFProperties(service, &props, nil, 0) == KERN_SUCCESS,
              let unmanaged = props,
              let dict = unmanaged.takeUnretainedValue() as? [String: Any] else { return nil }

        var best: Double? = nil
        if let stats = dict["PerformanceStatistics"] as? [String: Any] {
            for (key, value) in stats {
                guard key.contains("Utilization") || key.contains("Activity"),
                      let num = value as? NSNumber else { continue }
                let v = num.doubleValue
                if v > 0, best == nil || v > best! { best = v }
            }
        }
        return best
    }

    func sample() -> Sample {
        Sample(cpuPercent: cpuPercent(),
               memoryMB: memoryMB(),
               gpuPercent: gpuPercent(),
               gpuSource: "system")
    }
}
