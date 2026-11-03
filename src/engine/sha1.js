// SHA-1 over bytes, matching the digest Git uses for content addressing.
// Implemented locally so hashes are identical in browsers without crypto.subtle
// (file:// pages, non-secure contexts) and in Node.

const w = new Int32Array(80);

export function sha1Hex(bytes) {
  const h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  let hA = h0, hB = h1, hC = h2, hD = h3, hE = h4;

  const bitLen = bytes.length * 8;
  const blocks = Math.floor((bytes.length + 8) / 64) + 1;
  const padded = new Uint8Array(blocks * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));
  view.setUint32(padded.length - 4, bitLen >>> 0);

  for (let chunk = 0; chunk < padded.length; chunk += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getInt32(chunk + i * 4);
    for (let i = 16; i < 80; i++) {
      const v = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = (v << 1) | (v >>> 31);
    }

    let a = hA, b = hB, c = hC, d = hD, e = hE;
    for (let i = 0; i < 80; i++) {
      let f, k;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = -0x70e44324;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const sum = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) | 0;
      e = d;
      d = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = sum;
    }

    hA = (hA + a) | 0;
    hB = (hB + b) | 0;
    hC = (hC + c) | 0;
    hD = (hD + d) | 0;
    hE = (hE + e) | 0;
  }

  const out = new DataView(new ArrayBuffer(20));
  for (const [i, v] of [hA, hB, hC, hD, hE].entries()) out.setInt32(i * 4, v);
  let hex = '';
  for (let i = 0; i < 20; i++) hex += out.getUint8(i).toString(16).padStart(2, '0');
  return hex;
}
