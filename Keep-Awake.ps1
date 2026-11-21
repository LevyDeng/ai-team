[CmdletBinding()]
param([Parameter(Mandatory = $true)][ValidateRange(1, 2147483647)][int]$ParentProcessId)

$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class RelayKeepAwake {
    [StructLayout(LayoutKind.Sequential)]
    private struct LastInputInfo { public uint Size, Time; }
    [StructLayout(LayoutKind.Sequential)]
    private struct MouseInput {
        public int X, Y;
        public uint MouseData, Flags, Time;
        public UIntPtr ExtraInfo;
    }
    [StructLayout(LayoutKind.Explicit)]
    private struct InputData { [FieldOffset(0)] public MouseInput Mouse; }
    [StructLayout(LayoutKind.Sequential)]
    private struct Input { public uint Type; public InputData Data; }
    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder buffer, uint length, out uint needed);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool GetLastInputInfo(ref LastInputInfo info);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SystemParametersInfo(uint action, uint parameter, out bool value, uint flags);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint count, Input[] inputs, int size);

    private static bool IsInteractiveDesktop() {
        IntPtr desktop = OpenInputDesktop(0, false, 0x0001);
        if (desktop == IntPtr.Zero) return false;
        try {
            StringBuilder name = new StringBuilder(256);
            uint needed;
            return GetUserObjectInformation(desktop, 2, name, (uint)(name.Capacity * 2), out needed)
                && String.Equals(name.ToString(), "Default", StringComparison.OrdinalIgnoreCase);
        } finally { CloseDesktop(desktop); }
    }

    public static void Run(int processId) {
        using (Process parent = Process.GetProcessById(processId)) {
            int reportedError = 0;
            using (Timer timer = new Timer(delegate(object unused) {
                try {
                    if (parent.HasExited) return;
                    // Never refresh input on the lock screen or a secure desktop.
                    if (!IsInteractiveDesktop()) return;
                    bool screenSaverRunning;
                    if (!SystemParametersInfo(0x0072, 0, out screenSaverRunning, 0) || screenSaverRunning) return;
                    LastInputInfo last = new LastInputInfo { Size = (uint)Marshal.SizeOf(typeof(LastInputInfo)) };
                    if (!GetLastInputInfo(ref last) || unchecked((uint)Environment.TickCount - last.Time) < 15000) return;
                    // A zero-distance mouse event refreshes idle time without clicking, typing, or moving the pointer.
                    Input input = new Input { Type = 0, Data = new InputData { Mouse = new MouseInput { Flags = 0x0001 } } };
                    if (SendInput(1, new Input[] { input }, Marshal.SizeOf(typeof(Input))) != 1 && Interlocked.Exchange(ref reportedError, 1) == 0) {
                        Console.Error.WriteLine("Windows rejected the idle reset (" + Marshal.GetLastWin32Error() + ").");
                    }
                } catch (Exception error) {
                    if (Interlocked.Exchange(ref reportedError, 1) == 0) Console.Error.WriteLine("Idle reset failed: " + error.Message);
                }
            }, null, 0, 5000)) {
                Console.WriteLine("KEEP_AWAKE_READY");
                Console.Out.Flush();
                // The parent owns stdin. EOF also stops the helper if the app exits or crashes.
                while (Console.ReadLine() != null) { }
            }
        }
    }
}
'@
[RelayKeepAwake]::Run($ParentProcessId)
