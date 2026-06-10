"""
Extract WeChat database key by reading process memory.
Finds the WeChat process, reads memory, and searches for the 32-byte key.

Usage: python extract_key.py --args '{"wechat_path":""}'
"""
import sys
import os
import json
import ctypes
import ctypes.wintypes
import re

kernel32 = ctypes.windll.kernel32

PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010
PROCESS_TERMINATE = 0x0001
TH32CS_SNAPPROCESS = 0x00000002
CREATE_NEW_CONSOLE = 0x00000010
CREATE_NEW_PROCESS_GROUP = 0x00000200


class PROCESSENTRY32(ctypes.Structure):
    _fields_ = [
        ("dwSize", ctypes.wintypes.DWORD),
        ("cntUsage", ctypes.wintypes.DWORD),
        ("th32ProcessID", ctypes.wintypes.DWORD),
        ("th32DefaultHeapID", ctypes.POINTER(ctypes.wintypes.ULONG)),
        ("th32ModuleID", ctypes.wintypes.DWORD),
        ("cntThreads", ctypes.wintypes.DWORD),
        ("th32ParentProcessID", ctypes.wintypes.DWORD),
        ("pcPriClassBase", ctypes.wintypes.LONG),
        ("dwFlags", ctypes.wintypes.DWORD),
        ("szExeFile", ctypes.c_wchar * 260),
    ]


class MEMORY_BASIC_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("BaseAddress", ctypes.c_void_p),
        ("AllocationBase", ctypes.c_void_p),
        ("AllocationProtect", ctypes.wintypes.DWORD),
        ("RegionSize", ctypes.c_size_t),
        ("State", ctypes.wintypes.DWORD),
        ("Protect", ctypes.wintypes.DWORD),
        ("Type", ctypes.wintypes.DWORD),
    ]


def find_pid(name):
    snap = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    entry = PROCESSENTRY32()
    entry.dwSize = ctypes.sizeof(PROCESSENTRY32)
    pids = []
    if kernel32.Process32FirstW(snap, ctypes.byref(entry)):
        while True:
            if entry.szExeFile.lower() == name.lower():
                pids.append(entry.th32ProcessID)
            entry.dwSize = ctypes.sizeof(PROCESSENTRY32)
            if not kernel32.Process32NextW(snap, ctypes.byref(entry)):
                break
    kernel32.CloseHandle(snap)
    return pids


def find_wechat_data_path():
    import winreg
    appdata = os.environ.get("APPDATA", "")
    if not appdata:
        return ""
    user_profile = os.path.dirname(appdata)

    candidates = [
        os.path.join(user_profile, "Documents", "WeChat Files"),
        os.path.join(user_profile, "Documents", "XWeChat"),
    ]
    for base in candidates:
        if not os.path.isdir(base):
            continue
        for d in os.listdir(base):
            full = os.path.join(base, d)
            db_storage = os.path.join(full, "db_storage")
            if os.path.isdir(db_storage) and (d.startswith("wxid_") or d.startswith("wx_")):
                return full
    return ""


def scan_memory_for_key(pid):
    """
    Read process memory and search for WeChat DB key.
    The key is a 32-byte (64 hex char) value used as sqlcipher key.
    We search for known patterns near the key in memory.
    """
    PROCESS_VM_READ = 0x0010
    PROCESS_QUERY_INFORMATION = 0x0400

    handle = kernel32.OpenProcess(
        PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, False, pid
    )
    if not handle:
        return ""

    try:
        mbi = MEMORY_BASIC_INFORMATION()
        addr = 0
        max_addr = ctypes.c_void_p(0x7FFFFFFFEFFFF).value or 0x7FFFFFFFEFFFF

        key_pattern = re.compile(rb"[\x20-\x7e]{32,}")
        found_keys = set()

        while addr < max_addr:
            result = kernel32.VirtualQueryEx(
                handle, ctypes.c_void_p(addr), ctypes.byref(mbi),
                ctypes.sizeof(mbi)
            )
            if result == 0:
                break

            base = mbi.BaseAddress or 0
            size = mbi.RegionSize or 0

            if (mbi.State == 0x1000 and
                mbi.Protect in (0x04, 0x08, 0x20, 0x40, 0x80, 0x02) and
                mbi.Type in (0x20000, 0x40000)):

                if size > 0 and size < 100 * 1024 * 1024:
                    buf = (ctypes.c_ubyte * size)()
                    bytes_read = ctypes.c_size_t()
                    ok = kernel32.ReadProcessMemory(
                        handle, ctypes.c_void_p(base), buf, size,
                        ctypes.byref(bytes_read)
                    )
                    if ok and bytes_read.value > 0:
                        data = bytes(buf[:bytes_read.value])
                        _search_key_in_data(data, found_keys)

            addr = (base + size) if (base and size) else addr + 0x10000

        return _select_best_key(found_keys)
    finally:
        kernel32.CloseHandle(handle)


def _search_key_in_data(data, found_keys):
    # WeChat V4 key pattern: look for sequences that look like hex keys
    # The key appears in memory near "db_key" or as part of sqlcipher key setup
    # Search for 32-byte sequences that could be the raw key
    # We look for the pattern: valid hex string of exactly 64 chars
    hex_pattern = re.compile(rb'[0-9a-f]{64}')
    for match in hex_pattern.finditer(data):
        key_hex = match.group().decode('ascii')
        found_keys.add(key_hex)

    # Also search for raw 32-byte key (non-hex, binary)
    # The key in memory is often near a "Key" or "db" label
    idx = 0
    while idx < len(data) - 32:
        # Look for potential key locations
        if data[idx:idx+3] == b'key' or data[idx:idx+2] == b'K\x00':
            # Check nearby bytes for a 32-byte key
            start = idx + 4
            if start + 32 <= len(data):
                candidate = data[start:start+32]
                if all(0x20 <= b < 0x7f for b in candidate):
                    pass  # ASCII, skip
                elif any(b != 0 for b in candidate):
                    found_keys.add(candidate.hex())
        idx += 1


def _select_best_key(found_keys):
    if not found_keys:
        return ""
    # Filter: prefer keys that look like actual DB keys (all hex, 64 chars)
    hex_keys = [k for k in found_keys if len(k) == 64 and all(c in '0123456789abcdef' for c in k)]
    if not hex_keys:
        return ""
    # Return first found hex key
    return hex_keys[0] if hex_keys else ""


def find_wechat_path():
    try:
        import winreg
        keys = [
            (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\WeChat"),
            (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\WeChat"),
        ]
        for root, subkey in keys:
            try:
                k = winreg.OpenKey(root, subkey)
                for val_name in ["InstallLocation", "DisplayIcon"]:
                    try:
                        val, _ = winreg.QueryValueEx(k, val_name)
                    except OSError:
                        continue
                    if val:
                        val = val.split(",")[0].strip('"')
                        if not val.lower().endswith(".exe"):
                            for exe in ["Weixin.exe", "WeChat.exe"]:
                                p = os.path.join(val, exe)
                                if os.path.exists(p):
                                    winreg.CloseKey(k)
                                    return p
                        elif os.path.exists(val):
                            winreg.CloseKey(k)
                            return val
                winreg.CloseKey(k)
            except OSError:
                pass

        for exe in ["Weixin.exe", "WeChat.exe"]:
            for root_key in [winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER]:
                try:
                    k = winreg.OpenKey(root_key, rf"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{exe}")
                    val, _ = winreg.QueryValueEx(k, "")
                    winreg.CloseKey(k)
                    if val and os.path.exists(val):
                        return val
                except OSError:
                    pass
    except Exception:
        pass

    for drive in ["C:", "D:", "E:"]:
        for p in [
            rf"{drive}\Program Files\Tencent\WeChat\WeChat.exe",
            rf"{drive}\Program Files (x86)\Tencent\WeChat\WeChat.exe",
            rf"{drive}\Program Files\Tencent\Weixin\Weixin.exe",
            rf"{drive}\Weixin\Weixin.exe",
        ]:
            if os.path.exists(p):
                return p
    return ""


def run_extract(wechat_path):
    result = {
        "key": "",
        "wechat_path": "",
        "data_path": "",
        "method": "",
    }

    pids = find_pid("Weixin.exe")
    if not pids:
        pids = find_pid("WeChat.exe")

    if not pids:
        result["error"] = "WeChat is not running. Please start and login to WeChat first."
        return json.dumps(result, indent=2)

    # Try main window PID first (usually the one with a window title)
    user32 = ctypes.windll.user32
    main_pid = 0
    for pid in pids:
        # Just try the largest PID as main process heuristic
        if pid > main_pid:
            main_pid = pid

    if not main_pid:
        main_pid = pids[0]

    result["wechat_path"] = find_wechat_path()
    result["data_path"] = find_wechat_data_path()

    print(f"Scanning WeChat PID {main_pid} for key...", file=sys.stderr)
    key = scan_memory_for_key(main_pid)

    if not key:
        # Try all PIDs
        for pid in pids:
            if pid == main_pid:
                continue
            print(f"Trying PID {pid}...", file=sys.stderr)
            key = scan_memory_for_key(pid)
            if key:
                break

    if key:
        result["key"] = key
        result["method"] = "memory_scan"
        return json.dumps(result, indent=2)

    result["error"] = (
        "Could not extract key automatically.\n\n"
        "Manual options:\n"
        "1. Use wxdump CLI: pip install pywxdump && wxdump\n"
        "2. Download wx_key.dll from https://github.com/afumu/wetrace/releases\n"
        "3. Search WeChat data folder for an existing decrypted copy"
    )
    return json.dumps(result, indent=2)


def parse_args():
    for i, arg in enumerate(sys.argv):
        if arg == "--args" and i + 1 < len(sys.argv):
            return json.loads(sys.argv[i + 1])
    return {}


if __name__ == "__main__":
    args = parse_args()
    try:
        output = run_extract(args.get("wechat_path", ""))
        print(output)
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
