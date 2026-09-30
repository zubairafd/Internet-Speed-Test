const BASE = "https://speed.cloudflare.com";
const $ = id => document.getElementById(id);
const num=$("num"), statusEl=$("status"), prog=$("prog"), chart=$("chart");
let running=false, samples=[];

const mbps = (bytes, ms) => (bytes*8)/(ms/1000)/1e6;
const fmt = v => v>=100 ? v.toFixed(0) : v.toFixed(1);
function setNum(v){ num.textContent = fmt(v); }

function draw(){
  const c=chart.getContext("2d"), w=chart.width, h=chart.height;
  c.clearRect(0,0,w,h);
  if(samples.length<2) return;
  const max=Math.max(...samples)*1.15||1;
  c.beginPath(); c.lineWidth=4; c.strokeStyle="#e50914"; c.lineJoin="round";
  samples.forEach((v,i)=>{
    const x=i/(samples.length-1)*w, y=h-(v/max)*(h-8)-4;
    i?c.lineTo(x,y):c.moveTo(x,y);
  });
  c.stroke();
}

async function latency(){
  const times=[];
  for(let i=0;i<8;i++){
    const t=performance.now();
    try{ await fetch(`${BASE}/__down?bytes=0&r=${Math.random()}`,{cache:"no-store"}); }catch(e){ throw e; }
    times.push(performance.now()-t);
  }
  times.sort((a,b)=>a-b);
  return times[Math.floor(times.length/2)];
}

// Download: parallel streams, live speed from a sliding window
async function download(duration=10000, streams=4){
  const ctrl=new AbortController();
  let total=0; const start=performance.now();
  let win=[{t:start,b:0}], finalSpeed=0;
  const worker=async()=>{
    while(performance.now()-start<duration){
      try{
        const r=await fetch(`${BASE}/__down?bytes=25000000&r=${Math.random()}`,{cache:"no-store",signal:ctrl.signal});
        const rd=r.body.getReader();
        while(true){
          const {done,value}=await rd.read();
          if(done) break;
          total+=value.length;
        }
      }catch(e){ if(e.name==="AbortError") return; throw e; }
    }
  };
  const tick=setInterval(()=>{
    const now=performance.now();
    win.push({t:now,b:total});
    win=win.filter(p=>now-p.t<=2000);
    const a=win[0];
    const s=now-a.t>0?mbps(total-a.b,now-a.t):0;
    finalSpeed=mbps(total,now-start);
    if(now-start>1000){ setNum(s); samples.push(s); draw(); }
    prog.style.width=Math.min(100,(now-start)/duration*50)+"%";
  },200);
  const timer=setTimeout(()=>ctrl.abort(),duration);
  await Promise.all(Array.from({length:streams},worker));
  clearTimeout(timer); clearInterval(tick);
  return finalSpeed;
}

// Upload: parallel XHR with progress events
function upload(duration=8000, streams=3){
  const size=6*1024*1024, buf=new Uint8Array(size);
  for(let i=0;i<size;i+=65536) crypto.getRandomValues(buf.subarray(i,Math.min(i+65536,size)));
  const blob=new Blob([buf]);
  return new Promise(resolve=>{
    const start=performance.now(); let done=false;
    const loaded=new Array(streams).fill(0); let base=0;
    let win=[{t:start,b:0}], finalSpeed=0;
    const xhrs=[];
    const sum=()=>base+loaded.reduce((a,b)=>a+b,0);
    const launch=i=>{
      if(done) return;
      const x=new XMLHttpRequest(); xhrs.push(x);
      x.open("POST",`${BASE}/__up?r=${Math.random()}`);
      x.upload.onprogress=e=>{loaded[i]=e.loaded};
      const next=()=>{ base+=loaded[i]; loaded[i]=0; launch(i); };
      x.onload=next; x.onerror=()=>{ if(!done) next(); };
      x.send(blob);
    };
    for(let i=0;i<streams;i++) launch(i);
    const tick=setInterval(()=>{
      const now=performance.now(), tot=sum();
      win.push({t:now,b:tot}); win=win.filter(p=>now-p.t<=2000);
      const a=win[0];
      const s=now-a.t>0?mbps(tot-a.b,now-a.t):0;
      finalSpeed=mbps(tot,now-start);
      if(now-start>1000){ setNum(s); samples.push(s); draw(); }
      prog.style.width=(50+Math.min(50,(now-start)/duration*50))+"%";
      if(now-start>=duration){
        done=true; clearInterval(tick); xhrs.forEach(x=>x.abort()); resolve(finalSpeed);
      }
    },200);
  });
}

async function run(){
  if(running) return; running=true;
  $("start").disabled=true; $("start").textContent="Testing…";
  num.classList.remove("done"); samples=[]; chart.style.display="block";
  ["ping","dl","ul"].forEach(id=>$(id).textContent="–");
  setNum(0); prog.style.width="0";
  try{
    $("label").textContent="Testing your Internet speed…";
    statusEl.textContent="Measuring latency…";
    $("ping").textContent=Math.round(await latency());

    statusEl.textContent="Testing download speed…";
    const d=await download(); $("dl").textContent=fmt(d); setNum(d);

    $("label").textContent="Download speed"; samples=[];
    statusEl.textContent="Testing upload speed…"; setNum(0);
    const u=await upload(); $("ul").textContent=fmt(u);

    setNum(d); num.classList.add("done");
    $("label").textContent="Your Internet speed is";
    statusEl.textContent="Test complete"; prog.style.width="100%";
    $("more").classList.add("show"); $("toggle").textContent="Hide more info";
  }catch(e){
    console.error(e);
    statusEl.textContent="Test failed – check your connection and try again";
    $("label").textContent="Your Internet speed is";
  }
  running=false; $("start").disabled=false; $("start").textContent="Test Again";
}

$("start").onclick=run;
$("toggle").onclick=()=>{
  const m=$("more"); m.classList.toggle("show");
  $("toggle").textContent=m.classList.contains("show")?"Hide more info":"Show more info";
};
