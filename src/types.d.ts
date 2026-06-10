declare module "zstd-codec" {
  export class ZstdCodec {
    static run(callback: (zstd: { Simple: new () => ZstdSimple }) => void): void;
  }

  interface ZstdSimple {
    decompress(data: Uint8Array): Uint8Array;
    compress(data: Uint8Array): Uint8Array;
  }
}

declare module "sql.js" {
  export interface SqlJsStatic {
    Database: new (data?: ArrayLike<number | bigint>) => Database;
  }

  export interface Database {
    exec(sql: string, params?: unknown[]): QueryExecResult[];
    run(sql: string, params?: unknown[]): Database;
    close(): void;
    export(): Uint8Array;
  }

  export interface QueryExecResult {
    columns: string[];
    values: unknown[][];
  }

  export default function initSqlJs(): Promise<SqlJsStatic>;
}
