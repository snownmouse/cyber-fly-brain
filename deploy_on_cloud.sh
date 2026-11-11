#!/usr/bin/env bash
# ============================================================================
# Cyber-Fly 云端大脑 · 一键部署 / 自检 / 闭环验证
#
# 在腾讯云 Lighthouse（Debian 12）上执行：
#   cd /root/cyber-fly-brain
#   tar -xzf /root/cyber-fly-brain-deploy.tar.gz
#   bash deploy_on_cloud.sh
#
# 做完这三条，板子应从「源=已发无回 tx=... rx=0」变成「源=云端 rx>0」。
# ★ 只启动 relay + stage1 两个进程（LITE=1），不碰同机其它 2~3 个项目；
#   停止只按 PID 文件，绝不用 pkill node。
# ★ 板端 CONFIG_FLY_LINK_PORT=33333，所以云端必须 OFFSET=0，不能平移端口。
# ============================================================================
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$HERE/brain_b/b_loop/start_local.sh" ]; then
  ROOT="$HERE"
elif [ -n "${BRAIN_REPO:-}" ] && [ -f "$BRAIN_REPO/brain_b/b_loop/start_local.sh" ]; then
  ROOT="$BRAIN_REPO"
elif [ -f "/root/cyber-fly-brain/brain_b/b_loop/start_local.sh" ]; then
  ROOT="/root/cyber-fly-brain"
else
  echo "[失败] 找不到 brain_b/b_loop/start_local.sh"
  echo "  请把 tar 包解压到大脑仓根目录：tar -xzf cyber-fly-brain-deploy.tar.gz -C /root/cyber-fly-brain"
  exit 1
fi
LOOP="$ROOT/brain_b/b_loop"
FLYLAB="${FLYLAB:-/root/flywire-fly-lab}"
DATA="${FLYDATA:-$FLYLAB/results/dodge/subcircuit_v4.json}"
LOCAL="${FLY_LOCAL:-/tmp/cyber-fly-local}"

echo "=== Cyber-Fly 云端大脑一键部署 ==="
echo "  代码目录  $LOOP"
echo "  连接组    $DATA"
echo "  板端端口  33333 (UDP)  → 云端 OFFSET=0 / IN=33333 / BRAIN=33335"
echo

# ---------------------------------------------------------------- 1. 依赖检查
FAIL=0
command -v node >/dev/null 2>&1 || { echo "[失败] 没有 node"; FAIL=1; }
[ -f "$FLYLAB/dodge/brain.js" ] || { echo "[失败] 缺少 $FLYLAB/dodge/brain.js（flywire-fly-lab 运行时依赖）"; FAIL=1; }
[ -f "$DATA" ] || { echo "[失败] 缺少连接组 $DATA（CC BY-NC 4.0，不随包分发，需留在服务器上）"; FAIL=1; }
for f in relay.js stage1_loop.js fly_dashboard.js sense_panel.js; do
  [ -f "$LOOP/$f" ] || { echo "[失败] 缺少 $f"; FAIL=1; }
done
[ "$FAIL" = "0" ] || exit 1
echo "[1/6] 依赖齐全（node $(node --version)、brain.js、连接组数据）"

# ---------------------------------------------------------------- 2. 语法检查
for f in relay.js stage1_loop.js fly_dashboard.js sense_panel.js fly_watch2.js; do
  [ -f "$LOOP/$f" ] || continue
  node --check "$LOOP/$f" || { echo "[失败] $f 语法错误"; exit 1; }
done
echo "[2/6] 全部 JS 语法检查通过"

# ---------------------------------------------------------------- 3. 帧编解码自检
( cd "$LOOP" && FLYLAB="$FLYLAB" FLYDATA="$DATA" node stage1_loop.js --selftest ) || {
  echo "[失败] stage1_loop.js --selftest 未通过"; exit 1;
}
echo "[3/6] MPRB / MPRS / MPRC 编解码自检通过"

# ---------------------------------------------------------------- 4. 停旧 + 启新
if [ -f "$LOOP/stop_local.sh" ]; then
  ( cd "$LOOP" && FLY_LOCAL="$LOCAL" bash stop_local.sh ) || true
fi
sleep 1
( cd "$LOOP" && FLYLAB="$FLYLAB" FLYDATA="$DATA" FLY_LOCAL="$LOCAL" \
    LITE=1 WITH_DASHBOARD=0 OFFSET=0 FLY_SENSE_GAIN="${FLY_SENSE_GAIN:-0.18}" \
    bash start_local.sh ) || { echo "[失败] 启动脚本退出"; exit 1; }
echo "[4/6] 已按 LITE=1 / OFFSET=0 启动 relay + stage1"
sleep 2

# ---------------------------------------------------------------- 5. 进程与日志
echo "[5/6] 进程与日志"
if command -v ss >/dev/null 2>&1; then
  ss -lunp 2>/dev/null | grep -E '33333|33335' || echo "  ⚠ 没看到 33333/33335 的 UDP 监听"
fi
for f in brain-relay.log brain-stage1.log; do
  echo "  --- $LOCAL/$f (尾部) ---"
  tail -n 8 "$LOCAL/$f" 2>/dev/null || echo "  (无日志)"
done

# ---------------------------------------------------------------- 6. 本机回环闭环验证
# 发【合法】68B MPRB 直接到 127.0.0.1:33335（大脑），必须收到 32B MPRC。
# ★ 不能发到 33333(relay)：relay 的 board 会被真板子 20Hz 的帧不断刷新，
#   探测包的回包因此被转给板子，本机收不到 => 假阴性（2026-11-08 实测踩过：
#   云端 up=1013 down=1000、板子 rx>0 都正常，这一项却报 FAIL）。
#   33335 直连时 stage1 直接回包到探测 socket，完全不受 board 影响。
# relay 的下行转发另用日志里的 down= 计数确认。
cat > "$LOCAL/loopcheck.js" <<'JS'
const dgram = require('dgram');
const T = new Int32Array(256);
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); T[n] = c; }
function crc(b, n) { let c = -1; for (let i = 0; i < n; i++) c = T[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function mprb(seq) {
  const b = Buffer.alloc(68);
  b.writeUInt32LE(0x4D505242, 0); b.writeUInt8(1, 4); b.writeUInt8(2, 5); b.writeUInt16LE(68, 6);
  b.writeUInt32LE(seq, 8); b.writeUInt32LE(0, 12); b.writeUInt32LE(0, 16);
  b.writeUInt16LE(16000, 20); b.writeUInt8(1, 22); b.writeUInt8(3, 23);
  b.writeFloatLE(-38, 24); b.writeFloatLE(.3, 28); b.writeFloatLE(.4, 32); b.writeFloatLE(.3, 36);
  b.writeFloatLE(.05, 40); b.writeFloatLE(.02, 44); b.writeFloatLE(9.8, 48);
  b.writeUInt32LE(crc(b, 64), 64); return b;
}
const s = dgram.createSocket('udp4');
let got = 0;
s.on('message', (m) => { if (m.length === 32 && m.toString('ascii', 0, 4) === 'MPRC') got++; });
s.on('error', (e) => console.log('  socket error:', e.code));
s.bind(0, () => { for (let i = 0; i < 5; i++) s.send(mprb(900000 + i), 33335, '127.0.0.1', () => {}); });
setTimeout(() => {
  console.log(got > 0
    ? '  ✓ 大脑回环闭环 PASS：68B → stage1 → 32B MPRC（' + got + ' 包）'
    : '  ✗ 大脑回环闭环 FAIL：合法帧也没回包，看上面 brain-stage1.log');
  s.close(); process.exit(got > 0 ? 0 : 1);
}, 4000);
JS
node "$LOCAL/loopcheck.js"
RC=$?
DOWN=$(grep -o 'down=[0-9]*' "$LOCAL/brain-relay.log" 2>/dev/null | tail -1)
echo "  relay 下行转发: ${DOWN:-down=0}（板子在线时 >0 即说明 32B MPRC 已回到板子）"

echo
echo "=== 收尾 ==="
if [ "$RC" = "0" ]; then
  echo "  云端大脑已就绪，等板子下一帧即可把 rx 从 0 拉起来。"
  echo "  板端日志应出现：源=云端 tx=... rx>0 ..."
  echo
  echo "  ★ 若回环 PASS 但板子仍 rx=0，几乎可以确定是【云平台安全组】没放通："
  echo "    腾讯云轻量应用服务器控制台 → 防火墙 → 添加规则"
  echo "    协议 UDP / 端口 33333 / 来源 0.0.0.0/0（或限定热点出口 IP）"
  echo "    relay 回包走同一 socket 的临时端口，出站默认全放通，无需额外规则。"
else
  echo "  回环未通。按上面 [5/6] 的 brain-stage1.log 报错排查，最常见是连接组数据路径不对。"
fi
echo
echo "  停止：cd $LOOP && bash stop_local.sh"
echo "  看板（需要可调感官属性时，资源翻倍）："
echo "    cd $LOOP && FLY_LOCAL=$LOCAL bash stop_local.sh"
echo "    cd $LOOP && FLYLAB=$FLYLAB FLYDATA=$DATA FLY_LOCAL=$LOCAL LITE=0 WITH_DASHBOARD=1 OFFSET=0 bash start_local.sh"
exit "$RC"
