/**
 * Command Center — unified operational dashboard for AgentX.
 *
 * Six tabbed sections, each backed by real V2 API endpoints:
 *   1. System Health   — /api/health, /api/status, /api/supervisor/status
 *   2. Build Control   — /api/builder/runs, /api/builder/stats, /api/automation/kill-switch
 *   3. Intelligence    — /api/learning/stats, /api/cognitive/diagnostics, /api/knowledge/stats
 *   4. Self-Improvement— /api/models/performance, /api/learning/stats
 *   5. Model Control   — /api/models, /api/models/routing, /api/models/performance
 *   6. Memory/Cognitive— /api/memory/status, /api/memory/stats, /api/cognitive/diagnostics
 */

export const COMMAND_CENTER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AgentX Command Center</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0d1117;color:#c9d1d9;min-height:100vh}
.header{background:#161b22;border-bottom:1px solid #30363d;padding:16px 24px;display:flex;align-items:center;justify-content:space-between}
.header h1{color:#58a6ff;font-size:20px;font-weight:700}
.header .status-dot{width:10px;height:10px;border-radius:50%;display:inline-block;margin-right:8px}
.header .status-dot.ok{background:#3fb950}
.header .status-dot.err{background:#f85149}
.header .status-dot.warn{background:#d29922}
.header .meta{color:#8b949e;font-size:12px;display:flex;align-items:center;gap:12px}
.tabs{display:flex;background:#161b22;border-bottom:1px solid #30363d;padding:0 24px;gap:0;overflow-x:auto}
.tab{padding:12px 20px;font-size:13px;font-weight:600;color:#8b949e;cursor:pointer;border-bottom:2px solid transparent;white-space:nowrap;transition:color .15s,border-color .15s}
.tab:hover{color:#c9d1d9}
.tab.active{color:#58a6ff;border-bottom-color:#58a6ff}
.panel{display:none;padding:24px;max-width:1400px;margin:0 auto}
.panel.active{display:block}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:24px}
.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px}
.card .label{color:#8b949e;font-size:11px;text-transform:uppercase;letter-spacing:.5px}
.card .value{font-size:28px;font-weight:700;color:#f0f6fc;margin-top:4px}
.card .value.good{color:#3fb950}.card .value.warn{color:#d29922}.card .value.bad{color:#f85149}
.card .sub{color:#8b949e;font-size:11px;margin-top:4px}
section{margin-bottom:24px}
section h2{color:#58a6ff;font-size:16px;margin-bottom:12px;border-bottom:1px solid #21262d;padding-bottom:8px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;padding:8px 12px;background:#161b22;color:#8b949e;font-weight:600;border-bottom:1px solid #30363d}
td{padding:8px 12px;border-bottom:1px solid #21262d}
tr:hover td{background:#161b22}
.badge{display:inline-block;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600}
.badge-ok{background:#1f3a2e;color:#3fb950}
.badge-err{background:#3d1f1f;color:#f85149}
.badge-warn{background:#2d2a1f;color:#d29922}
.badge-info{background:#1f2d3d;color:#58a6ff}
.btn{padding:8px 16px;border:1px solid #30363d;border-radius:6px;background:#21262d;color:#c9d1d9;font-size:13px;cursor:pointer;font-weight:600;transition:background .15s}
.btn:hover{background:#30363d}
.btn:disabled{opacity:.5;cursor:not-allowed}
.btn-primary{background:#238636;border-color:#238636;color:#fff}
.btn-primary:hover{background:#2ea043}
.btn-danger{background:#da3633;border-color:#da3633;color:#fff}
.btn-danger:hover{background:#f85149}
.actions{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap}
.bar{display:flex;align-items:center;gap:8px;margin:4px 0}
.bar-label{width:140px;font-size:12px;color:#8b949e;flex-shrink:0}
.bar-track{flex:1;height:8px;background:#21262d;border-radius:4px;overflow:hidden}
.bar-fill{height:100%;border-radius:4px;transition:width .3s}
.bar-fill.blue{background:#58a6ff}.bar-fill.green{background:#3fb950}.bar-fill.yellow{background:#d29922}.bar-fill.red{background:#f85149}
.bar-count{font-size:12px;color:#8b949e;width:50px;text-align:right;flex-shrink:0}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:768px){.grid2{grid-template-columns:1fr}}
.mono{font-family:'SF Mono',Consolas,monospace;font-size:12px}
.empty{color:#484f58;text-align:center;padding:24px;font-size:13px}
.refresh-bar{display:flex;align-items:center;gap:8px;margin-bottom:16px}
.refresh-bar .timer{color:#484f58;font-size:11px}
#toast{position:fixed;bottom:24px;right:24px;background:#161b22;border:1px solid #30363d;border-radius:8px;padding:12px 20px;color:#c9d1d9;font-size:13px;display:none;z-index:100;box-shadow:0 4px 12px rgba(0,0,0,.4)}
.input-row{display:flex;gap:8px;margin-bottom:12px;align-items:center;flex-wrap:wrap}
.input-row input,.input-row textarea,.input-row select{background:#0d1117;border:1px solid #30363d;border-radius:6px;color:#c9d1d9;padding:8px 12px;font-size:13px;font-family:inherit}
.input-row input{flex:1;min-width:180px}
.input-row textarea{flex:1;min-width:180px;min-height:60px;resize:vertical}
.input-row select{min-width:140px}
.control-group{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;margin-bottom:16px}
.control-group h3{color:#c9d1d9;font-size:14px;margin-bottom:12px}
.switch{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.switch label{color:#8b949e;font-size:13px;min-width:100px}
</style>
</head>
<body>
<div class="header">
  <h1>AgentX Command Center</h1>
  <div class="meta" style="margin-left:auto">
    <span><span id="hdr-dot" class="status-dot"></span><span id="hdr-status">...</span></span>
    <span id="hdr-time"></span>
  </div>
</div>

<div class="tabs">
  <div class="tab active" data-panel="health">System Health</div>
  <div class="tab" data-panel="build">Build Control</div>
  <div class="tab" data-panel="intel">Intelligence</div>
  <div class="tab" data-panel="improve">Self-Improvement</div>
  <div class="tab" data-panel="models">Model Control</div>
  <div class="tab" data-panel="memory">Memory / Cognitive</div>
  <div class="tab" data-panel="autonomy">Checkpoints & Autonomy</div>
</div>

<!-- ── 1. System Health ───────────────────────────────────────── -->
<div id="health" class="panel active">
  <div class="refresh-bar"><button class="btn" onclick="loadHealth()">Refresh</button><span class="timer" id="health-ts"></span></div>
  <div class="cards" id="health-cards"></div>
  <div class="grid2">
    <section><h2>Services</h2><div id="health-services"></div></section>
    <section><h2>Runtime</h2><div id="health-runtime"></div></section>
  </div>
</div>

<!-- ── 2. Build Control ───────────────────────────────────────── -->
<div id="build" class="panel">
  <div class="actions">
    <button class="btn btn-primary" onclick="triggerBuild()">New Build</button>
    <button class="btn" onclick="loadBuild()">Refresh</button>
    <button class="btn btn-danger" id="ks-btn" onclick="toggleKillSwitch()">Kill Switch</button>
    <button class="btn" onclick="cancelBuild()">Cancel Build</button>
    <button class="btn" onclick="clearQueue()">Clear Queue</button>
    <span class="timer" id="build-ts"></span>
  </div>
  <div id="build-queue-status" style="margin:8px 0;padding:8px;border-radius:6px;background:var(--card-bg);font-size:13px;"></div>
  <div class="cards" id="build-cards"></div>
  <section><h2>Recent Builds</h2><table><thead><tr><th>ID</th><th>Status</th><th>Tasks</th><th>Duration</th><th>Started</th></tr></thead><tbody id="build-runs"></tbody></table></section>
</div>

<!-- ── 3. Intelligence ────────────────────────────────────────── -->
<div id="intel" class="panel">
  <div class="actions">
    <button class="btn" onclick="loadIntel()">Refresh</button>
    <button class="btn btn-danger" onclick="clearLearning()">Clear Learning Data</button>
    <span class="timer" id="intel-ts"></span>
  </div>
  <div class="cards" id="intel-cards"></div>
  <div class="grid2">
    <div>
      <div class="control-group">
        <h3>Ingest Knowledge Document</h3>
        <div class="input-row"><input id="ingest-title" placeholder="Document title" /></div>
        <div class="input-row"><textarea id="ingest-content" placeholder="Document content..."></textarea></div>
        <div class="input-row">
          <select id="ingest-type"><option value="manual">manual</option><option value="transcript">transcript</option><option value="article">article</option><option value="note">note</option></select>
          <button class="btn btn-primary" onclick="ingestDocument()">Ingest</button>
        </div>
      </div>
      <div class="control-group">
        <h3>Search Knowledge</h3>
        <div class="input-row"><input id="intel-query" placeholder="Search query..." /><button class="btn btn-primary" onclick="searchKnowledge()">Search</button></div>
        <div id="intel-results" class="mono"></div>
      </div>
    </div>
    <div>
      <section><h2>Learning Artifacts by Type</h2><div id="intel-types"></div></section>
      <section><h2>Knowledge Stats</h2><div id="intel-knowledge"></div></section>
    </div>
  </div>
  <section><h2>Cognitive Diagnostics</h2><div id="intel-cognitive" class="mono"></div></section>
  <div class="grid2">
    <section><h2>Learning Engine (Phase 10A)</h2><div id="intel-learning-engine" class="mono"></div></section>
    <section><h2>Vector Index (Phase 4)</h2><div id="intel-vector-index" class="mono"></div></section>
  </div>
  <section><h2>Personal Intelligence (Phase 11)</h2><div id="intel-personal" class="mono"></div></section>
</div>

<!-- ── 4. Self-Improvement ────────────────────────────────────── -->
<div id="improve" class="panel">
  <div class="actions">
    <button class="btn" onclick="loadImprove()">Refresh</button>
    <button class="btn btn-primary" onclick="runValidation('quick')">Quick Validation</button>
    <button class="btn btn-primary" onclick="runValidation('full')">Full Validation</button>
    <button class="btn" onclick="runDiagnostics()">Run Diagnostics</button>
    <span class="timer" id="improve-ts"></span>
  </div>
  <div class="cards" id="improve-cards"></div>
  <div class="grid2">
    <div>
      <section><h2>Model Performance Scores</h2><div id="improve-perf"></div></section>
      <div class="control-group">
        <h3>Repair Subsystem</h3>
        <div class="input-row">
          <select id="repair-subsystem">
            <option value="memory">memory</option>
            <option value="learning">learning</option>
            <option value="retrieval">retrieval</option>
            <option value="document_memory">document_memory</option>
            <option value="cognitive">cognitive</option>
          </select>
          <button class="btn btn-danger" onclick="repairSubsystem()">Repair</button>
        </div>
      </div>
    </div>
    <div>
      <section><h2>Learning Outcomes</h2><div id="improve-outcomes"></div></section>
      <section><h2>Validation Results</h2><div id="improve-validation" class="mono"></div></section>
      <section><h2>Diagnostics</h2><div id="improve-diagnostics" class="mono"></div></section>
    </div>
  </div>
  <div class="grid2">
    <section><h2>Self-Improvement Controller (Phase 12)</h2><div id="improve-sic" class="mono"></div></section>
    <section><h2>Memory Consolidation (Phase 3)</h2><div id="improve-consolidation" class="mono"></div></section>
  </div>
</div>

<!-- ── 5. Model Control ───────────────────────────────────────── -->
<div id="models" class="panel">
  <div class="actions">
    <button class="btn" onclick="loadModels()">Refresh</button>
    <button class="btn" onclick="discoverOllama()">Discover Ollama</button>
    <span class="timer" id="models-ts"></span>
  </div>
  <div class="cards" id="models-cards"></div>
  <div class="control-group">
    <h3>Routing Policy</h3>
    <div id="models-routing"></div>
    <div class="input-row" style="margin-top:12px">
      <select id="routing-mode"><option value="LOCAL_ONLY">LOCAL_ONLY</option><option value="COMBINATION">COMBINATION</option></select>
      <button class="btn btn-primary" onclick="setRoutingMode()">Apply Mode</button>
    </div>
  </div>
  <section><h2>Registered Models</h2><table><thead><tr><th>Provider</th><th>Model</th><th>Capabilities</th><th>Privacy</th><th>Latency</th><th>Enabled</th></tr></thead><tbody id="models-list"></tbody></table></section>
  <section><h2>Performance Records</h2><table><thead><tr><th>Model</th><th>Capability</th><th>Success Rate</th><th>Avg Latency</th><th>Uses</th></tr></thead><tbody id="models-perf"></tbody></table></section>
</div>

<!-- ── 6. Memory / Cognitive ──────────────────────────────────── -->
<div id="memory" class="panel">
  <div class="actions">
    <button class="btn" onclick="loadMemory()">Refresh</button>
    <button class="btn" onclick="triggerConsolidation()">Consolidate</button>
    <button class="btn" id="mem-toggle-btn" onclick="toggleMemory()">Toggle Memory</button>
    <button class="btn" onclick="purgeSuperseded()">Purge Superseded</button>
    <span class="timer" id="memory-ts"></span>
  </div>
  <div class="cards" id="memory-cards"></div>
  <div class="grid2">
    <div>
      <div class="control-group">
        <h3>Teach AgentX</h3>
        <div class="input-row"><textarea id="teach-content" placeholder="Teach new knowledge to AgentX..."></textarea></div>
        <div class="input-row"><input id="teach-tags" placeholder="Tags (comma-separated, optional)" /><button class="btn btn-primary" onclick="teachMemory()">Teach</button></div>
      </div>
      <div class="control-group">
        <h3>Search Cognitive Memory</h3>
        <div class="input-row"><input id="cog-query" placeholder="Search query..." /><button class="btn btn-primary" onclick="searchCognitive()">Search</button></div>
        <div id="cog-results" class="mono"></div>
      </div>
    </div>
    <div>
      <section><h2>Memory by Category</h2><div id="memory-categories"></div></section>
      <section><h2>Cognitive Services</h2><div id="memory-cognitive"></div></section>
    </div>
  </div>
</div>

<!-- ── 7. Checkpoints & Autonomy ───────────────────────────── -->
<div id="autonomy" class="panel">
  <div class="actions">
    <button class="btn" onclick="loadAutonomy()">Refresh</button>
    <button class="btn btn-primary" onclick="createCheckpoint()">Create Checkpoint</button>
    <span class="timer" id="autonomy-ts"></span>
  </div>
  <div class="cards" id="autonomy-cards"></div>
  <div class="grid2">
    <div>
      <section><h2>System Checkpoints (Phase 8)</h2><div id="autonomy-checkpoints" class="mono"></div></section>
    </div>
    <div>
      <section><h2>Intelligence Hardening (Phase 10D)</h2><div id="autonomy-hardening" class="mono"></div></section>
      <section><h2>Autonomy Gate (Phase 12.1)</h2><div id="autonomy-gate" class="mono"></div></section>
      <div class="control-group">
        <h3>Autonomy Control</h3>
        <div class="actions">
          <button class="btn" onclick="autonomyOptIn(true)">Opt In</button>
          <button class="btn" onclick="autonomyOptIn(false)">Opt Out</button>
          <button class="btn btn-primary" onclick="autonomyEscalate()">Escalate to Supervised</button>
          <button class="btn btn-danger" onclick="autonomyReset()">Reset to Suggest-Only</button>
        </div>
      </div>
    </div>
  </div>
</div>

<div id="toast"></div>

<script>
/* ── helpers ─────────────────────────────────────────────── */
function esc(s){if(!s)return '';const d=document.createElement('div');d.textContent=String(s);return d.innerHTML;}
function fmt(n){return typeof n==='number'?n.toLocaleString():String(n||0);}
function pct(n){return typeof n==='number'?(n*100).toFixed(1)+'%':n||'—';}
function ms(n){return typeof n==='number'?n.toFixed(0)+'ms':'—';}
function ago(ts){if(!ts)return '—';const d=new Date(ts);return d.toLocaleString();}
function card(label,value,cls,sub){return '<div class="card"><div class="label">'+esc(label)+'</div><div class="value'+(cls?' '+cls:'')+'">'+value+'</div>'+(sub?'<div class="sub">'+esc(sub)+'</div>':'')+'</div>';}
function bar(label,count,max,color){const p=max>0?Math.round(count/max*100):0;return '<div class="bar"><span class="bar-label">'+esc(label)+'</span><div class="bar-track"><div class="bar-fill '+(color||'blue')+'" style="width:'+p+'%"></div></div><span class="bar-count">'+fmt(count)+'</span></div>';}
function badge(text,cls){return '<span class="badge badge-'+(cls||'info')+'">'+esc(text)+'</span>';}
function tsNow(id){document.getElementById(id).textContent='Updated '+new Date().toLocaleTimeString();}
function toast(msg){const el=document.getElementById('toast');el.textContent=msg;el.style.display='block';setTimeout(()=>{el.style.display='none';},3000);}
async function api(path,opts){const r=await fetch(path,opts);if(!r.ok)throw new Error('HTTP '+r.status);return r.json();}

/* ── Tab switching ───────────────────────────────────────── */
document.querySelectorAll('.tab').forEach(t=>{
  t.addEventListener('click',()=>{
    document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(x=>x.classList.remove('active'));
    t.classList.add('active');
    document.getElementById(t.dataset.panel).classList.add('active');
  });
});

/* ── 1. System Health ────────────────────────────────────── */
async function loadHealth(){
  try{
    const [h,s]=await Promise.all([api('/api/health'),api('/api/status')]);
    const dot=document.getElementById('hdr-dot');
    const st=document.getElementById('hdr-status');
    dot.className='status-dot '+(h.ok?'ok':'err');
    st.textContent=h.ok?'Healthy':'Unhealthy';
    document.getElementById('hdr-time').textContent=new Date().toLocaleTimeString();

    let html=card('Status',h.ok?'OK':'DOWN',h.ok?'good':'bad');
    html+=card('Agent',esc(s.agentName||'—'),'');
    html+=card('Model',esc(s.model||'—'),'');
    html+=card('Active Sessions',fmt(s.activeSessions||0),'');
    document.getElementById('health-cards').innerHTML=html;

    // Supervisor
    let svcHtml='';
    try{
      const sup=await api('/api/supervisor/status');
      const svcs=sup.services||[];
      if(svcs.length===0){svcHtml='<div class="empty">No managed services</div>';}
      else{svcs.forEach(svc=>{
        const ok=svc.status==='running';
        svcHtml+='<div class="bar"><span class="bar-label">'+esc(svc.id||svc.name)+'</span>'+badge(svc.status,ok?'ok':'err')+'</div>';
      });}
    }catch(e){svcHtml='<div class="empty">Supervisor not available</div>';}
    document.getElementById('health-services').innerHTML=svcHtml;

    let rtHtml='';
    rtHtml+='<div class="bar"><span class="bar-label">Platform</span><span class="bar-count">'+esc(s.platform||navigator.platform)+'</span></div>';
    rtHtml+='<div class="bar"><span class="bar-label">Integrations</span><span class="bar-count">'+fmt((s.integrations||[]).length)+'</span></div>';
    document.getElementById('health-runtime').innerHTML=rtHtml;
    tsNow('health-ts');
  }catch(e){document.getElementById('health-cards').innerHTML='<div class="empty">Failed: '+esc(e.message)+'</div>';}
}

/* ── 2. Build Control ────────────────────────────────────── */
let killSwitchActive=false;
async function loadBuild(){
  try{
    const [stats,runs,ks]=await Promise.all([
      api('/api/builder/stats').catch(()=>({})),
      api('/api/automation/runs').catch(()=>[]),
      api('/api/automation/kill-switch').catch(()=>({active:false}))
    ]);
    killSwitchActive=ks.active||false;
    const ksBtn=document.getElementById('ks-btn');
    ksBtn.textContent=killSwitchActive?'Disable Kill Switch':'Kill Switch';
    ksBtn.className=killSwitchActive?'btn btn-danger':'btn';

    let html=card('Total Builds',fmt(stats.totalRuns||0),'');
    html+=card('Success Rate',pct(stats.successRate||0),(stats.successRate||0)>=0.7?'good':(stats.successRate||0)>=0.4?'warn':'bad');
    html+=card('Artifacts',fmt(stats.totalArtifacts||0),'');
    html+=card('Kill Switch',killSwitchActive?'ACTIVE':'Off',killSwitchActive?'bad':'good');
    document.getElementById('build-cards').innerHTML=html;

    const list=Array.isArray(runs)?runs:runs.runs||[];
    if(list.length===0){document.getElementById('build-runs').innerHTML='<tr><td colspan="5" class="empty">No builds yet</td></tr>';}
    else{document.getElementById('build-runs').innerHTML=list.slice(0,20).map(r=>{
      const ok=r.status==='completed'||r.success;
      return '<tr><td class="mono">'+esc((r.id||'').slice(0,8))+'</td><td>'+badge(r.status||'unknown',ok?'ok':'err')+'</td><td>'+fmt(r.totalTasks||r.tasks||0)+'</td><td>'+ms(r.durationMs||0)+'</td><td>'+ago(r.startedAt||r.createdAt)+'</td></tr>';
    }).join('');}
    tsNow('build-ts');
  }catch(e){document.getElementById('build-cards').innerHTML='<div class="empty">Failed: '+esc(e.message)+'</div>';}
}
async function triggerBuild(){
  try{
    toast('Starting build...');
    await api('/api/builder/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'Command Center build',description:'Triggered from Command Center'})});
    toast('Build started');
    setTimeout(loadBuild,1000);
  }catch(e){toast('Build failed: '+e.message);}
}
async function toggleKillSwitch(){
  try{
    await api('/api/automation/kill-switch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({active:!killSwitchActive})});
    toast(killSwitchActive?'Kill switch disabled':'Kill switch activated');
    setTimeout(loadBuild,500);
  }catch(e){toast('Kill switch error: '+e.message);}
}
async function loadBuildQueue(){
  try{
    const q=await api('/api/builder/queue');
    const el=document.getElementById('build-queue-status');
    if(!el)return;
    const parts=[];
    if(q.running){parts.push('<b>Running:</b> '+esc(q.running.appName)+' ('+esc(q.running.id.slice(0,12))+')');}
    else if(q.idle&&q.idle.state==='idle'){parts.push('<b>IDLE</b> — models unloaded, waiting for next task');}
    else{parts.push('<b>Ready</b> — no build running');}
    if(q.queued&&q.queued.length>0){parts.push(' | <b>Queued:</b> '+q.queued.length+' build(s)');}
    if(q.idle){parts.push(' | System: '+(q.idle.state==='idle'?'idle':'active'));}
    el.innerHTML=parts.join('');
  }catch(e){const el=document.getElementById('build-queue-status');if(el)el.innerHTML='Queue status unavailable';}
}
async function cancelBuild(){
  try{const r=await api('/api/builder/queue/cancel',{method:'POST'});toast(r.cancelled?'Build cancelled':'No build running');loadBuildQueue();}catch(e){toast('Cancel failed: '+e.message);}
}
async function clearQueue(){
  try{const r=await api('/api/builder/queue/clear',{method:'POST'});toast('Cleared '+r.cleared+' queued builds');loadBuildQueue();}catch(e){toast('Clear failed: '+e.message);}
}

/* ── 3. Intelligence ─────────────────────────────────────── */
async function loadIntel(){
  try{
    const [ls,ks,cog]=await Promise.all([
      api('/api/learning/stats').catch(()=>({})),
      api('/api/knowledge/stats').catch(()=>({})),
      api('/api/cognitive/diagnostics').catch(()=>null)
    ]);
    const a=ls.artifacts||{};const inj=ls.injections||{};const kpis=ls.kpis||{};
    let html=card('Learning Artifacts',fmt(a.total||0),'');
    html+=card('Help Rate',pct(inj.helpRate||0),(inj.helpRate||0)>=0.5?'good':'warn');
    html+=card('Knowledge Docs',fmt(ks.totalDocuments||ks.documents||0),'');
    html+=card('Knowledge Chunks',fmt(ks.totalChunks||ks.chunks||0),'');
    document.getElementById('intel-cards').innerHTML=html;

    const bt=a.byType||{};const maxBt=Math.max(...Object.values(bt),1);
    document.getElementById('intel-types').innerHTML=Object.keys(bt).length?Object.entries(bt).map(([k,v])=>bar(k,v,maxBt,'blue')).join(''):'<div class="empty">No artifacts</div>';

    let kHtml='';
    kHtml+=bar('Documents',ks.totalDocuments||ks.documents||0,Math.max(ks.totalDocuments||ks.documents||0,1),'green');
    kHtml+=bar('Chunks',ks.totalChunks||ks.chunks||0,Math.max(ks.totalChunks||ks.chunks||0,1),'blue');
    document.getElementById('intel-knowledge').innerHTML=kHtml;

    if(cog){
      const lines=Object.entries(cog).map(([k,v])=>'<div class="bar"><span class="bar-label">'+esc(k)+'</span><span class="bar-count" style="width:auto">'+esc(typeof v==='object'?JSON.stringify(v):String(v))+'</span></div>').join('');
      document.getElementById('intel-cognitive').innerHTML=lines||'<div class="empty">No diagnostics</div>';
    }else{document.getElementById('intel-cognitive').innerHTML='<div class="empty">Cognitive services not available</div>';}

    // Phase 10A: Learning Engine diagnostics
    try{
      const le=await api('/api/learning-engine/diagnostics');
      let leH=bar('Total Signals',le.totalSignals||0,Math.max(le.totalSignals||1,1),'blue');
      leH+=bar('Success Rate',Math.round((le.successRate||0)*100),100,(le.successRate||0)>=0.6?'green':'yellow');
      const subs=le.subsystemHealth||{};
      for(const[k,v]of Object.entries(subs)){leH+=bar(k+' ('+fmt(v.total)+')',Math.round(v.successRate*100),100,v.successRate>=0.6?'green':'red');}
      document.getElementById('intel-learning-engine').innerHTML=leH||'<div class="empty">No signals</div>';
    }catch(e){document.getElementById('intel-learning-engine').innerHTML='<div class="empty">Learning Engine: '+esc(e.message)+'</div>';}

    // Phase 4/4B: Vector Index diagnostics
    try{
      const vi=await api('/api/vector-index/diagnostics');
      let viH='<div style="margin:4px 0">Status: '+badge(vi.health||'unknown',(vi.health==='healthy'?'ok':vi.health==='degraded'?'warn':'err'))+'</div>';
      viH+=bar('Total Embeddings',vi.total_embeddings||0,Math.max(vi.total_embeddings||1,1),'blue');
      viH+=bar('Indexed Documents',vi.total_documents_indexed||0,Math.max(vi.total_documents_indexed||1,1),'green');
      viH+='<div style="font-size:11px;color:#8b949e;margin-top:4px">Provider: '+(vi.provider_name||'none')+(vi.provider_dimensions?' ('+vi.provider_dimensions+'d)':'')+'</div>';
      document.getElementById('intel-vector-index').innerHTML=viH;
    }catch(e){document.getElementById('intel-vector-index').innerHTML='<div class="empty">Vector Index: '+esc(e.message)+'</div>';}

    // Phase 11A/B: Personal Intelligence
    try{
      const pi=await api('/api/personal-intelligence/status');
      let piH='<div style="margin:4px 0">Task Outcomes: '+fmt(pi.totalTaskOutcomes||0)+' | Preferences: '+fmt(pi.totalPreferences||0)+'</div>';
      const prefs=pi.preferences||[];
      if(prefs.length){piH+=prefs.map(p=>'<div style="font-size:11px;margin:2px 0">'+esc(p.key)+': <strong>'+esc(p.value)+'</strong> (confidence: '+pct(p.confidence)+')</div>').join('');}
      else{piH+='<div class="empty">No preferences detected yet</div>';}
      document.getElementById('intel-personal').innerHTML=piH;
    }catch(e){document.getElementById('intel-personal').innerHTML='<div class="empty">Personal Intelligence: '+esc(e.message)+'</div>';}

    tsNow('intel-ts');
  }catch(e){document.getElementById('intel-cards').innerHTML='<div class="empty">Failed: '+esc(e.message)+'</div>';}
}
async function ingestDocument(){
  const title=document.getElementById('ingest-title').value.trim();
  const content=document.getElementById('ingest-content').value.trim();
  const sourceType=document.getElementById('ingest-type').value;
  if(!title||!content){toast('Title and content are required');return;}
  try{
    toast('Ingesting document...');
    await api('/api/knowledge/doc/ingest',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title,content,sourceType})});
    toast('Document ingested');
    document.getElementById('ingest-title').value='';
    document.getElementById('ingest-content').value='';
    loadIntel();
  }catch(e){toast('Ingest failed: '+e.message);}
}
async function searchKnowledge(){
  const query=document.getElementById('intel-query').value.trim();
  if(!query){toast('Enter a search query');return;}
  try{
    const r=await api('/api/knowledge/search',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query,limit:10})});
    const results=r.results||r||[];
    if(results.length===0){document.getElementById('intel-results').innerHTML='<div class="empty">No results</div>';return;}
    document.getElementById('intel-results').innerHTML=results.map(d=>'<div style="margin:4px 0;padding:4px 0;border-bottom:1px solid #21262d"><strong>'+esc(d.title||d.docId||'—')+'</strong> <span style="color:#8b949e">(score: '+(d.score||d.similarity||'—')+')</span><br><span style="color:#8b949e;font-size:11px">'+esc((d.content||d.text||'').slice(0,120))+'</span></div>').join('');
  }catch(e){document.getElementById('intel-results').innerHTML='<div class="empty">Search failed: '+esc(e.message)+'</div>';}
}
async function clearLearning(){
  if(!confirm('This will permanently delete all learning artifacts. Continue?'))return;
  try{
    toast('Clearing learning data...');
    await api('/api/learning',{method:'DELETE'});
    toast('Learning data cleared');
    loadIntel();
  }catch(e){toast('Clear failed: '+e.message);}
}

/* ── 4. Self-Improvement ─────────────────────────────────── */
async function loadImprove(){
  try{
    const [perf,ls]=await Promise.all([
      api('/api/models/performance').catch(()=>[]),
      api('/api/learning/stats').catch(()=>({}))
    ]);
    const kpis=ls.kpis||{};const outcomes=ls.outcomes||{};
    let html=card('1st Build Pass',pct(kpis.firstAttemptBuildSuccessRate||0),(kpis.firstAttemptBuildSuccessRate||0)>=0.6?'good':'warn');
    html+=card('Avg Confidence',typeof (ls.artifacts||{}).avgConfidence==='number'?(ls.artifacts.avgConfidence).toFixed(2):'—','');
    const perfList=Array.isArray(perf)?perf:perf.records||[];
    const avgSuccess=perfList.length?perfList.reduce((s,p)=>s+(p.successRate||0),0)/perfList.length:0;
    html+=card('Model Avg Success',pct(avgSuccess),avgSuccess>=0.7?'good':avgSuccess>=0.4?'warn':'bad');
    html+=card('Performance Records',fmt(perfList.length),'');
    document.getElementById('improve-cards').innerHTML=html;

    // Performance bars
    if(perfList.length){
      const maxUses=Math.max(...perfList.map(p=>p.successCount+p.failureCount||1));
      document.getElementById('improve-perf').innerHTML=perfList.map(p=>{
        const uses=(p.successCount||0)+(p.failureCount||0);
        const rate=uses>0?(p.successCount||0)/uses:0;
        const color=rate>=0.7?'green':rate>=0.4?'yellow':'red';
        return bar(p.model+' ('+p.capability+')',uses,maxUses,color);
      }).join('');
    }else{document.getElementById('improve-perf').innerHTML='<div class="empty">No performance data</div>';}

    // Learning outcomes
    const oc=(outcomes).byType||{};
    if(Object.keys(oc).length){
      const maxOc=Math.max(...Object.values(oc),1);
      document.getElementById('improve-outcomes').innerHTML=Object.entries(oc).map(([k,v])=>bar(k,v,maxOc,'blue')).join('');
    }else{document.getElementById('improve-outcomes').innerHTML='<div class="empty">No outcome data</div>';}

    // Phase 12: Self-Improvement Controller
    try{
      const sic=await api('/api/self-improvement/status');
      let sicH='<div style="margin:4px 0">Suggestions: '+fmt(sic.suggestions)+' (pending: '+fmt(sic.pendingSuggestions)+')</div>';
      sicH+='<div style="margin:4px 0">Proposals: '+fmt(sic.proposals)+' (pending: '+fmt(sic.pendingProposals)+')</div>';
      sicH+='<div style="margin:4px 0;font-size:11px;color:#8b949e">Mode: supervised (auto-apply disabled)</div>';
      const recent=sic.recentProposals||[];
      if(recent.length){sicH+='<div style="margin-top:8px"><strong>Recent Proposals:</strong></div>';recent.slice(-5).forEach(p=>{sicH+='<div style="font-size:11px;margin:2px 0;color:#8b949e">'+badge(p.status||'unknown',p.status==='proposed'?'info':p.status==='applied'?'ok':'warn')+' '+esc(p.reason||'').slice(0,100)+'</div>';});}
      document.getElementById('improve-sic').innerHTML=sicH;
    }catch(e){document.getElementById('improve-sic').innerHTML='<div class="empty">Self-improvement: '+esc(e.message)+'</div>';}

    // Phase 3: Consolidation status
    try{
      const cs=await api('/api/memory/consolidation-status');
      let csH='<div style="margin:4px 0">Scheduled: '+badge(cs.scheduled?'Active':'Inactive',cs.scheduled?'ok':'warn')+' (every '+fmt(cs.intervalMinutes)+' min)</div>';
      csH+='<div style="margin:4px 0">Total Runs: '+fmt(cs.totalRuns)+'</div>';
      if(cs.lastReport){
        csH+=bar('Merged',cs.lastReport.memoriesMerged||0,Math.max(cs.lastReport.memoriesMerged||1,1),'green');
        csH+=bar('Decayed',cs.lastReport.memoriesDecayed||0,Math.max(cs.lastReport.memoriesDecayed||1,1),'yellow');
        csH+=bar('Archived',cs.lastReport.memoriesArchived||0,Math.max(cs.lastReport.memoriesArchived||1,1),'blue');
        csH+='<div style="font-size:11px;color:#8b949e">Duration: '+ms(cs.lastReport.durationMs)+'</div>';
      }else{csH+='<div class="empty">No consolidation runs yet</div>';}
      document.getElementById('improve-consolidation').innerHTML=csH;
    }catch(e){document.getElementById('improve-consolidation').innerHTML='<div class="empty">Consolidation: '+esc(e.message)+'</div>';}

    tsNow('improve-ts');
  }catch(e){document.getElementById('improve-cards').innerHTML='<div class="empty">Failed: '+esc(e.message)+'</div>';}
}
async function runValidation(mode){
  try{
    toast('Running '+mode+' validation...');
    const r=await api('/api/validation/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode,deterministic:true})});
    const rpt=r.report||r||{};
    let html='<div style="margin:4px 0">'+badge('Score: '+pct(rpt.overallScore||0),((rpt.overallScore||0)>=0.7?'ok':'warn'))+'  ';
    html+=badge('Passed: '+(rpt.passed||0),'ok')+' '+badge('Failed: '+(rpt.failed||0),(rpt.failed>0?'err':'ok'))+' '+badge('Errors: '+(rpt.errors||0),(rpt.errors>0?'err':'ok'))+'</div>';
    if((rpt.suggestions||[]).length){html+='<div style="margin-top:8px;color:#8b949e"><strong>Suggestions:</strong></div>';rpt.suggestions.forEach(s=>{html+='<div style="margin:2px 0;font-size:11px;color:#8b949e">'+esc(s.subsystem||'')+': '+esc(s.suggestedFix||s.issue||'')+'</div>';});}
    document.getElementById('improve-validation').innerHTML=html;
    toast('Validation complete: '+fmt(rpt.passed||0)+' passed, '+fmt(rpt.failed||0)+' failed');
    loadImprove();
  }catch(e){toast('Validation failed: '+e.message);document.getElementById('improve-validation').innerHTML='<div class="empty">'+esc(e.message)+'</div>';}
}
async function runDiagnostics(){
  try{
    toast('Running diagnostics...');
    const r=await api('/api/integrity/run-diagnostics',{method:'POST'});
    const rpt=r.report||r||{};
    const st=rpt.overallState||rpt.state||'unknown';
    const checks=Array.isArray(rpt.checks)?rpt.checks:[];
    const nChecks=checks.length||(rpt.checkCount||0);
    const nFail=rpt.failures!=null?rpt.failures:checks.filter(c=>c.status==='fail'||c.status==='error').length;
    const nWarn=rpt.warnings!=null?rpt.warnings:checks.filter(c=>c.status==='warn'||c.status==='warning').length;
    let html='<div style="margin:4px 0">State: '+badge(st,(st==='healthy'?'ok':st==='degraded'?'warn':'err'))+'</div>';
    html+='<div style="margin:4px 0;color:#8b949e">Checks: '+fmt(nChecks)+' | Failures: '+fmt(nFail)+' | Warnings: '+fmt(nWarn)+'</div>';
    document.getElementById('improve-diagnostics').innerHTML=html;
    toast('Diagnostics: '+st);
  }catch(e){toast('Diagnostics failed: '+e.message);document.getElementById('improve-diagnostics').innerHTML='<div class="empty">'+esc(e.message)+'</div>';}
}
async function repairSubsystem(){
  const subsystem=document.getElementById('repair-subsystem').value;
  if(!confirm('Repair subsystem "'+subsystem+'"? This may restart services.')){return;}
  try{
    toast('Repairing '+subsystem+'...');
    await api('/api/integrity/repair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subsystem})});
    toast('Repair initiated for '+subsystem);
    setTimeout(()=>{runDiagnostics();},1000);
  }catch(e){toast('Repair failed: '+e.message);}
}

/* ── 5. Model Control ────────────────────────────────────── */
async function loadModels(){
  try{
    const [mdls,routing,perf]=await Promise.all([
      api('/api/models'),
      api('/api/models/routing').catch(()=>({})),
      api('/api/models/performance').catch(()=>[])
    ]);
    const list=Array.isArray(mdls)?mdls:mdls.models||[];
    const perfList=Array.isArray(perf)?perf:perf.records||[];

    let html=card('Total Models',fmt(list.length),'');
    const enabled=list.filter(m=>m.enabled!==false).length;
    html+=card('Enabled',fmt(enabled),'good');
    const local=list.filter(m=>m.privacyLevel==='local').length;
    html+=card('Local',fmt(local),'');
    html+=card('Cloud',fmt(list.length-local),'');
    document.getElementById('models-cards').innerHTML=html;

    // Routing
    let rHtml='';
    rHtml+='<div class="bar"><span class="bar-label">Mode</span><span class="bar-count" style="width:auto">'+badge(routing.mode||routing.currentMode||'unknown','info')+'</span></div>';
    rHtml+='<div class="bar"><span class="bar-label">Local First</span><span class="bar-count" style="width:auto">'+(routing.localFirst!==false?badge('Yes','ok'):badge('No','warn'))+'</span></div>';
    if(routing.maxLocalFailuresBeforeCloud!=null)rHtml+='<div class="bar"><span class="bar-label">Cloud Escalation After</span><span class="bar-count" style="width:auto">'+routing.maxLocalFailuresBeforeCloud+' failures</span></div>';
    document.getElementById('models-routing').innerHTML=rHtml;

    // Model list
    if(list.length===0){document.getElementById('models-list').innerHTML='<tr><td colspan="6" class="empty">No models registered</td></tr>';}
    else{document.getElementById('models-list').innerHTML=list.map(m=>'<tr><td>'+esc(m.provider)+'</td><td class="mono">'+esc(m.model||m.name)+'</td><td>'+(m.capabilities||[]).map(c=>badge(c,'info')).join(' ')+'</td><td>'+badge(m.privacyLevel||'unknown',m.privacyLevel==='local'?'ok':'warn')+'</td><td>'+ms(m.avgLatencyMs)+'</td><td>'+badge(m.enabled!==false?'Yes':'No',m.enabled!==false?'ok':'err')+'</td></tr>').join('');}

    // Performance
    if(perfList.length===0){document.getElementById('models-perf').innerHTML='<tr><td colspan="5" class="empty">No performance data</td></tr>';}
    else{document.getElementById('models-perf').innerHTML=perfList.map(p=>{
      const rate=p.successRate!=null?p.successRate:((p.successCount||0)/Math.max((p.successCount||0)+(p.failureCount||0),1));
      return '<tr><td class="mono">'+esc(p.model)+'</td><td>'+esc(p.capability)+'</td><td>'+badge(pct(rate),rate>=0.7?'ok':rate>=0.4?'warn':'err')+'</td><td>'+ms(p.avgLatencyMs)+'</td><td>'+fmt((p.successCount||0)+(p.failureCount||0))+'</td></tr>';
    }).join('');}
    tsNow('models-ts');
  }catch(e){document.getElementById('models-cards').innerHTML='<div class="empty">Failed: '+esc(e.message)+'</div>';}
}
async function discoverOllama(){
  try{
    toast('Discovering Ollama models...');
    const r=await api('/api/models/ollama');
    toast('Found '+(Array.isArray(r)?r.length:(r.models||[]).length)+' Ollama models');
    loadModels();
  }catch(e){toast('Ollama discovery failed: '+e.message);}
}
async function setRoutingMode(){
  const mode=document.getElementById('routing-mode').value;
  try{
    toast('Setting routing mode to '+mode+'...');
    await api('/api/models/routing',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode})});
    toast('Routing mode set to '+mode);
    loadModels();
  }catch(e){toast('Routing mode change failed: '+e.message);}
}

/* ── 6. Memory / Cognitive ───────────────────────────────── */
async function loadMemory(){
  try{
    const [ms,stats,cog]=await Promise.all([
      api('/api/memory/status').catch(()=>({})),
      api('/api/memory/stats').catch(()=>({})),
      api('/api/cognitive/diagnostics').catch(()=>null)
    ]);
    memoryEnabled=ms.enabled!==false;
    const tb=document.getElementById('mem-toggle-btn');
    if(tb){tb.textContent=memoryEnabled?'Disable Memory':'Enable Memory';tb.className=memoryEnabled?'btn':'btn btn-primary';}
    let html=card('Memory',memoryEnabled?'Enabled':'Disabled',memoryEnabled?'good':'warn');
    html+=card('Facts',fmt(stats.facts||stats.totalFacts||0),'');
    html+=card('Preferences',fmt(stats.preferences||stats.totalPreferences||0),'');
    html+=card('Categorized',fmt(stats.categorized||stats.totalCategorized||0),'');
    document.getElementById('memory-cards').innerHTML=html;

    // Categories
    const cats=stats.byCategory||stats.categories||{};
    if(Object.keys(cats).length){
      const maxCat=Math.max(...Object.values(cats).map(v=>typeof v==='number'?v:(v.count||0)),1);
      document.getElementById('memory-categories').innerHTML=Object.entries(cats).map(([k,v])=>{
        const count=typeof v==='number'?v:(v.count||0);
        return bar(k,count,maxCat,'green');
      }).join('');
    }else{document.getElementById('memory-categories').innerHTML='<div class="empty">No categorized memories</div>';}

    // Cognitive
    if(cog){
      const keys=['entityIndex','ftsIndex','learning','vector','retrieval','ranking','detector'];
      let cogHtml='';
      keys.forEach(k=>{
        if(cog[k]){
          const status=cog[k].healthy!==false?'ok':'err';
          cogHtml+='<div class="bar"><span class="bar-label">'+esc(k)+'</span>'+badge(cog[k].healthy!==false?'healthy':'unhealthy',status)+'</div>';
        }
      });
      document.getElementById('memory-cognitive').innerHTML=cogHtml||'<div class="empty">No cognitive service data</div>';
    }else{document.getElementById('memory-cognitive').innerHTML='<div class="empty">Cognitive services not available</div>';}
    tsNow('memory-ts');
  }catch(e){document.getElementById('memory-cards').innerHTML='<div class="empty">Failed: '+esc(e.message)+'</div>';}
}
async function triggerConsolidation(){
  try{
    toast('Consolidating memory...');
    await api('/api/memory/consolidate',{method:'POST'});
    toast('Consolidation complete');
    setTimeout(loadMemory,500);
  }catch(e){toast('Consolidation failed: '+e.message);}
}
let memoryEnabled=true;
async function toggleMemory(){
  try{
    memoryEnabled=!memoryEnabled;
    toast((memoryEnabled?'Enabling':'Disabling')+' memory...');
    await api('/api/memory/toggle',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:memoryEnabled})});
    toast('Memory '+(memoryEnabled?'enabled':'disabled'));
    loadMemory();
  }catch(e){toast('Toggle failed: '+e.message);}
}
async function teachMemory(){
  const content=document.getElementById('teach-content').value.trim();
  const tagsStr=document.getElementById('teach-tags').value.trim();
  if(!content){toast('Content is required');return;}
  const tags=tagsStr?tagsStr.split(',').map(t=>t.trim()).filter(Boolean):undefined;
  try{
    toast('Teaching AgentX...');
    await api('/api/memory/teach',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content,tags})});
    toast('Knowledge taught successfully');
    document.getElementById('teach-content').value='';
    document.getElementById('teach-tags').value='';
    loadMemory();
  }catch(e){toast('Teach failed: '+e.message);}
}
async function purgeSuperseded(){
  if(!confirm('Purge all superseded facts?'))return;
  try{
    toast('Purging superseded facts...');
    await api('/api/memory/facts/purge-superseded',{method:'POST'});
    toast('Superseded facts purged');
    loadMemory();
  }catch(e){toast('Purge failed: '+e.message);}
}
async function searchCognitive(){
  const query=document.getElementById('cog-query').value.trim();
  if(!query){toast('Enter a search query');return;}
  try{
    const r=await api('/api/cognitive/search',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query,topK:10})});
    const results=r.results||r||[];
    if(results.length===0){document.getElementById('cog-results').innerHTML='<div class="empty">No results</div>';return;}
    document.getElementById('cog-results').innerHTML=results.map(d=>'<div style="margin:4px 0;padding:4px 0;border-bottom:1px solid #21262d"><strong>'+esc(d.title||d.id||'—')+'</strong> <span style="color:#8b949e">(score: '+((d.score||d.similarity||0)).toFixed(3)+')</span><br><span style="color:#8b949e;font-size:11px">'+esc((d.content||d.text||d.chunk||'').slice(0,120))+'</span></div>').join('');
  }catch(e){document.getElementById('cog-results').innerHTML='<div class="empty">Search failed: '+esc(e.message)+'</div>';}
}

/* ── 7. Checkpoints & Autonomy ──────────────────────────── */
async function loadAutonomy(){
  try{
    const [cps,ih,ag]=await Promise.all([
      api('/api/checkpoints').catch(()=>({checkpoints:[],diagnostics:{}})),
      api('/api/intelligence-hardening/diagnostics').catch(()=>({})),
      api('/api/autonomy/status').catch(()=>({}))
    ]);

    let html=card('Checkpoints',fmt(cps.diagnostics?.totalCheckpoints||0),'');
    html+=card('Signals Accepted',fmt(ih.signalsAccepted||0),'good');
    html+=card('Signals Rejected',fmt(ih.signalsRejected||0),ih.signalsRejected>0?'warn':'');
    html+=card('Autonomy Level',esc(ag.currentLevel||'SUGGEST_ONLY'),(ag.currentLevel||'SUGGEST_ONLY')==='SUGGEST_ONLY'?'':'good');
    document.getElementById('autonomy-cards').innerHTML=html;

    // Checkpoints list
    const cpList=cps.checkpoints||[];
    if(cpList.length){
      document.getElementById('autonomy-checkpoints').innerHTML=cpList.slice(0,10).map(cp=>'<div style="margin:4px 0;padding:4px;border-bottom:1px solid #21262d">'+badge(cp.valid?'valid':'invalid',cp.valid?'ok':'err')+' <strong>'+esc(cp.name)+'</strong> <span style="color:#8b949e;font-size:11px">'+ago(cp.timestamp)+'</span><br><span style="font-size:11px;color:#8b949e">Signals: '+fmt(cp.state?.learningSignalCount||0)+' | Builds: '+fmt(cp.state?.buildQueueCompleted||0)+' | Embeddings: '+fmt(cp.state?.vectorEmbeddingCount||0)+'</span></div>').join('');
    }else{document.getElementById('autonomy-checkpoints').innerHTML='<div class="empty">No checkpoints yet</div>';}

    // Hardening
    let ihH='<div style="margin:4px 0">Drift: '+badge(ih.driftDetected?'DETECTED':'None',ih.driftDetected?'err':'ok')+'</div>';
    ihH+=bar('Accepted',ih.signalsAccepted||0,Math.max((ih.signalsAccepted||0)+(ih.signalsRejected||0),1),'green');
    ihH+=bar('Rejected',ih.signalsRejected||0,Math.max((ih.signalsAccepted||0)+(ih.signalsRejected||0),1),'red');
    const reasons=ih.rejectionReasons||{};
    if(Object.keys(reasons).length){ihH+='<div style="margin-top:4px;font-size:11px;color:#8b949e">Reasons: '+Object.entries(reasons).map(([k,v])=>esc(k)+': '+fmt(v)).join(', ')+'</div>';}
    document.getElementById('autonomy-hardening').innerHTML=ihH;

    // Autonomy gate
    let agH='<div style="margin:4px 0">Level: '+badge(ag.currentLevel||'SUGGEST_ONLY',(ag.currentLevel||'SUGGEST_ONLY')==='SUPERVISED'?'ok':'info')+'</div>';
    agH+='<div style="margin:4px 0">User Opt-in: '+badge(ag.userOptIn?'Yes':'No',ag.userOptIn?'ok':'warn')+'</div>';
    const r=ag.readiness||{};
    agH+='<div style="margin:4px 0">Ready for Supervised: '+badge(r.ready?'Yes':'No',r.ready?'ok':'warn')+'</div>';
    if((r.blockers||[]).length){agH+='<div style="margin-top:4px;font-size:11px;color:#8b949e">Blockers:<br>'+r.blockers.map(b=>'• '+esc(b)).join('<br>')+'</div>';}
    agH+='<div style="font-size:11px;color:#8b949e;margin-top:4px">Builds: '+fmt(ag.successfulBuilds||0)+' | Signals: '+fmt(ag.totalSignals||0)+'</div>';
    document.getElementById('autonomy-gate').innerHTML=agH;

    tsNow('autonomy-ts');
  }catch(e){document.getElementById('autonomy-cards').innerHTML='<div class="empty">Failed: '+esc(e.message)+'</div>';}
}
async function createCheckpoint(){
  try{
    toast('Creating checkpoint...');
    const r=await api('/api/checkpoints',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'manual-'+new Date().toISOString().slice(0,19),description:'Manual checkpoint from Command Center'})});
    toast('Checkpoint created: '+r.name);
    loadAutonomy();
  }catch(e){toast('Failed: '+e.message);}
}
async function autonomyOptIn(val){
  try{await api('/api/autonomy/opt-in',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({optIn:val})});toast('Opt-in: '+val);loadAutonomy();}catch(e){toast('Failed: '+e.message);}
}
async function autonomyEscalate(){
  if(!confirm('Escalate to SUPERVISED autonomy? Self-improvement proposals with high confidence may be auto-applied.'))return;
  try{const r=await api('/api/autonomy/escalate',{method:'POST'});if(r.escalated){toast('Escalated to SUPERVISED');}else{toast('Blocked: '+r.blockers.join(', '));}loadAutonomy();}catch(e){toast('Failed: '+e.message);}
}
async function autonomyReset(){
  if(!confirm('Reset autonomy to SUGGEST_ONLY?'))return;
  try{await api('/api/autonomy/reset',{method:'POST'});toast('Reset to SUGGEST_ONLY');loadAutonomy();}catch(e){toast('Failed: '+e.message);}
}

/* ── Auto-refresh ────────────────────────────────────────── */
function loadAll(){loadHealth();loadBuild();loadBuildQueue();loadIntel();loadImprove();loadModels();loadMemory();loadAutonomy();}
loadAll();
setInterval(loadAll,15000);
</script>
</body>
</html>`;

/**
 * Function-shaped export used by the /api/command-center route handler in
 * api.ts. That route dynamic-imports `renderCommandCenter` and calls it;
 * this wrapper bridges the older `COMMAND_CENTER_HTML` constant so the
 * Dashboard tab returns the real HTML instead of a 501 envelope.
 */
export function renderCommandCenter(): string {
  return COMMAND_CENTER_HTML;
}
