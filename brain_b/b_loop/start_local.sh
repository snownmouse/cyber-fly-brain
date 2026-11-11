#!/usr/bin/env bash
# Cyber-Fly 大脑 · 云端共存一键启动（Linux / 那台还挂着别的项目的云服务器）
#
# 默认就是轻量档：只跑 relay + stage1 两个进程，不开 --api（关掉 250 ms 影子脑）、
# 不开诊断与看板、日志减半，尽量少占 CPU/内存，跟同机 2~3 个其它项目和平共处。
#
# 用法：
#   bash start_local.sh                       # 轻量档，端口 33333/33335/33336
#   OFFSET=1000 bash start_local.sh           # 整套端口 +1000，避开别的项目
#   WITH_DASHBOARD=1 bash start_local.sh      # 附带诊断 + 8080 看板（自动开脑侧 --api，看完可切回）
#   LITE=1 WITH_DASHBOARD=1 bash start_local.sh  # 看板 + 仍是轻量档（轮询 1 s、不开影子脑全量日志）
#   FLY_SENSE_GAIN=0 bash start_local.sh      # 一键退回纯原链路
#   bash stop_local.sh                        # 停掉本脚本启动的全部进程（不影响别的项目）
#
# 注：只 kill 写进 PID 文件的进程，绝不用 pkill node —— 那会误杀同机其它项目。

set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL="${FLY_LOCAL:-/tmp/cyber-fly-local}"
mkdir -p "$LOCAL"

OFFSET="${OFFSET:-0}"
LITE="${LITE:-1}"
WITH_DASHBOARD="${WITH_DASHBOARD:-0}"
FLY_SENSE_GAIN="${FLY_SENSE_GAIN:-0.18}"

IN_PORT=$((33333 + OFFSET))
BRAIN_PORT=$((33335 + OFFSET))
WATCH_PORT=$((33336 + OFFSET))
API_PORT=$((33338 + OFFSET))
WATCH_HTTP=$((33340 + OFFSET))
DASH_HTTP=$((8080 + OFFSET))

REPO="${FLYLAB:-/root/flywire-fly-lab}"
DATA="${FLYDATA:-$REPO/results/dodge/subcircuit_v4.json}"

if [ ! -f "$REPO/dodge/brain.js" ]; then
  echo "[缺文件] 找不到 $REPO/dodge/brain.js"; exit 1
fi
if [ ! -f "$DATA" ]; then
  echo "[缺数据] 找不到连接组 $DATA"
  echo "  flywire-fly-lab 是运行时依赖（非 vendored，results/ 为 CC BY-NC 4.0），"
  echo "  请在服务器上保留一份，或用 FLYDATA=... 指定路径。"; exit 1
fi

PIDFILE="$LOCAL/cyber_fly_brain.pids"
if [ -f "$PIDFILE" ]; then
  echo "[已运行] 检测到 $PIDFILE，请先跑 bash stop_local.sh"; exit 1
fi

# 2026-11-11：云端已改成 systemd 常驻（cyber-fly-brain/relay/dashboard）。
# 若服务还在跑，再从这里起一份会抢 33333/33335/8080 → 端口占用、行为看着像"随机丢帧"。
# 所以先挡一道，并说清楚该用哪个命令。
if command -v systemctl >/dev/null 2>&1 &&
   systemctl is-active --quiet cyber-fly-brain 2>/dev/null; then
  echo "[冲突] cyber-fly-brain.service 正在常驻运行。"
  echo "  启停请用：systemctl {start|stop|restart} cyber-fly-brain cyber-fly-relay cyber-fly-dashboard"
  echo "  看日志：  journalctl -u cyber-fly-brain -f   （或 tail $LOCAL/brain-brain.log）"
  echo "  确实要用本脚本临时起一套：先 systemctl stop cyber-fly-brain cyber-fly-relay cyber-fly-dashboard"
  exit 1
fi

export FLYLAB="$REPO"
export FLYDATA="$DATA"
export FLY_IN_PORT="$IN_PORT"
export FLY_BRAIN_PORT="$BRAIN_PORT"
export FLY_WATCH_PORT="$WATCH_PORT"
export FLY_WATCH_HTTP="$WATCH_HTTP"
export FLY_BRAIN_API="http://127.0.0.1:$API_PORT/api"
export FLY_DIAG_API="http://127.0.0.1:$WATCH_HTTP/api"
export FLY_DASH_HTTP="$DASH_HTTP"
export FLY_SENSE_GAIN
# 感官直连：默认打开。这是「温湿度/嗅觉/照度真的进脑区」的唯一开关，
# 之前这里没 export → 代码里 pickSensePorts 永远返回空 → 数据只贡献了一个
# arousal 标量，THERMO/HYGRO/OLFA/视叶组始终 0 Hz。设 0 可退回纯调制模式。
export FLY_SENSE_PORT="${FLY_SENSE_PORT:-1}"
export FLY_SENSE_STALE_MS="${FLY_SENSE_STALE_MS:-2500}"
export FLY_DASH_POLL_MS=300

# 看板页面要读脑侧 /api；以前只有 LITE=0 才开 --api，导致 LITE=1 起看板时
# 页面会一直显示「脑侧未连上」。现在只要 WITH_DASHBOARD=1 就开 API 与感官调参。
# 代价：多一个 250 ms 影子脑；看完页面用 bash stop_local.sh 再按默认档重启即可降回去。
if [ "$WITH_DASHBOARD" = "1" ] || [ "$LITE" != "1" ]; then
  API_ARG="$API_PORT"; export FLY_SENSE_TUNE=1
else
  API_ARG=0; export FLY_SENSE_TUNE=0
fi
[ "$LITE" = "1" ] && export FLY_DASH_POLL_MS=1000

start_one () {
  local name="$1" script="$2"; shift 2
  nohup node "$DIR/$script" "$@" > "$LOCAL/brain-$name.log" 2>&1 &
  local pid=$!
  echo "$pid" >> "$PIDFILE"
  echo "  启动 $name PID=$pid  $*"
}

echo "=== Cyber-Fly 大脑 · 云端共存档 ==="
echo "  连接组  $DATA"
echo "  端口    IN=$IN_PORT BRAIN=$BRAIN_PORT WATCH=$WATCH_PORT API=$API_ARG DASH=$DASH_HTTP"
echo "  档位    LITE=$LITE WITH_DASHBOARD=$WITH_DASHBOARD GAIN=$FLY_SENSE_GAIN"

start_one relay relay.js
if [ "$API_ARG" = "0" ]; then
  start_one stage1 stage1_loop.js --serve --port "$BRAIN_PORT" --api 0 --quiet
else
  start_one stage1 stage1_loop.js --serve --port "$BRAIN_PORT" --api "$API_ARG" --quiet
fi

if [ "$WITH_DASHBOARD" = "1" ]; then
  start_one watch2 fly_watch2.js
  start_one dashboard fly_dashboard.js
  echo "  看板    http://127.0.0.1:$DASH_HTTP/"
fi

echo ""
echo "  板端 HOST 填本机可达 IPv4，PORT=$IN_PORT"
echo "  日志 $LOCAL/brain-*.log ｜ 停止 bash stop_local.sh"
echo "  轻量档 = 2 进程、无影子脑、无 HTTP，CPU 主要只有 20 Hz 主脑步。"
