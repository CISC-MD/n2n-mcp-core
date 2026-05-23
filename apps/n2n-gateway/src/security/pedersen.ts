// Secp256k1 Elliptic Curve Point Math and Pedersen Commitments
// Curve: y^2 = x^3 + 7 (mod p)

export const P = 2n ** 256n - 2n ** 32n - 977n; // Field prime
export const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n; // Curve order

export interface Point {
  x: bigint;
  y: bigint;
  isInfinity: boolean;
}

export const POINT_INFINITY: Point = { x: 0n, y: 0n, isInfinity: true };

// Standard Generator G
export const G: Point = {
  x: 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
  y: 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n,
  isInfinity: false
};

// Cryptographically independent Generator H
// H_x = sha256(G_x) = 0x50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0n
export const H_x = 0x50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0n;
// Calculate H_y: y^2 = x^3 + 7 (mod p) => y = (x^3 + 7)^((p+1)/4) mod p
const H_y_squared = (exp(H_x, 3n, P) + 7n) % P;
export const H: Point = {
  x: H_x,
  y: exp(H_y_squared, (P + 1n) / 4n, P),
  isInfinity: false
};

// --- Finite Field Arithmetic Helpers ---

export function addMod(a: bigint, b: bigint, m: bigint = P): bigint {
  const sum = (a + b) % m;
  return sum < 0n ? sum + m : sum;
}

export function subMod(a: bigint, b: bigint, m: bigint = P): bigint {
  const diff = (a - b) % m;
  return diff < 0n ? diff + m : diff;
}

export function mulMod(a: bigint, b: bigint, m: bigint = P): bigint {
  const prod = (a * b) % m;
  return prod < 0n ? prod + m : prod;
}

export function exp(base: bigint, exponent: bigint, m: bigint = P): bigint {
  let res = 1n;
  let b = base % m;
  let e = exponent;
  if (b < 0n) b += m;
  while (e > 0n) {
    if (e & 1n) res = (res * b) % m;
    b = (b * b) % m;
    e = e >> 1n;
  }
  return res;
}

export function inv(a: bigint, m: bigint = P): bigint {
  return exp(a, m - 2n, m);
}

// --- Elliptic Curve Point Math ---

export function pointAdd(p1: Point, p2: Point): Point {
  if (p1.isInfinity) return p2;
  if (p2.isInfinity) return p1;

  if (p1.x === p2.x) {
    if (addMod(p1.y, p2.y, P) === 0n) {
      return POINT_INFINITY;
    }
    return pointDouble(p1);
  }

  // lambda = (y2 - y1) / (x2 - x1) mod P
  const dy = subMod(p2.y, p1.y, P);
  const dx = subMod(p2.x, p1.x, P);
  const lambda = mulMod(dy, inv(dx, P), P);

  // x3 = lambda^2 - x1 - x2 mod P
  const x3 = subMod(subMod(exp(lambda, 2n, P), p1.x, P), p2.x, P);
  // y3 = lambda * (x1 - x3) - y1 mod P
  const y3 = subMod(mulMod(lambda, subMod(p1.x, x3, P), P), p1.y, P);

  return { x: x3, y: y3, isInfinity: false };
}

export function pointDouble(p: Point): Point {
  if (p.isInfinity || p.y === 0n) return POINT_INFINITY;

  // lambda = (3 * x^2) / (2 * y) mod P
  const numerator = mulMod(3n, exp(p.x, 2n, P), P);
  const denominator = mulMod(2n, p.y, P);
  const lambda = mulMod(numerator, inv(denominator, P), P);

  // x3 = lambda^2 - 2 * x mod P
  const x3 = subMod(exp(lambda, 2n, P), mulMod(2n, p.x, P), P);
  // y3 = lambda * (x - x3) - y mod P
  const y3 = subMod(mulMod(lambda, subMod(p.x, x3, P), P), p.y, P);

  return { x: x3, y: y3, isInfinity: false };
}

export function pointMultiply(p: Point, scalar: bigint): Point {
  if (p.isInfinity) return POINT_INFINITY;
  let s = scalar % N;
  if (s === 0n) return POINT_INFINITY;
  if (s < 0n) s += N;

  // Dynamic 4-bit windowed scalar multiplication for arbitrary points
  const table: Point[] = [POINT_INFINITY];
  let running = POINT_INFINITY;
  for (let d = 1; d < 16; d++) {
    running = pointAdd(running, p);
    table.push(running);
  }

  let res = POINT_INFINITY;
  for (let i = 63; i >= 0; i--) {
    for (let j = 0; j < 4; j++) {
      res = pointDouble(res);
    }
    const digit = Number((s >> BigInt(4 * i)) & 0xfn);
    if (digit > 0) {
      res = pointAdd(res, table[digit]);
    }
  }
  return res;
}

// --- Precomputed Windowed Scalar Multiplication for Fixed Generators G and H ---
// Window size w = 4. Number of windows = 64 (256 / 4).
// Values per window = 16 (2^4).
// This reduces scalar multiplication of constant generators G and H from ~384 operations down to <= 64 simple point additions.

const WINDOW_SIZE = 4;
const NUM_WINDOWS = 64;
const VALS_PER_WINDOW = 16;

function precomputeTable(base: Point): Point[][] {
  const table: Point[][] = [];
  let currentBase = base;
  for (let i = 0; i < NUM_WINDOWS; i++) {
    const windowPoints: Point[] = [POINT_INFINITY];
    let running = POINT_INFINITY;
    for (let d = 1; d < VALS_PER_WINDOW; d++) {
      running = pointAdd(running, currentBase);
      windowPoints.push(running);
    }
    table.push(windowPoints);
    
    // Advance currentBase by multiplying by 2^WINDOW_SIZE (pointDouble 4 times)
    let nextBase = currentBase;
    for (let j = 0; j < WINDOW_SIZE; j++) {
      nextBase = pointDouble(nextBase);
    }
    currentBase = nextBase;
  }
  return table;
}

// Precompute tables on load
const gTable = precomputeTable(G);
const hTable = precomputeTable(H);

export function pointMultiplyG(scalar: bigint): Point {
  let s = scalar % N;
  if (s === 0n) return POINT_INFINITY;
  if (s < 0n) s += N;

  let res = POINT_INFINITY;
  for (let i = 0; i < NUM_WINDOWS; i++) {
    const digit = Number((s >> BigInt(4 * i)) & 0xfn);
    if (digit > 0) {
      res = pointAdd(res, gTable[i][digit]);
    }
  }
  return res;
}

export function pointMultiplyH(scalar: bigint): Point {
  let s = scalar % N;
  if (s === 0n) return POINT_INFINITY;
  if (s < 0n) s += N;

  let res = POINT_INFINITY;
  for (let i = 0; i < NUM_WINDOWS; i++) {
    const digit = Number((s >> BigInt(4 * i)) & 0xfn);
    if (digit > 0) {
      res = pointAdd(res, hTable[i][digit]);
    }
  }
  return res;
}

export function pointNegate(p: Point): Point {
  if (p.isInfinity) return p;
  return { x: p.x, y: subMod(0n, p.y, P), isInfinity: false };
}

export function pointSubtract(p1: Point, p2: Point): Point {
  return pointAdd(p1, pointNegate(p2));
}

// --- Pedersen Commitment Implementation ---

/**
 * Creates a Pedersen Commitment: C = v*G + s*H
 * @param value The value (e.g. balance or fee)
 * @param blindingFactor Random scalar factor
 */
export function commit(value: bigint, blindingFactor: bigint): Point {
  const vG = pointMultiplyG(value);
  const sH = pointMultiplyH(blindingFactor);
  return pointAdd(vG, sH);
}

/**
 * Performs homomorphic subtraction of commitments: C_new = C_orig - C_fee
 */
export function subtractCommitments(cOrig: Point, cFee: Point): Point {
  return pointSubtract(cOrig, cFee);
}

/**
 * Verifies that a commitment opens to a given value and blinding factor.
 */
export function verifyCommitment(commitment: Point, value: bigint, blindingFactor: bigint): boolean {
  const calculated = commit(value, blindingFactor);
  return commitment.x === calculated.x && commitment.y === calculated.y && commitment.isInfinity === calculated.isInfinity;
}
