/**
 * 向量在 SQLite 里的统一编解码：number[] ⇄ Float32 BLOB。
 *
 * `rag` 与 `memory` 两张表存的是同一类东西，编码必须**只有一份** ——
 * 两处各写一遍的话，哪天有人只改了一边，另一边读出来的向量就是错的，
 * 而余弦相似度算错不会报错，只会安静地给出错误排序。
 */

/** number[] → Float32 BLOB */
export function toBlob(vector: number[]): Uint8Array {
  return new Uint8Array(new Float32Array(vector).buffer)
}

/** BLOB → number[]；非 BLOB 或空值返回 null */
export function fromBlob(value: unknown): number[] | null {
  if (!(value instanceof Uint8Array) || value.byteLength === 0)
    return null
  // 复制出对齐的 ArrayBuffer 再构造 Float32Array：DB 返回的视图 byteOffset 未必是 4 的倍数
  const buffer = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
  return Array.from(new Float32Array(buffer))
}
