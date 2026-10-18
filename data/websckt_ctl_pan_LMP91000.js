// Javascript code to set up a websocket for the LMP91000 control panel.

var m_websocket;
var m_url_JS = "ws://nanostat.local:81/";
var button;
var canvas;
var context;
var maxDataPoints = 100;
var sum = 0;
var avg_current = 0;
var std_dev_current =0;
var total_number_of_points_recieved_so_far = 0;

// initialize plotly plot

// var trace_scope = {
//     x: [],
//     y: [],
//     mode: 'markers',
//     type: 'scatter'
// };
// var data_scope = [trace_scope];
// Plotly.newPlot('plotly-scope', data_scope);

var trace_scope_current = {
    x: [],
    y: [],
    mode: 'markers',
    type: 'scatter',
    name: "Current"
};
var trace_scope_voltage = {
    x: [],
    y: [],
    mode: 'markers',
    type: 'scatter',
    yaxis: 'y2',
    name: "Voltage"
};

var data_IVvsTime_scope = [trace_scope_current, trace_scope_voltage];
var m_2yaxis_layout = {
    margin: {
        l: 50,
        r: 5,
        b: 50,
        t: 1,
        pad: 4
    },
    xaxis: {
        title: { text: 'Time (s)' }
    },
    yaxis: { title: 'Current (μA)' },
    yaxis2: {
        title: 'Voltage (mV)',
        titlefont: { color: 'rgb(148, 103, 189)' },
        tickfont: { color: 'rgb(148, 103, 189)' },
        overlaying: 'y',
        side: 'right'
    }
};

Plotly.newPlot('plotly-scope-2yaxis', data_IVvsTime_scope, m_2yaxis_layout, { scrollZoom: true, editable: true, responsive: true });
// Plotly.newPlot('plotly-scope-2yaxis', data_IVvsTime_scope);





// This is called when the page finishes loading
function init() {

    // Assign page elements to variables
    button = document.getElementById("toggleButton");
    canvas = document.getElementById("led");

    // Draw circle in canvas
    // context = canvas.getContext("2d");
    // context.arc(25, 25, 15, 0, Math.PI * 2, false);
    // context.lineWidth = 3;
    // context.strokeStyle = "black";
    // context.stroke();
    // context.fillStyle = "black";
    // context.fill();

    wsConnect(m_url_JS);   // Connect to WebSocket server


}

// Call this to connect to the WebSocket server
function wsConnect(m_url_JS) {

    // Connect to WebSocket server
    m_url_JS = "ws://" + window.location.hostname + ":81/"
    m_websocket = new WebSocket(m_url_JS);

    // Assign callbacks
    m_websocket.onopen = function (evt) { onOpen(evt) };
    m_websocket.onclose = function (evt) { onClose(evt) };
    m_websocket.onmessage = function (evt) { onMessage(evt) };
    m_websocket.onerror = function (evt) { onError(evt) };

}

// Called when a WebSocket connection is established with the server
function onOpen(evt) {

    // Log connection state
    console.log("Connected");
    setWsStatus(true);

    // initialize values to front panel browswer:
    doSend("{\"change_cell_voltage_to\":" + document.getElementById("cell_voltage_id").value + "}");
    doSend("{\"change_num_readings_to_average_per_point_to\":" + document.getElementById("num_readings_to_average_per_point_id").value + "}");
    doSend("{\"change_lmpGain_to\":" + document.getElementById("lmpGain_id").value + "}");
    doSend("{\"change_control_panel_is_active_to\":false}");
    doSend("{\"change_delay_between_points_ms_to\":" + document.getElementById("delay_between_points_ms_id").value + "}");

}

// Called when the WebSocket connection is closed
function onClose(evt) {

    // Log disconnection state
    console.log("Disconnected");
    setWsStatus(false);



    // Try to reconnect after a few seconds
    setTimeout(function () { wsConnect(m_url_JS) }, 2000);
}


var textboxContent2 = "";
// Called when a message is received from the server
function onMessage(evt) {

    // Print out our received message
    // console.log("Received: " + evt.data);
    var m_json_obj = JSON.parse(evt.data);
    // console.log(m_json_obj);
    if ('is_sweeping' in m_json_obj) {// changin in is sweeping status, update indicator on browswer page...
        // do something
        if (m_json_obj.is_sweeping == true) { // mode is sweeping
            // do something
            document.getElementById('sweep_mode_id').innerHTML = "<span style=\"color:red\">SWEEPING</span>";
            console.log("need to update indicator to true...");
        }
        if (m_json_obj.is_sweeping == false) { // mode is sweeping
            // do something
            document.getElementById('sweep_mode_id').innerHTML = "<span style=\"color:green\">IDLE</span>";
            console.log("need to update indicator to false...");
        }
    };

    if ('dacVout' in m_json_obj) {// update dacVout and percentage indicators on browswer page...
        // do something
        var m_dacVout = m_json_obj.dacVout;
        var m_percentage = m_json_obj.percentage;
        document.getElementById('m_dacVout_id').innerHTML = m_dacVout;
        document.getElementById('m_percentage_id').innerHTML = m_percentage;
    };

    // ===== 实验流程状态更新 =====
    if ('exp_state' in m_json_obj) {
        var m_exp_state = m_json_obj.exp_state;
        var m_exp_cycle = m_json_obj.exp_cycle;

        var m_state_el = document.getElementById('exp_state_id');
        if (m_state_el) {
            m_state_el.innerHTML = m_exp_state;
            m_state_el.style.color = (m_exp_state == "IDLE") ? "#198754" : "#0d6efd";
        }
        if (document.getElementById('exp_cycle_id')) {
            document.getElementById('exp_cycle_id').innerHTML = m_exp_cycle;
        }
        if ('calib_in_ms' in m_json_obj && document.getElementById('calib_countdown_id')) {
            document.getElementById('calib_countdown_id').innerHTML =
                formatCalibCountdown(m_json_obj.calib_in_ms, m_exp_state);
        }
        if ('pump_on' in m_json_obj) {
            setDeviceState('pump', m_json_obj.pump_on, '运行', '停止');
        }
        if ('valve0' in m_json_obj) {
            setDeviceState('valve0', m_json_obj.valve0, '开', '关');
        }
        if ('valve1' in m_json_obj) {
            setDeviceState('valve1', m_json_obj.valve1, '开', '关');
        }
        if ('circulate_min' in m_json_obj) {
            updateInputIfNotFocused('exp_circulate_min_id', m_json_obj.circulate_min);
        }
        if ('stopflow_min' in m_json_obj) {
            updateInputIfNotFocused('exp_stopflow_min_id', m_json_obj.stopflow_min);
        }
        if ('calib_interval_h' in m_json_obj) {
            updateInputIfNotFocused('exp_calib_interval_h_id', m_json_obj.calib_interval_h);
        }
        if ('calib_min' in m_json_obj) {
            updateInputIfNotFocused('exp_calib_min_id', m_json_obj.calib_min);
        }
    };

    if ('volts' in m_json_obj) {// next time point, parse and add to graph
        var m_voltage_point = m_json_obj.volts;
        var m_current_point = m_json_obj.amps;
        var m_time_point = m_json_obj.time;
        var m_analog_read_avg_bits = m_json_obj.analog_read_avg_bits;
        var m_analog_read_avg_mV = m_json_obj.analog_read_avg_mV;
        document.getElementById('analog_read_avg_bits_id').innerHTML = m_analog_read_avg_bits;
        document.getElementById('analog_read_avg_mV_id').innerHTML = m_analog_read_avg_mV;

        if (trace_scope_current.x.length > maxDataPoints) {
            trace_scope_current.x.shift();
            trace_scope_current.y.shift();
            trace_scope_voltage.x.shift();
            trace_scope_voltage.y.shift();
        }
        trace_scope_current.x.push(m_time_point/1000);
        trace_scope_current.y.push(m_current_point);
        trace_scope_voltage.x.push(m_time_point/1000);
        trace_scope_voltage.y.push(m_voltage_point);
        var data_IVvsTime_scope = [trace_scope_current];


        var textboxContent1 = m_time_point/1000 + " ,  " + m_current_point + ", " + m_voltage_point + "\n";
         if(textboxContent1 === textboxContent2) {return;} // do not add duplicate points to textbox
         else{
        var textboxContent_temp = document.getElementById("dataTextbox").value;
        document.getElementById("dataTextbox").value = textboxContent_temp + textboxContent1;
        textboxContent2 = textboxContent1;
         }

        Plotly.newPlot('plotly-scope-2yaxis', data_IVvsTime_scope, m_2yaxis_layout, { scrollZoom: true, editable: true, responsive: true });
        total_number_of_points_recieved_so_far++;
        update_average_current();
        // if (Number.isInteger(total_number_of_points_recieved_so_far/100)) { // update every 100 points 
        //     update_average_current();
        // };
    };




}



// Called when a WebSocket error occurs
function onError(evt) {
    console.log("ERROR: " + evt.data);
}

// Sends a message to the server (and prints it to the console)
function doSend(message) {
    console.log("Sending: " + message);
    if (m_websocket && m_websocket.readyState === WebSocket.OPEN) {
        m_websocket.send(message);
    } else {
        console.log("WebSocket not connected, message dropped.");
    }
}

// 更新页面上的连接状态
function setWsStatus(connected) {
    var el = document.getElementById("ws_status_id");
    if (!el) return;
    if (connected) {
        el.innerHTML = "已连接";
        el.className = "ns-badge ns-badge-on";
    } else {
        el.innerHTML = "未连接";
        el.className = "ns-badge ns-badge-off";
    }
}

// 校准倒计时格式：hh:mm:ss
function formatCalibCountdown(ms, state) {
    if (state == "IDLE") return "--";
    if (ms <= 0) return "即将校准";
    var total = Math.floor(ms / 1000);
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    return (h < 10 ? "0" + h : h) + ":" +
        (m < 10 ? "0" + m : m) + ":" +
        (s < 10 ? "0" + s : s);
}

// 设备状态文字 + 指示灯
function setDeviceState(prefix, on, onText, offText) {
    var txt = document.getElementById(prefix + "_state_id");
    var dot = document.getElementById(prefix + "_dot_id");
    if (txt) txt.innerHTML = on ? onText : offText;
    if (dot) {
        if (on) dot.classList.add("on");
        else dot.classList.remove("on");
    }
}

// 避免用户正在输入时被下行数据覆盖
function updateInputIfNotFocused(id, value) {
    var el = document.getElementById(id);
    if (el && document.activeElement !== el) el.value = value;
}


// Called whenever the HTML button is pressed
function onPress() {
    doSend("Button pressed. Sending this message over websocket from html page to ESP32 websocket server....");
}
// Call the init function as soon as the page loads
window.addEventListener("load", init, false);

// Set listeners to send UI inputs to ESP32:
document.getElementById("cell_voltage_id").addEventListener("change", respond_to_cell_voltage_input_change);

function respond_to_cell_voltage_input_change() { // tell main.cpp to change cell voltage
    // console.log("cell voltage input changed to");
    // console.log(document.getElementById("cell_voltage_id").value);
    // send message via websockets to server
    var cell_voltage_JSON_command;
    cell_voltage_JSON_command = "{\"change_cell_voltage_to\":" + document.getElementById("cell_voltage_id").value + "}";
    // console.log("Prototype JSON string to send=");
    // console.log(cell_voltage_JSON_command); 
    doSend(cell_voltage_JSON_command);
}

document.getElementById("num_readings_to_average_per_point_id").addEventListener("change", respond_to_num_readings_to_average_per_point_change);

function respond_to_num_readings_to_average_per_point_change() { // tell main.cpp to change num readings per point
    var cell_voltage_JSON_command;
    cell_voltage_JSON_command = "{\"change_num_readings_to_average_per_point_to\":" + document.getElementById("num_readings_to_average_per_point_id").value + "}";
    doSend(cell_voltage_JSON_command);
}

document.getElementById("delay_between_points_ms_id").addEventListener("change", respond_to_delay_between_points_ms_change);

function respond_to_delay_between_points_ms_change() { // tell main.cpp to change num readings per point
    var cell_voltage_JSON_command;
    cell_voltage_JSON_command = "{\"change_delay_between_points_ms_to\":" + document.getElementById("delay_between_points_ms_id").value + "}";
    doSend(cell_voltage_JSON_command);
}

document.getElementById("lmpGain_id").addEventListener("change", respond_to_lmpGain_change);

function respond_to_lmpGain_change() { // tell main.cpp to change num readings per point
    var cell_voltage_JSON_command;
    cell_voltage_JSON_command = "{\"change_lmpGain_to\":" + document.getElementById("lmpGain_id").value + "}";
    doSend(cell_voltage_JSON_command);
}

document.getElementById("m_control_panel_is_active_id").addEventListener("change", respond_to_m_control_panel_is_active_id_change);

function respond_to_m_control_panel_is_active_id_change() {
    var control_panel_is_active_JSON_command;
    control_panel_is_active_JSON_command = "{\"change_control_panel_is_active_to\":true}";
    doSend(control_panel_is_active_JSON_command);
    // also send all the parameters for the biasing: 1) TIA gain 2) cell voltage 3) # readings to avg 4) delay...
    respond_to_delay_between_points_ms_change();
    respond_to_num_readings_to_average_per_point_change();
    respond_to_lmpGain_change()
    respond_to_cell_voltage_input_change();
}


document.getElementById("m_control_panel_is_inactive_id").addEventListener("change", respond_to_m_control_panel_is_inactive_id_change);

function respond_to_m_control_panel_is_inactive_id_change() {
    var control_panel_is_active_JSON_command;
    control_panel_is_active_JSON_command = "{\"change_control_panel_is_active_to\":false}";
    doSend(control_panel_is_active_JSON_command);
}


document.getElementById("max_number_of_points_in_browser_id").addEventListener("change", respond_to_max_number_of_points_in_browser_id_change);

function respond_to_max_number_of_points_in_browser_id_change() {
    maxDataPoints = document.getElementById("max_number_of_points_in_browser_id").value;
    if (trace_scope_current.x.length > maxDataPoints) {
        var num_points_to_delete;
        num_points_to_delete = trace_scope_current.x.length - maxDataPoints;
        for (i = 0; i < num_points_to_delete; i++) {
            trace_scope_current.x.shift();
            trace_scope_current.y.shift();
            trace_scope_voltage.x.shift();
            trace_scope_voltage.y.shift();
        }
    }
}

// ===== 实验参数输入 =====
function sendExpParam(key, value) {
    var msg = {};
    msg[key] = Number(value);
    doSend(JSON.stringify(msg));
}

var m_exp_circ = document.getElementById("exp_circulate_min_id");
if (m_exp_circ) m_exp_circ.addEventListener("change", function () {
    sendExpParam("change_exp_circulate_min", this.value);
});

var m_exp_stop = document.getElementById("exp_stopflow_min_id");
if (m_exp_stop) m_exp_stop.addEventListener("change", function () {
    sendExpParam("change_exp_stopflow_min", this.value);
});

var m_exp_calib_h = document.getElementById("exp_calib_interval_h_id");
if (m_exp_calib_h) m_exp_calib_h.addEventListener("change", function () {
    sendExpParam("change_exp_calib_interval_h", this.value);
});

var m_exp_calib_m = document.getElementById("exp_calib_min_id");
if (m_exp_calib_m) m_exp_calib_m.addEventListener("change", function () {
    sendExpParam("change_exp_calib_min", this.value);
});



function removeData() {
    dataPlot.data.labels.shift();
    dataPlot.data.datasets[0].data.shift();
}
function addData(label, data) {
    if (dataPlot.data.labels.length > maxDataPoints) removeData();
    dataPlot.data.labels.push(label);
    dataPlot.data.datasets[0].data.push(data);
    dataPlot.update();
}


// PSUEDO CODE:

function update_average_current() {
    avg_current = 0;
    sum = 0;
    // trace_scope_current.y = [2,3,4,1,...]
    trace_scope_current.y.forEach(add_item_to_sum);

    avg_current = (1 / trace_scope_current.y.length) * sum
    document.getElementById("AVG_current_ID").innerHTML = avg_current;
    // console.log("updated avg current is =",avg_current);

    // now calculate standard deviatoin:
    sum=0;
    trace_scope_current.y.forEach(add_difference_between_item_and_average_squared_to_sum);
    std_dev_current=Math.sqrt(sum/trace_scope_current.y.length);
    document.getElementById("STD_DEV_current_ID").innerHTML = std_dev_current;


}

function add_item_to_sum(item) {
    sum += item;
}

function add_difference_between_item_and_average_squared_to_sum(item) {
    sum += (avg_current-item)*(avg_current-item);
}


// ===== 新增：实验流程控制按钮 =====
function respond_to_start_experiment() {
    doSend("{\"start_experiment\":true}");
}

function respond_to_stop_experiment() {
    doSend("{\"stop_experiment\":true}");
}

var m_btn_start = document.getElementById("btn_start_exp");
if (m_btn_start) {
    m_btn_start.addEventListener("click", respond_to_start_experiment);
}

var m_btn_stop = document.getElementById("btn_stop_exp");
if (m_btn_stop) {
    m_btn_stop.addEventListener("click", respond_to_stop_experiment);
}




