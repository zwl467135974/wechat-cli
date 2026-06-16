import koffi from "koffi";
import { execSync } from "node:child_process";

const lib = koffi.load("kernel32.dll");

const MBI = koffi.struct("MBI", {
  BaseAddress: "void *",
  AllocationBase: "void *",
  AllocationProtect: "uint32_t",
  _pad1: "uint32_t",
  RegionSize: "uint64_t",
  State: "uint32_t",
  Protect: "uint32_t",
  Type: "uint32_t",
  _pad2: "uint32_t",
});

const OpenProcess = lib.func("void *OpenProcess(uint32_t dwDesiredAccess, int bInheritHandle, uint32_t dwProcessId)") as any;
const CloseHandle = lib.func("int CloseHandle(void *hObject)") as any;
const VirtualQueryEx = lib.func("size_t VirtualQueryEx(void *hProcess, void *lpAddress, MBI *lpBuffer, size_t dwLength)") as any;
const ReadProcessMemory = lib.func("int ReadProcessMemory(void *hProcess, void *lpBaseAddress, uint8_t *lpBuffer, size_t nSize, size_t *lpNumberOfBytesRead)") as any;

const PROCESS_VM_READ = 0x0010;
const PROCESS_QUERY_INFORMATION = 0x0400;
const MEM_COMMIT = 0x1000;
const READABLE = new Set([0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80]);
const MAX_REGION = 500n * 1024n * 1024n;

export interface MemRegion {
  base: bigint;
  size: bigint;
}

export function findWechatPids(): Array<{ pid: number; memKb: number }> {
  let output: string;
  try {
    output = execSync('tasklist /FI "IMAGENAME eq Weixin.exe" /FO CSV /NH', {
      encoding: "utf-8",
      timeout: 5000,
    });
  } catch {
    return [];
  }

  const pids: Array<{ pid: number; memKb: number }> = [];
  for (const line of output.trim().split("\n")) {
    if (!line.trim()) continue;
    const clean = line.trim().replace(/^"|"$/g, "");
    const parts = clean.split('","');
    if (parts.length >= 5) {
      const pid = parseInt(parts[1]);
      const memStr = parts[4].replace(/,/g, "").replace(/\s*K/i, "").trim();
      const mem = parseInt(memStr) || 0;
      if (pid) pids.push({ pid, memKb: mem });
    }
  }

  pids.sort((a, b) => b.memKb - a.memKb);
  return pids;
}

export function openProcess(pid: number): any {
  return OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, 0, pid);
}

export function closeProcess(handle: any): void {
  if (handle) CloseHandle(handle);
}

export function enumRegions(handle: any): MemRegion[] {
  const regions: MemRegion[] = [];
  let addr = 0n;

  while (addr < 0x7fffffffffffn) {
    const mbi: Record<string, unknown> = {};
    const result = VirtualQueryEx(handle, addr, mbi, BigInt(MBI.size));

    if (result === 0n || result === 0) break;

    const base = BigInt(mbi.BaseAddress as any);
    const size = BigInt(mbi.RegionSize as any);
    const state = mbi.State as number;
    const protect = mbi.Protect as number;

    if (
      state === MEM_COMMIT &&
      READABLE.has(protect) &&
      size > 0n &&
      size < MAX_REGION
    ) {
      regions.push({ base, size });
    }

    const next = base + size;
    if (next <= addr) break;
    addr = next;
  }

  return regions;
}

export function readMemory(handle: any, base: bigint, size: bigint): Buffer | null {
  const sz = Number(size);
  if (sz <= 0 || sz > Number(MAX_REGION)) return null;

  const buf = Buffer.alloc(sz);
  const bytesRead = [0n];

  const ok = ReadProcessMemory(handle, base, buf, size, bytesRead);
  if (!ok) return null;

  const read = Number(bytesRead[0]);
  return read > 0 ? buf.subarray(0, read) : null;
}
