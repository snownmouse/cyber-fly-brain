# Cyber-Fly 云端大脑

[English](README.md) | 简体中文

Cyber-Fly 的**云端大脑**这一半：一个受连接组启发的果蝇脑，跑在服务器上，通过 UDP 以
**20 Hz** 驱动一块真实的 ESP32 板子，构成闭环。

板端固件与硬件文档在姊妹仓库 **[snownmouse/cyber-fly](https://github.com/snownmouse/cyber-fly)**。

![cyber_fly 云端连接组闭环](brain_b/b_loop/cyber_fly_flow.svg)

## 这是什么

Cyber-Fly 把一只果蝇拆分到两台机器上：

| 真实生物结构 | 项目里的角色 |
| --- | --- |
| 感觉器官 | 板载麦克风（听觉／风感）+ BMI270 IMU（本体感觉） |
| 脑干 / 脊髓 | ESP32 板子 —— I/O 网关与本地快反射（姊妹仓库） |
| **大脑 / 连接组** | **本仓库** —— 38 神经组 / 9 功能大区，v4 子回路 **6,296 个神经元** |
| 运动神经 / 肌肉 | 板载电机、振翅、转向 |

重点是**闭环**而不是模型本身：真实的声音与真实的动作上行，真实的运动指令下行，每秒 20 次；
板子屏幕上的每一帧都由大脑的真实输出驱动。

```
感知（板端：麦克风 + IMU）
  → 手机热点，UDP 上行
  → relay 中转
  → 连接组大脑（本仓库）
  → 运动指令，下行
  → 板端执行
  → 真实环境变化
  → 再感知
```

## 前置依赖：flywire-fly-lab

本仓库是**编排层，不是连接组引擎**。引擎没有随仓库分发，`brain_b/b_loop/stage1_loop.js`
在运行时把它加载进来：

```js
const REPO = process.env.FLYLAB || '/root/flywire-fly-lab';
const DATA_PATH = process.env.FLYDATA || path.join(REPO, 'results/dodge/subcircuit_v4.json');
const { ConnectomeBrain } = require(path.join(REPO, 'dodge/brain.js'));
```

所以你需要一份 **[suifei/flywire-fly-lab](https://github.com/suifei/flywire-fly-lab)**
（Apache-2.0）的检出，并把 `FLYLAB` 指向它。该项目 `results/` 下的数据集是
**CC BY-NC 4.0（禁止商用）**，本仓库不再分发 —— 详见 [NOTICE](NOTICE)。

## 进程一览

| 文件 | 职责 |
| --- | --- |
| `brain_b/b_loop/relay.js` | UDP 中转枢纽，端口 **33333**；用同一个 socket 做双向转发 |
| `brain_b/b_loop/stage1_loop.js` | 编排层：68 B MPRB 入 → 端口驱动 → v4 推进 → 读出 → EMA → 32 B MPRC 出。另在 33338 提供仅绑回环的 HTTP `/api` |
| `brain_b/b_loop/fly_watch2.js` | 诊断转发，端口 **33336**；算音频判定（rms / jo / verdict）。纯 UDP 无 HTTP —— 它在闭环里面 |
| `brain_b/b_loop/fly_dashboard.js` | 网页看板，端口 **8080**：指标卡、曲线、38 组活跃度、脑区神经图，并代理 `/api` |
| `brain_b/b_loop/probe_touch.js` | 定点探针：驱动三通道 L/R 组合，跨种子读出 DNa01/02 与 DNp01 |
| `brain_b/b_loop/patch_*.py` | 把设计改动（dose / gate / mapvar / onset / analyze）打到上游 stage-1 循环上 |

`stage1_loop.js` 支持多种模式：`--replay`、`--synth`、`--serve`、`--emit-dl FILE`、
`--grid`、`--selftest`、`--emit FILE`、`--blast HOST:PORT`。

## 线协议

| 帧 | 方向 | 长度 | 承载 |
| --- | --- | --- | --- |
| MPRB | 板端 → 云端 | 68 B | 特征，外加带符号的侧向加速度 |
| MPRC | 云端 → 板端 | 32 B | turn / motor / thrust / flags |

- **CRC-32/ISO-HDLC**（多项式 `0xEDB88320`，反射式），与板端 `fly_link.c` / `probe_common.c`、
  探针服务端 `udp_probe_server.py` 以及 `stage1_loop.js` **逐位一致**。
- 闭环 **20 Hz**。
- 端口：33333 relay、33336 watch、33338 stage-1 `/api`（仅回环）、8080 看板。
- 那些要编译**板端**源码的 host 验证程序现在在固件仓的 `tests/host/` 下
  （`verify_fly_link.c`、`verify_mprc.c`、`verify_hostcheck.c`）。
- **转向不由脑给**：v4 里 `DNa01/DNa02` 没有任何命名感觉输入，所以方向改由上行帧里的
  带符号侧向加速度直接给出。见
  [`brain_b/STAGE1-SENSOR-TO-BRAIN-DESIGN.md`](brain_b/STAGE1-SENSOR-TO-BRAIN-DESIGN.md) §3。

## 目录

| 路径 | 内容 |
| --- | --- |
| `brain_b/` | 大脑：设计文档 + `b_loop/` 运行时 |
| `brain_b/b_loop/` | 编排层、relay、watch、看板、探针、补丁脚本、项目梳理、图 |
| `brain_c/` | 汇报与数据架构笔记（带日期的方案记录） |

## 文档

- [brain_b/STAGE1-SENSOR-TO-BRAIN-DESIGN.md](brain_b/STAGE1-SENSOR-TO-BRAIN-DESIGN.md) —— 传感器 → 大脑 → 指令设计
- [brain_b/b_loop/cyber_fly_brief.md](brain_b/b_loop/cyber_fly_brief.md) —— 项目梳理（中文）
- [brain_b/b_loop/cyber_fly_intro.html](brain_b/b_loop/cyber_fly_intro.html) —— 可视化介绍
- [brain_b/FLYWIRE-FLY-LAB-EVAL.md](brain_b/FLYWIRE-FLY-LAB-EVAL.md) —— 为什么选 flywire-fly-lab，逐项对比
- [brain_b/PROJECT-CHOICE-DECISION.md](brain_b/PROJECT-CHOICE-DECISION.md) —— 选型判断，以及**刻意不上**的东西
- [brain_b/MB-EXTENSION-AND-CHANNEL-ARBITRATION.md](brain_b/MB-EXTENSION-AND-CHANNEL-ARBITRATION.md) —— 通道仲裁与蘑菇体问题
- [brain_b/TASK-B-COMPUTE-PLAN.md](brain_b/TASK-B-COMPUTE-PLAN.md) —— 算力计划
- [brain_b/TASK-C-HARDWARE-CHECKLIST.md](brain_b/TASK-C-HARDWARE-CHECKLIST.md) —— 板端验收清单

## 快速开始

```bash
git clone https://github.com/snownmouse/cyber-fly-brain
git clone https://github.com/suifei/flywire-fly-lab
export FLYLAB="$PWD/flywire-fly-lab"

node brain_b/b_loop/stage1_loop.js --selftest   # MPRC/MPRB 编解码自检
node brain_b/b_loop/stage1_loop.js --synth      # 全链闭环，不经网络
node brain_b/b_loop/stage1_loop.js --serve      # 成为云端大脑
```

真机联调时板子加入同一网络并与 `relay.js` 通信；看板在 8080 读取大脑状态。

## 出处与许可

本仓库代码采用 **Apache License 2.0** —— 见 [LICENSE](LICENSE)。第三方署名，
包括上游数据集的非商用状态，见 [NOTICE](NOTICE)。

云端一侧受 FlyWire 联盟 *Nature* 2024 成体果蝇完整连接组、以及 Shiu, Sterne et al.,
*Nature* 634:210–219 (2024) 启发 —— 后者用泄漏积分放电（LIF）模型，仅凭突触连接
就复现了完整的感觉→运动转换。本项目是同一原理的**功能化落地**，不是 14 万神经元的
逐神经元仿真。
