import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import express from "express";
import chalk from "chalk";
import {
  TuttiRuntime,
  ScoreLoader,
  createLogger,
} from "@tuttiai/core";
import type { Response as ExpressResponse } from "express";

const logger = createLogger("tutti-studio");
const envPort = Number.parseInt(process.env.PORT ?? "", 10);
const PORT = Number.isInteger(envPort) && envPort > 0 && envPort <= 65535 ? envPort : 4747;

function safeStringify(obj: unknown): string {
  return JSON.stringify(obj, (_key, value: unknown) => {
    if (value instanceof Error) return { message: value.message, name: value.name };
    if (typeof value === "function") return undefined;
    return value;
  });
}

function openBrowser(url: string): void {
  if (process.platform === "win32") {
    execFile("cmd.exe", ["/c", "start", "", url]);
    return;
  }
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  execFile(cmd, [url]);
}

export async function studioCommand(scorePath?: string): Promise<void> {
  const file = resolve(scorePath ?? "./tutti.score.ts");

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path built via resolve()
  if (!existsSync(file)) {
    logger.error({ file }, "Score file not found");
    console.error(chalk.dim('Run "tutti-ai init" to create a new project.'));
    process.exit(1);
  }

  let score;
  try {
    score = await ScoreLoader.load(file);
  } catch (err) {
    logger.error({ error: err instanceof Error ? err.message : String(err) }, "Failed to load score");
    process.exit(1);
  }

  const runtime = new TuttiRuntime(score);

  // Track sessions via events
  const sessionRegistry = new Map<string, { agent_name: string; created_at: Date }>();
  runtime.events.on("agent:start", (e) => {
    if (!sessionRegistry.has(e.session_id)) {
      sessionRegistry.set(e.session_id, { agent_name: e.agent_name, created_at: new Date() });
    }
  });

  // SSE clients
  const sseClients = new Set<ExpressResponse>();
  runtime.events.onAny((event) => {
    const data = safeStringify(event);
    for (const client of sseClients) {
      client.write("event: tutti\ndata: " + data + "\n\n");
    }
  });

  // Express
  const app = express();
  app.use(express.json());

  // SSE endpoint
  app.get("/events", (_req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(":\n\n");
    sseClients.add(res);
    _req.on("close", () => sseClients.delete(res));
  });

  // REST API
  app.get("/api/score", (_req, res) => {
    const agents = Object.fromEntries(
      Object.entries(runtime.score.agents).map(([id, agent]) => [
        id,
        {
          name: agent.name,
          description: agent.description,
          model: agent.model,
          role: agent.role,
          delegates: agent.delegates,
          voice_count: agent.voices.length,
          voices: agent.voices.map((v) => v.name),
        },
      ]),
    );
    res.json({
      name: runtime.score.name,
      description: runtime.score.description,
      default_model: runtime.score.default_model,
      entry: runtime.score.entry,
      agents,
    });
  });

  app.get("/api/sessions", (_req, res) => {
    const sessions = Array.from(sessionRegistry.entries()).map(([id, meta]) => {
      const session = runtime.getSession(id);
      return {
        id,
        agent_name: meta.agent_name,
        message_count: session?.messages.length ?? 0,
        created_at: meta.created_at,
      };
    });
    res.json(sessions.reverse());
  });

  app.get("/api/sessions/:id", (req, res) => {
    const session = runtime.getSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    res.json(session);
  });

  app.post("/api/run", async (req, res) => {
    const body: unknown = req.body;
    if (typeof body !== "object" || body === null) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }
    const agent = (body as Record<string, unknown>).agent;
    const input = (body as Record<string, unknown>).input;
    const session_id = (body as Record<string, unknown>).session_id;
    if (typeof agent !== "string" || agent.trim().length === 0) {
      res.status(400).json({ error: "agent must be a non-empty string" });
      return;
    }
    if (typeof input !== "string" || input.trim().length === 0) {
      res.status(400).json({ error: "input must be a non-empty string" });
      return;
    }
    if (session_id !== undefined && (typeof session_id !== "string" || session_id.trim().length === 0)) {
      res.status(400).json({ error: "session_id must be a non-empty string when provided" });
      return;
    }
    try {
      const result = await runtime.run(agent, input, session_id);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Serve UI
  app.get("/", (_req, res) => {
    res.type("html").send(getStudioHtml());
  });

  app.listen(PORT, () => {
    const url = "http://localhost:" + PORT;
    console.log();
    console.log(chalk.bold("  Tutti Studio"));
    console.log(chalk.dim("  " + url));
    console.log();
    console.log(chalk.dim("  Score: ") + (runtime.score.name ?? file));
    console.log(chalk.dim("  Agents: ") + Object.keys(runtime.score.agents).join(", "));
    console.log();
    openBrowser(url);
  });

  process.on("SIGINT", () => {
    console.log(chalk.dim("\nShutting down Tutti Studio..."));
    process.exit(0);
  });
}

// ---------------------------------------------------------------------------
// Inline HTML UI
// ---------------------------------------------------------------------------

function getStudioHtml(): string {
  return '<!DOCTYPE html>\
<html lang="en">\
<head>\
<meta charset="utf-8">\
<meta name="viewport" content="width=device-width,initial-scale=1">\
<title>Tutti Studio</title>\
<style>\
*{margin:0;padding:0;box-sizing:border-box}\
:root{\
--bg:#0a0a0f;--panel:#12121a;--card:#1a1a26;--input:#0f0f17;\
--border:#2a2a3a;--text:#e2e8f0;--muted:#64748b;\
--purple:#8b5cf6;--teal:#14b8a6;--blue:#3b82f6;--green:#10b981;\
--red:#ef4444;--orange:#f97316;--amber:#f59e0b;--indigo:#6366f1;\
}\
html,body{height:100%;font-family:system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--text);font-size:13px}\
#app{display:flex;flex-direction:column;height:100vh}\
\
header{display:flex;align-items:center;justify-content:space-between;padding:10px 20px;border-bottom:1px solid var(--border);background:var(--panel)}\
header .logo{font-weight:700;font-size:15px;letter-spacing:.5px}\
header .logo span{color:var(--purple)}\
header .meta{color:var(--muted);font-size:12px}\
header .status{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--muted)}\
header .dot{width:7px;height:7px;border-radius:50%;background:var(--green)}\
header .dot.off{background:var(--red)}\
\
main{display:grid;grid-template-columns:260px 1fr 280px;flex:1;overflow:hidden;border-bottom:1px solid var(--border)}\
\
.panel{display:flex;flex-direction:column;border-right:1px solid var(--border);overflow:hidden}\
.panel:last-child{border-right:none}\
.panel-title{padding:10px 14px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.8px;color:var(--muted);border-bottom:1px solid var(--border);background:var(--panel);flex-shrink:0}\
.panel-body{flex:1;overflow-y:auto;padding:10px}\
.panel-body::-webkit-scrollbar{width:5px}\
.panel-body::-webkit-scrollbar-track{background:transparent}\
.panel-body::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}\
\
#graph-panel .panel-body{padding:0;display:flex;align-items:center;justify-content:center}\
#graph-panel svg text{font-family:system-ui,-apple-system,sans-serif}\
\
#events-panel{display:flex;flex-direction:column}\
#event-stream{flex:1;overflow-y:auto;padding:10px}\
#event-stream::-webkit-scrollbar{width:5px}\
#event-stream::-webkit-scrollbar-track{background:transparent}\
#event-stream::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}\
\
.ev{padding:7px 10px;margin-bottom:6px;border-radius:6px;background:var(--card);border-left:3px solid var(--muted);font-size:12px;line-height:1.5}\
.ev .ev-head{display:flex;justify-content:space-between;align-items:center}\
.ev .ev-type{font-weight:600;font-family:"SF Mono",Menlo,monospace;font-size:11px}\
.ev .ev-time{color:var(--muted);font-size:10px;font-family:"SF Mono",Menlo,monospace}\
.ev .ev-detail{color:var(--muted);margin-top:3px;font-size:11px;word-break:break-all}\
.ev.agent{border-left-color:var(--purple)}.ev.agent .ev-type{color:var(--purple)}\
.ev.turn{border-left-color:var(--blue)}.ev.turn .ev-type{color:var(--blue)}\
.ev.llm{border-left-color:var(--green)}.ev.llm .ev-type{color:var(--green)}\
.ev.tool{border-left-color:var(--teal)}.ev.tool .ev-type{color:var(--teal)}\
.ev.tool-error{border-left-color:var(--red)}.ev.tool-error .ev-type{color:var(--red)}\
.ev.security{border-left-color:var(--orange)}.ev.security .ev-type{color:var(--orange)}\
.ev.budget-warn{border-left-color:var(--amber)}.ev.budget-warn .ev-type{color:var(--amber)}\
.ev.budget-exceed{border-left-color:var(--red)}.ev.budget-exceed .ev-type{color:var(--red)}\
.ev.delegate{border-left-color:var(--indigo)}.ev.delegate .ev-type{color:var(--indigo)}\
\
#input-bar{display:flex;gap:8px;padding:10px 12px;border-top:1px solid var(--border);background:var(--panel);flex-shrink:0}\
#agent-select{background:var(--input);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:6px 10px;font-size:12px;outline:none;cursor:pointer;min-width:110px}\
#user-input{flex:1;background:var(--input);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:6px 12px;font-size:13px;outline:none}\
#user-input:focus{border-color:var(--purple)}\
#send-btn{background:var(--purple);color:#fff;border:none;border-radius:6px;padding:6px 16px;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap}\
#send-btn:hover{opacity:.9}\
#send-btn:disabled{opacity:.4;cursor:default}\
\
.session-item{padding:8px 10px;margin-bottom:4px;border-radius:6px;background:var(--card);cursor:pointer;transition:background .15s}\
.session-item:hover{background:#22223a}\
.session-item.active{background:#22223a;border:1px solid var(--purple)}\
.session-id{font-family:"SF Mono",Menlo,monospace;font-size:11px;color:var(--purple)}\
.session-meta{font-size:11px;color:var(--muted);margin-top:2px}\
\
#session-detail{margin-top:10px;border-top:1px solid var(--border);padding-top:10px}\
.msg{padding:6px 8px;margin-bottom:4px;border-radius:5px;font-size:12px;line-height:1.5;word-break:break-word}\
.msg.user{background:#1c1c3a;border-left:2px solid var(--blue)}\
.msg.assistant{background:#1a2a1a;border-left:2px solid var(--green)}\
.msg .msg-role{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px}\
.msg.user .msg-role{color:var(--blue)}\
.msg.assistant .msg-role{color:var(--green)}\
\
footer{display:flex;align-items:center;gap:32px;padding:8px 20px;background:var(--panel);font-size:12px}\
.token-item{display:flex;align-items:center;gap:6px}\
.token-label{color:var(--muted)}\
.token-val{font-family:"SF Mono",Menlo,monospace;font-weight:600}\
.token-val.input{color:var(--blue)}\
.token-val.output{color:var(--green)}\
.token-val.cost{color:var(--amber)}\
\
.empty{color:var(--muted);text-align:center;padding:30px 10px;font-size:12px}\
</style>\
</head>\
<body>\
<div id="app">\
\
<header>\
  <div class="logo"><span>&#9835;</span> Tutti Studio</div>\
  <div class="meta" id="score-name"></div>\
  <div class="status"><div class="dot" id="sse-dot"></div><span id="sse-label">connecting</span></div>\
</header>\
\
<main>\
  <div class="panel" id="graph-panel">\
    <div class="panel-title">Agent Graph</div>\
    <div class="panel-body" id="graph-body"></div>\
  </div>\
\
  <div class="panel" id="events-panel">\
    <div class="panel-title">Live Event Stream</div>\
    <div id="event-stream"><div class="empty">Waiting for events&hellip;<br>Send a message below to start an agent run.</div></div>\
    <div id="input-bar">\
      <select id="agent-select"></select>\
      <input id="user-input" placeholder="Type a message&hellip;" autocomplete="off">\
      <button id="send-btn">Send</button>\
    </div>\
  </div>\
\
  <div class="panel" id="sessions-panel">\
    <div class="panel-title">Sessions</div>\
    <div class="panel-body" id="sessions-body"><div class="empty">No sessions yet</div></div>\
  </div>\
</main>\
\
<footer>\
  <div class="token-item"><span class="token-label">&#x2193; Input</span><span class="token-val input" id="tok-in">0</span></div>\
  <div class="token-item"><span class="token-label">&#x2191; Output</span><span class="token-val output" id="tok-out">0</span></div>\
  <div class="token-item"><span class="token-label">$ Est. cost</span><span class="token-val cost" id="tok-cost">0.0000</span></div>\
</footer>\
\
</div>\
\
<script>\
(function(){\
\
var tokIn=0,tokOut=0;\
var sessionMap={};\
var activeSession=null;\
\
/* ---- helpers ---- */\
function esc(s){var d=document.createElement("div");d.textContent=s;return d.innerHTML}\
function fmt(n){return n.toLocaleString()}\
function timeStr(){var d=new Date();return ("0"+d.getHours()).slice(-2)+":"+("0"+d.getMinutes()).slice(-2)+":"+("0"+d.getSeconds()).slice(-2)}\
function truncId(id){return id.slice(0,8)}\
\
/* ---- score + graph ---- */\
function loadScore(){\
  fetch("/api/score").then(function(r){return r.json()}).then(function(s){\
    document.getElementById("score-name").textContent=s.name||"tutti.score.ts";\
    var sel=document.getElementById("agent-select");\
    sel.innerHTML="";\
    Object.keys(s.agents).forEach(function(id){\
      var o=document.createElement("option");o.value=id;o.textContent=s.agents[id].name;sel.appendChild(o);\
    });\
    renderGraph(s);\
  });\
}\
\
function renderGraph(score){\
  var body=document.getElementById("graph-body");\
  var W=260,ids=Object.keys(score.agents),N=ids.length;\
  if(N===0){body.innerHTML="<div class=\\"empty\\">No agents</div>";return}\
  var hasDelegate=false;\
  ids.forEach(function(id){if(score.agents[id].delegates&&score.agents[id].delegates.length)hasDelegate=true});\
  var nodeR=26,padY=90,padTop=50;\
  var leftIds=[],rightIds=[];\
  if(hasDelegate){\
    ids.forEach(function(id){var a=score.agents[id];if(a.delegates&&a.delegates.length)leftIds.push(id);else rightIds.push(id)});\
  }else{leftIds=ids}\
  var cols=hasDelegate?2:1;\
  var cx1=cols===1?W/2:72,cx2=W-72;\
  var H=Math.max(leftIds.length,rightIds.length)*padY+padTop*2;\
  if(H<200)H=200;\
  var pos={};\
  var svg=\'<svg xmlns="http://www.w3.org/2000/svg" width="\'+W+\'" height="\'+H+\'" viewBox="0 0 \'+W+" "+H+\'">\';\
  svg+=\'<defs><marker id="ah" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0L10 5L0 10z" fill="#64748b"/></marker></defs>\';\
  function drawNode(id,cx,cy){\
    var a=score.agents[id];\
    var col=a.role==="orchestrator"?"#8b5cf6":"#14b8a6";\
    pos[id]={x:cx,y:cy};\
    svg+=\'<circle cx="\'+cx+\'" cy="\'+cy+\'" r="\'+nodeR+\'" fill="\'+col+\'" fill-opacity="0.15" stroke="\'+col+\'" stroke-width="2"/>\';\
    svg+=\'<text x="\'+cx+\'" y="\'+(cy+4)+\'" text-anchor="middle" fill="#e2e8f0" font-size="10" font-weight="600">\'+esc(a.name)+\'</text>\';\
    var model=a.model||score.default_model||"";\
    if(model){var sh=model.replace(/-\\d{8}$/,"");if(sh.length>18)sh=sh.slice(0,18)+"\\u2026";svg+=\'<text x="\'+cx+\'" y="\'+(cy+nodeR+14)+\'" text-anchor="middle" fill="#64748b" font-size="9">\'+esc(sh)+\'</text>\'}\
    svg+=\'<text x="\'+cx+\'" y="\'+(cy+nodeR+26)+\'" text-anchor="middle" fill="#64748b" font-size="9">\'+a.voice_count+" voice"+(a.voice_count!==1?"s":"")+\'</text>\';\
  }\
  leftIds.forEach(function(id,i){drawNode(id,cx1,padTop+i*padY)});\
  rightIds.forEach(function(id,i){drawNode(id,cx2,padTop+i*padY)});\
  ids.forEach(function(id){\
    var a=score.agents[id];\
    if(a.delegates)a.delegates.forEach(function(did){\
      if(pos[id]&&pos[did]){\
        var x1=pos[id].x+nodeR,y1=pos[id].y,x2=pos[did].x-nodeR,y2=pos[did].y;\
        var mx=(x1+x2)/2;\
        svg+=\'<path d="M\'+x1+" "+y1+" C"+mx+" "+y1+" "+mx+" "+y2+" "+x2+" "+y2+\'" fill="none" stroke="#64748b" stroke-width="1.5" stroke-dasharray="4 3" marker-end="url(#ah)"/>\';\
      }\
    });\
  });\
  svg+="</svg>";\
  body.innerHTML=svg;\
}\
\
/* ---- SSE ---- */\
function connectSSE(){\
  var es=new EventSource("/events");\
  es.addEventListener("tutti",function(e){\
    var ev=JSON.parse(e.data);\
    addEvent(ev);\
    if(ev.type==="llm:response"&&ev.response&&ev.response.usage){\
      tokIn+=ev.response.usage.input_tokens||0;\
      tokOut+=ev.response.usage.output_tokens||0;\
      document.getElementById("tok-in").textContent=fmt(tokIn);\
      document.getElementById("tok-out").textContent=fmt(tokOut);\
      document.getElementById("tok-cost").textContent=estimateCost(tokIn,tokOut);\
    }\
    if(ev.type==="agent:start"||ev.type==="agent:end")refreshSessions();\
  });\
  es.onopen=function(){document.getElementById("sse-dot").className="dot";document.getElementById("sse-label").textContent="connected"};\
  es.onerror=function(){document.getElementById("sse-dot").className="dot off";document.getElementById("sse-label").textContent="disconnected"};\
}\
\
/* Pricing: USD per 1M tokens (Sonnet-class default) */\
var INPUT_PRICE_PER_MILLION=3;\
var OUTPUT_PRICE_PER_MILLION=15;\
function estimateCost(inp,out){\
  var c=(inp/1e6)*INPUT_PRICE_PER_MILLION+(out/1e6)*OUTPUT_PRICE_PER_MILLION;\
  return c.toFixed(4);\
}\
\
function evClass(t){\
  if(t.indexOf("agent")===0)return "agent";\
  if(t.indexOf("turn")===0)return "turn";\
  if(t==="llm:request"||t==="llm:response")return "llm";\
  if(t==="tool:error")return "tool-error";\
  if(t.indexOf("tool")===0)return "tool";\
  if(t.indexOf("security")===0)return "security";\
  if(t==="budget:warning")return "budget-warn";\
  if(t==="budget:exceeded")return "budget-exceed";\
  if(t.indexOf("delegate")===0)return "delegate";\
  return "";\
}\
\
function evDetail(ev){\
  var parts=[];\
  if(ev.agent_name)parts.push("agent: "+ev.agent_name);\
  if(ev.session_id)parts.push("session: "+truncId(ev.session_id));\
  if(ev.turn!==undefined)parts.push("turn: "+ev.turn);\
  if(ev.tool_name)parts.push("tool: "+ev.tool_name);\
  if(ev.from)parts.push("from: "+ev.from);\
  if(ev.to)parts.push("to: "+ev.to);\
  if(ev.tokens!==undefined)parts.push("tokens: "+fmt(ev.tokens));\
  if(ev.cost_usd!==undefined)parts.push("cost: $"+ev.cost_usd.toFixed(4));\
  if(ev.response&&ev.response.usage)parts.push("tokens: "+fmt(ev.response.usage.input_tokens)+" in / "+fmt(ev.response.usage.output_tokens)+" out");\
  if(ev.error){var em=typeof ev.error==="object"?ev.error.message||"":ev.error;if(em)parts.push("error: "+em)}\
  if(ev.patterns)parts.push("patterns: "+ev.patterns.join(", "));\
  return parts.join(" &middot; ");\
}\
\
var firstEvent=true;\
function addEvent(ev){\
  var stream=document.getElementById("event-stream");\
  if(firstEvent){stream.innerHTML="";firstEvent=false}\
  var div=document.createElement("div");\
  div.className="ev "+evClass(ev.type);\
  div.innerHTML=\'<div class="ev-head"><span class="ev-type">\'+esc(ev.type)+\'</span><span class="ev-time">\'+timeStr()+\'</span></div>\';\
  var det=evDetail(ev);\
  if(det)div.innerHTML+=\'<div class="ev-detail">\'+det+"</div>";\
  stream.appendChild(div);\
  stream.scrollTop=stream.scrollHeight;\
}\
\
/* ---- sessions ---- */\
function refreshSessions(){\
  fetch("/api/sessions").then(function(r){return r.json()}).then(function(list){\
    var body=document.getElementById("sessions-body");\
    if(!list.length){body.innerHTML=\'<div class="empty">No sessions yet</div>\';return}\
    var html="";\
    list.forEach(function(s){\
      var cls="session-item"+(activeSession===s.id?" active":"");\
      html+=\'<div class="\'+cls+\'" data-id="\'+s.id+\'">\';\
      html+=\'<div class="session-id">\'+truncId(s.id)+"</div>";\
      html+=\'<div class="session-meta">\'+esc(s.agent_name)+" &middot; "+s.message_count+" msgs</div>";\
      html+="</div>";\
    });\
    if(activeSession)html+=\'<div id="session-detail"></div>\';\
    body.innerHTML=html;\
    body.querySelectorAll(".session-item").forEach(function(el){\
      el.addEventListener("click",function(){selectSession(el.getAttribute("data-id"))});\
    });\
    if(activeSession)loadSessionDetail(activeSession);\
  });\
}\
\
function selectSession(id){\
  activeSession=activeSession===id?null:id;\
  refreshSessions();\
}\
\
function loadSessionDetail(id){\
  var det=document.getElementById("session-detail");\
  if(!det)return;\
  fetch("/api/sessions/"+id).then(function(r){return r.json()}).then(function(session){\
    if(!session||session.error){det.innerHTML=\'<div class="empty">Session not found</div>\';return}\
    var html="";\
    (session.messages||[]).forEach(function(m){\
      var role=m.role;\
      var text="";\
      if(typeof m.content==="string")text=m.content;\
      else if(Array.isArray(m.content)){\
        m.content.forEach(function(b){\
          if(b.type==="text")text+=b.text+"\\n";\
          else if(b.type==="tool_use")text+="[tool_use: "+b.name+"]\\n";\
          else if(b.type==="tool_result")text+="[tool_result]\\n";\
        });\
      }\
      html+=\'<div class="msg \'+role+\'"><div class="msg-role">\'+role+"</div>"+esc(text.trim())+"</div>";\
    });\
    det.innerHTML=html;\
  });\
}\
\
/* ---- send ---- */\
function sendMessage(){\
  var agentSel=document.getElementById("agent-select");\
  var inputEl=document.getElementById("user-input");\
  var btn=document.getElementById("send-btn");\
  var agent=agentSel.value;\
  var input=inputEl.value.trim();\
  if(!input)return;\
  btn.disabled=true;btn.textContent="Running\\u2026";\
  inputEl.value="";\
  var sid=sessionMap[agent]||undefined;\
  fetch("/api/run",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({agent:agent,input:input,session_id:sid})})\
    .then(function(r){return r.json()})\
    .then(function(result){\
      if(result.session_id)sessionMap[agent]=result.session_id;\
      if(result.output){\
        addEvent({type:"__output",agent_name:agent,output:result.output});\
      }\
      refreshSessions();\
    })\
    .catch(function(err){addEvent({type:"__error",error:err.message||String(err)})})\
    .finally(function(){btn.disabled=false;btn.textContent="Send"});\
}\
\
document.getElementById("send-btn").addEventListener("click",sendMessage);\
document.getElementById("user-input").addEventListener("keydown",function(e){if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();sendMessage()}});\
\
/* ---- init ---- */\
loadScore();\
connectSSE();\
\
})();\
</script>\
</body>\
</html>';
}
