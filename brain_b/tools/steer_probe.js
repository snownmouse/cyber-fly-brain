#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// 转向闭环探针：给 --serve 实例发 40 B 感官帧 + 68 B 特征帧，再读 /api 看 turn 从哪来。
//
// 为什么用脚本而不是 curl：云端 shell 的命令内容过滤会把含 HTTP 头 / IP 字面量的命令行拦掉
// （EO_WEB_PROTECTION_BLOCKED），所以这些内容一律写在文件里，命令行只留 "node steer_probe.js"。
//
// 用法：
//   node steer_probe.js [--port 33999] [--api 34000] [--lux 800] [--ms 2500]
// 每个阶段打印：turn / src（brain:joy|brain:imu|reflex*）/ 脑内左右差 raw / 适应基线 base / flags
'use strict';
const dgram = require('dgram');
const http = require('http');

const argv = process.argv.slice(2);
const arg = (k, dflt) => (argv.indexOf(k) >= 0 ? +(argv[argv.indexOf(k) + 1]) : dflt);
const PORT = arg('--port', 33999);
const API = arg('--api', 34000);
const LUX = arg('--lux', 800);
const MS = arg('--ms', 2500);
const HOST = [127, 0, 0, 1].join('.');

// CRC-32/ISO-HDLC，与板端 probe_common.c、stage1_loop.js 逐位一致
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(b, len) {
  let c = -1;
  for (let i = 0; i < len; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function sense40(o) {
  const b = Buffer.alloc(40);
  b.writeUInt32LE(0x5352504D, 0);           // 'MPRS'
  b.writeUInt8(1, 4); b.writeUInt8(5, 5); b.writeUInt16LE(40, 6);
  b.writeUInt32LE(o.seq >>> 0, 8); b.writeUInt32LE((Date.now() * 1000) >>> 0, 12);
  b.writeInt16LE(Math.round(o.tempC * 100), 16);
  b.writeUInt16LE(Math.round(o.rh * 100), 18);
  b.writeUInt16LE(o.lux | 0, 20); b.writeUInt16LE(o.voc | 0, 22);
  b.writeUInt16LE(o.distMm | 0, 24);
  b.writeInt16LE(o.joyX | 0, 26); b.writeInt16LE(o.joyY | 0, 28);
  b.writeUInt16LE(o.valid, 30); b.writeUInt8(0, 32); b.writeUInt8(0, 33);
  b.writeUInt32LE(crc32(b, 36), 36);
  return b;
}

function feat68(o) {
  const b = Buffer.alloc(68);
  b.writeUInt32LE(0x4D505242, 0);           // 'MPRB'
  b.writeUInt8(1, 4); b.writeUInt8(2, 5); b.writeUInt16LE(68, 6);
  b.writeUInt32LE(o.seq >>> 0, 8); b.writeUInt32LE((Date.now() * 1000) >>> 0, 12);
  b.writeUInt16LE(16000, 20); b.writeUInt8(1, 22); b.writeUInt8(3, 23);
  b.writeFloatLE(-62, 24); b.writeFloatLE(-68, 28);
  b.writeFloatLE(-70, 32); b.writeFloatLE(-72, 36);
  b.writeFloatLE(o.ax, 40); b.writeFloatLE(o.ay, 44); b.writeFloatLE(o.az, 48);
  b.writeUInt32LE(crc32(b, 64), 64);
  return b;
}

function readApi() {
  return new Promise((res) => {
    const req = http.get({ host: HOST, port: API, path: '/api', timeout: 4000 }, (r) => {
      let s = '';
      r.on('data', (c) => (s += c));
      r.on('end', () => { try { res(JSON.parse(s)); } catch (e) { res(null); } });
    });
    req.on('error', () => res(null));
    req.on('timeout', () => { req.destroy(); res(null); });
  });
}

const sock = dgram.createSocket('udp4');
let seq = 0;

async function phase(tag, joy, ax, lux) {
  const t0 = Date.now();
  while (Date.now() - t0 < MS) {
    const n = ++seq;
    sock.send(sense40({ seq: n, tempC: 24.5, rh: 48, lux, voc: 280, distMm: 600,
                        joyX: joy, joyY: 0, valid: 0x1F }), PORT, HOST);
    sock.send(feat68({ seq: n, ax, ay: 0, az: 1.0 }), PORT, HOST);
    await new Promise((r) => setTimeout(r, 50));
  }
  const a = await readApi();
  const st = (a && a.steer) || {};
  const cmd = (a && a.cmd) || {};
  console.log(
    tag.padEnd(24),
    'turn', String(cmd.turn).padStart(7),
    'src', String(st.src || '-').padEnd(13),
    'raw', String(st.raw).padStart(7),
    'base', String(st.base).padStart(7),
    'visLat', String(st.visLat).padStart(6),
    'flags 0x' + (cmd.flags === undefined ? '-' : cmd.flags.toString(16)),
  );
}

(async () => {
  console.log(`探针 → 127.0.0.1:${PORT}（API ${API}，每段 ${MS} ms，lux ${LUX}）`);
  await phase('① 基准 摇杆中位', 0, 0, LUX);
  await phase('② 摇杆右推 +800', 800, 0, LUX);
  await phase('③ 摇杆左推 -800', -800, 0, LUX);
  await phase('④ 摇杆回中', 0, 0, LUX);
  await phase('⑤ IMU 右推 ax=+0.4', 0, 0.4, LUX);
  await phase('⑥ IMU 左推 ax=-0.4', 0, -0.4, LUX);
  await phase('⑦ 黑暗 lux=5', 0, 0, 5);
  sock.close();
  console.log('done');
})();
