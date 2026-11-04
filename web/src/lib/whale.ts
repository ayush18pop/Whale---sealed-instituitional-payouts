import { bytesToHex, hexToBytes, encodeFunctionData, parseAbi, parseUnits, formatUnits, keccak256, stringToHex, isAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { encrypt } from 'eciesjs';
export type Account = {address:Address; privateKey:Hex; label:string};
export type Accounts = {finance:Omit<Account,'label'>;approvers:Omit<Account,'label'>[];auditor:Omit<Account,'label'>;payees:Omit<Account,'label'>[]};
export type Status = {serverTime:number;epoch:number;demoMode:boolean;chainIds:{monad:number;domain:number};contracts:{treasury:Address;domainToken:Address;hub:Address;bridge:Address;tUSDC:Address;tUSDT:Address};operator:{status:string;monadWsConnected:boolean};monad?:{head:string;lastDomainBlock:string};explorer:string};
export type Batch={id:string;proposer:Address;status:string;approvals:number;total:string;payeeCount:number;approvedBy?:Address[];payees?:{payee:Address;amount:string}[]};
export type Treasury={balance:string;threshold:number;batchCount:string;address:Address;financeLead:Address;approvers:Address[]};
export type Payment={batchId:string;amount:string;paidAt:number;domainBlock?:string;monadBlock?:string};
export type Withdrawal={nonce:string;kind:number;status:string;amount?:string;amountIn?:string;claimTx:Hex|null;resultTx?:Hex|null;domainBlock:string;claimAsInput?:{args:{domainBlock:string;w:{payee:Address;tokenIn:Address;tokenOut:Address;amountIn:string;minOut:string;maxFee:string;nonce:string};salt:Hex;proof:Hex[]}}};
export type Quote={expectedNet:string;suggestedMinOut:string;suggestedMaxFee:string;relayerFee:string;poolFeeBps:number;simulated:boolean};
export type Feed={type:string;[key:string]:unknown;epoch?:number;id?:string;hubTx?:string;domainBlock?:string;txs?:{id:string;status?:string;reason?:string;receivedToExecutedMs?:number}[]};
export class ApiError extends Error {constructor(message:string,public status:number,public code?:string){super(message);}}
export async function api<T>(path:string,account?:Account,body?:unknown):Promise<T>{
 const headers:Record<string,string>={'content-type':'application/json'};
 if(account){const timestamp=String(Math.floor(Date.now()/1000));headers['x-address']=account.address;headers['x-timestamp']=timestamp;headers['x-signature']=await privateKeyToAccount(account.privateKey).signMessage({message:`whale-read:${timestamp}`});}
 const response=await fetch(`/api/backend/${path}`,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body),cache:'no-store',signal:AbortSignal.timeout(50000)});
 const result=await response.json();if(!response.ok)throw new ApiError(result.message||'Request failed.',response.status,result.error);return result;
}
export const treasuryAbi=parseAbi(['function propose(address[] payees,uint256[] amounts,bytes32 memoHash) returns (uint256)','function approve(uint256 batchId)']);
export const tokenAbi=parseAbi(['function requestWithdrawal(uint256 amount) returns (uint256)','function requestSwapWithdrawal(uint256 amount,address tokenOut,uint256 minOut,uint256 maxFee) returns (uint256)']);
export function amount(value:string){if(!/^\d+(\.\d{1,6})?$/.test(value.trim()))throw new Error('Enter a positive amount with at most six decimal places.');const n=parseUnits(value.trim(),6);if(n<=0n)throw new Error('Amount must be greater than zero.');if(n>2n**256n-1n)throw new Error('Amount exceeds the supported range.');return n;}
export function money(value:string|undefined){if(value===undefined)return '—';const [whole,fraction='']=formatUnits(BigInt(value),6).split('.');return `${BigInt(whole).toLocaleString('en-US')}.${fraction.padEnd(2,'0')}`;}
export type CsvLine={line:number;address:string;amountText:string;amount?:string;error?:string};
/** Parses a payout CSV and reports every problem per row, so the preview can show them inline. */
export function parseCsv(text:string):{lines:CsvLine[];rows:{address:Address;amount:string}[];error?:string}{
 const all=text.replace(/^\uFEFF/,'').trim().split(/\r?\n/);
 if(all.shift()?.trim().toLowerCase()!=='address,amount')return {lines:[],rows:[],error:'CSV header must be address,amount.'};
 const body=all.filter(l=>l.trim()!=='');
 if(!body.length||body.length>100)return {lines:[],rows:[],error:'Add between 1 and 100 recipients.'};
 const seen=new Set<string>();
 const lines=body.map((raw,i):CsvLine=>{
  const [address='',amountText='',...extra]=raw.split(',').map(x=>x.trim());const line={line:i+2,address,amountText};
  if(extra.length)return {...line,error:'Use exactly two columns: address and amount.'};
  if(!isAddress(address,{strict:false}))return {...line,error:'Enter a valid wallet address.'};
  if(seen.has(address.toLowerCase()))return {...line,error:'This address appears more than once.'};
  seen.add(address.toLowerCase());
  try{return {...line,amount:amount(amountText).toString()};}catch(e){return {...line,error:(e as Error).message};}
 });
 return {lines,rows:lines.filter(l=>!l.error).map(l=>({address:l.address as Address,amount:l.amount!}))};
}
export function csv(text:string){const parsed=parseCsv(text);if(parsed.error)throw new Error(parsed.error);const bad=parsed.lines.find(l=>l.error);if(bad)throw new Error(`Row ${bad.line}: ${bad.error}`);return parsed.rows;}
export const short=(address:string)=>`${address.slice(0,6)}…${address.slice(-4)}`;
export function proposeData(rows:{address:Address;amount:string}[],memo:string){return encodeFunctionData({abi:treasuryAbi,functionName:'propose',args:[rows.map(r=>r.address),rows.map(r=>BigInt(r.amount)),keccak256(stringToHex(memo))]});}
export async function submit(account:Account,status:Status,data:Hex,to:Address){
 const [nonce,crypto]=await Promise.all([api<{nonce:number}>(`nonce/${account.address}`,account),api<{publicKey:Hex}>('crypto')]);
 const gas=12000000n;
 const raw=await privateKeyToAccount(account.privateKey).signTransaction({chainId:status.chainIds.domain,type:'legacy',gasPrice:0n,gas,value:0n,nonce:nonce.nonce,to,data});
 const ciphertext=bytesToHex(encrypt(hexToBytes(crypto.publicKey),hexToBytes(raw)));
 return api<{id:Hex;hubTx:Hex}>('submit',undefined,{ciphertext,gasLimit:gas.toString()});
}
