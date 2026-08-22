/** Minimal RIFF/WAVE writer with TPDF dither for 16-bit output. */

export function encodeWav(channels, sampleRate, bits = 16, dither = true) {
  const nCh = channels.length;
  const frames = channels[0].length;
  const bytesPerSample = bits / 8;
  const dataLen = frames * nCh * bytesPerSample;
  const buf = new ArrayBuffer(44 + dataLen);
  const dv = new DataView(buf);

  const ascii = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  ascii(0, 'RIFF'); dv.setUint32(4, 36 + dataLen, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, bits === 32 ? 3 : 1, true);          // 3 = IEEE float
  dv.setUint16(22, nCh, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * nCh * bytesPerSample, true);
  dv.setUint16(32, nCh * bytesPerSample, true);
  dv.setUint16(34, bits, true);
  ascii(36, 'data'); dv.setUint32(40, dataLen, true);

  let p = 44;
  if (bits === 32) {
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < nCh; c++) { dv.setFloat32(p, channels[c][i], true); p += 4; }
    }
  } else if (bits === 24) {
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < nCh; c++) {
        const v = Math.max(-1, Math.min(1, channels[c][i]));
        const s = Math.round(v * 8388607);
        dv.setUint8(p, s & 0xff); dv.setUint8(p + 1, (s >> 8) & 0xff); dv.setUint8(p + 2, (s >> 16) & 0xff);
        p += 3;
      }
    }
  } else {
    const scale = 32767;
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < nCh; c++) {
        let v = channels[c][i] * scale;
        if (dither) v += (Math.random() + Math.random() - 1) * 0.5; // TPDF, 1 LSB peak-to-peak
        const s = Math.max(-32768, Math.min(32767, Math.round(v)));
        dv.setInt16(p, s, true);
        p += 2;
      }
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}
