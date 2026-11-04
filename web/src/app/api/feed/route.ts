import WebSocket from 'ws';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request:Request) {
 const url=new URL(process.env.WHALE_WS_URL||`${(process.env.WHALE_API_URL||'http://127.0.0.1:8787').replace(/\/$/,'')}/api/events`);
 url.protocol=url.protocol==='https:'?'wss:':url.protocol==='http:'?'ws:':url.protocol;
 let socket:WebSocket; let heartbeat:ReturnType<typeof setInterval>; let closed=false;
 const encoder=new TextEncoder();
 const stream=new ReadableStream({start(controller){
  const close=()=>{if(closed)return;closed=true;clearInterval(heartbeat);socket?.terminate();try{controller.close();}catch{}};
  const send=(data:string)=>{if(!closed)controller.enqueue(encoder.encode(data));};
  socket=new WebSocket(url,{headers:{'ngrok-skip-browser-warning':'1'},handshakeTimeout:10000});
  socket.on('message',data=>{try{send(`data: ${JSON.stringify(JSON.parse(data.toString()))}\n\n`);}catch{}});
  socket.on('error',close);socket.on('close',close);
  heartbeat=setInterval(()=>send(': keepalive\n\n'),15000);
  request.signal.addEventListener('abort',close,{once:true});
 },cancel(){closed=true;clearInterval(heartbeat);socket?.terminate();}});
 return new Response(stream,{headers:{'content-type':'text/event-stream','cache-control':'no-cache, no-transform','connection':'keep-alive'}});
}
