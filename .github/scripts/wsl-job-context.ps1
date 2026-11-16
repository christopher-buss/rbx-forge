Add-Type @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class ForgeJobContext {
    [StructLayout(LayoutKind.Sequential)]
    public struct Limits {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveProcesses;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool inJob);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(IntPtr job, int kind, out Limits limits, int bytes, IntPtr length);
    public static object Read() {
        bool inJob;
        if (!IsProcessInJob(new IntPtr(-1), IntPtr.Zero, out inJob))
            throw new Win32Exception();
        Limits limits;
        bool queried = QueryInformationJobObject(IntPtr.Zero, 2, out limits, Marshal.SizeOf(typeof(Limits)), IntPtr.Zero);
        int error = queried ? 0 : Marshal.GetLastWin32Error();
        return new { inJob, queried, error, flags = queried ? (uint?)limits.Flags : null,
            breakaway = queried && (limits.Flags & 0x800) != 0,
            silentBreakaway = queried && (limits.Flags & 0x1000) != 0 };
    }
}
'@
[ordered]@{
    job = [ForgeJobContext]::Read()
    session = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
    interactive = [Environment]::UserInteractive
} | ConvertTo-Json -Compress
