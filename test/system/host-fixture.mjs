import http from 'node:http';

export class HostFixtureServer {
  async start() {
    this.server=http.createServer((request,response)=>{
      const url=new URL(request.url ?? '/','http://127.0.0.1');
      if(url.pathname!=='/host') { response.writeHead(404); response.end(); return; }
      response.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});
      response.end(HOST_PAGE);
    });
    await new Promise((resolve)=>this.server.listen(0,'127.0.0.1',resolve));
    this.origin=`http://127.0.0.1:${this.server.address().port}`;
    return this;
  }
  url() { return new URL('/host',this.origin).toString(); }
  async close() {
    if(!this.server) return;
    await new Promise((resolve,reject)=>this.server.close((error)=>error?reject(error):resolve()));
  }
}

const HOST_PAGE=`<!doctype html><html><head><meta charset="utf-8"><title>Sync system host</title></head>
<body><canvas id="source" width="640" height="360"></canvas><script>
const fixture=window.__SYNC_HOST_CONFIG;
if(!fixture) throw new Error('Missing host fixture configuration');
const api=new URL(fixture.apiBase);
const socketUrl=new URL('/api/signaling',api);
socketUrl.protocol=socketUrl.protocol==='https:'?'wss:':'ws:';
socketUrl.searchParams.set('ticket',fixture.ticket);
const forceRelay=fixture.forceRelay===true;
window.__hostReady=false; window.__messages=[]; window.__channels=[]; window.__ended=[]; window.__peer=null;
const canvas=document.querySelector('#source'); const context=canvas.getContext('2d'); let frame=0;
setInterval(()=>{ frame+=1; context.fillStyle=frame%2?'#145c4b':'#173b47'; context.fillRect(0,0,640,360);
  context.fillStyle='#ffffff'; context.font='36px sans-serif'; context.fillText('Sync system '+frame,130,190); },80);
const stream=canvas.captureStream(12); const socket=new WebSocket(socketUrl); let currentSession=null; let pending=[];
socket.onopen=()=>{window.__hostReady=true};
socket.onclose=()=>{window.__socketClosed=true};
socket.onmessage=async(event)=>{
  const message=JSON.parse(event.data);
  if(message.type==='session-start') { await createPeer(message.session,message.iceServers); return; }
  if(message.type==='session-ended') { window.__ended.push(message); window.__peer?.close(); window.__peer=null; currentSession=null; return; }
  const peer=window.__peer;
  if(!peer || message.sessionId!==currentSession?.id) return;
  if(message.type==='offer') {
    await peer.setRemoteDescription({type:'offer',sdp:message.sdp});
    for(const candidate of pending.splice(0)) await peer.addIceCandidate(candidate);
    const answer=await peer.createAnswer(); await peer.setLocalDescription(answer);
    socket.send(JSON.stringify({type:'answer',sessionId:currentSession.id,sdp:answer.sdp}));
  } else if(message.type==='ice' && message.candidate) {
    if(peer.remoteDescription) await peer.addIceCandidate(message.candidate); else pending.push(message.candidate);
  }
};
async function createPeer(session,iceServers) {
  window.__peer?.close(); currentSession=session; pending=[];
  const peer=new RTCPeerConnection({iceServers,iceTransportPolicy:forceRelay?'relay':'all'}); window.__peer=peer;
  peer.addTrack(stream.getVideoTracks()[0],stream);
  peer.ondatachannel=(event)=>{ const channel=event.channel;
    window.__channels.push({label:channel.label,ordered:channel.ordered,maxRetransmits:channel.maxRetransmits});
    channel.onmessage=(received)=>{ const parsed=JSON.parse(received.data); window.__messages.push(parsed);
      if(channel.readyState==='open') channel.send(received.data); };
  };
  peer.onicecandidate=(event)=>{ if(event.candidate && socket.readyState===WebSocket.OPEN) socket.send(JSON.stringify({
    type:'ice',sessionId:session.id,candidate:event.candidate.toJSON()})); };
}
window.__selectedCandidate=async()=>{
  const peer=window.__peer; if(!peer) return null; const stats=await peer.getStats();
  for(const report of stats.values()) if(report.type==='candidate-pair' && report.state==='succeeded' && report.nominated) {
    const local=stats.get(report.localCandidateId); const remote=stats.get(report.remoteCandidateId);
    return {local:local?.candidateType??null,remote:remote?.candidateType??null};
  }
  return null;
};
</script></body></html>`;
