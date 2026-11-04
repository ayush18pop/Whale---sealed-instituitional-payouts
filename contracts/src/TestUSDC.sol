// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @notice TESTNET ONLY mock stablecoin. Anyone can mint, so the demo never depends on a faucet.
contract TestUSDC is ERC20, ERC20Permit {
    constructor() ERC20("Test USDC", "tUSDC") ERC20Permit("Test USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
