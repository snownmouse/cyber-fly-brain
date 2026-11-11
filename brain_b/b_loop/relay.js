// 板子帧双向转发（云端旁路）
//
// 架构（2026-10-07 修正后定案）：
//   板子 --UDP 33333--> relay.js --127.0.0.1--> 大脑 33335
//             ^                |
//             |                +--127.0.0.1--> 中文诊断 33336
//             +-- 回包（32 B MPRC）由 relay 转发回来
//
// ★ 双向是关键。第一版只做上行转发（板子 → 大脑），结果：
//   板子 tx 一路上涨、云端 20 万帧零丢弃、诊断"已转发 10 万"，
//   而板子 rx 恒为 0。
//
// ★★ 为什么必须用**同一个 socket**收发
// 大脑用 `sock.send(dl, rinfo.port, rinfo.address)` 回包，而 rinfo 来自
// **收到帧的那个 socket 的源地址**。若转发用独立的出口 socket，回包就只回到
// 那个独立 socket，主 socket 永远收不到 —— 症状是"云端在收在回、relay 下行 0、
// 板子 rx=0"。改成收发共用一个 socket 后立刻正常（up=300 down=284, errs=0）。
//
// ★★★ 目标必须用 127.0.0.1，不能用公网 IP。
// 最初写成 <公网IP>:33335，症状极具误导性：
//   send 回调成功、errs 0、日志显示 "forwarded 250"，
//   但大脑进程 CPU 时间 0:00.00，一个包都没收到；
//   iptables INPUT 规则数为 0（不是本机防火墙）；
//   改成 127.0.0.1 后立刻收到回包。
// ⇒ 腾讯云等厂商的网络层会丢弃"绕出去再回来"的流量。
const dgram = require('dgram');

const IN_PORT = +(process.env.FLY_IN_PORT || 33333);
const BRAIN = +(process.env.FLY_BRAIN_PORT || 33335);
const WATCH = +(process.env.FLY_WATCH_PORT || 33336);
const SENSE_LEN = 40;               // 2 Hz 感官包（MPRS）
const MAGIC_SENSE = 0x5352504D;     // 'MPRS'

const sock = dgram.createSocket('udp4');
sock.on('error', (e) => console.log('[socket 错误]', e.message));

// ---------------------------------------------------------------------------
// 板子身份锁（2026-11-11 加）
// 之前任何往 33333 投一个 68 B 包的主机都会被当成「板子」——board 地址被覆盖，
// 真板子的下行立刻被劫持；投 40 B 假帧还能伪造全部传感器数值（实测能把
// T/RH/LUX/VOC 全部盖掉，而看板没有任何「这条数据是谁给的」标记）。
// 现在改成：认第一个说话的人，之后只认他。
//   FLY_ALLOW_IP=a,b   显式白名单（逗号分隔），优先级最高
//   FLY_LOCK_TTL_MS    N 毫秒内没再收到锁定 IP 的帧，才允许换绑（默认 10 min）
//   127.0.0.1 永远放行，留给本机回放/自检
// 换绑会打一条显式日志，方便在日志里看出「谁抢了板子的位置」。
const ALLOW_IP = (process.env.FLY_ALLOW_IP || '').split(',').map((s) => s.trim()).filter(Boolean);
const LOCK_TTL_MS = +(process.env.FLY_LOCK_TTL_MS || 600000);
const LOCK_NEED = +(process.env.FLY_LOCK_NEED || 20);   // 连续多少帧才认定是板子
let board = null;        // 当前板子地址（收到上行帧时更新）
let lockIp = null;       // 当前锁定的板子源 IP
let lockAt = 0;          // 最后一次从 lockIp 收到上行帧的时间
let candIp = null, candN = 0, candAt = 0;   // 未锁定时的候选计数
let up = 0, down = 0, errs = 0;
let sense = 0;    // 2 Hz 感官帧计数（新增，不影响原有计数）
let rejected = 0;

function boardAllowed(ip) {
  if (ip === '127.0.0.1') return true;
  if (ALLOW_IP.length && !ALLOW_IP.includes(ip)) return false;
  const now = Date.now();
  if (lockIp) {
    if (ip === lockIp) { lockAt = now; return true; }
    if (now - lockAt > LOCK_TTL_MS) {
      const old = lockIp, silentS = Math.round((now - lockAt) / 1000);
      lockIp = ip; lockAt = now;
      console.log(`[relay] ★ 板子换绑 ${old} -> ${ip}（原地址已静默 ${silentS}s）`);
      return true;
    }
    return false;
  }
  // 还没锁定：要求同一 IP 连续 LOCK_NEED 帧、且帧间隔不超过 1 s，才认定为板子。
  // 这样零星扫端口的包、单发的假帧都不会把板子的位置占掉。
  if (ip !== candIp || now - candAt > 1000) { candIp = ip; candN = 1; }
  else candN++;
  candAt = now;
  if (candN >= LOCK_NEED) {
    lockIp = ip; lockAt = now;
    console.log(`[relay] 锁定板子源地址 ${ip}（连续 ${candN} 帧，此后再来的其它源都会被拒）`);
  }
  return true;   // 候选期照常放行，否则板子上电第一秒的数据会被吞掉
}

sock.on('message', (msg, rinfo) => {
  const c = Buffer.from(msg);   // Node 可能复用 msg 的内存

  if (msg.length === 68) {
    if (!boardAllowed(rinfo.address)) {
      rejected++;
      if (rejected % 20 === 1) {
        console.log(`[relay] 拒绝上行 68 B 来自 ${rinfo.address}（当前锁定 ${lockIp}），累计 ${rejected} 次`);
      }
      return;
    }
    // 上行：记住板子地址，用同一个 socket 转发给大脑和诊断
    board = { host: rinfo.address, port: rinfo.port };
    sock.send(c, BRAIN, '127.0.0.1', (e) => { if (e) errs++; });
    sock.send(c, WATCH, '127.0.0.1', (e) => { if (e) errs++; });
    up++;
    if (up % 100 === 0) {
      console.log(`[relay] up=${up} (board ${board.host}:${board.port}) down=${down} err=${errs}`);
    }
  } else if (msg.length === SENSE_LEN && c.readUInt32LE(0) === MAGIC_SENSE) {
    if (!boardAllowed(rinfo.address)) {
      rejected++;
      if (rejected % 20 === 1) {
        console.log(`[relay] 拒绝感官帧来自 ${rinfo.address}（当前锁定 ${lockIp}），累计 ${rejected} 次`);
      }
      return;
    }
    // 2 Hz 感官包：只送大脑，绝不送 33336 诊断（watch2 只认 68 B，会记成坏帧）。
    // 必须复用同一个 sock；board 由 20 Hz 的 68 B 帧持续刷新，这里补一次更稳。
    board = { host: rinfo.address, port: rinfo.port };
    sock.send(c, BRAIN, '127.0.0.1', (e) => { if (e) errs++; });
    sense++;
    if (sense % 20 === 0) console.log(`[relay] 感官帧 ${sense}`);
  } else if (msg.length === 32) {
    // 下行：大脑回包，转回板子。只接受本机（大脑）发来的，外部注入的 32 B 一律丢弃。
    if (rinfo.address !== '127.0.0.1') { rejected++; return; }
    if (!board) return;
    sock.send(c, board.port, board.host, (e) => {
      if (e) { errs++; return; }
      down++;
      if (down % 100 === 0) console.log(`[relay] up=${up} down=${down} err=${errs}`);
    });
  }
});

sock.bind(IN_PORT, '0.0.0.0', () =>
  console.log(`[relay] ${IN_PORT} <-> 127.0.0.1:${BRAIN}(大脑) + ${WATCH}(诊断)`));

setInterval(() => { if (up) console.log(`[relay] up=${up} down=${down} err=${errs} rej=${rejected} board=${lockIp}`); }, 6000);

process.on('SIGINT', () => {
  console.log(`\n[relay] 汇总：上行 ${up} 下行 ${down} 错误 ${errs} 拒绝 ${rejected}`);
  if (sense) console.log(`[relay] 感官帧 ${sense}`);
  process.exit(0);
});
