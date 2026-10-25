/* =====================================================================
   系统页：文件列表 / WiFi 扫描 / 重启
   上传与固件烧写使用原生表单提交（后端返回带跳转的 HTML）
   ===================================================================== */
(function () {
  "use strict";

  const $ = NS.$;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function emptyRow(text) {
    const row = document.createElement("div");
    row.className = "list__item";
    const span = document.createElement("span");
    span.className = "muted";
    span.textContent = text;
    row.appendChild(span);
    return row;
  }

  /* ---------- 文件 ---------- */
  function renderFiles(items) {
    const list = $("#file-list");
    if (!list) return;
    list.textContent = "";

    const files = items.filter((item) => item.type === "file");
    if (!files.length) {
      list.appendChild(emptyRow("目录为空"));
      return;
    }

    files.forEach((file) => {
      const row = document.createElement("div");
      row.className = "list__item";

      const name = document.createElement("span");
      name.className = "list__name";
      name.textContent = file.name;

      const actions = document.createElement("span");
      actions.className = "row";

      const del = document.createElement("button");
      del.className = "btn btn--sm btn--ghost";
      del.textContent = "删除";
      del.addEventListener("click", function () {
        if (!confirm("确认删除 " + file.name + " ？")) return;
        fetch("/edit?file=/" + encodeURIComponent(file.name), { method: "DELETE" })
          .then(loadFiles)
          .catch(function () {
            alert("删除失败");
          });
      });

      actions.appendChild(del);
      row.appendChild(name);
      row.appendChild(actions);
      list.appendChild(row);
    });
  }

  function loadFiles() {
    const list = $("#file-list");
    if (list) list.replaceChildren(emptyRow("加载中…"));

    return fetch("/list?dir=/", { cache: "no-store" })
      .then((response) => response.json())
      .then(renderFiles)
      .catch(function () {
        if (list) list.replaceChildren(emptyRow("读取目录失败，请刷新重试"));
      });
  }

  /* ---------- WiFi ---------- */
  function renderWifi(networks) {
    const list = $("#wifi-list");
    if (!list) return;
    list.textContent = "";

    networks
      .sort((a, b) => (b.RSSI || -999) - (a.RSSI || -999))
      .forEach((net) => {
        const row = document.createElement("div");
        row.className = "list__item";

        const name = document.createElement("button");
        name.className = "btn btn--sm btn--ghost list__name";
        name.textContent = net.SSID;
        name.addEventListener("click", function () {
          fillSsid(net.SSID);
        });

        const rssi = document.createElement("span");
        rssi.className = "muted mono";
        rssi.textContent = net.RSSI + " dBm";

        row.appendChild(name);
        row.appendChild(rssi);
        list.appendChild(row);
      });
  }

  function fillSsid(ssid) {
    const inputs = ["ssid1", "ssid2", "ssid3"].map((id) => document.getElementById(id));
    const target = inputs.find((el) => el && !el.value);
    if (target) target.value = ssid;
    else if (inputs[0]) inputs[0].value = ssid;
  }

  let scanning = false;

  async function scanWifi() {
    if (scanning) return;
    scanning = true;

    const list = $("#wifi-list");
    if (list) list.replaceChildren(emptyRow("扫描中…"));

    for (let attempt = 0; attempt < 7; attempt++) {
      try {
        const response = await fetch("wifiScan.json", { cache: "no-store" });
        const data = await response.json();
        const networks = (data.scan_result || []).filter((net) => net.SSID);
        if (networks.length) {
          renderWifi(networks);
          scanning = false;
          return;
        }
      } catch (err) {
        /* 扫描尚未完成，继续等待 */
      }
      await sleep(1500);
    }

    if (list) list.replaceChildren(emptyRow("未扫描到网络，可再次点击扫描"));
    scanning = false;
  }

  /* ---------- 启动 ---------- */
  document.addEventListener("DOMContentLoaded", function () {
    const refreshBtn = $("#btn-refresh-files");
    if (refreshBtn) refreshBtn.addEventListener("click", loadFiles);

    const scanBtn = $("#btn-scan");
    if (scanBtn) scanBtn.addEventListener("click", scanWifi);

    const rebootBtn = $("#btn-reboot");
    if (rebootBtn) {
      rebootBtn.addEventListener("click", function () {
        if (!confirm("确认重启 NanoStat？正在进行的实验会中断。")) return;
        location.href = "/rebootnanostat";
      });
    }

    if ($("#file-list")) loadFiles();

    NS.$$("[data-tabs]").forEach((group) => {
      group.addEventListener("tab:change", function (event) {
        if (event.detail === "files") loadFiles();
      });
    });
  });
})();
