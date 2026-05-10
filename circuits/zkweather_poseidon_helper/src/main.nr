use ::poseidon::poseidon::bn254::hash_2 as poseidon_hash_2;
use ::poseidon::poseidon::bn254::hash_6 as poseidon_hash_6;

fn main(
    mode: pub u32,
    a: Field,
    b: Field,
    c: Field,
    d: Field,
    e: Field,
    f: Field,
) -> pub Field {
    if mode == 2 {
        poseidon_hash_2([a, b])
    } else {
        poseidon_hash_6([a, b, c, d, e, f])
    }
}