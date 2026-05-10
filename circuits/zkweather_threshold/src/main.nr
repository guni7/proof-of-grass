use ::poseidon::poseidon::bn254::hash_2 as poseidon_hash_2;
use ::poseidon::poseidon::bn254::hash_6 as poseidon_hash_6;

fn hash2(left: Field, right: Field) -> Field {
    poseidon_hash_2([left, right])
}

fn hash_reading(
    device_hash: Field,
    nonce: Field,
    timestamp: Field,
    temperature_x10: Field,
    humidity_x10: Field,
    firmware_hash: Field
) -> Field {
    poseidon_hash_6([
        device_hash,
        nonce,
        timestamp,
        temperature_x10,
        humidity_x10,
        firmware_hash
    ])
}

fn merkle_root_from_path(
    leaf: Field,
    path: [Field; 3],
    index: u32
) -> Field {
    let mut current = leaf;
    let mut idx = index;

    for i in 0..3 {
        let sibling = path[i];

        if idx % 2 == 0 {
            current = hash2(current, sibling);
        } else {
            current = hash2(sibling, current);
        }

        idx = idx / 2;
    }

    current
}

fn is_gte(a: u32, b: u32) -> u32 {
    if a >= b {
        1
    } else {
        0
    }
}

fn main(
    device_hashes: [Field; 5],
    nonces: [Field; 5],
    timestamps: [u32; 5],
    temperature_x10s: [Field; 5],
    humidity_x10s: [u32; 5],
    firmware_hashes: [Field; 5],

    merkle_paths: [[Field; 3]; 5],
    leaf_indices: [u32; 5],

    merkle_root: pub Field,
    threshold: pub u32,
    min_count: pub u32,
    window_start: pub u32,
    window_end: pub u32
) {
    let mut count: u32 = 0;

    for i in 0..5 {
        assert(humidity_x10s[i] <= 1000);

        assert(timestamps[i] >= window_start);
        assert(timestamps[i] <= window_end);

        let leaf = hash_reading(
            device_hashes[i],
            nonces[i],
            timestamps[i] as Field,
            temperature_x10s[i],
            humidity_x10s[i] as Field,
            firmware_hashes[i]
        );

        let computed_root = merkle_root_from_path(
            leaf,
            merkle_paths[i],
            leaf_indices[i]
        );

        assert(computed_root == merkle_root);

        count = count + is_gte(humidity_x10s[i], threshold);
    }

    assert(timestamps[0] <= timestamps[1]);
    assert(timestamps[1] <= timestamps[2]);
    assert(timestamps[2] <= timestamps[3]);
    assert(timestamps[3] <= timestamps[4]);

    assert(count >= min_count);
}