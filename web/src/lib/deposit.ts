import { createWalletClient, createPublicClient, custom, http, defineChain, parseAbi, type Address, type EIP1193Provider } from 'viem';
import type { Status } from './whale';
const abi=parseAbi(['function approve(address spender,uint256 amount) returns (bool)','function deposit(address token,uint256 amount,address domainRecipient) returns (uint256)']);
export async function depositFunds(status:Status,recipient:Address,amount:bigint){
 const provider=(window as unknown as {ethereum?:EIP1193Provider}).ethereum;
 if(!provider)throw new Error('Install or enable a browser wallet to deposit funds.');
 const chain=defineChain({id:10143,name:'Monad Testnet',nativeCurrency:{name:'MON',symbol:'MON',decimals:18},rpcUrls:{default:{http:['https://testnet-rpc.monad.xyz']}}});
 const wallet=createWalletClient({chain,transport:custom(provider)});
 const [account]=await wallet.requestAddresses();await wallet.switchChain({id:chain.id});
 if(status.chainIds.monad!==chain.id)throw new Error('Unsupported deposit network.');
 const client=createPublicClient({chain,transport:http()});
 const approval=await wallet.writeContract({account,address:status.contracts.tUSDC,abi,functionName:'approve',args:[status.contracts.bridge,amount]});
 if((await client.waitForTransactionReceipt({hash:approval})).status!=='success')throw new Error('Token approval failed. No deposit was sent.');
 const hash=await wallet.writeContract({account,address:status.contracts.bridge,abi,functionName:'deposit',args:[status.contracts.tUSDC,amount,recipient]});
 if((await client.waitForTransactionReceipt({hash})).status!=='success')throw new Error('The deposit reverted. Your treasury was not credited.');
 return hash;
}

/** Payee-only fallback: the connected wallet must own the withdrawal. */
export async function claimOriginal(status:Status,withdrawal:import('./whale').Withdrawal,payee:Address){
 const args=withdrawal.claimAsInput?.args;if(!args)throw new Error('No original-token claim is available.');
 const provider=(window as unknown as {ethereum?:EIP1193Provider}).ethereum;if(!provider)throw new Error('Connect the recipient wallet. MON is required for this fallback.');
 const chain=defineChain({id:10143,name:'Monad Testnet',nativeCurrency:{name:'MON',symbol:'MON',decimals:18},rpcUrls:{default:{http:['https://testnet-rpc.monad.xyz']}}});
 const wallet=createWalletClient({chain,transport:custom(provider)});const [account]=await wallet.requestAddresses();
 if(account.toLowerCase()!==payee.toLowerCase())throw new Error('Connect the recipient’s wallet to use this fallback. MON is required for gas.');
 await wallet.switchChain({id:chain.id});
 const fallbackAbi=parseAbi(['function claimAsInput(uint256 domainBlock,(address payee,address tokenIn,address tokenOut,uint256 amountIn,uint256 minOut,uint256 maxFee,uint256 nonce) w,bytes32 salt,bytes32[] proof)']);
 const hash=await wallet.writeContract({account,address:status.contracts.hub,abi:fallbackAbi,functionName:'claimAsInput',args:[BigInt(args.domainBlock),{...args.w,amountIn:BigInt(args.w.amountIn),minOut:BigInt(args.w.minOut),maxFee:BigInt(args.w.maxFee),nonce:BigInt(args.w.nonce)},args.salt,args.proof]});
 if((await createPublicClient({chain,transport:http()}).waitForTransactionReceipt({hash})).status!=='success')throw new Error('The claim reverted. Refresh the withdrawal status before retrying.');return hash;
}
