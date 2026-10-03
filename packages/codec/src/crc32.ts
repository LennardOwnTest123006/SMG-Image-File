// CRC-32 (IEEE 802.3, reflected polynomial 0xEDB88320) — the same checksum
// used by ZIP/PNG/gzip. Table-driven, processes one byte per step.

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** Incrementally update a CRC. Start with `crc = 0`. */
export function crc32Update(crc: number, data: Uint8Array, start = 0, end = data.length): number {
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = start; i < end; i++) c = TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function crc32(data: Uint8Array, start = 0, end = data.length): number {
  return crc32Update(0, data, start, end);
}
