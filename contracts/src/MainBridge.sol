// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ISwapAdapter} from "./interfaces/ISwapAdapter.sol";

/// @title MainBridge
/// @notice Escrows real tokens on Monad. The private domain holds a synthetic 1:1 representation.
///         Tokens are released only when the Hub has verified a withdrawal proof.
/// @dev White paper section 5.5 (lock-and-mint). Deposit amounts are public by design (section 8).
///      Gasless deposits are intentionally NOT supported: a permit signature does not bind the
///      domain recipient, so a third party could redirect the credit. A safe version needs a
///      separate signed deposit intent.
contract MainBridge is ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public immutable owner;
    address public hub; // set once
    mapping(address token => bool) public allowedToken;
    uint256 public depositCount;

    /// @notice Swap venue used by releaseAndSwap. Owner-set; see PRD 6.1 (trust note: the adapter is
    ///         only ever approved the exact amount of one claim, and output is measured by balance).
    ISwapAdapter public swapAdapter;
    /// @notice Flat relayer fee, in units of the OUTPUT token, deducted from a swapped payout.
    uint256 public relayerFee;

    event SwapAdapterSet(address indexed adapter);
    event RelayerFeeSet(uint256 fee);
    event ReleasedWithSwap(
        address indexed payee,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOutNet,
        uint256 fee,
        address feeRecipient
    );
    event Deposit(
        uint256 indexed depositId,
        address indexed token,
        address indexed from,
        address domainRecipient,
        uint256 amount
    );
    event Released(address indexed token, address indexed to, uint256 amount);
    event TokenAllowed(address indexed token, bool allowed);
    event HubSet(address indexed hub);

    error NotOwner();
    error NotHub();
    error HubAlreadySet();
    error TokenNotAllowed();
    error ZeroAmount();
    error ZeroAddress();
    error BalanceDeltaMismatch();
    error NoSwapAdapter();
    error SameToken();
    error FeeAboveMax();
    error OutputBelowMin();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyHub() {
        if (msg.sender != hub) revert NotHub();
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function setHub(address hub_) external onlyOwner {
        if (hub != address(0)) revert HubAlreadySet();
        if (hub_ == address(0)) revert ZeroAddress();
        hub = hub_;
        emit HubSet(hub_);
    }

    function setTokenAllowed(address token, bool allowed) external onlyOwner {
        allowedToken[token] = allowed;
        emit TokenAllowed(token, allowed);
    }

    /// @notice Lock `amount` of `token` and credit `domainRecipient` inside the private domain.
    function deposit(address token, uint256 amount, address domainRecipient)
        external
        nonReentrant
        returns (uint256 id)
    {
        if (!allowedToken[token]) revert TokenNotAllowed();
        if (amount == 0) revert ZeroAmount();
        if (domainRecipient == address(0)) revert ZeroAddress();

        uint256 balanceBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        // White paper 5.5.1: the bridge must see its balance rise by exactly the amount.
        if (IERC20(token).balanceOf(address(this)) - balanceBefore != amount) {
            revert BalanceDeltaMismatch();
        }

        id = ++depositCount;
        emit Deposit(id, token, msg.sender, domainRecipient, amount);
    }

    /// @notice Release escrowed tokens. Callable only by the Hub after it verified a proof.
    function release(address token, address to, uint256 amount) external onlyHub nonReentrant {
        IERC20(token).safeTransfer(to, amount);
        emit Released(token, to, amount);
    }

    function setSwapAdapter(address adapter) external onlyOwner {
        if (adapter == address(0)) revert ZeroAddress();
        swapAdapter = ISwapAdapter(adapter);
        emit SwapAdapterSet(adapter);
    }

    function setRelayerFee(uint256 fee) external onlyOwner {
        relayerFee = fee;
        emit RelayerFeeSet(fee);
    }

    /// @notice Swap escrowed `tokenIn` to `tokenOut` and pay the payee, in one transaction.
    ///         Callable only by the Hub after it verified the payee's signed terms (the Merkle leaf).
    /// @param minOut Minimum the PAYEE must receive, after the relayer fee.
    /// @param maxFee Highest relayer fee the payee agreed to; reverts if the configured fee is higher.
    function releaseAndSwap(
        address payee,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        uint256 maxFee,
        address feeRecipient
    ) external onlyHub nonReentrant {
        if (address(swapAdapter) == address(0)) revert NoSwapAdapter();
        if (tokenIn == tokenOut) revert SameToken();
        if (!allowedToken[tokenIn] || !allowedToken[tokenOut]) revert TokenNotAllowed();
        uint256 fee = relayerFee;
        if (fee > maxFee) revert FeeAboveMax();

        uint256 required = minOut + fee;
        uint256 outBefore = IERC20(tokenOut).balanceOf(address(this));
        IERC20(tokenIn).forceApprove(address(swapAdapter), amountIn);
        swapAdapter.swapExactIn(tokenIn, tokenOut, amountIn, required, address(this));
        IERC20(tokenIn).forceApprove(address(swapAdapter), 0); // approval never outlives the claim

        // Trust the balance, not the adapter's return value.
        uint256 received = IERC20(tokenOut).balanceOf(address(this)) - outBefore;
        if (received < required) revert OutputBelowMin();

        if (fee > 0) IERC20(tokenOut).safeTransfer(feeRecipient, fee);
        uint256 net = received - fee;
        IERC20(tokenOut).safeTransfer(payee, net);
        emit ReleasedWithSwap(payee, tokenIn, tokenOut, amountIn, net, fee, feeRecipient);
    }
}
