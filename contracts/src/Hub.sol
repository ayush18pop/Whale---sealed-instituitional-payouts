// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {IMainBridge} from "./interfaces/IMainBridge.sol";

/// @title Hub
/// @notice Public mailbox and notary for one private settlement domain ("PSD-lite").
///         It cannot read anything: it only (1) records encrypted submissions in Monad's order,
///         (2) accepts operator-attested result roots strictly in block order, and
///         (3) verifies withdrawal proofs and tells the bridge to release tokens.
/// @dev Maps to white paper sections 5.1 (hub), 5.2 (lifecycle), 5.3.2 (message anchors),
///      5.3.3 (replay protection), 6.1 (committee attestation).
///      Operators and the encryption key are fixed at construction (the paper's v1 cannot
///      change them either). Backpressure (MAX_EXECUTION_GAP) is intentionally not implemented in
///      this version; see PRD section 10, Phase 6.
contract Hub {
    /// @dev Leaf kind tags make future message types unambiguous (Phase 7 adds swap terms).
    uint8 public constant KIND_WITHDRAWAL = 1;
    uint8 public constant KIND_SWAP_WITHDRAWAL = 2;
    uint256 public constant MAX_CIPHERTEXT_BYTES = 65_536;
    uint256 public constant MAX_DOMAIN_GAS = 30_000_000; // Monad per-transaction gas limit

    IMainBridge public immutable bridge;
    uint256 public immutable domainChainId;
    uint8 public immutable threshold;
    /// @notice Public key the browser encrypts to. Published here so clients can verify it.
    bytes public operatorEncryptionKey;

    address[] private _operators;
    mapping(address operator => bool) public isOperator;

    uint64 public lastDomainBlock;
    uint64 public lastMonadBlock;

    struct Result {
        bytes32 stateRoot;
        bytes32 msgRoot;
        uint64 monadBlock;
    }

    mapping(uint64 domainBlock => Result) public results;
    mapping(bytes32 leaf => bool) public claimed;

    /// @dev No storage is written by submit(): concurrent submissions touch no shared slot.
    event Submitted(address indexed courier, uint256 gasLimit, bytes ciphertext);
    event ResultPosted(
        uint64 indexed domainBlock, uint64 monadBlock, bytes32 stateRoot, bytes32 msgRoot
    );
    event Claimed(
        uint64 indexed domainBlock,
        address indexed payee,
        address token,
        uint256 amount,
        uint256 nonce
    );

    event ClaimedSwap(
        uint64 indexed domainBlock,
        address indexed payee,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 nonce
    );
    event ClaimedAsInput(
        uint64 indexed domainBlock,
        address indexed payee,
        address tokenIn,
        uint256 amountIn,
        uint256 nonce
    );

    error EmptyCiphertext();
    error CiphertextTooLarge();
    error BadGasLimit();
    error BadConfig();
    error OutOfOrder();
    error BadMonadBlock();
    error NotEnoughSignatures();
    error SignersNotAscending();
    error NotOperator();
    error NotPosted();
    error InvalidProof();
    error AlreadyClaimed();
    error NotPayee();

    constructor(
        IMainBridge bridge_,
        uint256 domainChainId_,
        address[] memory operators_,
        uint8 threshold_,
        bytes memory operatorEncryptionKey_
    ) {
        if (address(bridge_) == address(0)) revert BadConfig();
        if (threshold_ == 0 || threshold_ > operators_.length) revert BadConfig();
        if (operatorEncryptionKey_.length == 0) revert BadConfig();
        for (uint256 i = 0; i < operators_.length; i++) {
            address op = operators_[i];
            if (op == address(0) || isOperator[op]) revert BadConfig();
            isOperator[op] = true;
            _operators.push(op);
        }
        bridge = bridge_;
        domainChainId = domainChainId_;
        threshold = threshold_;
        operatorEncryptionKey = operatorEncryptionKey_;
    }

    function operators() external view returns (address[] memory) {
        return _operators;
    }

    // ---------------------------------------------------------------- submission

    /// @notice Post an encrypted domain transaction. The Hub cannot read it.
    /// @param ciphertext The signed domain transaction, encrypted to `operatorEncryptionKey`.
    /// @param gasLimit Declared gas limit of the inner domain transaction (the only plaintext
    ///        besides the domain chain ID, as in white paper 5.2.1).
    function submit(bytes calldata ciphertext, uint256 gasLimit) external {
        if (ciphertext.length == 0) revert EmptyCiphertext();
        if (ciphertext.length > MAX_CIPHERTEXT_BYTES) revert CiphertextTooLarge();
        if (gasLimit == 0 || gasLimit > MAX_DOMAIN_GAS) revert BadGasLimit();
        emit Submitted(msg.sender, gasLimit, ciphertext);
    }

    // ---------------------------------------------------------------- attestation

    /// @notice Digest the operators sign for a result. Exposed so off-chain code signs the same thing.
    function resultDigest(
        uint64 domainBlock,
        uint64 monadBlock,
        bytes32 stateRoot,
        bytes32 msgRoot
    ) public view returns (bytes32) {
        return MessageHashUtils.toEthSignedMessageHash(
            keccak256(
                abi.encode(
                    address(this), block.chainid, domainChainId, domainBlock, monadBlock, stateRoot, msgRoot
                )
            )
        );
    }

    /// @notice Accept the next domain block's results, attested by >= threshold operators.
    /// @dev Signatures must be ordered by strictly ascending signer address (rules out duplicates).
    function postResult(
        uint64 domainBlock,
        uint64 monadBlock,
        bytes32 stateRoot,
        bytes32 msgRoot,
        bytes[] calldata signatures
    ) external {
        if (domainBlock != lastDomainBlock + 1) revert OutOfOrder(); // strictly in order (5.2.3)
        if (monadBlock <= lastMonadBlock || monadBlock > block.number) revert BadMonadBlock();
        if (signatures.length < threshold) revert NotEnoughSignatures();

        bytes32 digest = resultDigest(domainBlock, monadBlock, stateRoot, msgRoot);
        address previous = address(0);
        for (uint256 i = 0; i < signatures.length; i++) {
            address signer = ECDSA.recover(digest, signatures[i]);
            // Every supplied signature must be valid; reverting inside the loop is intended.
            // forge-lint: disable-next-line(require-revert-in-loop)
            if (!isOperator[signer]) revert NotOperator();
            // forge-lint: disable-next-line(require-revert-in-loop)
            if (signer <= previous) revert SignersNotAscending();
            previous = signer;
        }

        lastDomainBlock = domainBlock;
        lastMonadBlock = monadBlock;
        results[domainBlock] = Result(stateRoot, msgRoot, monadBlock);
        emit ResultPosted(domainBlock, monadBlock, stateRoot, msgRoot);
    }

    // ---------------------------------------------------------------- withdrawal

    /// @notice Leaf hash for a withdrawal, in OpenZeppelin StandardMerkleTree format so the
    ///         off-chain operator can build the tree with the OpenZeppelin merkle-tree library.
    ///         Types: (uint8 kind, address payee, address token, uint256 amount, uint256 nonce, bytes32 salt)
    function withdrawalLeaf(
        address payee,
        address token,
        uint256 amount,
        uint256 nonce,
        bytes32 salt
    ) public pure returns (bytes32) {
        return keccak256(
            bytes.concat(
                keccak256(abi.encode(KIND_WITHDRAWAL, payee, token, amount, nonce, salt))
            )
        );
    }

    /// @notice Release tokens for a withdrawal included in an accepted message root.
    ///         Anyone may call (the relayer does); funds always go to `payee`.
    function claim(
        uint64 domainBlock,
        address payee,
        address token,
        uint256 amount,
        uint256 nonce,
        bytes32 salt,
        bytes32[] calldata proof
    ) external {
        bytes32 root = results[domainBlock].msgRoot;
        if (root == bytes32(0)) revert NotPosted();

        bytes32 leaf = withdrawalLeaf(payee, token, amount, nonce, salt);
        if (!MerkleProof.verifyCalldata(proof, root, leaf)) revert InvalidProof();
        if (claimed[leaf]) revert AlreadyClaimed();

        claimed[leaf] = true; // effects (and the log) before the external call
        emit Claimed(domainBlock, payee, token, amount, nonce);
        bridge.release(token, payee, amount);
    }

    // ---------------------------------------------------------------- withdrawal with swap

    /// @notice The terms a payee signed inside the private chain (via requestSwapWithdrawal).
    ///         `minOut` is the minimum the payee must receive AFTER the relayer fee; `maxFee` is the
    ///         highest relayer fee they accepted.
    struct SwapWithdrawal {
        address payee;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minOut;
        uint256 maxFee;
        uint256 nonce;
    }

    /// @notice Leaf hash for a swap withdrawal (kind 2), OpenZeppelin StandardMerkleTree format.
    ///         Types, in order: (uint8 kind, address payee, address tokenIn, address tokenOut,
    ///         uint256 amountIn, uint256 minOut, uint256 maxFee, uint256 nonce, bytes32 salt)
    function swapWithdrawalLeaf(SwapWithdrawal calldata w, bytes32 salt) public pure returns (bytes32) {
        return keccak256(
            bytes.concat(
                keccak256(
                    abi.encode(
                        KIND_SWAP_WITHDRAWAL,
                        w.payee,
                        w.tokenIn,
                        w.tokenOut,
                        w.amountIn,
                        w.minOut,
                        w.maxFee,
                        w.nonce,
                        salt
                    )
                )
            )
        );
    }

    function _verifyAndMark(uint64 domainBlock, bytes32 leaf, bytes32[] calldata proof) private {
        bytes32 root = results[domainBlock].msgRoot;
        if (root == bytes32(0)) revert NotPosted();
        if (!MerkleProof.verifyCalldata(proof, root, leaf)) revert InvalidProof();
        if (claimed[leaf]) revert AlreadyClaimed();
        claimed[leaf] = true;
    }

    /// @notice Pay the payee in `tokenOut` via the bridge's swap adapter, in one transaction.
    ///         Anyone may call (the relayer does and earns the capped fee). If the swap fails the whole
    ///         call reverts and the leaf stays unclaimed, so the payee can use claimAsInput.
    function claimSwap(
        uint64 domainBlock,
        SwapWithdrawal calldata w,
        bytes32 salt,
        bytes32[] calldata proof
    ) external {
        _verifyAndMark(domainBlock, swapWithdrawalLeaf(w, salt), proof);
        emit ClaimedSwap(domainBlock, w.payee, w.tokenIn, w.tokenOut, w.amountIn, w.nonce);
        bridge.releaseAndSwap(
            w.payee, w.tokenIn, w.tokenOut, w.amountIn, w.minOut, w.maxFee, msg.sender
        );
    }

    /// @notice Fallback: take the original token instead of swapping. Withdrawals must never be
    ///         blockable (white paper 5.5.3). Only the payee may call, so a third party cannot force
    ///         a payee out of their chosen token; the payee pays their own gas here (rare path).
    function claimAsInput(
        uint64 domainBlock,
        SwapWithdrawal calldata w,
        bytes32 salt,
        bytes32[] calldata proof
    ) external {
        if (msg.sender != w.payee) revert NotPayee();
        _verifyAndMark(domainBlock, swapWithdrawalLeaf(w, salt), proof);
        emit ClaimedAsInput(domainBlock, w.payee, w.tokenIn, w.amountIn, w.nonce);
        bridge.release(w.tokenIn, w.payee, w.amountIn);
    }
}
