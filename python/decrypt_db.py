"""
WeChat database decryption script.
Supports: pysqlcipher3 / sqlcipher CLI / pywxdump

Usage: python decrypt_db.py --args '{"src_path":"...", "key":"...", "out_dir":"..."}'
"""
import sys
import os
import json


def parse_args():
    for i, arg in enumerate(sys.argv):
        if arg == "--args" and i + 1 < len(sys.argv):
            return json.loads(sys.argv[i + 1])
    return {}


def decrypt_with_pywxdump(src_path, dst_path, key_str):
    from pywxdump import decrypt

    os.makedirs(os.path.dirname(dst_path) or ".", exist_ok=True)
    result = decrypt(key_str, src_path, dst_path)
    if result and isinstance(result, (list, tuple)) and result[0]:
        if os.path.exists(dst_path):
            return True
    if result and isinstance(result, (list, tuple)):
        raise RuntimeError(f"pywxdump decrypt failed: {result[1]}")
    raise RuntimeError("pywxdump decrypt returned falsy")


def decrypt_with_pysqlcipher3(src_path, dst_path, key_str):
    from pysqlcipher3 import dbapi2 as sqlcipher

    tmp_dst = dst_path + ".tmp"
    try:
        conn = sqlcipher.connect(src_path)
        c = conn.cursor()
        c.execute(f"PRAGMA key = \"x'{key_str}'\"")
        c.execute("PRAGMA cipher_compatibility = 4")
        c.execute("PRAGMA cipher_page_size = 4096")
        c.execute("PRAGMA kdf_iter = 64000")
        c.execute("ATTACH DATABASE ? AS plaintext KEY ''", (tmp_dst,))
        c.execute("SELECT sqlcipher_export('plaintext')")
        c.execute("DETACH DATABASE plaintext")
        conn.close()

        if os.path.exists(dst_path):
            os.remove(dst_path)
        os.rename(tmp_dst, dst_path)
        return True
    except Exception:
        if os.path.exists(tmp_dst):
            os.remove(tmp_dst)
        raise


def decrypt_with_sqlcipher_cli(src_path, dst_path, key_str):
    import subprocess

    tmp_dst = dst_path + ".tmp"
    sql = f"""PRAGMA key = "x'{key_str}'";
PRAGMA cipher_compatibility = 4;
PRAGMA cipher_page_size = 4096;
PRAGMA kdf_iter = 64000;
ATTACH DATABASE '{tmp_dst}' AS plaintext KEY '';
SELECT sqlcipher_export('plaintext');
DETACH DATABASE plaintext;
"""
    sqlfile = src_path + ".sql"
    with open(sqlfile, "w") as f:
        f.write(sql)

    try:
        result = subprocess.run(
            ["sqlcipher", src_path, ".read", sqlfile],
            capture_output=True, text=True, timeout=30,
        )
        if os.path.exists(sqlfile):
            os.remove(sqlfile)

        if result.returncode != 0:
            if os.path.exists(tmp_dst):
                os.remove(tmp_dst)
            raise RuntimeError(f"sqlcipher CLI error: {result.stderr}")

        if os.path.exists(dst_path):
            os.remove(dst_path)
        os.rename(tmp_dst, dst_path)
        return True
    except FileNotFoundError:
        if os.path.exists(sqlfile):
            os.remove(sqlfile)
        raise


def decrypt_db(src_path, dst_path, key_str):
    errors = []

    try:
        return decrypt_with_pywxdump(src_path, dst_path, key_str)
    except ImportError:
        pass
    except Exception as e:
        errors.append(f"pywxdump: {e}")

    try:
        return decrypt_with_pysqlcipher3(src_path, dst_path, key_str)
    except ImportError:
        pass
    except Exception as e:
        errors.append(f"pysqlcipher3: {e}")

    try:
        return decrypt_with_sqlcipher_cli(src_path, dst_path, key_str)
    except FileNotFoundError:
        pass
    except Exception as e:
        errors.append(f"sqlcipher CLI: {e}")

    raise RuntimeError(
        "All decrypt methods failed:\n" +
        "\n".join(f"  - {e}" for e in errors) +
        "\n\nPlease install one of:\n"
        "  pip install pywxdump  (recommended)\n"
        "  pip install pysqlcipher3\n"
        "  or install sqlcipher CLI binary"
    )


def run_decrypt(src_dir, key_str, out_dir):
    if not key_str:
        raise ValueError("Database key is empty")
    if not src_dir:
        raise ValueError("Source path is empty")
    if not os.path.isdir(src_dir):
        raise ValueError(f"Source path does not exist: {src_dir}")

    os.makedirs(out_dir, exist_ok=True)

    db_storage = os.path.join(src_dir, "db_storage")
    search_dir = db_storage if os.path.isdir(db_storage) else src_dir

    db_files = []
    for root, dirs, files in os.walk(search_dir):
        for f in files:
            if f.lower().endswith(".db") and "fts" not in f.lower():
                db_files.append(os.path.join(root, f))

    if not db_files:
        raise ValueError(f"No .db files found in {search_dir}")

    success = 0
    errors = []

    for src_path in db_files:
        try:
            rel = os.path.relpath(src_path, search_dir)
            dst_path = os.path.join(out_dir, rel)
            os.makedirs(os.path.dirname(dst_path), exist_ok=True)

            decrypt_db(src_path, dst_path, key_str)
            success += 1
            print(f"OK: {rel}")
        except Exception as e:
            errors.append(f"FAIL {os.path.basename(src_path)}: {e}")
            print(f"FAIL: {os.path.basename(src_path)}: {e}", file=sys.stderr)

    result = {
        "success": success,
        "total": len(db_files),
        "errors": errors,
        "output_dir": os.path.abspath(out_dir),
    }
    return json.dumps(result, indent=2)


if __name__ == "__main__":
    args = parse_args()
    try:
        output = run_decrypt(
            args.get("src_path", ""),
            args.get("key", ""),
            args.get("out_dir", "data"),
        )
        print(output)
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
