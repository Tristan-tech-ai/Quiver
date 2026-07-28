pragma circom 2.1.6;

// NOT a Quiver statement. A measuring stick.
//
// Plonk's proving cost is dominated by the size of the evaluation domain, which is the next power of
// two above the constraint count, and not by what the constraints happen to say. So a chain of
// multiplications sized to fill a domain gives a representative timing for ANY circuit that lands in
// that domain, including a portfolio circuit we cannot build yet for want of a bigger ceremony file.
//
// Two data points (1024 and 2048) were not enough to extrapolate three doublings from. This adds the
// third at 4096, which is the ceiling of the powers-of-tau on hand, so it costs no download.
template PadProbe(N) {
    signal input seed;
    signal output out;

    signal chain[N + 1];
    chain[0] <== seed;
    for (var i = 0; i < N; i++) {
        chain[i + 1] <== chain[i] * chain[i];
    }
    out <== chain[N];
}

component main {public [seed]} = PadProbe(3900);
