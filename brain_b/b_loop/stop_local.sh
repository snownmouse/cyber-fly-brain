#!/usr/bin/env bash
# 停止 start_local.sh 启动的进程（只按 PID 文件，不影响同机其它项目）
set -u
LOCAL="${FLY_LOCAL:-/tmp/cyber-fly-local}"
PIDFILE="$LOCAL/cyber_fly_brain.pids"
if [ ! -f "$PIDFILE" ]; then
  echo "没有找到 $PIDFILE —— 本脚本没在跑。"
  # 2026-11-11 起云端由 systemd 常驻；这时 PID 文件里没有记录，不能假装"没事"。
  if command -v systemctl >/dev/null 2>&1 &&
     systemctl is-active --quiet cyber-fly-brain 2>/dev/null; then
    echo "但 cyber-fly-brain.service 在跑。要停请用："
    echo "  systemctl stop cyber-fly-brain cyber-fly-relay cyber-fly-dashboard"
  fi
  exit 0
fi
while read -r pid; do
  [ -z "$pid" ] && continue
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null && echo "  已停止 PID=$pid"
  else
    echo "  跳过 PID=$pid（已退出）"
  fi
done < "$PIDFILE"
rm -f "$PIDFILE"
echo "本项目进程已停止；同机其它项目不受影响。"
