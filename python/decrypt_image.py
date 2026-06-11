import struct
import sys
import os
import json
from collections import Counter


def decrypt_v2_dat(dat_path, aes_key, xor_key=0xD5):
    from Crypto.Cipher import AES

    with open(dat_path, 'rb') as f:
        data = f.read()

    if len(data) < 15:
        return None

    sig = data[:6]
    if sig not in (b'\x07\x08V2\x08\x07', b'\x07\x08V1\x08\x07'):
        return None

    aes_size = struct.unpack_from('<I', data, 6)[0]
    xor_size = struct.unpack_from('<I', data, 10)[0]

    file_data = data[15:]
    aligned_aes_size = aes_size + (16 - (aes_size % 16))

    if aligned_aes_size > len(file_data):
        return None

    if isinstance(aes_key, str):
        aes_key = aes_key[:16].encode('ascii')
    if len(aes_key) < 16:
        return None

    aes_part = file_data[:aligned_aes_size]
    try:
        cipher = AES.new(aes_key[:16], AES.MODE_ECB)
        dec_raw = cipher.decrypt(aes_part)
        pad_len = dec_raw[-1]
        if 0 < pad_len <= 16 and all(b == pad_len for b in dec_raw[-pad_len:]):
            dec_aes = dec_raw[:-pad_len]
        else:
            dec_aes = dec_raw
    except (ValueError, KeyError):
        return None

    remaining = file_data[aligned_aes_size:]
    if len(remaining) < xor_size:
        return None
    raw_len = len(remaining) - xor_size
    raw_data = remaining[:raw_len]
    xor_data = remaining[raw_len:]
    dec_xor = bytes(b ^ xor_key for b in xor_data)

    decrypted = dec_aes + raw_data + dec_xor

    fmt = 'bin'
    if decrypted[:3] == b'\xff\xd8\xff':
        fmt = 'jpg'
    elif decrypted[:4] == b'\x89PNG':
        fmt = 'png'
    elif decrypted[:4] == b'RIFF':
        fmt = 'webp'
    elif decrypted[:3] == b'GIF':
        fmt = 'gif'
    elif decrypted[:4] == b'wxgf':
        fmt = 'wxgf'

    return {'data': decrypted, 'format': fmt}


def get_xor_key(attach_base):
    pairs = []
    for root, dirs, files in os.walk(attach_base):
        for fn in files:
            if not fn.endswith('_t.dat'):
                continue
            try:
                with open(os.path.join(root, fn), 'rb') as f:
                    data = f.read()
                if len(data) < 2:
                    continue
                pairs.append((data[-2], data[-1]))
                if len(pairs) >= 20:
                    break
            except:
                pass
        if len(pairs) >= 20:
            break

    if not pairs:
        return None

    counter = Counter(pairs)
    (b0, b1), _ = counter.most_common(1)[0]
    xor_ff = b0 ^ 0xFF
    xor_d9 = b1 ^ 0xD9
    if xor_ff == xor_d9:
        return xor_ff
    return None


def get_template_ciphertext(attach_base):
    sig = bytes([0x07, 0x08, 0x56, 0x32, 0x08, 0x07])
    for root, dirs, files in os.walk(attach_base):
        for fn in files:
            if not fn.endswith('_t.dat'):
                continue
            try:
                with open(os.path.join(root, fn), 'rb') as f:
                    data = f.read()
                if len(data) >= 0x1F and data[:6] == sig:
                    return data[0x0F:0x1F]
            except:
                pass
    return None


def verify_aes_key(ciphertext, key_str):
    from Crypto.Cipher import AES
    if len(key_str) < 16:
        return False
    key_bytes = key_str[:16].encode('ascii')
    try:
        cipher = AES.new(key_bytes, AES.MODE_ECB)
        dec = cipher.decrypt(ciphertext)
        return dec[:3] == b'\xff\xd8\xff'
    except:
        return False


def find_v2_key():
    import ctypes
    import psutil

    attach_base = os.environ.get('WECHAT_ATTACH_DIR', '')
    if not attach_base:
        script_dir = os.path.dirname(os.path.abspath(__file__))
        for _ in range(3):
            script_dir = os.path.dirname(script_dir)
        print("Error: WECHAT_ATTACH_DIR not set", file=sys.stderr)
        return None, 'WECHAT_ATTACH_DIR environment variable not set'

    xor_key = get_xor_key(attach_base)
    if xor_key is None:
        return None, 'Cannot determine XOR key from _t.dat files'

    ciphertext = get_template_ciphertext(attach_base)
    if ciphertext is None:
        return None, 'No V2 template _t.dat found'

    main_pid = None
    for p in psutil.process_iter(['pid', 'name', 'cmdline']):
        if p.info.get('name', '').lower() != 'weixin.exe':
            continue
        cmd = ' '.join(p.cmdline() or [])
        if '--type' not in cmd:
            main_pid = p.pid
            break

    if main_pid is None:
        return None, 'WeChat main process not found'

    PROCESS_VM_READ = 0x0010
    PROCESS_QUERY_INFORMATION = 0x0400

    class MBI(ctypes.Structure):
        _fields_ = [
            ("BaseAddress", ctypes.c_void_p),
            ("AllocationBase", ctypes.c_void_p),
            ("AllocationProtect", ctypes.c_ulong),
            ("RegionSize", ctypes.c_size_t),
            ("State", ctypes.c_ulong),
            ("Protect", ctypes.c_ulong),
            ("Type", ctypes.c_ulong),
        ]

    kernel32 = ctypes.windll.kernel32
    handle = kernel32.OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, False, main_pid)
    if not handle:
        return None, 'Cannot open WeChat process'

    mbi = MBI()
    addr = 0x10000
    regions = []
    while addr < 0x7FFFFFFFFFFF:
        result = kernel32.VirtualQueryEx(handle, ctypes.c_void_p(addr), ctypes.byref(mbi), ctypes.sizeof(mbi))
        if result == 0:
            addr += 0x10000
            continue
        if (mbi.State == 0x1000
                and not (mbi.Protect & 0x100)
                and not (mbi.Protect & 0x01)
                and mbi.RegionSize <= 50 * 1024 * 1024):
            regions.append((mbi.BaseAddress, mbi.RegionSize))
        addr = mbi.BaseAddress + mbi.RegionSize

    for base, size in regions:
        try:
            buf = (ctypes.c_ubyte * size)()
            bytesRead = ctypes.c_size_t()
            ok = kernel32.ReadProcessMemory(handle, ctypes.c_void_p(base), buf, size, ctypes.byref(bytesRead))
            if not ok or bytesRead.value < 34:
                continue
            data = bytes(buf[:bytesRead.value])

            i = 0
            while i < len(data) - 34:
                b = data[i]
                is_al = (ord('a') <= b <= ord('z')) or (ord('0') <= b <= ord('9'))
                if not is_al:
                    i += 1
                    continue

                start = i
                end = start
                while end < len(data) and end - start < 40:
                    c = data[end]
                    if (ord('a') <= c <= ord('z')) or (ord('0') <= c <= ord('9')):
                        end += 1
                    else:
                        break

                if end - start >= 32:
                    for j in range(start, end - 31):
                        prev_ok = (j == 0 or not (
                            (ord('a') <= data[j - 1] <= ord('z')) or (ord('0') <= data[j - 1] <= ord('9'))
                        ))
                        if not prev_ok:
                            continue
                        next_ok = (j + 32 >= len(data) or not (
                            (ord('a') <= data[j + 32] <= ord('z')) or (ord('0') <= data[j + 32] <= ord('9'))
                        ))
                        if not next_ok:
                            continue

                        candidate = data[j:j + 32]
                        key_str = bytes(candidate).decode('ascii', errors='replace')
                        if verify_aes_key(ciphertext, key_str):
                            kernel32.CloseHandle(handle)
                            key_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'image_key.txt')
                            with open(key_file, 'w') as f:
                                json.dump({'key': key_str, 'xor_key': xor_key}, f)
                            return {'key': key_str, 'xor_key': xor_key}, None

                i = max(end, start + 1)
        except:
            pass

    kernel32.CloseHandle(handle)
    return None, 'AES key not found in WeChat memory'


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('Usage: python decrypt_image.py <command>')
        print('Commands: find-key, decrypt <dat_path>')
        sys.exit(1)

    cmd = sys.argv[1]
    if cmd == 'find-key':
        result, err = find_v2_key()
        if result:
            print(json.dumps(result))
        else:
            print(f'Error: {err}', file=sys.stderr)
            sys.exit(1)
    elif cmd == 'decrypt':
        if len(sys.argv) < 3:
            print('Usage: python decrypt_image.py decrypt <dat_path> [key] [xor_key]')
            sys.exit(1)
        dat_path = sys.argv[2]
        key = sys.argv[3] if len(sys.argv) > 3 else None
        xor_key = int(sys.argv[4]) if len(sys.argv) > 4 else 0xD5

        key_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'image_key.txt')
        if not key and os.path.exists(key_file):
            with open(key_file) as f:
                kd = json.load(f)
                key = kd['key']
                xor_key = kd.get('xor_key', 0xD5)

        if not key:
            print('No key available', file=sys.stderr)
            sys.exit(1)

        result = decrypt_v2_dat(dat_path, key, xor_key)
        if result:
            sys.stdout.buffer.write(result['data'])
        else:
            print('Decrypt failed', file=sys.stderr)
            sys.exit(1)
