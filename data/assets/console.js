/* =====================================================================
   控制台：实验流程 + 手动扫描 + 实时曲线
   依赖：assets/app.js（唯一 WebSocket 连接）
   消息来源：固件 expBroadcastState()/CTLPANEL 循环/sendVoltammogramWebsocketBIN()
   ===================================================================== */
(function () {
  "use strict";

  const $ = NS.$;
  const $$ = NS.$$;

  const EXP_STATE_LABEL = {
    IDLE: "空闲",
    CIRCULATE: "循环均质",
    STOP_FLOW: "停流平衡",
    MEASURE: "测量中",
    CALIBRATE: "校准中",
  };

  // 固件 expBroadcastState() 的 next_action 取值
  const NEXT_ACTION_LABEL = {
    pump_stop: "停止循环泵",
    valve_close: "关闭阀门",
    measure: "开始静测",
    measuring: "静测采集",
    pump_start: "启动循环泵",
    calib_flush: "校准：开阀冲洗/排废",
    calib_wait: "校准：关阀静置",
  };

  const SWEEP_LABEL = {
    CV: "CV 循环伏安",
    NPV: "NPV 常规脉冲",
    DPV: "DPV 差分脉冲",
    SWV: "SWV 方波伏安",
    CA: "CA 计时电流",
    DC: "DC 直流偏置",
    IV: "IV 曲线",
    CAL: "Cal 校准",
    MISC: "Misc 调试",
  };

  const state = {
    live: { t0: 0, t: [], v: [], i: [] },
    sweep: { t: [], v: [], i: [] },
    binSeq: 0,
    binAmps: null,
    binVolts: null,
    sweeping: false,
    drawPending: false,
    exp: { deadline: 0, action: "", auto: false, mode: "idle", pending: true, pendingPct: null },
  };

  /* ---------- 图表（uPlot，随固件一起下发，离线可用） ---------- */
  const hasChart = typeof window.uPlot !== "undefined";
  const CHART_FONT =
    '11px system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';

  const charts = {
    it: { el: null, plot: null },
    iv: { el: null, plot: null },
  };

  const COMMON_OPTS = {
    legend: { show: false },
    cursor: { drag: { x: true, y: false } },
    padding: [8, 8, 0, 0],
    scales: {
      x: { time: false, auto: true },
      y: { auto: true },
      v: { auto: true },
    },
  };

  // side: 0 上 / 1 右 / 2 下 / 3 左
  function axisOpts(label, scale, side) {
    return {
      label: label,
      scale: scale,
      side: side,
      font: CHART_FONT,
      labelFont: CHART_FONT,
      labelSize: 20,
      stroke: "#6b7280",
      grid: { stroke: "#eef1f5", width: 1 },
      ticks: { stroke: "#e4e8ee", width: 1, size: 5 },
      gap: 6,
    };
  }

  function seriesCurrent() {
    return {
      label: "电流 (µA)",
      scale: "y",
      stroke: "#2563eb",
      width: 1.5,
      // uPlot 的 points.show 必须是函数；点数过多时隐藏标记
      points: {
        show: function (u) {
          return !u || !u.data || u.data[0].length <= 300;
        },
        size: 4,
        width: 0,
        fill: "#2563eb",
      },
      value: function (u, v) {
        return v == null ? "--" : v.toFixed(3);
      },
    };
  }

  function seriesVoltage() {
    return {
      label: "电压 (mV)",
      scale: "v",
      stroke: "#d97706",
      width: 1,
      dash: [4, 3],
      points: { show: function () { return false; } },
      value: function (u, v) {
        return v == null ? "--" : v.toFixed(0);
      },
    };
  }

  function plotOpts(kind) {
    const opts = Object.assign({}, COMMON_OPTS);
    if (kind === "iv") {
      opts.series = [{}, seriesCurrent()];
      opts.axes = [
        axisOpts("电压 (mV)", "x", 2),
        axisOpts("电流 (µA)", "y", 3),
      ];
    } else {
      opts.series = [{}, seriesCurrent(), seriesVoltage()];
      opts.axes = [
        axisOpts("时间 (s)", "x", 2),
        axisOpts("电流 (µA)", "y", 3),
        axisOpts("电压 (mV)", "v", 1),
      ];
    }
    return opts;
  }

  function nulls(n) {
    const arr = new Array(n);
    for (let i = 0; i < n; i++) arr[i] = null;
    return arr;
  }

  function renderChart(kind, data) {
    if (!hasChart) return;
    const slot = charts[kind];
    if (!slot.el) slot.el = document.getElementById("chart-" + kind);
    if (!slot.el) return;

    const width = slot.el.clientWidth;
    const height = slot.el.clientHeight;
    // Tab 隐藏时宽度为 0，跳过绘制；切回该 Tab 或窗口缩放时会重画
    if (!width || !height) return;

    if (!slot.plot) {
      const opts = plotOpts(kind);
      opts.width = width;
      opts.height = height;
      slot.plot = new uPlot(opts, data, slot.el);
      return;
    }

    if (slot.plot.width !== width || slot.plot.height !== height) {
      slot.plot.setSize({ width: width, height: height });
    }
    slot.plot.setData(data);
  }

  function drawIV(volts, amps) {
    renderChart("iv", [volts || [], amps || []]);
  }

  function drawIT(times, amps, volts) {
    const t = times || [];
    const v = volts && volts.length ? volts : nulls(t.length);
    renderChart("it", [t, amps || [], v]);
  }

  function refreshCharts() {
    if (state.sweep.t.length) {
      drawIV(state.sweep.v, state.sweep.i);
      drawIT(state.sweep.t, state.sweep.i, null);
    } else if (state.live.t.length) {
      drawIT(state.live.t, state.live.i, state.live.v);
    }
  }

  /* ---------- 状态显示 ---------- */
  function setBadge(el, text, kind) {
    if (!el) return;
    el.textContent = text;
    el.className = "badge" + (kind ? " badge--" + kind : "");
  }

  function setDevice(dotId, stateId, rowId, on, onText, offText, offline) {
    const dot = document.getElementById(dotId);
    const label = document.getElementById(stateId);
    const row = document.getElementById(rowId);
    if (dot) {
      dot.classList.toggle("is-on", !!on && !offline);
      dot.classList.toggle("is-off", !!offline);
    }
    if (label) label.textContent = offline ? "离线" : on ? onText : offText;
    if (row) row.classList.toggle("is-offline", !!offline);
  }

  function formatDuration(ms) {
    if (!ms || ms <= 0) return "--";
    const total = Math.floor(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return h > 0 ? h + ":" + pad(m) + ":" + pad(s) : pad(m) + ":" + pad(s);
  }

  // 倒计时用：到 0 显示 00:00（向上取整，最后一秒不会提前归零）
  function formatCountdown(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return h > 0 ? h + ":" + pad(m) + ":" + pad(s) : pad(m) + ":" + pad(s);
  }

  function tickCountdown() {
    const actEl = $("#next-action");
    const inEl = $("#next-in");
    if (!actEl || !inEl) return;
    if (state.exp.mode === "offline") {
      actEl.textContent = "从机离线";
      inEl.textContent = "";
      return;
    }
    if (!state.exp.auto) {
      actEl.textContent = state.exp.mode === "manual" ? "手动控制（需重新启动实验）" : "--";
      inEl.textContent = "";
      return;
    }
    actEl.textContent = state.exp.action || "--";
    if (!state.exp.pending) {
      inEl.textContent = "进行中";
      return;
    }
    inEl.textContent = formatCountdown(state.exp.deadline - Date.now());
  }

  function showMsg(text, kind) {
    const el = $("#exp-msg");
    if (!el) return;
    el.textContent = text || "";
    el.className = "hint" + (kind ? " hint--" + kind : "") + (text ? "" : " hidden");
  }

  function syncInput(id, value) {
    const el = document.getElementById(id);
    if (!el || document.activeElement === el) return;
    if (value !== undefined && String(el.value) !== String(value)) el.value = value;
  }

  function renderExpState(msg) {
    const label = EXP_STATE_LABEL[msg.exp_state] || msg.exp_state || "--";
    const stateEl = $("#exp-state");
    if (stateEl) stateEl.textContent = label;
    const cycleEl = $("#exp-cycle");
    if (cycleEl) cycleEl.textContent = msg.exp_cycle === undefined ? "0" : msg.exp_cycle;
    const calibEl = $("#calib-left");
    if (calibEl) calibEl.textContent = formatDuration(msg.calib_in_ms);

    const online = msg.slave_link === "online";
    setDevice("pump-dot", "pump-state", "row-pump", msg.pump_on, "运行", "停止", !online);
    setDevice("valve0-dot", "valve0-state", "row-valve0", msg.valve0, "开启", "关闭", !online);
    setDevice("valve1-dot", "valve1-state", "row-valve1", msg.valve1, "开启", "关闭", !online);
    setBadge($("#slave-badge"), online ? "从机在线" : "从机离线", online ? "on" : "off");

    // 下一动作倒计时：以固件剩余毫秒为基准，页面本地按秒递减
    // 从机离线时不显示倒计时（此时动作无法执行，显示会误导）
    state.exp.mode = online ? (msg.mode || "idle") : "offline";
    state.exp.auto = state.exp.mode === "auto";
    state.exp.action = NEXT_ACTION_LABEL[msg.next_action] || "";
    state.exp.pending = msg.next_action !== "measuring";
    state.exp.deadline = state.exp.auto ? Date.now() + (Number(msg.next_in_ms) || 0) : 0;
    tickCountdown();

    syncInput("exp-circulate-min", msg.circulate_min);
    syncInput("exp-stopflow-min", msg.stopflow_min);
    syncInput("exp-valve-s", msg.valve_open_s);
    syncInput("exp-calib-interval-h", msg.calib_interval_h);
    syncInput("exp-calib-min", msg.calib_min);
    syncInput("conc-slope", msg.calib_slope);
    syncInput("conc-intercept", msg.calib_intercept);

    if ("last_current_ua" in msg) {
      const currentEl = $("#last-current");
      if (currentEl) currentEl.textContent = NS.fmt(msg.last_current_ua, 4) + " µA";
    }
    if ("conc_valid" in msg) {
      const concEl = $("#last-conc");
      if (concEl) concEl.textContent = msg.conc_valid ? NS.fmt(msg.last_conc, 4) + " mM" : "--";
    }
    if ("time_synced" in msg) {
      const tsEl = $("#time-sync");
      if (tsEl) {
        tsEl.textContent = msg.time_synced ? "已对时（绝对时间戳可用）" : "未对时（仅相对时间）";
      }
    }

    const faultEl = $("#exp-fault");
    if (faultEl) {
      if (msg.exp_fault) {
        faultEl.textContent = "实验故障：" + (msg.exp_fault_code || "UNKNOWN");
        faultEl.classList.remove("hidden");
      } else {
        faultEl.textContent = "";
        faultEl.classList.add("hidden");
      }
    }

    // 占空比滑块：本地刚改过的值以固件回显为准，避免旧广播把滑块拉回去
    const pctEl = document.getElementById("exp-pump-pct");
    if (pctEl) {
      if (msg.pump_pct !== undefined) {
        if (state.exp.pendingPct !== null && Number(msg.pump_pct) === state.exp.pendingPct) {
          state.exp.pendingPct = null;
        }
        if (state.exp.pendingPct === null) syncInput("exp-pump-pct", msg.pump_pct);
      }
      const pctVal = document.getElementById("exp-pump-pct-val");
      if (pctVal) pctVal.textContent = pctEl.value + " %";
    }

    const startBtn = $("#btn-start-exp");
    const stopBtn = $("#btn-stop-exp");
    if (startBtn) startBtn.disabled = msg.exp_state !== "IDLE" || !online;
    if (stopBtn) stopBtn.disabled = msg.exp_state === "IDLE";

    // 手动按钮：离线全禁用；已处于目标状态的一侧禁用
    const manualEnabled = {
      "btn-pump-on": !msg.pump_on,
      "btn-pump-off": !!msg.pump_on,
      "btn-valve0-on": !msg.valve0,
      "btn-valve0-off": !!msg.valve0,
      "btn-valve1-on": !msg.valve1,
      "btn-valve1-off": !!msg.valve1,
    };
    Object.keys(manualEnabled).forEach(function (id) {
      const el = document.getElementById(id);
      if (el) el.disabled = !online || !manualEnabled[id];
    });
  }

  function renderRealtime(msg) {
    if ("percentage" in msg) {
      const el = $("#percentage");
      if (el) el.textContent = msg.percentage + " %";
    }
    if ("dacVout" in msg) {
      const el = $("#dac-vout");
      if (el) el.textContent = NS.fmt(msg.dacVout, 0) + " mV";
    }
    if ("analog_read_avg_bits" in msg) {
      const el = $("#adc-bits");
      if (el) el.textContent = NS.fmt(msg.analog_read_avg_bits, 1);
    }
    if ("analog_read_avg_mV" in msg) {
      const el = $("#adc-mv");
      if (el) el.textContent = NS.fmt(msg.analog_read_avg_mV, 2) + " mV";
    }

    if (!("amps" in msg) || !("time" in msg)) return;

    if (!state.live.t0) state.live.t0 = Number(msg.time);
    state.live.t.push((Number(msg.time) - state.live.t0) / 1000);
    state.live.i.push(Number(msg.amps));
    state.live.v.push(Number(msg.volts));

    trimLive();
    updateStats();
    scheduleLiveDraw();
  }

  function maxPoints() {
    const el = $("#max-points");
    const v = el ? parseInt(el.value, 10) : 100;
    return isFinite(v) && v > 0 ? v : 100;
  }

  function trimLive() {
    const limit = maxPoints();
    ["t", "v", "i"].forEach((key) => {
      const arr = state.live[key];
      if (arr.length > limit) arr.splice(0, arr.length - limit);
      if (key === "t" && arr.length === 0) state.live.t0 = 0;
    });
  }

  function updateStats() {
    const arr = state.live.i;
    if (!arr.length) return;
    let sum = 0;
    for (let i = 0; i < arr.length; i++) sum += arr[i];
    const avg = sum / arr.length;
    let sq = 0;
    for (let i = 0; i < arr.length; i++) sq += (arr[i] - avg) * (arr[i] - avg);

    const avgEl = $("#avg-current");
    if (avgEl) avgEl.textContent = NS.fmt(avg, 3) + " µA";
    const stdEl = $("#std-current");
    if (stdEl) stdEl.textContent = NS.fmt(Math.sqrt(sq / arr.length), 3) + " µA";
    const countEl = $("#point-count");
    if (countEl) countEl.textContent = String(arr.length);
  }

  function scheduleLiveDraw() {
    if (state.drawPending) return;
    state.drawPending = true;
    setTimeout(function () {
      state.drawPending = false;
      drawIT(state.live.t, state.live.i, state.live.v);
    }, 250);
  }

  /* ---------- 扫描结果 ---------- */
  function applySweepResult(times, volts, amps) {
    state.sweep.t = times;
    state.sweep.v = volts;
    state.sweep.i = amps;
    drawIV(volts, amps);
    drawIT(times, amps, null);
    const countEl = $("#point-count");
    if (countEl) countEl.textContent = String(amps.length);
    showMsg("扫描完成，共 " + amps.length + " 个点，可保存或下载数据。");

    const ivTab = document.querySelector('[data-tab="iv"]');
    if (ivTab) ivTab.click();
  }

  function handleBinary(buffer) {
    state.binSeq += 1;
    if (state.binSeq === 1) {
      state.binAmps = Array.from(new Float32Array(buffer));
      return;
    }
    if (state.binSeq === 2) {
      state.binVolts = Array.from(new Int16Array(buffer));
      return;
    }
    const times = Array.from(new Int32Array(buffer)).map((ms) => ms / 1000);
    if (state.binAmps && state.binVolts) {
      applySweepResult(times, state.binVolts, state.binAmps);
    }
    state.binSeq = 0;
    state.binAmps = null;
    state.binVolts = null;
  }

  /* ---------- 绑定 ---------- */
  function bindSweepButtons() {
    $$("[data-sweep]").forEach((btn) => {
      btn.addEventListener("click", async function () {
        const endpoint = btn.dataset.endpoint;
        btn.disabled = true;
        try {
          const response = await fetch("/" + endpoint, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ on: true }),
          });
          if (!response.ok) throw new Error("HTTP " + response.status);
          showMsg("已触发 " + (SWEEP_LABEL[btn.dataset.mode] || btn.dataset.mode) + " 扫描。");
        } catch (err) {
          showMsg("触发扫描失败：" + err.message, "danger");
        } finally {
          setTimeout(function () {
            btn.disabled = false;
          }, 800);
        }
      });
    });
  }

  function bindRuntimeParams() {
    const gain = $("#lmp-gain");
    if (gain) {
      gain.addEventListener("change", function () {
        NS.send({ change_lmpGain_to: Number(gain.value) });
      });
    }

    const voltage = $("#cell-voltage");
    if (voltage) {
      voltage.addEventListener("change", function () {
        NS.send({ change_cell_voltage_to: Number(voltage.value) });
      });
    }

    const readings = $("#num-readings");
    if (readings) {
      readings.addEventListener("change", function () {
        NS.send({ change_num_readings_to_average_per_point_to: Number(readings.value) });
      });
    }

    const delay = $("#delay-ms");
    if (delay) {
      delay.addEventListener("change", function () {
        NS.send({ change_delay_between_points_ms_to: Number(delay.value) });
      });
    }

    const maxEl = $("#max-points");
    if (maxEl) {
      maxEl.addEventListener("change", function () {
        trimLive();
        updateStats();
      });
    }

    $$('[name="monitor-active"]').forEach((radio) => {
      radio.addEventListener("change", function () {
        if (!radio.checked) return;
        const active = radio.value === "true";
        if (active) {
          if (gain) NS.send({ change_lmpGain_to: Number(gain.value) });
          if (voltage) NS.send({ change_cell_voltage_to: Number(voltage.value) });
          if (readings) {
            NS.send({ change_num_readings_to_average_per_point_to: Number(readings.value) });
          }
          if (delay) NS.send({ change_delay_between_points_ms_to: Number(delay.value) });
        }
        NS.send({ change_control_panel_is_active_to: active });
        showMsg(active ? "实时监测已启用。" : "实时监测已停用。");
      });
    });
  }

  function bindExpControls() {
    const startBtn = $("#btn-start-exp");
    if (startBtn) {
      startBtn.addEventListener("click", function () {
        if (NS.send({ start_experiment: true })) {
          showMsg("启动指令已发送，等待从机响应。");
        } else {
          showMsg("WebSocket 未连接，无法启动实验。", "danger");
        }
      });
    }

    const stopBtn = $("#btn-stop-exp");
    if (stopBtn) {
      stopBtn.addEventListener("click", function () {
        NS.send({ stop_experiment: true });
        showMsg("停止指令已发送。");
      });
    }

    const map = {
      "exp-circulate-min": "change_exp_circulate_min",
      "exp-stopflow-min": "change_exp_stopflow_min",
      "exp-valve-s": "change_exp_valve_s",
      "exp-calib-interval-h": "change_exp_calib_interval_h",
      "exp-calib-min": "change_exp_calib_min",
      "conc-slope": "change_conc_slope",
      "conc-intercept": "change_conc_intercept",
    };
    Object.keys(map).forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener("change", function () {
        const payload = {};
        payload[map[id]] = Number(el.value);
        NS.send(payload);
      });
    });

    // 泵 PWM 占空比：拖动即时更新读数，松手后下发
    const pct = $("#exp-pump-pct");
    if (pct) {
      pct.addEventListener("input", function () {
        const pctVal = $("#exp-pump-pct-val");
        if (pctVal) pctVal.textContent = pct.value + " %";
      });
      pct.addEventListener("change", function () {
        const v = Number(pct.value);
        state.exp.pendingPct = v;
        if (!NS.send({ change_exp_pump_pct: v })) {
          state.exp.pendingPct = null;
          showMsg("WebSocket 未连接，占空比未下发。", "danger");
        }
      });
    }

    // 手动控制：任一动作都会让固件退出自动流程
    const manualMap = {
      "btn-pump-on": { manual_pump: true },
      "btn-pump-off": { manual_pump: false },
      "btn-valve0-on": { manual_valve0: true },
      "btn-valve0-off": { manual_valve0: false },
      "btn-valve1-on": { manual_valve1: true },
      "btn-valve1-off": { manual_valve1: false },
    };
    Object.keys(manualMap).forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener("click", function () {
        if (!NS.send(manualMap[id])) {
          showMsg("WebSocket 未连接，无法手动控制。", "danger");
          return;
        }
        showMsg("已切换到手动控制，自动流程已停止；恢复自动请重新点击「启动实验」。", "warn");
      });
    });
  }

  function bindDataActions() {
    const saveBtn = $("#btn-save");
    if (saveBtn) {
      saveBtn.addEventListener("click", function () {
        const source = state.sweep.t.length ? state.sweep : state.live;
        if (!source.t.length) {
          showMsg("暂无数据可保存。", "warn");
          return;
        }
        const lines = ["Time(s),Current(uA),Voltage(mV)"];
        for (let i = 0; i < source.t.length; i++) {
          lines.push([NS.fmt(source.t[i], 3), NS.fmt(source.i[i], 4), NS.fmt(source.v[i], 1)].join(","));
        }
        NS.downloadText(lines.join("\n"), "nanostat-data.csv");
      });
    }
  }

  function bindTabs() {
    NS.$$("[data-tabs]").forEach(function (group) {
      group.addEventListener("tab:change", function () {
        // 等浏览器完成布局，拿到新面板的真实宽度后再画
        setTimeout(refreshCharts, 30);
      });
    });

    let timer = null;
    window.addEventListener("resize", function () {
      clearTimeout(timer);
      timer = setTimeout(refreshCharts, 150);
    });
  }

  /* ---------- 本地演示（index.html?demo=1） ---------- */
  function startDemo() {
    const t0 = Date.now();
    setInterval(function () {
      const elapsed = (Date.now() - t0) / 1000;
      const slot = Math.floor(elapsed) % 60;
      let expState;
      if (slot < 25) expState = "CIRCULATE";
      else if (slot < 40) expState = "STOP_FLOW";
      else if (slot < 47) expState = "MEASURE";
      else expState = "CIRCULATE";

      const fault = slot >= 52 && slot < 56;
      if (fault) expState = "IDLE";

      const current = 12.0 + 0.8 * Math.sin(elapsed / 6) + (Math.random() - 0.5) * 0.12;
      const conc = (current - 1.0) / 2.4;

      NS.emit("json", {
        exp_state: expState,
        mode: expState === "IDLE" ? "idle" : "auto",
        next_action: expState === "CIRCULATE" ? "pump_stop"
          : expState === "STOP_FLOW" ? "measure"
          : expState === "MEASURE" ? "measuring" : "none",
        next_in_ms: expState === "MEASURE"
          ? 0
          : 30000 - Math.floor(elapsed * 1000) % 30000,
        exp_cycle: 1 + Math.floor(elapsed / 60),
        calib_in_ms: Math.max(0, 600000 - (elapsed * 1000) % 600000),
        pump_on: expState === "CIRCULATE",
        valve0: false,
        valve1: false,
        slave_link: "online",
        exp_fault: fault,
        exp_fault_code: fault ? "DEMO_FAULT" : "",
        last_current_ua: current,
        conc_valid: true,
        last_conc: conc,
        calib_slope: 2.4,
        calib_intercept: 1.0,
        circulate_min: 5,
        stopflow_min: 5,
        calib_interval_h: 6,
        calib_min: 3,
        time_synced: true,
      });

      NS.emit("json", {
        time: elapsed * 1000,
        amps: current,
        volts: 100,
        analog_read_avg_bits: 2048 + Math.round(Math.random() * 8),
        analog_read_avg_mV: 1650 + Math.random() * 2,
      });
    }, 1000);
  }

  /* ---------- 启动 ---------- */
  document.addEventListener("DOMContentLoaded", function () {
    if (!hasChart) {
      const hint = $("#chart-fallback");
      if (hint) hint.classList.remove("hidden");
    }

    bindSweepButtons();
    bindRuntimeParams();
    bindExpControls();
    bindDataActions();
    bindTabs();

    // 倒计时本地走秒，不依赖每秒一条广播
    setInterval(tickCountdown, 250);

    NS.on("json", function (msg) {
      if ("exp_state" in msg) {
        renderExpState(msg);
        return;
      }
      if ("is_sweeping" in msg) {
        state.sweeping = !!msg.is_sweeping;
        setBadge($("#mode-badge"), msg.is_sweeping ? "扫描中" : "空闲", msg.is_sweeping ? "busy" : "");
        if (msg.is_sweeping) showMsg("正在扫描…");
        return;
      }
      if ("expect_binary_data" in msg) {
        state.binSeq = 0;
        state.binAmps = null;
        state.binVolts = null;
        return;
      }
      if ("Voltage" in msg && "Current" in msg) {
        const times = (msg.Time || []).map((ms) => ms / 1000);
        applySweepResult(times, msg.Voltage, msg.Current);
        return;
      }
      if ("exp_error" in msg) {
        const text = msg.exp_error === "slave_offline" ? "从机离线，操作已拒绝。" : "实验异常：" + msg.exp_error;
        showMsg(text, "danger");
        return;
      }
      renderRealtime(msg);
    });

    NS.on("bin", handleBinary);
    NS.on("close", function () {
      setBadge($("#slave-badge"), "从机离线", "off");
      state.exp.auto = false;
      state.exp.mode = "idle";
      tickCountdown();
    });

    if (NS.demo) startDemo();
  });
})();
