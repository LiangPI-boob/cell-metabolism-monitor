# 细胞代谢监测系统 — 双 MCU 固件与网页

培养芯片（膜下小体积腔）+ 独立检测模块，主机 NanoStat（ESP32 + LMP91000）负责电化学采集与调度，从机 ESP32 负责泵/阀流体控制。

## 目录结构

```
.
├── platformio.ini          # 主机（NanoStat）PlatformIO 工程配置
├── src/
│   ├── main.cpp            # 主机固件：电化学采集 + 网页/WebSocket + 实验调度 + 从机串口
│   └── wifi_credentials.example.h
├── data/                   # 主机网页文件系统（SPIFFS），改完需 uploadfs
│   ├── panel.html          # 控制面板（实验流程 / 参数 / 状态）
│   ├── websckt_ctl_pan_LMP91000.js
│   └── ...
├── slave/
│   └── slave_firmware.ino  # 从机固件（Arduino IDE 烧录）
├── docs/                   # 设计文档与图纸
└── tools/
    └── md2docx.py
```

## 硬件与引脚

### 主机 NanoStat
| 功能 | GPIO |
|---|---|
| 从机 UART2 RX | 32 |
| 从机 UART2 TX | 33 |
| DAC | 25 |
| LED | 26 |
| LMP_C1 / LMP_C2 / ADC | 27 / 39 / 35 |
| MENB | 5 |

### 从机 ESP32
| 功能 | GPIO |
|---|---|
| 循环泵 | 25 |
| 切换阀 | 26 |
| 排废阀 | 27 |
| 主机 UART2 RX | 32 |
| 主机 UART2 TX | 33 |

### 双板连线

```
主机 GPIO32 (RX) ← 从机 GPIO33 (TX)
主机 GPIO33 (TX) → 从机 GPIO32 (RX)
GND ↔ GND
```

> 注意：不要用 GPIO16/17 做 UART2，在 NanoStat 板上会导致看门狗重启。

## 编译与烧录

### 主机（PlatformIO）

```powershell
cd D:\Nanostat
& "D:\platformio\penv\Scripts\pio.exe" run -t upload
& "D:\platformio\penv\Scripts\pio.exe" run -t uploadfs
```

### 从机（Arduino IDE）

打开 `slave/slave_firmware.ino`，开发板选 ESP32 Dev Module，安装 ArduinoJson 库后烧录。

## 访问网页

- 已连 WiFi：`http://nanostat.local/panel.html` 或 `http://<设备IP>/panel.html`
- 没有 WiFi：设备开热点 `NanoStatAP`（无密码），连上后打开 `http://192.168.4.1/panel.html`

## 首次使用

`src/wifi_credentials.h` 不参与版本管理。首次编译前：

1. 复制 `src/wifi_credentials.example.h` 为 `src/wifi_credentials.h`
2. 填入自己的 WiFi 信息（或留占位值，设备会走热点模式）

## 注意

- **不要提交** `src/wifi_credentials.h`、`data/secrets.json` 等含账号密码的文件
- `.pio/` 是构建缓存，不要提交
- 网页文件改动后必须重新执行 `uploadfs`
