// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title Equilibrium zkML Verifier
/// @notice Verifies RISC Zero receipts for quantized MLP inference (ERC-7992).
///
/// Journal byte layout (RISC Zero serde, little-endian — must stay in sync with
/// `ZkmlOutput` in `equilibrium/src/zkml_prover.rs` and the guest):
///
///   Offset        Length    Field
///   0             32        model_root  ([u8; 32], raw bytes)
///   32            32        input_hash  ([u8; 32], raw bytes)
///   64            4         output_len  (u32, little-endian)
///   68            4 × n     output[i]   (i32, little-endian each)
///   68 + 4n       8         block_height (u64, little-endian)
///
///   Minimum journal size: 76 bytes (empty output vec).
interface IRiscZeroVerifier {
    /// @notice Verify a RISC Zero receipt against an image ID and journal hash.
    /// @param seal     The serialized receipt / proof bytes.
    /// @param imageId  The 32-byte image ID of the compiled guest program.
    /// @param journalHash  SHA-256 of the raw journal bytes committed by the guest.
    /// @return True if the receipt is cryptographically valid.
    function verify(
        bytes calldata seal,
        bytes32 imageId,
        bytes32 journalHash
    ) external view returns (bool);
}

contract EquilibriumZkmlVerifier {
    IRiscZeroVerifier public immutable verifier;
    bytes32           public immutable imageId;

    /// @notice Emitted after a receipt is validated and the journal decoded.
    event InferenceVerified(
        bytes32 indexed modelRoot,
        bytes32 indexed inputHash,
        uint64          blockHeight,
        int32[]         output
    );

    constructor(address _verifier, bytes32 _imageId) {
        require(_verifier != address(0), "verifier: zero address");
        require(_imageId  != bytes32(0), "imageId: zero");
        verifier = IRiscZeroVerifier(_verifier);
        imageId  = _imageId;
    }

    // ── Public entry points ───────────────────────────────────────────────────

    /// @notice Verify a single zkML inference receipt.
    ///
    /// @param seal                Serialized RISC Zero proof (from `receipt_bytes`).
    /// @param journal             Raw journal bytes from the RISC Zero receipt.
    ///                            These are the exact bytes the guest committed via
    ///                            `env::commit(&ZkmlOutput { ... })`.  The caller
    ///                            obtains them from `receipt.journal.bytes` in Rust.
    /// @param expectedModelRoot   Expected Merkle root of model weights (replay
    ///                            protection: must match the journal field).
    /// @param expectedInputHash   Expected hash of input features.
    /// @param expectedBlockHeight Expected block height for replay protection.
    ///
    /// @return output  The decoded output logit vector extracted from the journal.
    function verifyInference(
        bytes   calldata seal,
        bytes   calldata journal,
        bytes32          expectedModelRoot,
        bytes32          expectedInputHash,
        uint64           expectedBlockHeight
    ) external returns (int32[] memory output) {
        // 1. Verify the receipt — sha256(journal) binds the proof to exact journal content.
        bytes32 journalHash = _sha256Precompile(journal);
        require(verifier.verify(seal, imageId, journalHash), "receipt: invalid proof");

        // 2. Decode the journal and verify caller-supplied expectations.
        bytes32 modelRoot;
        bytes32 inputHash;
        uint64  blockHeight;
        (modelRoot, inputHash, output, blockHeight) = _decodeJournal(journal);

        require(modelRoot  == expectedModelRoot,   "journal: model root mismatch");
        require(inputHash  == expectedInputHash,   "journal: input hash mismatch");
        require(blockHeight == expectedBlockHeight, "journal: block height mismatch");

        emit InferenceVerified(modelRoot, inputHash, blockHeight, output);
    }

    /// @notice Batch-verify multiple inference receipts.  Reverts on the first
    ///         failure.
    function verifyBatch(
        bytes[]   calldata seals,
        bytes[]   calldata journals,
        bytes32[] calldata expectedModelRoots,
        bytes32[] calldata expectedInputHashes,
        uint64[]  calldata expectedBlockHeights
    ) external returns (bool) {
        uint256 n = seals.length;
        require(
            journals.length             == n &&
            expectedModelRoots.length   == n &&
            expectedInputHashes.length  == n &&
            expectedBlockHeights.length == n,
            "batch: length mismatch"
        );

        for (uint256 i = 0; i < n; i++) {
            bytes32 journalHash = _sha256Precompile(journals[i]);
            require(verifier.verify(seals[i], imageId, journalHash), "batch: invalid proof");

            (
                bytes32   modelRoot,
                bytes32   inputHash,
                int32[] memory output,
                uint64    blockHeight
            ) = _decodeJournal(journals[i]);

            require(modelRoot   == expectedModelRoots[i],   "batch: model root mismatch");
            require(inputHash   == expectedInputHashes[i],  "batch: input hash mismatch");
            require(blockHeight == expectedBlockHeights[i], "batch: block height mismatch");

            emit InferenceVerified(modelRoot, inputHash, blockHeight, output);
        }
        return true;
    }

    // ── Journal decoder ───────────────────────────────────────────────────────

    /// @dev Decode raw RISC Zero journal bytes into `ZkmlOutput` fields.
    ///      Layout is little-endian throughout (matches the RISC Zero serde codec
    ///      used by `env::commit` in the guest).
    function _decodeJournal(bytes calldata j)
        internal
        pure
        returns (
            bytes32        modelRoot,
            bytes32        inputHash,
            int32[] memory output,
            uint64         blockHeight
        )
    {
        // Minimum size: 32 + 32 + 4 (len) + 0 (empty vec) + 8 (u64) = 76 bytes.
        require(j.length >= 76, "journal: too short");

        // model_root and input_hash are raw byte arrays — calldataload gives the
        // correct big-endian bytes32 representation of 32 sequential bytes.
        modelRoot = _readBytes32(j, 0);
        inputHash = _readBytes32(j, 32);

        uint32 outLen = _readU32LE(j, 64);
        require(j.length == 76 + uint256(outLen) * 4, "journal: length mismatch");

        output = new int32[](outLen);
        for (uint32 i = 0; i < outLen; i++) {
            output[i] = _readI32LE(j, 68 + uint256(i) * 4);
        }

        blockHeight = _readU64LE(j, 68 + uint256(outLen) * 4);
    }

    // ── Low-level calldata readers ────────────────────────────────────────────

    /// @dev Read 32 bytes from calldata at `offset` as a bytes32 value.
    function _readBytes32(bytes calldata data, uint256 offset)
        internal
        pure
        returns (bytes32 result)
    {
        // calldataload reads 32 bytes at the absolute calldata position
        // data.offset + offset, interpreting them as a big-endian 256-bit value.
        // For raw byte arrays (hashes) there is no endianness — the bytes are
        // in their original order, which is what bytes32 needs.
        assembly {
            result := calldataload(add(data.offset, offset))
        }
    }

    /// @dev Read a little-endian uint32 from calldata at `offset`.
    function _readU32LE(bytes calldata data, uint256 offset)
        internal
        pure
        returns (uint32 result)
    {
        assembly {
            let word := calldataload(add(data.offset, offset))
            // byte(n, word): byte at position n (0 = MSB) of the 32-byte word.
            // LE u32 = b0 | b1<<8 | b2<<16 | b3<<24 (b0 is at calldata position offset,
            // which lands at byte(0, word) — the most significant byte of calldataload).
            let b0 := byte(0, word)
            let b1 := byte(1, word)
            let b2 := byte(2, word)
            let b3 := byte(3, word)
            result := or(or(b0, shl(8, b1)), or(shl(16, b2), shl(24, b3)))
        }
    }

    /// @dev Read a little-endian uint64 from calldata at `offset`.
    function _readU64LE(bytes calldata data, uint256 offset)
        internal
        pure
        returns (uint64)
    {
        uint64 lo = uint64(_readU32LE(data, offset));
        uint64 hi = uint64(_readU32LE(data, offset + 4));
        return lo | (hi << 32);
    }

    /// @dev Read a little-endian int32 from calldata at `offset`.
    function _readI32LE(bytes calldata data, uint256 offset)
        internal
        pure
        returns (int32)
    {
        // uint32 → int32 bit-reinterprets (two's complement), matching Rust i32::from_le_bytes.
        return int32(_readU32LE(data, offset));
    }

    // ── SHA-256 via EVM precompile ────────────────────────────────────────────

    /// @dev SHA-256 via the precompile at address 0x02.  Gas cost is proportional
    ///      to input length; cheaper and more correct than keccak256 for RISC Zero
    ///      journal hashing, which uses SHA-256 internally.
    function _sha256Precompile(bytes calldata data)
        internal
        view
        returns (bytes32 result)
    {
        assembly {
            // Copy calldata slice to memory so the precompile can read it.
            let len := data.length
            let ptr := mload(0x40)             // free memory pointer
            mstore(0x40, add(ptr, len))        // bump allocator
            calldatacopy(ptr, data.offset, len)

            // staticcall(gas, addr=0x02, in, insize, out, outsize)
            let ok := staticcall(gas(), 2, ptr, len, 0x00, 32)
            if iszero(ok) { revert(0, 0) }
            result := mload(0x00)
        }
    }
}
