const BASE = "https://speed.cloudflare.com";
const $ = id => document.getElementById(id);
const num = $("num"), statusEl = $("status"), prog = $("prog"), chart = $("chart");
let running = false;
let dlSamples = [];
let ulSamples = [];
let currentSamples = [];

const mbps = (bytes, ms) => (ms > 0 ? (bytes * 8) / (ms / 1000) / 1e6 : 0);
const fmt = v => (v >= 100 ? v.toFixed(0) : v.toFixed(1));
function setNum(v) { num.textContent = fmt(v); }

function draw(samples = currentSamples) {
  const c = chart.getContext("2d"), w = chart.width, h = chart.height;
  c.clearRect(0, 0, w, h);
  if (!samples || samples.length < 2) return;
  const max = Math.max(...samples) * 1.15 || 1;
  c.beginPath();
  c.lineWidth = 4;
  c.strokeStyle = "#e50914";
  c.lineJoin = "round";
  samples.forEach((v, i) => {
    const x = (i / (samples.length - 1)) * w;
    const y = h - (v / max) * (h - 8) - 4;
    i ? c.lineTo(x, y) : c.moveTo(x, y);
  });
  c.stroke();
}

async function latency() {
  const times = [];
  for (let i = 0; i < 6; i++) {
    const t = performance.now();
    try {
      await fetch(`${BASE}/__down?bytes=0&r=${Math.random()}`, { cache: "no-store" });
      times.push(performance.now() - t);
    } catch (e) {
      // ignore single ping failures
    }
  }
  if (times.length === 0) throw new Error("Latency measurement failed");
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)];
}

// Download: parallel streams, live speed from a sliding window
async function download(duration = 10000, streams = 4) {
  const ctrl = new AbortController();
  let total = 0;
  const start = performance.now();
  let win = [{ t: start, b: 0 }];
  let finalSpeed = 0;
  let tick = null;
  let timer = null;

  const worker = async () => {
    while (performance.now() - start < duration) {
      try {
        const r = await fetch(`${BASE}/__down?bytes=25000000&r=${Math.random()}`, {
          cache: "no-store",
          signal: ctrl.signal
        });
        if (!r.ok) continue;
        const rd = r.body.getReader();
        while (true) {
          const { done, value } = await rd.read();
          if (done) break;
          total += value.length;
        }
      } catch (e) {
        if (e.name === "AbortError" || ctrl.signal.aborted) return;
      }
    }
  };

  try {
    tick = setInterval(() => {
      const now = performance.now();
      win.push({ t: now, b: total });
      win = win.filter(p => now - p.t <= 2000);
      const a = win[0];
      const s = now - a.t > 0 ? mbps(total - a.b, now - a.t) : 0;
      finalSpeed = mbps(total, now - start);
      if (now - start > 1000) {
        setNum(s);
        dlSamples.push(s);
        currentSamples = dlSamples;
        draw();
      }
      prog.style.width = Math.min(50, ((now - start) / duration) * 50) + "%";
    }, 200);

    timer = setTimeout(() => ctrl.abort(), duration);
    await Promise.all(Array.from({ length: streams }, worker));
  } finally {
    if (timer) clearTimeout(timer);
    if (tick) clearInterval(tick);
    ctrl.abort();
  }
  return finalSpeed;
}

// Upload: parallel XHR with progress events
function upload(duration = 8000, streams = 3) {
  const size = 6 * 1024 * 1024;
  const buf = new Uint8Array(size);
  for (let i = 0; i < size; i += 65536) {
    crypto.getRandomValues(buf.subarray(i, Math.min(i + 65536, size)));
  }
  const blob = new Blob([buf]);

  return new Promise((resolve) => {
    const start = performance.now();
    let done = false;
    const loaded = new Array(streams).fill(0);
    let base = 0;
    let win = [{ t: start, b: 0 }];
    let finalSpeed = 0;
    const xhrs = [];

    const sum = () => base + loaded.reduce((a, b) => a + b, 0);

    const cleanup = () => {
      done = true;
      if (tick) clearInterval(tick);
      xhrs.forEach(x => {
        x.upload.onprogress = null;
        x.onload = null;
        x.onerror = null;
        x.abort();
      });
    };

    const launch = i => {
      if (done) return;
      const x = new XMLHttpRequest();
      xhrs.push(x);
      x.open("POST", `${BASE}/__up?r=${Math.random()}`);
      x.upload.onprogress = e => {
        if (!done) loaded[i] = e.loaded;
      };
      x.onload = () => {
        if (done) return;
        base += loaded[i];
        loaded[i] = 0;
        launch(i);
      };
      x.onerror = () => {
        if (done) return;
        loaded[i] = 0; // Reset unconfirmed bytes on failure
        launch(i);
      };
      x.send(blob);
    };

    for (let i = 0; i < streams; i++) launch(i);

    const tick = setInterval(() => {
      const now = performance.now();
      const tot = sum();
      win.push({ t: now, b: tot });
      win = win.filter(p => now - p.t <= 2000);
      const a = win[0];
      const s = now - a.t > 0 ? mbps(tot - a.b, now - a.t) : 0;
      finalSpeed = mbps(tot, now - start);

      if (now - start > 1000) {
        setNum(s);
        ulSamples.push(s);
        currentSamples = ulSamples;
        draw();
      }

      prog.style.width = 50 + Math.min(50, ((now - start) / duration) * 50) + "%";

      if (now - start >= duration) {
        cleanup();
        resolve(finalSpeed);
      }
    }, 200);
  });
}

async function run() {
  if (running) return;
  running = true;
  $("start").disabled = true;
  $("start").textContent = "Testing…";
  num.classList.remove("done");
  dlSamples = [];
  ulSamples = [];
  currentSamples = [];
  chart.style.display = "block";
  draw();

  ["ping", "dl", "ul"].forEach(id => ($(id).textContent = "–"));
  setNum(0);
  prog.style.width = "0%";

  try {
    $("label").textContent = "Testing your Internet speed…";
    statusEl.textContent = "Measuring latency…";
    const p = await latency();
    $("ping").textContent = Math.round(p);

    $("label").textContent = "Download speed";
    statusEl.textContent = "Testing download speed…";
    const d = await download();
    $("dl").textContent = fmt(d);
    setNum(d);

    $("label").textContent = "Upload speed";
    statusEl.textContent = "Testing upload speed…";
    setNum(0);
    const u = await upload();
    $("ul").textContent = fmt(u);

    // Final result screen configuration
    currentSamples = dlSamples;
    draw();
    setNum(d);
    num.classList.add("done");
    $("label").textContent = "Your Internet speed is";
    statusEl.textContent = "Test complete";
    prog.style.width = "100%";
    $("more").classList.add("show");
    $("toggle").textContent = "Hide more info";
  } catch (e) {
    console.error("Speed test error:", e);
    statusEl.textContent = "Test failed – check your connection and try again";
    $("label").textContent = "Your Internet speed is";
  } finally {
    running = false;
    $("start").disabled = false;
    $("start").textContent = "Test Again";
  }
}

$("start").onclick = run;
$("toggle").onclick = () => {
  const m = $("more");
  m.classList.toggle("show");
  $("toggle").textContent = m.classList.contains("show") ? "Hide more info" : "Show more info";
};
