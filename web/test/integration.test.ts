import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PrivateKey, decrypt } from 'eciesjs';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { bytesToHex, hexToBytes, parseTransaction, recoverMessageAddress, decodeFunctionData } from 'viem';
import { amount, money, csv, parseCsv, api, submit, proposeData, treasuryAbi, ApiError, type Status } from '../src/lib/whale';
import { GET, POST } from '../src/app/api/backend/[...path]/route';

const privateKey=generatePrivateKey();const signer=privateKeyToAccount(privateKey);const account={privateKey,address:signer.address,label:'Test'};
test('amount parsing preserves precision and rejects invalid amounts',()=>{
 assert.equal(amount('9007199254.740993'),9007199254740993n);assert.equal(money('9007199254740993'),'9,007,199,254.740993');
 for(const invalid of ['1e3','-1','0','1.0000001','NaN','', '9'.repeat(100)])assert.throws(()=>amount(invalid));
});
test('CSV validates header, rows, and exact units',()=>{
 assert.deepEqual(csv(`\uFEFFaddress,amount\r\n${account.address},1.123456`),[{address:account.address,amount:'1123456'}]);
 for(const invalid of [`bad,header\n${account.address},1`,`address,amount\ninvalid,1`,`address,amount\n${account.address},-1`,`address,amount\n${account.address},1,2`,`address,amount\n${Array(101).fill(`${account.address},1`).join('\n')}`])assert.throws(()=>csv(invalid));
});
test('read authentication signs the backend message and preserves denied responses',async()=>{
 const original=global.fetch;
 global.fetch=async(_url,init)=>{const h=init!.headers as Record<string,string>;assert.equal(await recoverMessageAddress({message:`whale-read:${h['x-timestamp']}`,signature:h['x-signature'] as `0x${string}`}),account.address);return Response.json({error:'denied',message:'Access denied'},{status:403});};
 try{await assert.rejects(api(`balance/${account.address}`,account),(e:unknown)=>e instanceof ApiError&&e.status===403);}finally{global.fetch=original;}
});
test('proposal is signed for private chain then encrypted using operator-compatible ECIES',async()=>{
 const original=global.fetch;const operator=new PrivateKey();let submitted=false;
 const status={chainIds:{domain:7777}} as Status;
 global.fetch=async(url,init)=>{
  if(String(url).includes('/nonce/'))return Response.json({nonce:7});
  if(String(url).endsWith('/crypto'))return Response.json({publicKey:bytesToHex(operator.publicKey.toBytes(false))});
  const body=JSON.parse(init!.body as string);assert.equal(body.gasLimit,'12000000');
  const raw=bytesToHex(decrypt(operator.secret,hexToBytes(body.ciphertext)));
  const tx=parseTransaction(raw);assert.equal(tx.chainId,7777);assert.equal(tx.nonce,7);assert.equal(tx.gasPrice??0n,0n);assert.equal(tx.to?.toLowerCase(),account.address.toLowerCase());
  const call=decodeFunctionData({abi:treasuryAbi,data:tx.data!});assert.equal(call.functionName,'propose');submitted=true;return Response.json({id:'0x1234',hubTx:'0x1234'});
 };
 try{await submit(account,status,proposeData([{address:account.address,amount:'1234567'}],'Review'),account.address);assert.ok(submitted);}finally{global.fetch=original;}
});
test('proxy blocks admin routes, cross-origin writes and account export by default',async()=>{
 const ctx=(...path:string[])=>({params:Promise.resolve({path})});
 assert.equal((await POST(new Request('http://localhost/api/backend/demo/reset',{method:'POST'}),ctx('demo','reset'))).status,404);
 assert.equal((await POST(new Request('http://localhost/api/backend/submit',{method:'POST',headers:{origin:'https://other.test'}}),ctx('submit'))).status,403);
 delete process.env.WHALE_ENABLE_TEST_ACCOUNTS;
 assert.equal((await GET(new Request('http://localhost/api/backend/demo/accounts'),ctx('demo','accounts'))).status,403);
});
test('proxy forwards only read-auth headers, disables caching and handles upstream failure',async()=>{
 const original=global.fetch;process.env.WHALE_API_URL='https://backend.example';
 global.fetch=async(url,init)=>{assert.equal(String(url),'https://backend.example/api/status');const headers=init!.headers as Headers;assert.equal(headers.get('ngrok-skip-browser-warning'),'1');assert.equal(headers.get('x-admin-token'),null);assert.equal(init!.cache,'no-store');return Response.json({epoch:2});};
 try{const r=await GET(new Request('http://localhost/api/backend/status',{headers:{'x-admin-token':'not-forwarded'}}),{params:Promise.resolve({path:['status']})});assert.equal(r.headers.get('cache-control'),'no-store');assert.deepEqual(await r.json(),{epoch:2});global.fetch=async()=>{throw new Error('offline');};assert.equal((await GET(new Request('http://localhost/api/backend/status'),{params:Promise.resolve({path:['status']})})).status,503);}finally{global.fetch=original;delete process.env.WHALE_API_URL;}
});
test('CSV preview reports every bad row inline and keeps the valid ones',()=>{
 const a=account.address;
 const r=parseCsv(`address,amount\n${a},10\nnot-an-address,5\n${a},3\n0x000000000000000000000000000000000000dEaD,-1\n0x000000000000000000000000000000000000bEEF,2.5`);
 assert.equal(r.error,undefined);assert.deepEqual(r.lines.map(l=>[l.line,!!l.error]),[[2,false],[3,true],[4,true],[5,true],[6,false]]);
 assert.match(r.lines[2].error!,/more than once/);assert.deepEqual(r.rows.map(x=>x.amount),['10000000','2500000']);
 assert.match(parseCsv('wallet,value\nx,1').error!,/header/);
});
