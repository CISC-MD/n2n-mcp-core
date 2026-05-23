/**
 * Copyright (c) 2026 Center for Innovation in Cybersecurity (CISC).
 * Chief Architect: Pavel Berezovschi.
 * All rights reserved.
 * Licensed under the MIT License. See LICENSE in the project root for license information.
 */

use napi_derive::napi;
use bulletproofs::{BulletproofGens, PedersenGens, RangeProof};
use curve25519_dalek_ng::ristretto::CompressedRistretto;
use merlin::Transcript;

/// Highly optimized cryptographic range proof verification executed natively via Rust compiled assembly.
/// Integrates with V8 via NAPI-RS, eliminating thread serialization overhead.
#[napi]
pub fn verify_bulletproof_zk(commitment_bytes: Vec<u8>, proof_bytes: Vec<u8>) -> bool {
    if commitment_bytes.len() != 32 {
        return false;
    }

    // 1. Deserializes Pedersen Ristretto Commitment
    let commitment = CompressedRistretto::from_slice(&commitment_bytes);

    // 2. Deserializes Range Proof coefficients
    let proof = match RangeProof::from_bytes(&proof_bytes) {
        Ok(p) => p,
        Err(_) => return false,
    };

    // 3. Recreates Merlin transcript context (Fiat-Shamir challenge generator)
    let mut transcript = Transcript::new(b"N2N_ZK_RANGE_PROOF");
    let pc_gens = PedersenGens::default();
    let bp_gens = BulletproofGens::new(64, 1);

    // 4. Executes native Bulletproof range proof check
    proof.verify_single(&bp_gens, &pc_gens, &mut transcript, &commitment, 32).is_ok()
}
