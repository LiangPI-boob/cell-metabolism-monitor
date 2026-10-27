/* =====================================================================
   公共脚本：工具函数 / Tab 组件 / 唯一 WebSocket 连接
   约定：
   - 全站只有本文件可以 new WebSocket；
   - 页面脚本通过 NS.on('json' | 'bin' | 'open' | 'close', fn) 订阅消息；
   - 页面需要实时数据的，在 <body data-ws="1"> 上声明。
   ===================================================================== */
(function () {
  "use strict";

  const NS = (window.NS = {});
  // 本地演示：index.html?demo=1，不连设备，由页面脚本喂假数据
  NS.demo = new URLSearchParams(location.search).get("demo") === "1";

  /* ---------- 基础工具 ---------- */
  NS.$ = (sel, root) => (root || document).querySelector(sel);
  NS.$$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));

  NS.fmt = function (value, digits) {
    const v = Number(value);
    if (value === null || value === undefined || !isFinite(v)) return "--";
    return v.toFixed(digits === undefined ? 3 : digits);
  };

  NS.downloadText = function (text, filename) {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  /* ---------- Tab 组件 ---------- */
  function activateTab(group, name) {
    NS.$$("[data-tab]", group).forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.tab === name);
    });
    NS.$$("[data-panel]", group).forEach((panel) => {
      panel.classList.toggle("is-active", panel.dataset.panel === name);
    });
    group.dispatchEvent(new CustomEvent("tab:change", { detail: name }));
  }

  NS.initTabs = function () {
    NS.$$("[data-tabs]").forEach((group) => {
      group.addEventListener("click", (event) => {
        const btn = event.target.closest("[data-tab]");
        if (!btn || !group.contains(btn)) return;
        activateTab(group, btn.dataset.tab);
        if (history.replaceState) history.replaceState(null, "", "#" + btn.dataset.tab);
        else location.hash = btn.dataset.tab;
      });

      const hash = location.hash.replace("#", "");
      if (hash && NS.$('[data-tab="' + hash + '"]', group)) activateTab(group, hash);
    });

    window.addEventListener("hashchange", () => {
      const hash = location.hash.replace("#", "");
      NS.$$("[data-tabs]").forEach((group) => {
        if (hash && NS.$('[data-tab="' + hash + '"]', group)) activateTab(group, hash);
      });
    });
  };

  /* ---------- WebSocket ---------- */
  NS.bus = new EventTarget();
  NS.ready = false;

  let socket = null;
  let retryDelay = 1000;

  NS.on = function (type, handler) {
    NS.bus.addEventListener(type, (event) => handler(event.detail));
  };

  function emit(type, detail) {
    NS.bus.dispatchEvent(new CustomEvent(type, { detail: detail }));
  }
  NS.emit = emit;   // 演示模式 / 页面脚本注入消息用

  function connect() {
    const url = "ws://" + location.hostname + ":81/";
    socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";

    socket.onopen = function () {
      retryDelay = 1000;
      NS.ready = true;
      emit("open");
    };

    socket.onclose = function () {
      NS.ready = false;
      emit("close");
      setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 10000);
    };

    socket.onerror = function () {
      emit("error");
    };

    socket.onmessage = function (event) {
      if (typeof event.data === "string") {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch (err) {
          return;
        }
        emit("json", message);
      } else {
        emit("bin", event.data);
      }
    };
  }

  NS.send = function (payload) {
    if (NS.demo) {
      console.log("[DEMO] " + JSON.stringify(payload));
      return true;
    }
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(payload));
      return true;
    }
    return false;
  };

  /* ---------- 网络模式提示条 ---------- */
  const AP_FALLBACK_IP = "192.168.4.1";

  function buildNetbar(info) {
    const nav = document.querySelector("nav.nav");
    if (!nav || document.querySelector("[data-netbar]")) return;

    const host = location.hostname || location.host || "本机";
    const apIp = (info && info.ap_ip) || AP_FALLBACK_IP;
    const apSsid = (info && info.ap_ssid) || "NanoStatAP";
    const staUp = !!(info && info.sta_connected);
    const staIp = info && info.sta_ip ? info.sta_ip : "";
    const staSsid = info && info.sta_ssid ? info.sta_ssid : "";
    const direct = location.hostname === apIp;

    let text;
    if (direct) {
      text =
        "已连接 " + apSsid + "（" + apIp + "）· 无外网也可正常采集与绘图。";
      if (staUp && staIp) {
        text += "设备同时已接入路由器，也可用 http://" + staIp + " 访问。";
      } else {
        text += "如设备已接入路由器，改用路由器分配的地址访问可获得更快的加载速度。";
      }
    } else {
      text = staUp
        ? "设备已接入路由器" + (staSsid ? " " + staSsid : "") + "，当前地址 " + host + " · 热点 " + apSsid + " 仍常开。"
        : "当前地址 " + host + " · 设备未连路由器，热点 " + apSsid + " 仍可直连 " + apIp + "。";
    }

    const bar = document.createElement("div");
    bar.className = "netbar " + (direct ? "netbar--ap" : "netbar--sta");
    bar.setAttribute("data-netbar", "");
    bar.innerHTML =
      '<div class="netbar__inner">' +
      '<span class="netbar__tag"></span>' +
      '<span class="netbar__text"></span>' +
      '<a class="netbar__link" href="help.html#network">网络说明</a>' +
      "</div>";
    bar.querySelector(".netbar__tag").textContent = direct ? "热点直连" : "路由模式";
    bar.querySelector(".netbar__text").textContent = text;
    nav.parentNode.insertBefore(bar, nav.nextSibling);
  }

  function initNetbar() {
    if (!window.fetch) {
      buildNetbar(null);
      return;
    }
    fetch("/netinfo", { cache: "no-store" })
      .then(function (response) {
        return response.ok ? response.json() : null;
      })
      .catch(function () {
        return null;
      })
      .then(buildNetbar);
  }

  /* ---------- 启动 ---------- */
  document.addEventListener("DOMContentLoaded", function () {
    NS.initTabs();
    if (!NS.demo) initNetbar();

    const wsBadge = document.querySelector("[data-ws-badge]");
    if (wsBadge) {
      NS.on("open", function () {
        wsBadge.textContent = "已连接";
        wsBadge.className = "badge badge--on";
      });
      NS.on("close", function () {
        wsBadge.textContent = "未连接";
        wsBadge.className = "badge badge--off";
      });
      if (NS.demo) {
        wsBadge.textContent = "演示模式";
        wsBadge.className = "badge badge--on";
      }
    }

    if (document.body.dataset.ws === "1" && !NS.demo) connect();
  });
})();
