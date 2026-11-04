const readPaths = /^(status|crypto|whoami|treasury|batches(?:\/\d+(?:\/payment\/0x[a-fA-F0-9]{40})?)?|nonce\/0x[a-fA-F0-9]{40}|balance\/0x[a-fA-F0-9]{40}|payments\/0x[a-fA-F0-9]{40}|withdrawals\/0x[a-fA-F0-9]{40}|receipts\/0x[a-fA-F0-9]{40}\/\d+|public\/hub-events|demo\/accounts)$/;
const writePaths = /^(submit|quote|claim|receipts\/verify)$/;
export const dynamic = 'force-dynamic';
async function proxy(request: Request, context: {params: Promise<{path:string[]}>}) {
 const path = (await context.params).path.join('/');
 if (!(request.method === 'GET' ? readPaths : writePaths).test(path)) return Response.json({message:'Endpoint unavailable.'},{status:404});
 if (request.method==='POST' && request.headers.get('origin') && request.headers.get('origin')!==new URL(request.url).origin) return Response.json({message:'Origin not allowed.'},{status:403});
 if (path==='demo/accounts' && process.env.WHALE_ENABLE_TEST_ACCOUNTS!=='1') return Response.json({message:'Test account access is disabled. Set WHALE_ENABLE_TEST_ACCOUNTS=1 for a trusted testnet environment.'},{status:403});
 const headers = new Headers({'content-type':'application/json','ngrok-skip-browser-warning':'1'});
 for (const name of ['x-address','x-timestamp','x-signature']) { const value=request.headers.get(name); if(value)headers.set(name,value); }
 try {
  const body=request.method==='POST'?await request.text():undefined;
  if(body && body.length>400000)return Response.json({message:'Request is too large.'},{status:413});
  const upstream=await fetch(`${(process.env.WHALE_API_URL||'http://127.0.0.1:8787').replace(/\/$/,'')}/api/${path}${new URL(request.url).search}`,{method:request.method,headers,body,cache:'no-store',signal:AbortSignal.timeout(45000),redirect:'error'});
  const text=await upstream.text();
  try { JSON.parse(text); } catch {return Response.json({message:'The backend returned an unexpected response. Check its URL.'},{status:502});}
  return new Response(text,{status:upstream.status,headers:{'content-type':'application/json','cache-control':'no-store'}});
 } catch {return Response.json({message:'The payment service is unavailable. Check the backend connection and retry.'},{status:503});}
}
export const GET=proxy; export const POST=proxy;
