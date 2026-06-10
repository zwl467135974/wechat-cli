import { ZstdCodec } from "zstd-codec";

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

interface ZstdSimple {
  decompress(data: Uint8Array): Uint8Array;
  compress(data: Uint8Array): Uint8Array;
}

let zstdReady = false;
let zstdInstance: ZstdSimple | null = null;

function getZstd(): Promise<ZstdSimple> {
  if (zstdReady && zstdInstance) return Promise.resolve(zstdInstance);
  return new Promise((resolve) => {
    ZstdCodec.run((zstd: { Simple: new () => ZstdSimple }) => {
      zstdReady = true;
      zstdInstance = new zstd.Simple();
      resolve(zstdInstance);
    });
  });
}

export function decompressZstd(data: Buffer): Promise<Buffer | null> {
  if (
    data.length < 4 ||
    data[0] !== ZSTD_MAGIC[0] ||
    data[1] !== ZSTD_MAGIC[1] ||
    data[2] !== ZSTD_MAGIC[2] ||
    data[3] !== ZSTD_MAGIC[3]
  ) {
    return Promise.resolve(null);
  }

  return getZstd()
    .then((simple) => {
      const result = simple.decompress(new Uint8Array(data));
      return Buffer.from(result);
    })
    .catch(() => null);
}

export async function decodeMessageContent(raw: Uint8Array | Buffer): Promise<string> {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);

  const decompressed = await decompressZstd(buf);
  if (decompressed) {
    return decompressed.toString("utf-8");
  }

  return buf.toString("utf-8");
}
