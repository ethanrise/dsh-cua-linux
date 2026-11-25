/**
 * png.js —— 最小 PNG 编码器（RGBA8，filter=0），只用 node:zlib。
 *
 * 为什么不引第三方包：截图这条链上每加一个依赖，用户就多一个装失败的理由；
 * PNG 容器本身只有 IHDR/IDAT/IEND 三个块，CRC 表 40 行就够。
 */
import zlib from 'node:zlib'

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

/**
 * @param {number} width
 * @param {number} height
 * @param {Buffer} rgba 长度必须为 width*height*4
 * @returns {Buffer} PNG 字节
 */
export function encodePNG(width, height, rgba) {
  if (rgba.length !== width * height * 4) {
    throw new Error(`RGBA 长度不符: 期望 ${width * height * 4}，实得 ${rgba.length}`)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8    // bit depth
  ihdr[9] = 6    // color type: RGBA
  ihdr[10] = 0   // compression
  ihdr[11] = 0   // filter
  ihdr[12] = 0   // interlace

  // 每行前置一个 filter 字节（0 = None）
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * X11 GetImage 给的是 BGRX（32bpp）或 BGR（24bpp），转成 RGBA。
 * @param {Buffer} data
 * @param {number} width
 * @param {number} height
 */
export function xImageToRGBA(data, width, height) {
  const px = data.length / (width * height)
  const out = Buffer.alloc(width * height * 4)
  if (px === 4) {
    for (let i = 0, o = 0; i < data.length; i += 4, o += 4) {
      out[o] = data[i + 2]
      out[o + 1] = data[i + 1]
      out[o + 2] = data[i]
      out[o + 3] = 255
    }
  } else if (px === 3) {
    for (let i = 0, o = 0; i < data.length; i += 3, o += 4) {
      out[o] = data[i + 2]
      out[o + 1] = data[i + 1]
      out[o + 2] = data[i]
      out[o + 3] = 255
    }
  } else {
    throw new Error(`不支持的像素宽度: ${px} 字节/像素`)
  }
  return out
}
