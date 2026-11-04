// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

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
}
