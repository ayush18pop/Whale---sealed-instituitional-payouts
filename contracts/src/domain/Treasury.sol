// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DomainToken} from "./DomainToken.sol";

/// @title Treasury
/// @notice Dual-control batch payouts inside the private domain.
///         The finance lead proposes a batch; `threshold` distinct approvers must approve; the
///         approval that reaches the threshold executes the payout in the same transaction.
///         White paper section 3 (enterprise treasury): "dual-control sign-offs ... directly
///         mandated by the underlying smart contracts".
/// @dev Separation of duties: the finance lead cannot be an approver. Batch details are readable
///      only by staff (finance, approvers, auditors); a payee can read only their own amount.
contract Treasury {
    enum Status {
        None,
        Pending,
        Executed,
        Cancelled
    }

    struct Batch {
        address proposer;
        Status status;
        uint8 approvals;
        uint256 total;
        bytes32 memoHash;
        address[] payees;
        uint256[] amounts;
    }

    uint256 public constant MAX_PAYEES = 100;

    DomainToken public immutable token;
    address public immutable financeLead;
    uint8 public immutable threshold;

    address[] private _approvers;
    mapping(address => bool) public isApprover;
    mapping(address => bool) public isAuditor;

    uint256 public batchCount;
    mapping(uint256 batchId => Batch) private _batches;
    mapping(uint256 batchId => mapping(address approver => bool)) private _approvedBy;
    mapping(uint256 batchId => mapping(address payee => uint256)) private _amountOf;

    event Proposed(uint256 indexed batchId, address indexed proposer, bytes32 memoHash);
    event Approved(uint256 indexed batchId, address indexed approver, uint8 approvals);
    event Executed(uint256 indexed batchId);
    event Cancelled(uint256 indexed batchId);
    event Paid(uint256 indexed batchId, address indexed payee, uint256 amount);
    event AuditorSet(address indexed auditor, bool allowed);

    error Denied();
    error BadConfig();
    error BadBatch();
    error NotPending();
    error AlreadyApproved();
    error InsufficientFunds();
    error TransferFailed();

    modifier onlyFinance() {
        if (msg.sender != financeLead) revert Denied();
        _;
    }

    modifier onlyApprover() {
        if (!isApprover[msg.sender]) revert Denied();
        _;
    }

    modifier onlyStaff() {
        if (!_isStaff(msg.sender)) revert Denied();
        _;
    }

    constructor(
        DomainToken token_,
        address financeLead_,
        address[] memory approvers_,
        uint8 threshold_
    ) {
        if (address(token_) == address(0) || financeLead_ == address(0)) revert BadConfig();
        if (threshold_ == 0 || threshold_ > approvers_.length) revert BadConfig();
        for (uint256 i = 0; i < approvers_.length; i++) {
            address a = approvers_[i];
            // no zero address, no duplicates, and finance cannot approve its own batches
            if (a == address(0) || isApprover[a] || a == financeLead_) revert BadConfig();
            isApprover[a] = true;
            _approvers.push(a);
        }
        token = token_;
        financeLead = financeLead_;
        threshold = threshold_;
    }

    function approvers() external view returns (address[] memory) {
        return _approvers;
    }

    function setAuditor(address auditor, bool allowed) external onlyFinance {
        if (auditor == address(0)) revert BadConfig();
        isAuditor[auditor] = allowed;
        emit AuditorSet(auditor, allowed);
    }

    function _isStaff(address who) internal view returns (bool) {
        return who == financeLead || isApprover[who] || isAuditor[who];
    }

    // ------------------------------------------------------------- workflow

    function propose(address[] calldata payees, uint256[] calldata amounts, bytes32 memoHash)
        external
        onlyFinance
        returns (uint256 batchId)
    {
        uint256 n = payees.length;
        if (n == 0 || n > MAX_PAYEES || n != amounts.length) revert BadBatch();

        batchId = ++batchCount;
        Batch storage b = _batches[batchId];
        b.proposer = msg.sender;
        b.status = Status.Pending;
        b.memoHash = memoHash;

        uint256 total;
        for (uint256 i = 0; i < n; i++) {
            if (payees[i] == address(0) || amounts[i] == 0) revert BadBatch();
            total += amounts[i];
            _amountOf[batchId][payees[i]] += amounts[i];
        }
        b.total = total;
        b.payees = payees;
        b.amounts = amounts;
        emit Proposed(batchId, msg.sender, memoHash);
    }

    function approve(uint256 batchId) external onlyApprover {
        Batch storage b = _batches[batchId];
        if (b.status != Status.Pending) revert NotPending();
        if (_approvedBy[batchId][msg.sender]) revert AlreadyApproved();

        _approvedBy[batchId][msg.sender] = true;
        b.approvals += 1;
        emit Approved(batchId, msg.sender, b.approvals);

        if (b.approvals >= threshold) _execute(batchId, b);
    }

    function cancel(uint256 batchId) external onlyFinance {
        Batch storage b = _batches[batchId];
        if (b.status != Status.Pending) revert NotPending();
        b.status = Status.Cancelled;
        emit Cancelled(batchId);
    }

    function _execute(uint256 batchId, Batch storage b) internal {
        if (token.balanceOf(address(this)) < b.total) revert InsufficientFunds();
        b.status = Status.Executed; // before any external call
        uint256 n = b.payees.length;
        // The loop is bounded by MAX_PAYEES and only calls our own domain token (it reverts on
        // failure; the return value is checked anyway).
        // forge-lint: disable-start(calls-loop, reentrancy-events)
        for (uint256 i = 0; i < n; i++) {
            if (!token.transfer(b.payees[i], b.amounts[i])) revert TransferFailed();
            emit Paid(batchId, b.payees[i], b.amounts[i]);
        }
        emit Executed(batchId);
        // forge-lint: disable-end(calls-loop, reentrancy-events)
    }

    // ------------------------------------------------------------- restricted reads

    function getBatch(uint256 batchId)
        external
        view
        onlyStaff
        returns (
            address proposer,
            Status status,
            uint8 approvals,
            uint256 total,
            bytes32 memoHash,
            address[] memory payees,
            uint256[] memory amounts
        )
    {
        Batch storage b = _batches[batchId];
        return (b.proposer, b.status, b.approvals, b.total, b.memoHash, b.payees, b.amounts);
    }

    /// @notice A payee reads only their own amount; staff may read anyone's.
    function paymentOf(uint256 batchId, address payee) external view returns (uint256) {
        if (!(msg.sender == payee || _isStaff(msg.sender))) revert Denied();
        return _amountOf[batchId][payee];
    }

    function hasApproved(uint256 batchId, address approver) external view onlyStaff returns (bool) {
        return _approvedBy[batchId][approver];
    }

    function treasuryBalance() external view onlyStaff returns (uint256) {
        return token.balanceOf(address(this));
    }
}
