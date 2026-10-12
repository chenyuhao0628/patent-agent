import { spawn, execFile, type ChildProcess, type SpawnOptions } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const PROCESS_STOP_MS = 8_000;
export function windowsTaskkillArgs(pid: number): string[] { return ['/PID', String(pid), '/T', '/F']; }

// A Windows Job Object owns the entire tree, even if OpenCode exits before cleanup.
// Assign it atomically at CreateProcess, not after a suspend/assign window. Windows 11 is the product target.
const WINDOWS_SUPERVISOR = String.raw`param([Parameter(Mandatory=$true)][string]$InputPath)
$ErrorActionPreference = 'Stop'
$spec = Get-Content -Raw -Encoding UTF8 -LiteralPath $InputPath | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.ComponentModel;
public static class WorkbenchJob {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet;
    public uint ActiveProcesses;
    public UIntPtr Affinity;
    public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IO { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct Limits {
    public BasicLimit Basic; public IO Counters;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)] struct Startup {
    public uint Size; public IntPtr Reserved, Desktop, Title;
    public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
    public ushort Show, ReservedSize;
    public IntPtr ReservedData, Input, Output, Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup Info; public IntPtr Attributes; }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public uint ProcessId, ThreadId; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref Limits info, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr env, string cwd, ref StartupEx startup, out ProcessInfo process);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int kind);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  public static int Run(string executable, string command, string cwd) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null), attributes = IntPtr.Zero, jobList = IntPtr.Zero;
    ProcessInfo process = new ProcessInfo(); bool initialized = false;
    if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      Limits limits = new Limits(); limits.Basic.Flags = 0x2000; // KILL_ON_JOB_CLOSE
      Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(Limits))));
      IntPtr size = IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
      attributes = Marshal.AllocHGlobal(size);
      Check(InitializeProcThreadAttributeList(attributes, 1, 0, ref size)); initialized = true;
      jobList = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobList, job);
      Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x2000d), jobList, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
      StartupEx startup = new StartupEx(); startup.Info.Size = (uint)Marshal.SizeOf(typeof(StartupEx));
      startup.Info.Flags = 0x100; startup.Info.Input = GetStdHandle(-10); startup.Info.Output = GetStdHandle(-11); startup.Info.Error = GetStdHandle(-12); startup.Attributes = attributes;
      Check(CreateProcess(executable, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero, true, 0x08080000, IntPtr.Zero, cwd, ref startup, out process));
      WaitForSingleObject(process.Process, 0xffffffff);
      uint code; Check(GetExitCodeProcess(process.Process, out code)); return unchecked((int)code);
    } finally {
      CloseHandle(job); // Kill surviving descendants on normal exit as well.
      if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread);
      if (process.Process != IntPtr.Zero) CloseHandle(process.Process);
      if (initialized) DeleteProcThreadAttributeList(attributes);
      if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
      if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList);
    }
  }
}
'@
exit ([WorkbenchJob]::Run($spec.executable, $spec.commandLine, $spec.cwd))
`;

export function quoteWindowsArgument(value: string): string {
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
}

export function spawnManagedProcess(executable: string, args: string[], options: SpawnOptions, controlDirectory: string): ChildProcess {
  if (process.platform !== 'win32') return spawn(executable, args, { ...options, detached: true, shell: false });
  fs.mkdirSync(controlDirectory, { recursive: true, mode: 0o700 });
  const control = fs.mkdtempSync(path.join(controlDirectory, '.process-'));
  const script = path.join(control, 'supervisor.ps1'), input = path.join(control, 'launch.json');
  fs.writeFileSync(script, WINDOWS_SUPERVISOR, { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(input, JSON.stringify({ executable, commandLine: [executable, ...args].map(quoteWindowsArgument).join(' '), cwd: String(options.cwd ?? process.cwd()) }), { mode: 0o600, flag: 'wx' });
  const powershell = path.join(process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-InputPath', input], { ...options, windowsHide: true, detached: false, shell: false });
  child.once('close', () => { try { fs.rmSync(control, { recursive: true, force: true }); } catch { /* retained for diagnosis */ } });
  return child;
}

async function waitExit(proc: ChildProcess, ms: number): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  await new Promise<void>(resolve => {
    const done = () => { clearTimeout(timer); proc.off('exit', done); resolve(); };
    const timer = setTimeout(done, ms); timer.unref(); proc.once('exit', done);
    if (proc.exitCode !== null || proc.signalCode !== null) done();
  });
}

const stopping = new WeakMap<ChildProcess, Promise<void>>();
export function killManagedProcess(proc: ChildProcess | undefined): Promise<void> {
  if (!proc?.pid) return Promise.resolve();
  const previous = stopping.get(proc); if (previous) return previous;
  const pid = proc.pid;
  const task = (async () => {
    if (process.platform === 'win32') {
      // Terminate the tree while the parent still exists. The supervisor Job Object
      // also covers parent crashes and descendants escaping ordinary parent tracking.
      if (proc.exitCode === null && proc.signalCode === null) {
        const taskkill = path.join(process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows', 'System32', 'taskkill.exe');
        await new Promise<void>(resolve => execFile(taskkill, windowsTaskkillArgs(pid), { windowsHide: true, timeout: 5_000 }, () => resolve()));
        if (proc.exitCode === null && proc.signalCode === null) try { proc.kill(); } catch { /* already exited */ }
        await waitExit(proc, 3_000);
      }
      return;
    }
    const signalTree = (signal: NodeJS.Signals) => {
      try { process.kill(-pid, signal); }
      catch { if (proc.exitCode === null && proc.signalCode === null) try { proc.kill(signal); } catch { /* already exited */ } }
    };
    signalTree('SIGTERM');
    await waitExit(proc, PROCESS_STOP_MS);
    // The process group can remain alive after its leader has exited.
    signalTree('SIGKILL');
    await waitExit(proc, 3_000);
  })();
  stopping.set(proc, task); return task;
}
