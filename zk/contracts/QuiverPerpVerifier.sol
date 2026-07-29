// SPDX-License-Identifier: MIT
pragma solidity >=0.8.4 <0.9.0;

/**
 * QuiverPerpVerifier — the join, on HyperEVM (chain 999).
 *
 * Quiver's liquidation SNARK proves the ARITHMETIC of a perpetual-futures liquidation price. Until
 * now the INPUT to that arithmetic — the price the position was struck at — was attested by nothing:
 * the registry on X Layer verifies a proof about a number that arrived over unsigned HTTPS. HyperEVM
 * can read that number out of HyperCore's own committed state, but has no verifier. Each chain held
 * one half.
 *
 * This contract holds both, in one call:
 *
 *     verifyPerpGate(proof, publicSignals, asset)
 *       1. STATICCALL 0x…0806 markPx(uint32) and 0x…080a perpAssetInfo(uint32) as this call executes
 *       2. require the mark equals publicSignals[4] (p0Hat) inside a MEASURED window
 *       3. verify the Plonk proof
 *
 * A caveat on step 1, measured rather than assumed: these precompiles are NOT block-scoped under
 * `eth_call`. A read at an explicit historical block tag returns CURRENT HyperCore state, verified by
 * watching a 20,000-block-old tag track `latest` in lock-step while the price moved. Inside a
 * transaction the read is part of that block's execution and consensus commits to it, which is what
 * makes this an attestation at all — but nobody can replay a PAST join as a simulation afterwards.
 * The evidence a mark held is the transaction's own inclusion, not a call anyone can repeat.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHICH PRICE IS BOUND, AND WHY IT IS THE ENTRY PRICE.
 *
 * The liquidation circuit's public signals are, MEASURED (not assumed) by printing them over three
 * positions with distinct magnitudes and both sides:
 *
 *     [0] residual   [1] tolerance   [2] mHat   [3] qHat   [4] p0Hat   [5] s   [6] mmrHat   [7] pLiqHat
 *
 * There is NO mark-price signal. The mark is not a term in the liquidation identity at all — the
 * engine uses it only for `moveToLiquidationPct` and `positionStatus`. The one place a HyperCore mark
 * enters the proven statement is `p0Hat`: when perp-gate is asked about a SYMBOL and the caller
 * supplies no entryPrice, the adapter defaults entryPrice to the live mark and flags it
 * `_entryDefaultedToMark`. For that call — and only that call — the entry price bound into the proof
 * IS HyperCore's mark, and this contract can attest it.
 *
 * For a caller who supplies their own entry price (an existing position), p0Hat is a private fact
 * about that caller and no chain attests it. `verifyProof` below is the honest answer there: the
 * arithmetic is still proven, the input still is not.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THE UNIT CONVERSION IS EXACT, SO EVERY RESIDUAL IS REAL PRICE MOVEMENT.
 *
 * HyperCore carries a perp price as an integer of 10^(6 − szDecimals) units. The circuit works on a
 * 1e9 grid. 1e9 / 10^(6 − szDecimals) = 10^(3 + szDecimals), an integer for every szDecimals in 0..8,
 * so the conversion is a MULTIPLICATION and nothing is lost. Measured across all 232 perps: the
 * contract's markPxHat reproduces the off-chain read exactly, in every case, with zero residual. Any
 * deviation this contract then sees is the price having moved, which is what `windowPpm` is for and
 * what A3 measured.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT THIS DOES NOT PROVE, STATED HERE RATHER THAN IN A README NOBODY OPENS.
 *
 *  - Not that HyperCore's mark is CORRECT. It is a stake-weighted median of external venues; a
 *    manipulated oracle is attested with full force. This reaches the venue's committed state and
 *    stops there.
 *  - Not the ASSET. The circuit carries no asset identifier, so the join binds a PRICE, not an
 *    identity. Two perps whose marks agree to within `windowPpm` are interchangeable here. Naming
 *    the asset in calldata is what a caller asserts; the price is what the chain confirms.
 *  - Not funding. No funding precompile exists anywhere in 0x800–0x8ff, so perp-gate's funding-drag
 *    figure stays unattested and this contract does not pretend otherwise.
 */

interface IPlonkVerifier {
    function verifyProof(uint256[24] calldata _proof, uint256[8] calldata _pubSignals) external view returns (bool);
}

contract QuiverPerpVerifier {
    /// HyperCore read precompiles. Verified live: both REVERT (PrecompileError) on an out-of-range
    /// asset rather than returning zero, so a failed STATICCALL is the real signal and is propagated.
    address public constant MARK_PX = 0x0000000000000000000000000000000000000806;
    address public constant PERP_ASSET_INFO = 0x000000000000000000000000000000000000080a;

    /// Index of p0Hat in the liquidation circuit's public signals. Measured, and asserted by the gate.
    uint256 public constant P0_INDEX = 4;

    /// The 1e9 fixed-point grid the circuit and `src/util/scale.cjs` share.
    uint256 public constant CIRCUIT_SCALE = 1e9;

    IPlonkVerifier public immutable verifier;

    /// Staleness window, in parts per million of the chain's mark. Set from A3's measurement of how
    /// far a mark actually moves over the read→submit interval; a window chosen before that
    /// measurement would be a guess.
    uint256 public immutable windowPpm;

    /**
     * A FLOOR on the window, in HyperCore price ticks. Not a comfort margin — a correctness condition.
     *
     * HyperCore carries a price as an integer, so the smallest deviation that can exist at all is ONE
     * TICK, and a tick is worth wildly different amounts in relative terms across the universe:
     * measured live, BTC's tick is 1.6 ppm of its mark while PUMP's is 508 ppm of its. A pure-ppm
     * window set from BTC-scale drift is therefore SMALLER than one tick for the coarse-grid assets,
     * which makes the gate unsatisfiable for them: nothing but an exact integer match could ever pass,
     * and an exact match on a moving price is luck. The floor is what stops one window from being
     * correct at one end of the universe and impossible at the other.
     */
    uint256 public immutable windowTicks;

    error PrecompileUnavailable(address precompile, uint32 asset);
    error PrecompileShortReturn(address precompile, uint32 asset, uint256 length);
    error ImplausibleSzDecimals(uint32 asset, uint256 szDecimals);
    error MarkMismatch(uint32 asset, uint256 chainMarkHat, uint256 provenP0Hat, uint256 deviationHat, uint256 allowedHat);
    error ProofRejected();

    constructor(address verifier_, uint256 windowPpm_, uint256 windowTicks_) {
        require(verifier_ != address(0), "verifier required");
        require(windowTicks_ >= 1, "windowTicks must be at least 1: below one tick nothing but an exact match can pass");
        verifier = IPlonkVerifier(verifier_);
        windowPpm = windowPpm_;
        windowTicks = windowTicks_;
    }

    // ── A1 ───────────────────────────────────────────────────────────────────────────────────────

    /// Raw HyperCore mark, in 10^(6 − szDecimals) units. Reverts rather than returning zero.
    function markPxRaw(uint32 asset) public view returns (uint64) {
        (bool ok, bytes memory data) = MARK_PX.staticcall(abi.encode(asset));
        if (!ok) revert PrecompileUnavailable(MARK_PX, asset);
        if (data.length < 32) revert PrecompileShortReturn(MARK_PX, asset, data.length);
        return abi.decode(data, (uint64));
    }

    /// szDecimals from perpAssetInfo, which sets the price grid. Reverts rather than returning zero.
    function szDecimals(uint32 asset) public view returns (uint8) {
        (bool ok, bytes memory data) = PERP_ASSET_INFO.staticcall(abi.encode(asset));
        if (!ok) revert PrecompileUnavailable(PERP_ASSET_INFO, asset);
        // string coin, uint32 marginTableId, uint8 szDecimals, uint8 maxLeverage, bool onlyIsolated
        if (data.length < 192) revert PrecompileShortReturn(PERP_ASSET_INFO, asset, data.length);
        uint256 sz;
        // Word 3 of the return: [0] tuple offset, [1] string offset, [2] marginTableId, [3] szDecimals.
        // Read positionally rather than via abi.decode so a future extra trailing field cannot shift
        // the meaning of this value silently.
        assembly { sz := mload(add(data, 128)) }
        if (sz > 8) revert ImplausibleSzDecimals(asset, sz);
        return uint8(sz);
    }

    /// The mark on the circuit's 1e9 grid. Exact: 1e9 / 10^(6−sz) = 10^(3+sz).
    function markPxHat(uint32 asset) public view returns (uint256) {
        uint256 hat = uint256(markPxRaw(asset)) * (10 ** (3 + uint256(szDecimals(asset))));
        if (hat == 0) revert PrecompileUnavailable(MARK_PX, asset);
        return hat;
    }

    /// Both precompile reads and the derived grid value in one call, for a caller that wants to see
    /// the parts the gate will compare.
    function markSnapshot(uint32 asset) external view returns (uint64 raw, uint8 sz, uint256 hat, uint256 blockNumber) {
        raw = markPxRaw(asset);
        sz = szDecimals(asset);
        hat = uint256(raw) * (10 ** (3 + uint256(sz)));
        blockNumber = block.number;
    }

    /// The precompiles' RAW return bytes alongside the values derived from them, in one call.
    ///
    /// This exists so the decode can be checked with no timing in the way. Comparing a contract read
    /// against a separate off-chain read compares two different moments — HyperCore marks turn over
    /// about once a second — so a disagreement is ambiguous between "the decode is wrong" and "the
    /// price moved". Handing back the exact bytes the precompile returned makes the decode checkable
    /// against those same bytes, and leaves nothing for movement to explain.
    function markProvenance(uint32 asset)
        external view returns (bytes memory markRet, bytes memory infoRet, uint64 raw, uint8 sz, uint256 hat)
    {
        bool ok;
        (ok, markRet) = MARK_PX.staticcall(abi.encode(asset));
        if (!ok) revert PrecompileUnavailable(MARK_PX, asset);
        (ok, infoRet) = PERP_ASSET_INFO.staticcall(abi.encode(asset));
        if (!ok) revert PrecompileUnavailable(PERP_ASSET_INFO, asset);
        raw = markPxRaw(asset);
        sz = szDecimals(asset);
        hat = uint256(raw) * (10 ** (3 + uint256(sz)));
    }

    /// Many assets AT ONE BLOCK. Sampling assets one call at a time folds RPC latency into what looks
    /// like price drift; this does not, which is what A3's staleness measurement needs to be honest.
    function marksHat(uint32[] calldata assets)
        external view returns (uint256 blockNumber, uint256 blockTime, uint256[] memory hats)
    {
        hats = new uint256[](assets.length);
        for (uint256 i = 0; i < assets.length; i++) {
            hats[i] = uint256(markPxRaw(assets[i])) * (10 ** (3 + uint256(szDecimals(assets[i]))));
        }
        return (block.number, block.timestamp, hats);
    }

    // ── A0 ───────────────────────────────────────────────────────────────────────────────────────

    /// The arithmetic alone, with no claim about where the input came from. Same call, same answer,
    /// same bytes as the verifier already deployed on X Layer.
    function verifyProof(uint256[24] calldata proof, uint256[8] calldata pubSignals) external view returns (bool) {
        return verifier.verifyProof(proof, pubSignals);
    }

    // ── A2 ───────────────────────────────────────────────────────────────────────────────────────

    /// The window for one asset, on the 1e9 grid: the wider of `windowPpm` of the mark and
    /// `windowTicks` ticks. Public so a caller can see the bound their proof will be held to before
    /// they pay for a transaction that would revert.
    function allowedDeviationHat(uint32 asset) public view returns (uint256 chainHat, uint256 allowed) {
        uint64 raw = markPxRaw(asset);
        uint256 tick = 10 ** (3 + uint256(szDecimals(asset)));
        chainHat = uint256(raw) * tick;
        // A mark of zero is not a price, it is the absence of one, and comparing a proven price against
        // it would make every near-zero p0Hat pass. The precompile reverts for an asset it does not
        // know, but nothing guarantees a known asset always carries a non-zero mark, so this fails
        // closed rather than trusting that it does.
        if (chainHat == 0) revert PrecompileUnavailable(MARK_PX, asset);
        uint256 byPpm = (chainHat * windowPpm) / 1_000_000;
        uint256 byTicks = windowTicks * tick;
        allowed = byPpm > byTicks ? byPpm : byTicks;
    }

    /// How far the proven entry price sits from the chain's mark right now, in ppm.
    function deviationPpm(uint256[8] calldata pubSignals, uint32 asset) public view returns (uint256) {
        uint256 chainHat = markPxHat(asset);
        if (chainHat == 0) revert PrecompileUnavailable(MARK_PX, asset);
        uint256 proven = pubSignals[P0_INDEX];
        uint256 diff = chainHat > proven ? chainHat - proven : proven - chainHat;
        return (diff * 1_000_000) / chainHat;
    }

    /**
     * THE JOIN. One call, both halves.
     *
     * Reverts — never returns false — when the price is wrong or the proof is bad, so a caller cannot
     * mistake a zero return for a pass and so the reason is on chain in the revert data.
     */
    function verifyPerpGate(uint256[24] calldata proof, uint256[8] calldata pubSignals, uint32 asset)
        external view returns (bool)
    {
        (uint256 chainHat, uint256 allowed) = allowedDeviationHat(asset);
        uint256 proven = pubSignals[P0_INDEX];
        uint256 diff = chainHat > proven ? chainHat - proven : proven - chainHat;

        // Compared on the 1e9 grid as integers, with no division anywhere in the decision. A ppm
        // figure computed by dividing would truncate, and the truncation would sit exactly on the
        // boundary this gate exists to hold.
        if (diff > allowed) revert MarkMismatch(asset, chainHat, proven, diff, allowed);
        if (!verifier.verifyProof(proof, pubSignals)) revert ProofRejected();
        return true;
    }
}
