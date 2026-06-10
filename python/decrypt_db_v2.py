"""
WeChat V4 数据库解密器 (SQLCipher 4)

基于 wechat-decrypt 方案:
- 纯 Python AES-256-CBC 逐页解密
- SQLCipher 4 参数: page_size=4096, reserve=80, HMAC-SHA512
- 依赖: pycryptodome

用法:
  python decrypt_db_v2.py                     # 解密所有数据库
  python decrypt_db_v2.py --incremental       # 增量模式
  python decrypt_db_v2.py --db contact/contact.db  # 解密单个数据库
"""
import hashlib
import hmac as hmac_mod
import json
import os
import struct
import sys
import time
import argparse

from Crypto.Cipher import AES

PAGE_SZ = 4096
KEY_SZ = 32
SALT_SZ = 16
IV_SZ = 16
HMAC_SZ = 64
RESERVE_SZ = 80
SQLITE_HDR = b"SQLite format 3\x00"


def derive_mac_key(enc_key, salt):
    """从 enc_key 派生 HMAC 密钥 (SQLCipher 4: PBKDF2-SHA512, iter=2)"""
    mac_salt = bytes(b ^ 0x3A for b in salt)
    return hashlib.pbkdf2_hmac("sha512", enc_key, mac_salt, 2, dklen=KEY_SZ)


def decrypt_page(enc_key, page_data, pgno):
    """解密单个页面"""
    iv = page_data[PAGE_SZ - RESERVE_SZ : PAGE_SZ - RESERVE_SZ + IV_SZ]

    if pgno == 1:
        encrypted = page_data[SALT_SZ : PAGE_SZ - RESERVE_SZ]
        cipher = AES.new(enc_key, AES.MODE_CBC, iv)
        decrypted = cipher.decrypt(encrypted)
        page = bytearray(SQLITE_HDR + decrypted + b"\x00" * RESERVE_SZ)
        return bytes(page)
    else:
        encrypted = page_data[: PAGE_SZ - RESERVE_SZ]
        cipher = AES.new(enc_key, AES.MODE_CBC, iv)
        decrypted = cipher.decrypt(encrypted)
        return decrypted + b"\x00" * RESERVE_SZ


def decrypt_database(db_path, out_path, enc_key):
    """解密整个数据库文件"""
    file_size = os.path.getsize(db_path)
    total_pages = file_size // PAGE_SZ

    if file_size % PAGE_SZ != 0:
        total_pages += 1

    with open(db_path, "rb") as fin:
        page1 = fin.read(PAGE_SZ)

    if len(page1) < PAGE_SZ:
        print(f"  [ERROR] 文件太小")
        return False

    salt = page1[:SALT_SZ]
    mac_key = derive_mac_key(enc_key, salt)

    p1_hmac_data = page1[SALT_SZ : PAGE_SZ - RESERVE_SZ + IV_SZ]
    p1_stored_hmac = page1[PAGE_SZ - HMAC_SZ : PAGE_SZ]
    hm = hmac_mod.new(mac_key, p1_hmac_data, hashlib.sha512)
    hm.update(struct.pack("<I", 1))
    if hm.digest() != p1_stored_hmac:
        print(f"  [ERROR] Page 1 HMAC验证失败! salt: {salt.hex()}")
        return False

    print(f"  HMAC OK, {total_pages} pages", end="")

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(db_path, "rb") as fin, open(out_path, "wb") as fout:
        for pgno in range(1, total_pages + 1):
            page = fin.read(PAGE_SZ)
            if len(page) < PAGE_SZ:
                if len(page) > 0:
                    page = page + b"\x00" * (PAGE_SZ - len(page))
                else:
                    break

            decrypted = decrypt_page(enc_key, page, pgno)
            fout.write(decrypted)

            if pgno == 1 and decrypted[:16] != SQLITE_HDR:
                print(f" [WARN] header不匹配!", end="")

            if pgno % 10000 == 0:
                print(f"\n  进度: {pgno}/{total_pages} ({100 * pgno / total_pages:.1f}%)", end="")

    return True


def main():
    parser = argparse.ArgumentParser(description="WeChat V4 SQLCipher 4 数据库解密器")
    parser.add_argument("-i", "--incremental", action="store_true", help="增量模式")
    parser.add_argument("--db", type=str, default=None, help="解密单个数据库 (相对路径)")
    parser.add_argument("--keys", type=str, default=None, help="密钥文件路径")
    parser.add_argument("--db-dir", type=str, default=None, help="DB目录")
    parser.add_argument("--out-dir", type=str, default=None, help="输出目录")
    args = parser.parse_args()

    script_dir = os.path.dirname(os.path.abspath(__file__))
    project_dir = os.path.dirname(script_dir)

    db_dir = args.db_dir or os.path.join("D:", os.sep, "weixinDoc", "xwechat_files", "wxid_oofdngwmbpok21_1562", "db_storage")
    out_dir = args.out_dir or os.path.join(project_dir, "decrypted")
    keys_file = args.keys or os.path.join(script_dir, "all_keys.json")

    print("=" * 60)
    print("  WeChat V4 SQLCipher 4 数据库解密器")
    print("=" * 60)

    if not os.path.exists(keys_file):
        print(f"[ERROR] 密钥文件不存在: {keys_file}")
        print("请先运行: python extract_key_v3.py")
        sys.exit(1)

    with open(keys_file, encoding="utf-8") as f:
        keys = json.load(f)

    keys = {k: v for k, v in keys.items() if not k.startswith("_")}
    print(f"\n加载 {len(keys)} 个数据库密钥")
    print(f"输出目录: {out_dir}")
    if args.incremental:
        print("模式: 增量")
    os.makedirs(out_dir, exist_ok=True)

    db_files = []
    if args.db:
        path = os.path.join(db_dir, args.db) if not os.path.isabs(args.db) else args.db
        if os.path.exists(path):
            rel = os.path.relpath(path, db_dir)
            db_files.append((rel, path, os.path.getsize(path)))
        else:
            print(f"[ERROR] 文件不存在: {path}")
            sys.exit(1)
    else:
        for root, dirs, files in os.walk(db_dir):
            for fname in files:
                if fname.endswith(".db") and not fname.endswith("-wal") and not fname.endswith("-shm"):
                    path = os.path.join(root, fname)
                    rel = os.path.relpath(path, db_dir)
                    sz = os.path.getsize(path)
                    db_files.append((rel, path, sz))
        db_files.sort(key=lambda x: x[2])

    print(f"找到 {len(db_files)} 个数据库\n")

    success = 0
    failed = 0
    skipped = 0
    total_bytes = 0

    for rel, path, sz in db_files:
        key_info = None
        for candidate in (rel, rel.replace("\\", "/"), rel.replace("/", "\\")):
            if candidate in keys:
                key_info = keys[candidate]
                break

        if not key_info:
            print(f"SKIP: {rel} (无密钥)")
            skipped += 1
            continue

        out_path = os.path.join(out_dir, rel)

        if args.incremental and os.path.exists(out_path):
            src_mtime = os.path.getmtime(path)
            dst_mtime = os.path.getmtime(out_path)
            if src_mtime <= dst_mtime:
                continue

        print(f"解密: {rel} ({sz / 1024 / 1024:.1f}MB) ...", end=" ")
        t0 = time.time()

        enc_key = bytes.fromhex(key_info["enc_key"])
        ok = decrypt_database(path, out_path, enc_key)

        elapsed = time.time() - t0

        if ok:
            try:
                import sqlite3
                conn = sqlite3.connect(out_path)
                tables = conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
                conn.close()
                table_names = [t[0] for t in tables]
                print(f" OK! {elapsed:.1f}s, 表: {', '.join(table_names[:5])}", end="")
                if len(table_names) > 5:
                    print(f" ...共{len(table_names)}个", end="")
                print()
                success += 1
                total_bytes += sz
            except Exception as e:
                print(f" WARN: SQLite验证失败: {e}")
                failed += 1

            for suffix in ("-shm", "-wal"):
                residual = out_path + suffix
                if os.path.exists(residual):
                    try:
                        os.remove(residual)
                    except OSError:
                        pass
        else:
            failed += 1

    print(f"\n{'=' * 60}")
    print(f"结果: {success} 成功, {failed} 失败, {skipped} 跳过, 共 {len(db_files)} 个")
    if total_bytes > 0:
        print(f"解密数据量: {total_bytes / 1024 / 1024 / 1024:.1f}GB")
    print(f"解密文件在: {out_dir}")


if __name__ == "__main__":
    main()
