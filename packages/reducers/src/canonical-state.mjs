const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const SHA256_K = Object.freeze([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function canonicalStateJson(value) {
  return encodeCanonical(value, "$", new Set());
}

export function canonicalStateDigest(value) {
  return `sha256:${sha256Hex(canonicalStateJson(value))}`;
}

export function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const paddedLength = ((bytes.length + 9 + 63) >> 6) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded.set([0x80], bytes.length);

  const bitLength = bytes.length * 8;
  padded.set(
    [
      (bitLength >>> 24) & 0xff,
      (bitLength >>> 16) & 0xff,
      (bitLength >>> 8) & 0xff,
      bitLength & 0xff,
    ],
    padded.length - 4,
  );

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  for (let chunk = 0; chunk < padded.length; chunk += 64) {
    const words = new Uint32Array(64);
    for (let index = 0; index < 16; index += 1) {
      const offset = chunk + index * 4;
      const word =
        ((padded.at(offset) << 24) |
          (padded.at(offset + 1) << 16) |
          (padded.at(offset + 2) << 8) |
          padded.at(offset + 3)) >>>
        0;
      words.set([word], index);
    }
    for (let index = 16; index < 64; index += 1) {
      const left = words.at(index - 15);
      const right = words.at(index - 2);
      const s0 = rotr(left, 7) ^ rotr(left, 18) ^ (left >>> 3);
      const s1 = rotr(right, 17) ^ rotr(right, 19) ^ (right >>> 10);
      words.set(
        [(words.at(index - 16) + s0 + words.at(index - 7) + s1) >>> 0],
        index,
      );
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 =
        (h + s1 + choose + SHA256_K.at(index) + words.at(index)) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + majority) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((word) => word.toString(16).padStart(8, "0"))
    .join("");
}

function rotr(value, bits) {
  return (value >>> bits) | (value << (32 - bits));
}

function encodeCanonical(value, path, ancestors) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must be finite`);
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new TypeError(`${path} exceeds the safe integer range`);
    }
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new TypeError(`${path} contains an unsupported value`);
  }
  if (ancestors.has(value)) throw new TypeError(`${path} is cyclic`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Object.keys(value);
      if (keys.length !== value.length) {
        throw new TypeError(`${path} is sparse or has custom properties`);
      }
      return `[${value
        .map((item, index) =>
          encodeCanonical(item, `${path}[${index}]`, ancestors),
        )
        .join(",")}]`;
    }
    const entries = Object.entries(value).sort((left, right) => {
      const leftKey = left.at(0);
      const rightKey = right.at(0);
      if (leftKey < rightKey) return -1;
      if (leftKey > rightKey) return 1;
      return 0;
    });
    return (
      "{" +
      entries
        .map(([key, item]) => {
          if (FORBIDDEN_KEYS.has(key))
            throw new TypeError(`${path}.${key} is forbidden`);
          return `${JSON.stringify(key)}:${encodeCanonical(item, `${path}.${key}`, ancestors)}`;
        })
        .join(",") +
      "}"
    );
  } finally {
    ancestors.delete(value);
  }
}
