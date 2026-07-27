// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title QuiverProofRegistry
/// @notice An agent buys a risk number from Quiver; this contract checks its arithmetic on chain
///         without trusting the seller, and records what survived.
///
/// WHAT IS AND IS NOT TRUSTED HERE.
///
/// The number under test is a perpetual-futures liquidation price. Quiver computes it off chain and
/// sells it. Nothing about Quiver's identity, uptime, signature or reputation is what makes the
/// number credible: `submit` hands the PLONK proof to a verifier contract, and that verifier either
/// confirms the liquidation identity holds for the exact position in the public signals, or it does
/// not. A seller who lies produces a proof that fails here, in public, for anyone to see.
///
/// The circuit already pins everything the arithmetic needs — every input is range-bounded, `side`
/// is forced to exactly +1 or -1, the maintenance rate is forced below 1, size is forced non-zero,
/// and the residual is bounded by |2R| <= q*(SCALE+mmr) inside the constraint system. So this
/// contract deliberately does NOT re-check those in Solidity. Redundant require statements over
/// facts the SNARK already enforces would cost gas and buy nothing but the appearance of rigour.
///
/// THE SIGNATURE IS A SEPARATE CLAIM, AND IT IS OPTIONAL.
///
/// A proof says "this arithmetic is correct". It does not say "Quiver sold this". Those are
/// different claims and this contract keeps them apart. `attestation` is an EIP-191 signature by
/// Quiver's attestor key over keccak256(abi.encodePacked(pubSignals)) — the same eight words this
/// contract hashes from calldata, so there is no gap between what was proved and what was signed.
/// It may be empty. An unattested proof is still accepted and still recorded, flagged as
/// unattested: the arithmetic stands on its own, and pretending otherwise would invert the entire
/// point of proving it.
///
/// REJECTIONS ARE RECORDED, NOT REVERTED.
///
/// A revert leaves nothing behind but a failed transaction. Emitting `ProofRejected` means a bad
/// proof produces a permanent, indexable, publicly readable record that it was offered and refused —
/// which is the artefact a buyer actually wants from a registry of risk claims.
interface IPlonkVerifier {
    function verifyProof(uint256[24] calldata _proof, uint256[8] calldata _pubSignals) external view returns (bool);
}

contract QuiverProofRegistry {
    /// Fixed-point resolution shared with the circuit: every quantity is an integer times 1e9.
    uint256 public constant SCALE = 1e9;

    /// Public signal layout, as snarkjs emits it: circuit outputs first, then public inputs in
    /// declaration order. Named so a reader does not have to count array indices to audit this.
    uint256 private constant I_RESIDUAL = 0;
    uint256 private constant I_TOLERANCE = 1;
    uint256 private constant I_MARGIN = 2;
    uint256 private constant I_SIZE = 3;
    uint256 private constant I_ENTRY = 4;
    uint256 private constant I_SIDE = 5;
    uint256 private constant I_MMR = 6;
    uint256 private constant I_LIQ = 7;

    IPlonkVerifier public immutable verifier;
    /// The key Quiver signs public signals with. Immutable: a registry whose notion of "Quiver" can
    /// be edited afterwards is not a registry, it is a promise.
    address public immutable quiverAttestor;

    struct Certified {
        uint256 marginHat;
        uint256 sizeHat;
        uint256 entryHat;
        uint256 mmrHat;
        uint256 liquidationHat;
        bool isLong;
        bool quiverAttested;
        uint64 blockNumber;
        address submitter;
    }

    /// Keyed by the digest of the public signals, so the same position proved twice is the same
    /// entry — the record is about the claim, not about who happened to post it.
    mapping(bytes32 => Certified) public certified;
    uint256 public acceptedCount;
    uint256 public rejectedCount;

    event ProofAccepted(
        bytes32 indexed signalsDigest,
        address indexed submitter,
        uint256 liquidationHat,
        bool isLong,
        bool quiverAttested
    );
    event ProofRejected(bytes32 indexed signalsDigest, address indexed submitter, string reason);

    constructor(address _verifier, address _quiverAttestor) {
        require(_verifier != address(0), "verifier required");
        verifier = IPlonkVerifier(_verifier);
        quiverAttestor = _quiverAttestor;
    }

    /// @notice Check a Quiver liquidation proof on chain and record the outcome.
    /// @param _proof       the 24 field elements of the PLONK proof
    /// @param _pubSignals  the 8 public signals: [residual, tolerance, margin, size, entry, side, mmr, liq]
    /// @param _attestation optional 65-byte EIP-191 signature by the Quiver attestor over the digest
    /// @return accepted    true when the arithmetic verified
    function submit(
        uint256[24] calldata _proof,
        uint256[8] calldata _pubSignals,
        bytes calldata _attestation
    ) external returns (bool accepted) {
        bytes32 digest = keccak256(abi.encodePacked(_pubSignals));

        // A malformed proof point makes the verifier revert rather than return false, so the call is
        // wrapped: a rejection must be a recorded outcome, not a transaction that dies on the way in.
        bool ok;
        try verifier.verifyProof(_proof, _pubSignals) returns (bool r) {
            ok = r;
        } catch {
            ok = false;
        }

        if (!ok) {
            unchecked { rejectedCount++; }
            emit ProofRejected(digest, msg.sender, "proof does not verify");
            return false;
        }

        // `side` is +1 or -1 as a field element, so a short arrives as p-1 rather than as a negative
        // number. Anything else is impossible — the circuit constrains (s-1)(s+1) === 0 — so this is
        // a decode, not a check.
        bool isLong = _pubSignals[I_SIDE] == 1;

        bool attested = _attestation.length == 65 && _recover(digest, _attestation) == quiverAttestor && quiverAttestor != address(0);

        certified[digest] = Certified({
            marginHat: _pubSignals[I_MARGIN],
            sizeHat: _pubSignals[I_SIZE],
            entryHat: _pubSignals[I_ENTRY],
            mmrHat: _pubSignals[I_MMR],
            liquidationHat: _pubSignals[I_LIQ],
            isLong: isLong,
            quiverAttested: attested,
            blockNumber: uint64(block.number),
            submitter: msg.sender
        });
        unchecked { acceptedCount++; }

        emit ProofAccepted(digest, msg.sender, _pubSignals[I_LIQ], isLong, attested);
        return true;
    }

    /// @notice The liquidation price this contract has verified for a position, in whole units and
    ///         in the 1e-9 remainder — Solidity has no decimals, and rounding here would throw away
    ///         precision the proof went to some trouble to establish.
    function liquidationPrice(bytes32 signalsDigest) external view returns (uint256 whole, uint256 nano) {
        uint256 hat = certified[signalsDigest].liquidationHat;
        require(hat != 0, "no verified proof for that digest");
        return (hat / SCALE, hat % SCALE);
    }

    /// @notice Check a proof without writing anything — for a caller who wants the answer, not a record.
    function check(uint256[24] calldata _proof, uint256[8] calldata _pubSignals) external view returns (bool) {
        try verifier.verifyProof(_proof, _pubSignals) returns (bool r) {
            return r;
        } catch {
            return false;
        }
    }

    /// @notice The digest a caller must sign, and the key under which entries are stored.
    function digestOf(uint256[8] calldata _pubSignals) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(_pubSignals));
    }

    /// EIP-191 personal_sign recovery over the 32-byte digest. Signatures with s in the upper half of
    /// the curve order are refused: every ECDSA signature has a second valid form, and accepting both
    /// would let the same attestation be presented twice under different bytes.
    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        bytes32 ethSigned = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) return address(0);
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) return address(0);
        return ecrecover(ethSigned, v, r, s);
    }
}
