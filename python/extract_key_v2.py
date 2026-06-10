"""
Direct key extraction using pymem pattern scanning.
Scans Weixin.dll for the DB key based on pywxdump's approach.
"""
import sys
import os
import json
import ctypes
import hashlib
import hmac as hmac_mod

import pymem
import pymem.process
import pymem.pattern


SQLITE_HEADER = "SQLite format 3\x00"


def verify_key(key_bytes, db_path):
    """Verify key against a database file by checking HMAC."""
    if not key_bytes or len(key_bytes) != 32:
        return False
    if not os.path.exists(db_path):
        return False
    try:
        with open(db_path, "rb") as f:
            blist = f.read(4096)
        if len(blist) < 4096:
            return False
        salt = blist[:16]
        mac_salt = bytes([(salt[i] ^ 58) for i in range(16)])
        byte_hmac = hashlib.pbkdf2_hmac("sha1", key_bytes, salt, 64000, 32)
        mac_key = hashlib.pbkdf2_hmac("sha1", byte_hmac, mac_salt, 2, 32)
        hash_mac = hmac_mod.new(mac_key, blist[16:4064], hashlib.sha1)
        hash_mac.update(b'\x01\x00\x00\x00')
        return hash_mac.digest() == blist[-32:-12]
    except Exception:
        return False


def extract_key_pymem():
    """Extract WeChat DB key using pymem pattern scanning."""
    try:
        pm = pymem.Pymem("Weixin.exe")
    except Exception:
        try:
            pm = pymem.Pymem("WeChat.exe")
        except Exception:
            return None, "WeChat not running"

    pid = pm.process_id
    pm.check_wow64()

    address_len = 8 if not pm.is_WoW64 else 4
    print(f"PID: {pid}, WoW64: {pm.is_WoW64}, addr_len: {address_len}", file=sys.stderr)

    module_name = None
    for name in ["Weixin.dll", "WeChatWin.dll", "WeChat.dll"]:
        mod = pymem.process.module_from_name(pm.process_handle, name)
        if mod:
            module_name = name
            print(f"Found module: {name} at 0x{mod.lpBaseOfDll:X}", file=sys.stderr)
            break

    if not module_name:
        return None, "No Weixin.dll or WeChatWin.dll found"

    module = pymem.process.module_from_name(pm.process_handle, module_name)

    db_path = None
    for candidate in [
        r"D:\weixinDoc\xwechat_files\wxid_oofdngwmbpok21_1562\db_storage\contact\contact.db",
        r"D:\weixinDoc\xwechat_files\wxid_oofdngwmbpok21_1562\db_storage\message\message_0.db",
        r"D:\weixinDoc\xwechat_files\wxid_oofdngwmbpok21_1562\db_storage\session\session.db",
    ]:
        if os.path.exists(candidate):
            db_path = candidate
            break

    # Method 1: Search for public key pattern, then find key nearby
    print("Method 1: Public key pattern scan...", file=sys.stderr)
    key_len_offset = 0xd0
    key_ptr_offset = 0xd8

    # Read the entire module memory
    module_data = pm.read_bytes(module.lpBaseOfDll, module.SizeOfImage)
    print(f"  Module size: {len(module_data)} bytes", file=sys.stderr)

    pub_key_pattern = b"-----BEGIN PUBLIC KEY-----\n..."
    pub_key_offsets = []
    idx = 0
    while True:
        idx = module_data.find(pub_key_pattern, idx)
        if idx == -1:
            break
        pub_key_offsets.append(idx)
        idx += 1
    print(f"  Found {len(pub_key_offsets)} public key patterns in module", file=sys.stderr)

    # Search all of process memory for these addresses
    # Actually, the pattern is in the module itself, so the addresses point within the module
    # We need to find pointers TO these patterns in the module
    for off in pub_key_offsets:
        addr = module.lpBaseOfDll + off
        addr_bytes = addr.to_bytes(address_len, byteorder="little")
        # Search for this pointer value in the module
        ptr_offsets = []
        pidx = 0
        while True:
            pidx = module_data.find(addr_bytes, pidx)
            if pidx == -1:
                break
            ptr_offsets.append(pidx)
            pidx += 1
        for po in ptr_offsets:
            try:
                ma = module.lpBaseOfDll + po
                key_len = module_data[po - key_len_offset] if po >= key_len_offset else 0
                if key_len != 32:
                    continue
                key_ptr_bytes = module_data[po - key_ptr_offset:po - key_ptr_offset + address_len]
                if len(key_ptr_bytes) != address_len:
                    continue
                key_ptr = int.from_bytes(key_ptr_bytes, "little")
                if not key_ptr or key_ptr < 0x10000:
                    continue
                # Read key from that pointer
                key_bytes = pm.read_bytes(key_ptr, 32)
                if not key_bytes or len(key_bytes) != 32:
                    continue
                key_hex = key_bytes.hex()
                print(f"  Candidate key: {key_hex}", file=sys.stderr)
                if db_path and verify_key(key_bytes, db_path):
                    pm.close_process()
                    return key_hex, "public_key_pattern"
            except Exception as e:
                print(f"  Error at offset 0x{po:X}: {e}", file=sys.stderr)
                continue

    # Method 2: Scan all memory for 32-byte sequences and verify against DB
    print("Method 2: Brute-force memory scan with DB verification...", file=sys.stderr)
    if db_path:
        all_regions = []
        mbi = MEMORY_BASIC_INFORMATION()
        addr = 0
        max_addr = 0x7FFFFFFFEFFFF
        kernel32 = ctypes.windll.kernel32
        handle = pm.process_handle

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
                mbi.Type in (0x20000, 0x40000) and
                size > 0 and size < 100 * 1024 * 1024):
                try:
                    data = pm.read_bytes(base, size)
                    if data:
                        _scan_for_key(data, db_path, base)
                except Exception:
                    pass
            addr = (base + size) if (base and size) else addr + 0x10000

    pm.close_process()
    return None, "Key not found"


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


_found_key = [None]

def _scan_for_key(data, db_path, base_addr):
    """Scan a memory region for 32-byte keys that verify against a DB."""
    if _found_key[0]:
        return
    # Try every 8-byte aligned offset as a potential 32-byte key
    for offset in range(0, len(data) - 32, 8):
        candidate = data[offset:offset+32]
        if all(b == 0 for b in candidate):
            continue
        if verify_key(candidate, db_path):
            _found_key[0] = candidate.hex()
            print(f"  FOUND KEY at 0x{base_addr+offset:X}: {_found_key[0]}", file=sys.stderr)
            return


if __name__ == "__main__":
    key, method = extract_key_pymem()
    if key:
        print(json.dumps({"key": key, "method": method}, indent=2))
    else:
        print(json.dumps({"error": f"Key extraction failed: {method}"}, indent=2))
