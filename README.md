# 细胞代谢监测系统 — 双 MCU 固件与网页

培养芯片（膜下小体积腔）+ 独立检测模块，主机 NanoStat（ESP32 + LMP91000）负责电化学采集与调度，从机 ESP32 负责泵/阀流体控制。

## 目录结构

```
.
├── platformio.ini          # 主机（NanoStat）PlatformIO 工程配置
├── src/
│   ├── main.cpp            # 主机固件：电化学采集 + 网页/WebSocket + 实验调度 + 从机 TCP 链路
│   └── wifi_credentials.example.h
├── data/                   # 主机网页文件系统（SPIFFS），改完需 uploadfs
│   ├── index.html          # 控制台：实验流程 / 手动扫描 / 实时曲线
│   ├── setup.html          # 扫描参数（按模式折叠）
│   ├── system.html         # 系统：文件 / WiFi / 固件 / 重启
│   ├── help.html           # 帮助与关于
│   └── assets/             # app.css、app.js（唯一 WebSocket）、console.js、system.js、uplot.min.js/.css（本地图表库）
├── slave/
│   └── slave_firmware/     # 从机 sketch（Arduino IDE 打开此文件夹）
│       ├── slave_firmware.ino
│       └── wifi_secrets.example.h
├── docs/                   # 设计文档（方案 / 需求 / 硬件 / 进度 / 汇报）
├── hardware/               # 硬件资产，与固件编译无关
│   ├── pcb/                # Gerber、BOM、贴片坐标、原理图（按版本 3.5.0 / 3.5.1 / 3.5.4）
│   ├── case/               # 外壳 STL 与 Fusion 360 源文件（带电池 / 不带电池）
│   └── drawings/           # 加工图与管路图（SVG）
├── tools/
│   └── md2docx.py
└── .trae/specs/            # 本次 Wi-Fi 链路改造的规格、任务与验收清单
```

## 文档索引

| 分类 | 文档 | 内容 |
|---|---|---|
| 方案 | [芯片设计说明书.md](docs/芯片设计说明书.md) | 系统方案、芯片/检测模块参数、测量协议 |
| 方案 | [开发方案.md](docs/开发方案.md) | 从机详细设计（硬件/固件/协议/测试/采购） |
| 方案 | [软件需求说明书.md](docs/软件需求说明书.md) | 软件需求，第四章为对硬件的接口要求 |
| 方案 | [实验创新性分析报告.md](docs/实验创新性分析报告.md) | 系统级创新点论证 |
| 方案 | [网页优化方案.md](docs/网页优化方案.md) | 网页结构合并、风格统一与格式规范 |
| 开发 | [主从WiFi通信开发文档.md](docs/主从WiFi通信开发文档.md) | 主机↔从机 Wi-Fi TCP 链路：协议、改造点、测试计划 |
| 硬件 | [硬件交接单.md](docs/硬件交接单.md) | GPIO 分配、接线规范、单件测试、安全约束 |
| 硬件 | [hardware/drawings/](hardware/drawings/) | 下腔替代件加工图、流体管路连接图、芯片设计图 |
| 进度 | [项目进度总结.md](docs/项目进度总结.md) | 进度、经验教训、待办 |
| 汇报 | [PPT大纲.md](docs/PPT大纲.md) | 汇报提纲 |

## 硬件与引脚

### 主机 NanoStat
| 功能 | GPIO |
|---|---|
| DAC | 25 |
| LED | 26 |
| LMP_C1 / LMP_C2 / ADC | 27 / 39 / 35 |
| MENB | 5 |

> 板间链路走 Wi-Fi，不占用主机 GPIO（NanoStat 主机 PCB 未引出 UART/GPIO 排针）。

### 从机 ESP32
| 功能 | GPIO |
|---|---|
| 循环泵 | 25 |
| 切换阀 | 26 |
| 排废阀 | 27 |

> 板间链路走 Wi-Fi（STA），不占用从机 GPIO；`GPIO1/3` 保留为 USB 调试串口。

### 板间链路（Wi-Fi）

```
主机 NanoStat：WIFI_AP_STA，常开 SoftAP「NanoStatAP」（密码宏 AP_PASSWORD）
               TCP Server 监听 192.168.4.1:3333
从机 ESP32：  STA 连接 NanoStatAP → TCP Client 连接 192.168.4.1:3333
应用层：      JSON 行协议不变（一行一个 JSON，\n 结尾，单行 ≤512 B）
鉴权：        hello 事件携带 fw / channels / key，key 必须等于 SLAVE_LINK_KEY
心跳：        主机每 5 s 发 ping；从机 120 s 无消息进安全态；主机 20 s 无消息判离线
```

> 主机只允许 1 个从机客户端接入；从机离线时主机拒绝启动实验并广播 `{"exp_error":"slave_offline"}`。

凭据文件（均不入库）：

- 主机 `src/wifi_credentials.h`：SSID / PASSWORD / AP_PASSWORD / SLAVE_LINK_KEY
- 从机 `slave/slave_firmware/wifi_secrets.h`：SLAVE_WIFI_SSID / SLAVE_WIFI_PASS / SLAVE_LINK_KEY

两个文件分别由同目录的 `.example.h` 示例复制而来，`SLAVE_LINK_KEY` 两端必须一致。

## 编译与烧录

### 主机（PlatformIO）

```powershell
cd D:\Nanostat
& "D:\platformio\penv\Scripts\pio.exe" run -t upload
& "D:\platformio\penv\Scripts\pio.exe" run -t uploadfs
```

### 从机（Arduino IDE）

打开 `slave/slave_firmware/slave_firmware.ino`，开发板选 ESP32 Dev Module，安装 ArduinoJson 库后烧录。

## 访问网页

设备工作在 `WIFI_AP_STA`，两种访问方式功能完全一致，**都不需要外网**：

| 模式 | 地址 | 说明 |
|---|---|---|
| 热点直连 | `http://192.168.4.1/`（或 `http://192.168.4.1/setup.html` 等） | 电脑/手机连 `NanoStatAP`（密码见 `AP_PASSWORD`），适合无路由器场景 |
| 路由模式 | `http://nanostat.local/` 或路由器分配的 IP | 设备已连路由器（SSID 见 `src/wifi_credentials.h`），加载更快 |

- 图表库 uPlot 随网页一起烧进 SPIFFS，不再引用任何 CDN；
- 每页导航下方有一条提示条，显示当前是「热点直连」还是「路由模式」，并给出另一种访问地址，数据来自固件 `/netinfo`；
- 详细说明见「帮助 → 网络与访问方式」（`help.html#network`）。

## 首次使用

`src/wifi_credentials.h` 与 `slave/slave_firmware/wifi_secrets.h` 不参与版本管理。首次编译前：

1. 复制 `src/wifi_credentials.example.h` 为 `src/wifi_credentials.h`
2. 填入自己的 WiFi 信息与 `AP_PASSWORD` / `SLAVE_LINK_KEY`（未定义或缺文件时编译会直接报错并提示）
3. 复制 `slave/slave_firmware/wifi_secrets.example.h` 为 `slave/slave_firmware/wifi_secrets.h`
4. 填入从机的 `SLAVE_WIFI_SSID`（默认 `NanoStatAP`）/ `SLAVE_WIFI_PASS` / `SLAVE_LINK_KEY`，`SLAVE_LINK_KEY` 必须与主机一致

## 注意

- **不要提交** `src/wifi_credentials.h`、`slave/slave_firmware/wifi_secrets.h`、`data/secrets.json` 等含账号密码的文件
- `.pio/` 是构建缓存，不要提交
- 网页文件改动后必须重新执行 `uploadfs`
