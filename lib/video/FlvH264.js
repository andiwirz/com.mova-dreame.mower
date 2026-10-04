'use strict';
// Incremental, bounded FLV/H.264 demuxer.
// Live camera audio is intentionally ignored: Homey receives a video-only FLV
// and dashboard widgets receive H.264 frames only.

class FlvH264 {
  constructor(onTag = () => {}) {
    this.onTag = onTag;
    this.buffer = Buffer.alloc(0);
    this.header = null;
    this.config = null;
    this.configTags = new Map();
    this.frames = [];
    this.sequence = 0;
    this.frameBytes = 0;
    this.gop = [];
    this.gopBytes = 0;
    this.configVersion = 0;
    this.hasKey = false;
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > 4 * 1024 * 1024) throw Error('Kamerapuffer zu groß');
    if (!this.header) {
      if (this.buffer.length < 9) return;
      if (this.buffer.toString('ascii', 0, 3) !== 'FLV') throw Error('Kein FLV-Kamerastream');
      const n = this.buffer.readUInt32BE(5);
      if (n < 9 || n > 1024) throw Error('Ungültiger FLV-Header');
      if (this.buffer.length < n + 4) return;
      this.header = Buffer.from(this.buffer.subarray(0, n + 4));
      // Clear the FLV audio flag. The Homey integration deliberately exposes
      // only video, even if the mower's upstream FLV also contains audio tags.
      this.header[4] &= ~0x04;
      this.buffer = this.buffer.subarray(n + 4);
    }
    while (this.buffer.length >= 15) {
      const n = this.buffer.readUIntBE(1, 3);
      if (n > 2 * 1024 * 1024) throw Error('Kamerapaket zu groß');
      if (this.buffer.length < n + 15) return;
      const raw = Buffer.from(this.buffer.subarray(0, n + 15));
      this.buffer = this.buffer.subarray(n + 15);
      if (raw.readUInt32BE(n + 11) !== n + 11) throw Error('Ungültige FLV-Paketlänge');
      this.tag(raw);
    }
  }

  tag(raw) {
    const type = raw[0];
    // Type 8 = audio. Do not retain, expose or relay camera audio.
    if (type === 8) return;

    const body = raw.subarray(11, -4);
    const dts = raw.readUIntBE(4, 3) + raw[7] * 16777216;
    let key = false;

    if (type === 18) this.configTags.set('meta', raw);

    if (type === 9 && body.length >= 5) {
      if ((body[0] & 15) !== 7) throw Error('Kamera liefert keinen unterstützten H.264-Stream');
      if (body[1] === 0) {
        const avcc = body.subarray(5);
        if (avcc.length < 7 || avcc[0] !== 1) throw Error('Ungültige H.264-Konfiguration');
        const desc = avcc.toString('base64');
        if (this.config?.description !== desc) {
          this.configVersion++;
          this.frames = [];
          this.frameBytes = 0;
          this.gop = [];
          this.gopBytes = 0;
          this.hasKey = false;
        }
        this.config = { codec: `avc1.${avcc.subarray(1, 4).toString('hex')}`, description: desc, version: this.configVersion };
        this.configTags.set('video', raw);
      }
      if (body[1] === 1 && this.config) {
        key = (body[0] >> 4) === 1;
        const bytes = Buffer.from(body.subarray(5));
        const frame = {
          seq: ++this.sequence,
          key,
          timestamp: (dts + body.readIntBE(2, 3)) * 1000,
          data: bytes.toString('base64'),
          bytes: bytes.length,
        };
        this.frames.push(frame);
        this.frameBytes += bytes.length;
        while (this.frames.length > 240 || this.frameBytes > 2 * 1024 * 1024) {
          this.frameBytes -= this.frames.shift().bytes;
        }
      }
    }

    if (key) {
      this.gop = [];
      this.gopBytes = 0;
      this.hasKey = true;
    }
    if (this.hasKey && (type === 9 || type === 18)) {
      this.gop.push(raw);
      this.gopBytes += raw.length;
      if (this.gopBytes > 2 * 1024 * 1024) {
        this.gop = [];
        this.gopBytes = 0;
        this.hasKey = false;
      }
    }
    this.onTag(raw);
  }

  initial() {
    return this.header ? Buffer.concat([this.header, ...this.configTags.values(), ...this.gop]) : null;
  }

  snapshot(since = 0) {
    let frames = this.frames.filter(f => f.seq > since);
    const reset = !since || (frames[0] && frames[0].seq > since + 1);
    if (reset) {
      const at = frames.findIndex(f => f.key);
      frames = at < 0 ? [] : frames.slice(at);
    }
    let size = 0;
    const result = [];
    for (const frame of frames) {
      if (frame.bytes > 320000) throw Error('Videobild zu groß für Widget');
      if (result.length && size + frame.bytes > 240000) break;
      size += frame.bytes;
      const { bytes, ...rest } = frame;
      result.push(rest);
    }
    return {
      config: this.config,
      frames: result,
      cursor: result.at(-1)?.seq || since,
      reset,
    };
  }
}

module.exports = { FlvH264 };
