// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @notice TESTNET ONLY second mock stablecoin so payouts can demonstrate a currency choice.
contract TestUSDT is ERC20, ERC20Permit {
    constructor() ERC20("Test USDT", "tUSDT") ERC20Permit("Test USDT") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
