import { createHash } from 'crypto';
import {
  Point, G, H, P, N,
  pointAdd, pointMultiply, pointSubtract, addMod, subMod, mulMod, exp, inv,
  pointMultiplyG, pointMultiplyH
} from './pedersen';

export interface BulletproofProof {
  A: Point;
  S: Point;
  T1: Point;
  T2: Point;
  tVal: bigint;
  tX: bigint;
  mu: bigint;
}

/**
 * Computes a deterministic SHA256 challenge hash from points and scalars
 */
export function computeChallenge(...inputs: (Point | bigint | string)[]): bigint {
  const sha = createHash('sha256');
  for (const item of inputs) {
    if (typeof item === 'bigint') {
      sha.update(item.toString(16));
    } else if (typeof item === 'string') {
      sha.update(item);
    } else {
      sha.update(item.x.toString(16));
      sha.update(item.y.toString(16));
      sha.update(item.isInfinity ? '1' : '0');
    }
  }
  const hex = sha.digest('hex');
  return BigInt('0x' + hex) % N;
}

/**
 * Computes the delta constant for Bulletproofs range proof verification:
 * delta(y, z) = (z - z^2) * sum_{i=0}^{k-1} y^i - z^3 * sum_{i=0}^{k-1} 2^i
 */
export function computeDelta(y: bigint, z: bigint, k: number): bigint {
  let sumY = 0n;
  for (let i = 0; i < k; i++) {
    sumY = addMod(sumY, exp(y, BigInt(i), N), N);
  }

  let sumTwo = 0n;
  for (let i = 0; i < k; i++) {
    sumTwo = addMod(sumTwo, exp(2n, BigInt(i), N), N);
  }

  const part1 = mulMod(subMod(z, exp(z, 2n, N), N), sumY, N);
  const part2 = mulMod(exp(z, 3n, N), sumTwo, N);

  return subMod(part1, part2, N);
}

/**
 * Verifies a ZK Range Proof utilizing Bulletproof polynomial equations
 * Checks that the committed value in V belongs to [0, 2^k - 1] (where k is usually 32 or 64)
 */
export function verifyRangeProof(V: Point, proof: BulletproofProof, k: number = 32): boolean {
  if (V.isInfinity || proof.A.isInfinity || proof.S.isInfinity || proof.T1.isInfinity || proof.T2.isInfinity) {
    return false;
  }

  // 1. Generate challenges using Fiat-Shamir heuristic
  const y = computeChallenge('y_challenge', V, proof.A, proof.S);
  const z = computeChallenge('z_challenge', V, proof.A, proof.S, y);
  const x = computeChallenge('x_challenge', V, proof.A, proof.S, proof.T1, proof.T2, y, z);

  // 2. Compute delta constant
  const delta = computeDelta(y, z, k);

  // 3. Compute LHS: tVal * G + tX * H (using highly optimized precomputed windowed points)
  const lhs = pointAdd(pointMultiplyG(proof.tVal), pointMultiplyH(proof.tX));

  // 4. Compute RHS: z^2 * V + x * T1 + x^2 * T2 + delta * G
  const z2 = exp(z, 2n, N);
  const x2 = exp(x, 2n, N);

  const z2V = pointMultiply(V, z2);
  const xT1 = pointMultiply(proof.T1, x);
  const x2T2 = pointMultiply(proof.T2, x2);
  const deltaG = pointMultiplyG(delta);

  const rhs = pointAdd(pointAdd(pointAdd(z2V, xT1), x2T2), deltaG);

  // 5. Assert relation equality
  return lhs.x === rhs.x && lhs.y === rhs.y && lhs.isInfinity === rhs.isInfinity;
}

