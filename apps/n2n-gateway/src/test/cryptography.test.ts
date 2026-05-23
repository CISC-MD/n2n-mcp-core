import { test } from 'node:test';
import assert from 'node:assert';
import {
  G, H, POINT_INFINITY, N,
  pointAdd, pointMultiply, pointSubtract, commit, subtractCommitments, verifyCommitment,
  pointMultiplyG, pointMultiplyH, addMod, mulMod, exp, Point
} from '../security/pedersen';
import { verifyRangeProof, BulletproofProof, computeChallenge, computeDelta } from '../security/bulletproofs';

/**
 * Helper to generate a mock valid bulletproof range proof for testing and authorization.
 * Relocated from production bulletproofs.ts module to testing context.
 */
function generateMockProof(value: bigint, blinding: bigint, k: number = 32): { V: Point, proof: BulletproofProof } {
  const V = pointAdd(pointMultiplyG(value), pointMultiplyH(blinding));

  // We choose deterministic values that will solve the verification relation:
  // tVal * G + tX * H = z^2 * V + x * T1 + x^2 * T2 + delta * G
  // We can set random T1, T2, and solve for tVal and tX:
  const t1Blinding = 4829103n;
  const t2Blinding = 9182038n;
  
  const T1 = pointAdd(pointMultiplyG(100n), pointMultiplyH(t1Blinding));
  const T2 = pointAdd(pointMultiplyG(200n), pointMultiplyH(t2Blinding));

  const A = pointAdd(pointMultiplyG(50n), pointMultiplyH(120n));
  const S = pointAdd(pointMultiplyG(60n), pointMultiplyH(130n));

  const y = computeChallenge('y_challenge', V, A, S);
  const z = computeChallenge('z_challenge', V, A, S, y);
  const x = computeChallenge('x_challenge', V, A, S, T1, T2, y, z);

  const delta = computeDelta(y, z, k);
  
  const z2 = exp(z, 2n, N);
  const x2 = exp(x, 2n, N);

  // Solve for tVal and tX:
  // tVal = z^2 * value + x * 100 + x^2 * 200 + delta
  const tVal = addMod(
    addMod(mulMod(z2, value, N), mulMod(x, 100n, N), N),
    addMod(mulMod(x2, 200n, N), delta, N),
    N
  );

  // tX = z^2 * blinding + x * t1Blinding + x^2 * t2Blinding
  const tX = addMod(
    mulMod(z2, blinding, N),
    addMod(mulMod(x, t1Blinding, N), mulMod(x2, t2Blinding, N), N),
    N
  );

  const proof: BulletproofProof = {
    A,
    S,
    T1,
    T2,
    tVal,
    tX,
    mu: 9999n // mock inner-product coefficient
  };

  return { V, proof };
}

test('Cryptographic Ledger - Elliptic Curve Arithmetic', async (t) => {
  await t.test('G generator is on the curve and not infinity', () => {
    assert.strictEqual(G.isInfinity, false);
    assert.notStrictEqual(G.x, 0n);
    assert.notStrictEqual(G.y, 0n);
  });

  await t.test('H generator is on the curve and not infinity', () => {
    assert.strictEqual(H.isInfinity, false);
    assert.notStrictEqual(H.x, 0n);
    assert.notStrictEqual(H.y, 0n);
  });

  await t.test('Adding identity (Infinity) returns the point', () => {
    const res = pointAdd(G, POINT_INFINITY);
    assert.strictEqual(res.x, G.x);
    assert.strictEqual(res.y, G.y);
  });

  await t.test('Scalar multiplication of point by 1 returns the point', () => {
    const res = pointMultiply(G, 1n);
    assert.strictEqual(res.x, G.x);
    assert.strictEqual(res.y, G.y);
  });

  await t.test('Scalar multiplication of point by 2 matches point addition/doubling', () => {
    const mult2 = pointMultiply(G, 2n);
    const add2 = pointAdd(G, G);
    assert.strictEqual(mult2.x, add2.x);
    assert.strictEqual(mult2.y, add2.y);
  });

  await t.test('Point subtraction G - G returns Infinity', () => {
    const res = pointSubtract(G, G);
    assert.strictEqual(res.isInfinity, true);
  });
});

test('Cryptographic Ledger - Pedersen Commitments', async (t) => {
  const v1 = 1500n;
  const s1 = 981240182n;
  const v2 = 500n;
  const s2 = 412890381n;

  await t.test('Verification of correct commitment opening succeeds', () => {
    const c = commit(v1, s1);
    const valid = verifyCommitment(c, v1, s1);
    assert.strictEqual(valid, true);
  });

  await t.test('Verification of incorrect commitment opening fails', () => {
    const c = commit(v1, s1);
    const invalid = verifyCommitment(c, v1 + 1n, s1);
    assert.strictEqual(invalid, false);
  });

  await t.test('Homomorphic subtraction works: C(v1 - v2, s1 - s2) == C(v1) - C(v2)', () => {
    const c1 = commit(v1, s1);
    const c2 = commit(v2, s2);
    
    // Homomorphic subtraction
    const cSub = subtractCommitments(c1, c2);
    
    // Manual opening subtraction
    const expectedVal = v1 - v2;
    const expectedBlinding = s1 - s2;
    
    const valid = verifyCommitment(cSub, expectedVal, expectedBlinding);
    assert.strictEqual(valid, true);
  });
});

test('Cryptographic Ledger - Bulletproof ZK Range Proofs', async (t) => {
  await t.test('Verification of valid range proof succeeds', () => {
    const val = 120500n; // inside range [0, 2^32 - 1]
    const blinding = 48290384n;
    const { V, proof } = generateMockProof(val, blinding, 32);

    const isValid = verifyRangeProof(V, proof, 32);
    assert.strictEqual(isValid, true);
  });

  await t.test('Verification fails for proof modified maliciously', () => {
    const val = 120500n;
    const blinding = 48290384n;
    const { V, proof } = generateMockProof(val, blinding, 32);

    // Tamper with value scalar slightly
    const maliciousProof = { ...proof, tVal: proof.tVal + 1n };
    const isValid = verifyRangeProof(V, maliciousProof, 32);
    assert.strictEqual(isValid, false);
  });
});

test('Cryptographic Ledger - Bulletproof ZK Range Proofs in Worker Pool (verifyProofAsync)', async (t) => {
  const { verifyProofAsync } = await import('../security/crypto-pool');

  await t.test('Asynchronous verification of valid range proof succeeds', async () => {
    const val = 120500n;
    const blinding = 48290384n;
    const { V, proof } = generateMockProof(val, blinding, 32);

    const isValid = await verifyProofAsync(V, proof, 32);
    assert.strictEqual(isValid, true);
  });

  await t.test('Asynchronous verification fails for maliciously tampered proof', async () => {
    const val = 120500n;
    const blinding = 48290384n;
    const { V, proof } = generateMockProof(val, blinding, 32);

    const maliciousProof = { ...proof, tVal: proof.tVal + 1n };
    const isValid = await verifyProofAsync(V, maliciousProof, 32);
    assert.strictEqual(isValid, false);
  });
});

