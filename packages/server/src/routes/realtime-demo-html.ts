/**
 * Static HTML for `GET /realtime-demo`.
 *
 * Captures microphone input as 16-bit PCM via an `AudioWorkletNode`,
 * sends base64 frames over `/realtime`, and plays back base64 PCM
 * deltas using a small queue feeding a `ScriptProcessorNode`-free
 * `AudioBufferSourceNode` chain. Designed to be self-contained — one
 * file, no build step — so a working voice loop is one CLI flag away.
 */

export const realtimeDemoHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Tutti Realtime Demo</title>
  <style>
    body { font: 14px/1.5 system-ui, sans-serif; margin: 2rem; max-width: 720px; }
    h1 { margin: 0 0 0.5rem; font-size: 1.4rem; }
    .row { display: flex; gap: 0.5rem; align-items: center; margin: 0.5rem 0; }
    button { padding: 0.5rem 0.9rem; border-radius: 6px; border: 1px solid #ccc; background: #fff; cursor: pointer; }
    button[disabled] { opacity: 0.5; cursor: not-allowed; }
    input { padding: 0.4rem; border-radius: 6px; border: 1px solid #ccc; min-width: 240px; }
    #log { border: 1px solid #ddd; border-radius: 6px; padding: 0.75rem; height: 320px; overflow-y: auto; background: #fafafa; font-family: ui-monospace, monospace; font-size: 12px; }
    .user { color: #0a4; }
    .assistant { color: #04a; }
    .tool { color: #a40; }
    .err { color: #a00; }
    .meta { color: #888; }
  </style>
</head>
<body>
  <h1>Tutti Realtime Demo</h1>
  <div class="row">
    <label>API key <input id="apiKey" type="password" placeholder="bearer token" /></label>
    <button id="connect">Connect</button>
    <button id="disconnect" disabled>Disconnect</button>
  </div>
  <div class="row">
    <button id="mic" disabled>Start microphone</button>
    <input id="text" type="text" placeholder="Type a message and press Enter" />
  </div>
  <div id="log"></div>
  <script type="module">
    const SAMPLE_RATE = 24000;
    const log = document.getElementById('log');
    const connectBtn = document.getElementById('connect');
    const disconnectBtn = document.getElementById('disconnect');
    const micBtn = document.getElementById('mic');
    const apiKeyInput = document.getElementById('apiKey');
    const textInput = document.getElementById('text');

    let ws, audioCtx, micNode, micStream, playbackTime = 0;

    function appendLog(text, cls) {
      const div = document.createElement('div');
      div.className = cls || 'meta';
      div.textContent = text;
      log.appendChild(div);
      log.scrollTop = log.scrollHeight;
    }
    function b64ToPCM16(b64) {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
    }
    function pcm16ToBase64(samples) {
      const bytes = new Uint8Array(samples.buffer);
      let s = '';
      for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      return btoa(s);
    }
    function play(pcm) {
      if (!audioCtx) return;
      const buf = audioCtx.createBuffer(1, pcm.length, SAMPLE_RATE);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
      const src = audioCtx.createBufferSource();
      src.buffer = buf;
      src.connect(audioCtx.destination);
      const start = Math.max(audioCtx.currentTime, playbackTime);
      src.start(start);
      playbackTime = start + buf.duration;
    }
    async function startMic() {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: { sampleRate: SAMPLE_RATE, channelCount: 1, echoCancellation: true } });
      const workletURL = URL.createObjectURL(new Blob([
        \`class P extends AudioWorkletProcessor{
          process(inputs){const ch=inputs[0]?.[0];if(!ch||!ch.length)return true;
            const pcm=new Int16Array(ch.length);
            for(let i=0;i<ch.length;i++){const s=Math.max(-1,Math.min(1,ch[i]));pcm[i]=s<0?s*32768:s*32767;}
            this.port.postMessage(pcm);return true;}}
          registerProcessor('pcm-capture',P);\`
      ], { type: 'application/javascript' }));
      await audioCtx.audioWorklet.addModule(workletURL);
      micNode = new AudioWorkletNode(audioCtx, 'pcm-capture');
      micNode.port.onmessage = (e) => {
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'audio', data: pcm16ToBase64(e.data) }));
      };
      audioCtx.createMediaStreamSource(micStream).connect(micNode);
      micBtn.textContent = 'Stop microphone';
      appendLog('[mic on]');
    }
    function stopMic() {
      micStream?.getTracks().forEach((t) => t.stop());
      micStream = null;
      micNode?.disconnect();
      micNode = null;
      micBtn.textContent = 'Start microphone';
      appendLog('[mic off]');
    }
    connectBtn.onclick = () => {
      const key = apiKeyInput.value.trim();
      if (!key) return appendLog('API key required', 'err');
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(proto + '//' + location.host + '/realtime?api_key=' + encodeURIComponent(key));
      audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });
      ws.onopen = () => { connectBtn.disabled = true; disconnectBtn.disabled = false; micBtn.disabled = false; appendLog('[connected]'); };
      ws.onmessage = (ev) => {
        const f = JSON.parse(ev.data);
        if (f.type === 'audio') play(b64ToPCM16(f.data));
        else if (f.type === 'transcript') appendLog((f.role === 'user' ? 'you: ' : 'agent: ') + f.text, f.role);
        else if (f.type === 'tool:call') appendLog('tool call: ' + f.name + ' ' + JSON.stringify(f.args), 'tool');
        else if (f.type === 'tool:result') appendLog('tool result: ' + f.name + ' → ' + f.result.content, 'tool');
        else if (f.type === 'interrupt') appendLog('interrupt: ' + f.tool_name + ' (' + f.interrupt_id + ')', 'err');
        else if (f.type === 'error') appendLog('error: ' + f.message, 'err');
        else if (f.type === 'end') appendLog('[end: ' + f.reason + ']');
        else if (f.type === 'ready') appendLog('[ready: ' + f.model + ' / ' + f.voice + ']');
      };
      ws.onclose = (ev) => { connectBtn.disabled = false; disconnectBtn.disabled = true; micBtn.disabled = true; if (micStream) stopMic(); appendLog('[closed: ' + ev.code + ']'); };
      ws.onerror = () => appendLog('[ws error]', 'err');
    };
    disconnectBtn.onclick = () => ws?.close();
    micBtn.onclick = () => { if (micStream) stopMic(); else void startMic(); };
    textInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !textInput.value.trim()) return;
      ws?.send(JSON.stringify({ type: 'text', content: textInput.value }));
      appendLog('you: ' + textInput.value, 'user');
      textInput.value = '';
    });
  </script>
</body>
</html>`;
