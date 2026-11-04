// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title DomainToken
/// @notice Private-domain representation of a token escrowed in MainBridge on Monad (1:1).
///         Runs on the private EVM only. Balances and allowances are readable only by the
///         account itself or readers it granted, enforced INSIDE the contract so that another
///         contract cannot read them indirectly (white paper 5.4: a deployed "snooping"
///         contract is the attack the execution-layer policy exists to stop).
/// @dev Deliberate deviation from the paper: policy is a caller check in the contract, not an
///      injected call by the execution client. Revert data from failed ERC20 operations can
///      reveal the caller's own balance to that caller only.
contract DomainToken is ERC20 {
    /// @notice The only account allowed to mint (the operator's system relayer).
    address public immutable systemRelayer;
    /// @notice The real token on Monad this represents. Part of every withdrawal leaf.
    address public immutable monadToken;

    mapping(uint256 depositId => bool) public depositProcessed;
    mapping(address account => mapping(address reader => bool)) public isReader;
    mapping(address account => uint256) public withdrawalNonce;

    event DepositMinted(uint256 indexed depositId, address indexed to, uint256 amount);
    event ReaderGranted(address indexed account, address indexed reader);
    event ReaderRevoked(address indexed account, address indexed reader);
    /// @dev The operator turns these into Merkle leaves for the Hub.
    event WithdrawalRequested(
        address indexed payee, address token, uint256 amount, uint256 nonce
    );

    /// @dev The operator turns these into kind-2 Merkle leaves for the Hub (see Hub.swapWithdrawalLeaf).
    event SwapWithdrawalRequested(
        address indexed payee,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        uint256 maxFee,
        uint256 nonce
    );
    event PayoutPreferenceSet(address indexed account, address tokenOut);

    mapping(address account => address) private _payoutPreference;

    error BadTokenOut();
    error Denied();
    error NotSystemRelayer();
    error DepositAlreadyProcessed();
    error ZeroAmount();
    error ZeroAddress();

    constructor(address systemRelayer_, address monadToken_) ERC20("Private USDC", "pUSDC") {
        if (systemRelayer_ == address(0) || monadToken_ == address(0)) revert ZeroAddress();
        systemRelayer = systemRelayer_;
        monadToken = monadToken_;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    // ------------------------------------------------------------- access control

    function _canRead(address account) internal view returns (bool) {
        return msg.sender == account || isReader[account][msg.sender];
    }

    function grantReader(address reader) external {
        if (reader == address(0)) revert ZeroAddress();
        isReader[msg.sender][reader] = true;
        emit ReaderGranted(msg.sender, reader);
    }

    function revokeReader(address reader) external {
        isReader[msg.sender][reader] = false;
        emit ReaderRevoked(msg.sender, reader);
    }

    function balanceOf(address account) public view override returns (uint256) {
        if (!_canRead(account)) revert Denied();
        return super.balanceOf(account);
    }

    function allowance(address owner, address spender) public view override returns (uint256) {
        if (!(msg.sender == owner || msg.sender == spender || isReader[owner][msg.sender])) {
            revert Denied();
        }
        return super.allowance(owner, spender);
    }

    // ------------------------------------------------------------- bridge side

    /// @notice Mint for a deposit seen on Monad. Each deposit id can be processed once.
    function mintDeposit(uint256 depositId, address to, uint256 amount) external {
        if (msg.sender != systemRelayer) revert NotSystemRelayer();
        if (depositProcessed[depositId]) revert DepositAlreadyProcessed();
        if (amount == 0) revert ZeroAmount();
        depositProcessed[depositId] = true;
        _mint(to, amount);
        emit DepositMinted(depositId, to, amount);
    }

    /// @notice Withdraw and receive a DIFFERENT token on Monad (claim-and-swap, PRD 6.1).
    /// @param tokenOut The Monad token the payee wants.
    /// @param minOut Minimum the payee will receive after the relayer fee.
    /// @param maxFee Highest relayer fee the payee accepts, in `tokenOut` units.
    function requestSwapWithdrawal(uint256 amount, address tokenOut, uint256 minOut, uint256 maxFee)
        external
        returns (uint256 nonce)
    {
        if (amount == 0) revert ZeroAmount();
        if (tokenOut == address(0) || tokenOut == monadToken) revert BadTokenOut();
        _burn(msg.sender, amount);
        nonce = withdrawalNonce[msg.sender]++;
        emit SwapWithdrawalRequested(msg.sender, monadToken, tokenOut, amount, minOut, maxFee, nonce);
    }

    /// @notice Remember which token the caller prefers to be paid out in (UI pre-fill; private state).
    function setPayoutPreference(address tokenOut) external {
        _payoutPreference[msg.sender] = tokenOut;
        emit PayoutPreferenceSet(msg.sender, tokenOut);
    }

    function payoutPreference(address account) external view returns (address) {
        if (!_canRead(account)) revert Denied();
        return _payoutPreference[account];
    }

    /// @notice Burn the caller's tokens and queue a withdrawal to the same address on Monad.
    function requestWithdrawal(uint256 amount) external returns (uint256 nonce) {
        if (amount == 0) revert ZeroAmount();
        _burn(msg.sender, amount); // reverts if balance is insufficient
        nonce = withdrawalNonce[msg.sender]++;
        emit WithdrawalRequested(msg.sender, monadToken, amount, nonce);
    }
}
