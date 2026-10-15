# Cyber-Fly Brain

[简体中文](README_CN.md) | English

The **cloud brain** half of Cyber-Fly: a connectome-inspired fruit-fly brain that runs on a
server and drives a real ESP32 board over UDP in a 20 Hz closed loop.

The board firmware and the hardware documentation live in the sibling repository
**[snownmouse/cyber-fly](https://github.com/snownmouse/cyber-fly)**.

![Cyber-Fly closed-loop architecture](brain_b/b_loop/cyber_fly_flow.svg)

## What this is

Cyber-Fly splits a fly across two machines:

| Biological part | Role |
| --- | --- |
| Sense organs | microphone (hearing / wind) + BMI270 IMU (proprioception) on the board |
| Brainstem / spinal cord | the ESP32 board — I/O gateway, local fast reflexes (sibling repo) |
| **Brain / connectome** | **this repository** — 38 groups, 9 regions, v4 subcircuit of 6,296 neurons |
| Motor nerves / muscles | motors, wing drive, steering on the board |

The point is the loop rather than the model: real sound and real motion go up, real motor
commands come down, 20 times a second, and every frame on the board's screen is driven by the
brain's actual output.

```
sense (board: mic + IMU)
  -> phone hotspot, UDP uplink
  -> relay
  -> connectome brain  (this repo)
  -> motor command, downlink
  -> board executes
  -> the world changes
  -> sense again
```

## Required: flywire-fly-lab

This repository is an **orchestration layer, not a connectome engine**. The engine is not
vendored. `brain_b/b_loop/stage1_loop.js` loads it at runtime:

```js
const REPO = process.env.FLYLAB || '/root/flywire-fly-lab';
const DATA_PATH = process.env.FLYDATA || path.join(REPO, 'results/dodge/subcircuit_v4.json');
const { ConnectomeBrain } = require(path.join(REPO, 'dodge/brain.js'));
```

So you need a checkout of **[suifei/flywire-fly-lab](https://github.com/suifei/flywire-fly-lab)**
(Apache-2.0) and must point `FLYLAB` at it. The datasets under that project's `results/`
directory are **CC BY-NC 4.0 (non-commercial)** and are not redistributed here — see
[NOTICE](NOTICE).

## Processes

| File | Role |
| --- | --- |
| `brain_b/b_loop/relay.js` | UDP relay hub on port **33333**; one socket forwards both directions |
| `brain_b/b_loop/stage1_loop.js` | Orchestrator: 68 B MPRB in → port drive → v4 step → readout → EMA → 32 B MPRC out. Also serves a loopback-only HTTP `/api` on 33338 |
| `brain_b/b_loop/fly_watch2.js` | Diagnostic fan-out on **33336**; computes the audio verdict (rms / jo / verdict). Pure UDP, no HTTP — it sits inside the loop |
| `brain_b/b_loop/fly_dashboard.js` | Web dashboard on **8080**: metric cards, curves, per-group activity, brain-region map, proxying `/api` |
| `brain_b/b_loop/probe_touch.js` | Fixed-point probe: drives L/R channel combinations, reads DNa01/02 and DNp01 across seeds |
| `brain_b/b_loop/patch_*.py` | Apply the design changes (dose / gate / mapvar / onset / analyze) onto the upstream stage-1 loop |

`stage1_loop.js` runs in several modes: `--replay`, `--synth`, `--serve`, `--emit-dl FILE`,
`--grid`, `--selftest`, `--emit FILE`, `--blast HOST:PORT`.

## Wire protocol

| Frame | Direction | Size | Carries |
| --- | --- | --- | --- |
| MPRB | board → cloud | 68 B | features, plus signed lateral acceleration |
| MPRC | cloud → board | 32 B | turn / motor / thrust / flags |

- **CRC-32/ISO-HDLC** (polynomial `0xEDB88320`, reflected) — bit-identical across the board's
  `fly_link.c` / `probe_common.c`, the probe server `udp_probe_server.py` and `stage1_loop.js`.
- **20 Hz** closed loop.
- Ports: 33333 relay, 33336 watch, 33338 stage-1 `/api` (loopback only), 8080 dashboard.
- The host harnesses that compile against the **board** sources now live in the firmware
  repository, under `tests/host/` (`verify_fly_link.c`, `verify_mprc.c`, `verify_hostcheck.c`).
- Steering does **not** come from the brain: in v4, `DNa01/DNa02` have no named sensory input,
  so the signed lateral acceleration is carried in the uplink frame. See
  [`brain_b/STAGE1-SENSOR-TO-BRAIN-DESIGN.md`](brain_b/STAGE1-SENSOR-TO-BRAIN-DESIGN.md) §3.

## Layout

| Path | What |
| --- | --- |
| `brain_b/` | The brain: design documents plus the `b_loop/` runtime |
| `brain_b/b_loop/` | Orchestrator, relay, watch, dashboard, probes, patch scripts, brief, diagrams |
| `brain_c/` | Presentation and data-architecture notes (dated design record) |

## Documentation

- [brain_b/STAGE1-SENSOR-TO-BRAIN-DESIGN.md](brain_b/STAGE1-SENSOR-TO-BRAIN-DESIGN.md) — sensor → brain → command design
- [brain_b/b_loop/cyber_fly_brief.md](brain_b/b_loop/cyber_fly_brief.md) — project walkthrough (中文)
- [brain_b/b_loop/cyber_fly_intro.html](brain_b/b_loop/cyber_fly_intro.html) — visual introduction
- [brain_b/FLYWIRE-FLY-LAB-EVAL.md](brain_b/FLYWIRE-FLY-LAB-EVAL.md) — why flywire-fly-lab, compared with the alternatives
- [brain_b/PROJECT-CHOICE-DECISION.md](brain_b/PROJECT-CHOICE-DECISION.md) — engine choice, and what deliberately is *not* included
- [brain_b/MB-EXTENSION-AND-CHANNEL-ARBITRATION.md](brain_b/MB-EXTENSION-AND-CHANNEL-ARBITRATION.md) — channel arbitration and the mushroom-body question
- [brain_b/TASK-B-COMPUTE-PLAN.md](brain_b/TASK-B-COMPUTE-PLAN.md) — compute plan
- [brain_b/TASK-C-HARDWARE-CHECKLIST.md](brain_b/TASK-C-HARDWARE-CHECKLIST.md) — board-side acceptance checklist

## Quick start

```bash
git clone https://github.com/snownmouse/cyber-fly-brain
git clone https://github.com/suifei/flywire-fly-lab
export FLYLAB="$PWD/flywire-fly-lab"

node brain_b/b_loop/stage1_loop.js --selftest   # MPRC/MPRB codec self-check
node brain_b/b_loop/stage1_loop.js --synth      # full chain, no network
node brain_b/b_loop/stage1_loop.js --serve      # become the cloud brain
```

In the live setup the board joins the same network and talks to `relay.js`; the dashboard then
reads the brain's state on port 8080.

## Credits and licence

Code in this repository is licensed under the **Apache License 2.0** — see [LICENSE](LICENSE).
Third-party attributions, including the non-commercial status of the upstream datasets, are in
[NOTICE](NOTICE).

The cloud side is inspired by the FlyWire consortium's *Nature* 2024 full adult fruit-fly
connectome, and by Shiu, Sterne et al., *Nature* 634:210–219 (2024) — a leaky integrate-and-fire
model that reproduces the complete sensory-to-motor transform from synaptic connectivity alone.
This project is a **functional** realisation of the same principle, not a per-neuron simulation
of all ~140,000 cells.
