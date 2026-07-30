// What does it cost to check execadverse's ENTIRE statement on-chain WITHOUT a proof?
// Every input of the circuit is public (r1cs header: nPrvIn = 0), so the statement is a closed-form
// predicate over the eight numbers the verifier already receives. This measures that predicate in the
// same @ethereumjs/evm harness gate B5-5 uses, against the same witness.
import __P from '../paths.mjs';
import { createRequire } from 'node:module';
const ZK = __P.ZK;
const req = createRequire(`${ZK}/package.json`);
const solc = req('solc');
const { EVM } = req('@ethereumjs/evm');
const { Common, Chain, Hardfork } = req('@ethereumjs/common');
const { keccak256 } = req('ethereum-cryptography/keccak.js');
const { utf8ToBytes, bytesToHex, hexToBytes } = req('ethereum-cryptography/utils.js');

const SRC = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract DirectCheck {
    int256 constant S     = 1000000000;
    int256 constant AMAX  = 4611686018427387904;     // 2^62
    int256 constant BMAX  = 1125899906842624;        // 2^50
    // Exactly the statement execadverse.circom enforces, no proof involved.
    function check(int256 x, int256 y, int256 dx, int256 f, int256 inn, int256 o, int256 z, int256 b)
        external pure returns (bool)
    {
        // range discipline (the circuit's Num2Bits set)
        if (x <= 0 || y <= 0 || dx <= 0 || z <= 0) return false;
        if (x >= AMAX || y >= AMAX || dx >= AMAX || inn >= AMAX || o >= AMAX || z >= AMAX) return false;
        if (inn < 0 || o < 0) return false;
        if (f < 0 || f >= S) return false;                  // a fee is a fraction
        if (b < -BMAX || b >= BMAX) return false;           // signed headline width
        int256 yOut = y - o;
        if (yOut < 0) return false;                         // the pool cannot overpay
        int256 xIn = x + inn;
        // the fee identity, |Rf| <= S/2
        int256 Rf = inn * S - dx * (S - f);
        if (2 * Rf + S < 0 || 2 * Rf + S > 2 * S) return false;
        // the invariant, |R| <= (xIn + yOut)/2
        int256 R = xIn * yOut - x * y;
        int256 tol = xIn + yOut;
        if (2 * R + tol < 0 || 2 * R + tol > 2 * tol) return false;
        // the shortfall, exact
        int256 s = o - z;
        // the headline, |Rb| <= o/2
        int256 Rb = b * o - 10000 * S * s;
        if (2 * Rb + o < 0 || 2 * Rb + o > 2 * o) return false;
        return true;
    }
}
`;

const out = JSON.parse(solc.compile(JSON.stringify({
  language: 'Solidity',
  sources: { 'DirectCheck.sol': { content: SRC } },
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } } },
})));
const errs = (out.errors || []).filter((e) => e.severity === 'error');
if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join('\n'));
const V = out.contracts['DirectCheck.sol'].DirectCheck;
console.log(`solc ${solc.version()} · deployed ${V.evm.deployedBytecode.object.length / 2} bytes`);

const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Cancun });
const evm = await EVM.create({ common });
const caller = hexToBytes('1000000000000000000000000000000000000001');
const dep = await evm.runCall({ caller: { bytes: caller }, data: hexToBytes(V.evm.bytecode.object), gasLimit: 30_000_000n });
if (dep.execResult.exceptionError) throw new Error('deploy: ' + dep.execResult.exceptionError);
const addr = dep.createdAddress;

const R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const sel = bytesToHex(keccak256(utf8ToBytes('check(int256,int256,int256,int256,int256,int256,int256,int256)'))).slice(0, 8);
const enc = (vals) => hexToBytes(sel + vals.map((v) => ((BigInt(v) % (1n << 256n)) + (1n << 256n)) % (1n << 256n)).map((v) => v.toString(16).padStart(64, '0')).join(''));

// the witness gate B5-3/B5-5 recorded
const W = [1500000000000000n, 3750000000000000n, 15000000000000n, 3000000n, 14955000000000n, 37018426289890n, 36900000000000n, 31991173521n];

const call = async (label, vals, expect) => {
  const data = enc(vals);
  const res = await evm.runCall({ caller: { bytes: caller }, to: addr, data, gasLimit: 8_000_000n });
  const err = res.execResult.exceptionError;
  const ret = bytesToHex(res.execResult.returnValue);
  const value = err ? null : BigInt('0x' + (ret || '0')) === 1n;
  let cd = 0; for (const bb of data) cd += bb === 0 ? 4 : 16;
  const g = Number(res.execResult.executionGasUsed);
  console.log(`  [${value === expect ? 'PASS' : '*** FAIL ***'}] ${label.padEnd(38)} ${String(value).padEnd(5)} execGas=${String(g).padStart(6)} calldata=${cd} total=${g + cd}`);
  return { g, cd };
};

console.log('\nChecking execadverse\'s statement directly, no proof:');
const honest = await call('the honest witness', W, true);
// every perturbation the circuit refuses, the direct checker must refuse too
const perturb = [
  ['xHat +1', 0], ['yHat +1', 1], ['dxHat +1', 2], ['fHat +1', 3],
  ['inHat +1', 4], ['outHat +1', 5], ['realizedHat +1', 6], ['bpsHat +1', 7],
];
let refused = 0;
for (const [label, i] of perturb) {
  const v = [...W]; v[i] = v[i] + 1n;
  const r = await call(label + ' must be refused', v, false);
  refused++;
}
// a sign-flipped headline and a headline past the 2^50 width
for (const [label, i, val] of [['bpsHat sign-flipped', 7, -31991173521n], ['bpsHat past 2^50', 7, 1125899906842624n]]) {
  const v = [...W]; v[i] = val;
  await call(label + ' must be refused', v, false);
}

console.log(`\nhonest accept: ${honest.g} execution gas + ${honest.cd} calldata = ${honest.g + honest.cd} total`);
console.log('gate B5-5 measured 278,962 execution gas for the Plonk verifier on the same statement.');
console.log(`ratio (execution only): ${(278962 / honest.g).toFixed(1)}x`);
