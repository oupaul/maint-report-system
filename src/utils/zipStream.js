// 最小的 ZIP 寫入器：只用「不壓縮（store）」逐個檔案寫進輸出串流，記憶體只需同時放一個檔案。
// 給「每家客戶各一份 PDF」打包用（PDF 本身已經壓縮過，再壓縮沒有意義）。檔名用 UTF-8（旗標 bit 11），
// 所以中文檔名在 Windows／macOS 內建解壓縮都正常。不支援 ZIP64（單檔與總量都要小於 4GB、檔案數小於 65535，
// 巡檢報告遠遠不會到）。
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

class ZipStream {
  constructor(out) {
    this.out = out;
    this.offset = 0;
    this.entries = [];
  }

  _write(buf) {
    this.offset += buf.length;
    return new Promise((resolve, reject) => {
      const ok = this.out.write(buf, (err) => (err ? reject(err) : undefined));
      if (ok) resolve(); else this.out.once('drain', resolve);
    });
  }

  async addFile(name, data, date = new Date()) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const { time, date: dd } = dosDateTime(date);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);       // version needed
    header.writeUInt16LE(0x0800, 6);   // UTF-8 檔名
    header.writeUInt16LE(0, 8);        // store
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(dd, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);
    const entry = { nameBuf, crc, size: data.length, time, date: dd, offset: this.offset };
    this.entries.push(entry);
    await this._write(header);
    await this._write(nameBuf);
    await this._write(data);
  }

  async finish() {
    const start = this.offset;
    for (const e of this.entries) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE(20, 4);
      h.writeUInt16LE(20, 6);
      h.writeUInt16LE(0x0800, 8);
      h.writeUInt16LE(0, 10);
      h.writeUInt16LE(e.time, 12);
      h.writeUInt16LE(e.date, 14);
      h.writeUInt32LE(e.crc, 16);
      h.writeUInt32LE(e.size, 20);
      h.writeUInt32LE(e.size, 24);
      h.writeUInt16LE(e.nameBuf.length, 28);
      h.writeUInt32LE(e.offset, 42);
      await this._write(h);
      await this._write(e.nameBuf);
    }
    const size = this.offset - start;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(size, 12);
    end.writeUInt32LE(start, 16);
    await this._write(end);
    await new Promise((resolve) => this.out.end(resolve));
  }
}

module.exports = { ZipStream, crc32 };
