import { parentPort, workerData } from 'worker_threads';
import { verifyRangeProof } from './bulletproofs';
import type { BulletproofProof } from './bulletproofs';
import type { Point } from './pedersen';

interface WorkerInput {
  V: Point;
  proof: BulletproofProof;
  k?: number;
}

function run() {
  if (!parentPort) {
    console.error('This script must be run as a worker thread.');
    process.exit(1);
  }

  try {
    const { V, proof, k } = workerData as WorkerInput;
    
    // Parse BigInt values just in case they were serialized as strings (e.g. from JSON)
    const parsePoint = (p: any): Point => ({
      x: typeof p.x === 'string' ? BigInt(p.x) : p.x,
      y: typeof p.y === 'string' ? BigInt(p.y) : p.y,
      isInfinity: !!p.isInfinity
    });

    const parsedV = parsePoint(V);
    const parsedProof = {
      A: parsePoint(proof.A),
      S: parsePoint(proof.S),
      T1: parsePoint(proof.T1),
      T2: parsePoint(proof.T2),
      tVal: typeof proof.tVal === 'string' ? BigInt(proof.tVal) : proof.tVal,
      tX: typeof proof.tX === 'string' ? BigInt(proof.tX) : proof.tX,
      mu: typeof proof.mu === 'string' ? BigInt(proof.mu) : proof.mu,
    };

    const isValid = verifyRangeProof(parsedV, parsedProof, k ?? 32);
    parentPort.postMessage(isValid);
  } catch (err: any) {
    console.error('[Bulletproofs Worker] Error during proof verification:', err);
    parentPort.postMessage(false);
  }
}

run();
