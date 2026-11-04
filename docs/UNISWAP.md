# Uniswap v4 on Monad testnet: what exists and how to switch

## Findings (checked 4 Nov 2026)
- Uniswap's **official** v3 and v4 deployment pages list Monad **mainnet** only. The official v3 mainnet addresses have no
  code on testnet.
- Monad maintains its **own Uniswap v4 deployment on testnet** (chain 10143): PoolManager
  `0x451D64ab3b650040d2aE1886602b97ed6eDc643d`, UniversalRouter, PositionManager, Quoter, StateView. It is "not an official
  Uniswap deployment" (its own wording). All contracts have code on-chain; router and StateView point at that PoolManager.
- The testnet token list has only MON, USDC (Circle), WETH, WMON. **No USDT.** Pools for MON/USDC and USDC/WMON exist with
  liquidity, but they use Circle's USDC, which we cannot mint. Our tUSDC/tUSDT are open-mint mocks, so we made **our own pool**.

## What we built
- `UniswapV4Adapter` (implements `ISwapAdapter`): talks straight to the PoolManager (unlock, swap, settle, take); no
  Permit2 or router. Bridge-only; exact input; reverts instead of partially filling; reverts below `minOut`.
- `PoolSeeder` (testnet helper, owner = deployer): created the pool, added liquidity, and can swap to **move the price**
  for the slippage demo.
- Pool: tUSDT (currency0) / tUSDC (currency1), fee 500 (0.05%), tick spacing 10, no hooks, price 1:1, liquidity 4e12 over
  ticks -1000..1000 (about 195,000 of each token, +-10% around 1:1). Addresses: `deployments/monad-testnet.json`.

## Verified
- Interface: the 7 PoolManager selectors used exist in the deployed bytecode; struct field orders read from v4-core 1.0.2.
- Fork tests against the real PoolManager (`RUN_FORK_TESTS=1`): 100 in gives 99.947502 out (0.05% fee plus tiny impact), reverse
  direction the same, `minOut` guard, no partial fills, and a price move of a 60,000-token sell makes the same trade return
  97.01 so a payee's `minOut` rejects it.
- Full claim-and-swap through the REAL Hub, bridge and the real pool on a fork: payee receives 99.897502 tUSDT (pool 99.947502
  minus the flat 0.05 relayer fee), escrow falls by exactly 100, no approval left open.
  Run: `forge script script/SmokeUniswapFork.s.sol --rpc-url $MONAD_TESTNET_RPC` (simulation only; never `--broadcast`).

## Switching the venue (deliberate, reversible)
```
# switch the bridge to Uniswap (bridge owner = deployer)
cast send $BRIDGE "setSwapAdapter(address)" $UNISWAP_ADAPTER --private-key $DEPLOYER_PRIVATE_KEY --rpc-url $MONAD_TESTNET_RPC
# roll back to the simulated venue
cast send $BRIDGE "setSwapAdapter(address)" $MOCKSWAP --private-key $DEPLOYER_PRIVATE_KEY --rpc-url $MONAD_TESTNET_RPC
```
The backend must be configured for the same venue (`SWAP_VENUE`), otherwise quotes and the slippage demo describe a
different pool than the one that executes.

## Caveats
- It is Uniswap v4 code on a Monad-maintained testnet deployment, with our own pool of **mock** tokens. Do not describe it
  as a mainnet or official Uniswap market.
- The pool lives on testnet; a testnet reset (it was reset on 2025-12-16) would erase it. Re-run
  `forge script script/DeployUniswapPool.s.sol --broadcast` to recreate it.
- The liquidity range is +-10%; a trade larger than the range reverts (`PartialFill`) and the payee uses the fallback claim.
