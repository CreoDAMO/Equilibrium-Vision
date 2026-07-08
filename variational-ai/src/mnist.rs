/// MNIST data container (real or synthetic).
///
/// All pixels are normalised to [0, 1].  Labels are binary (0.0 or 1.0).
/// For the default synthetic path, features are linearly separable so
/// benchmarks complete instantly without downloading MNIST files.
///
/// To use real MNIST:
///   1. Download the four IDX files from http://yann.lecun.com/exdb/mnist/
///   2. Decompress them into `variational-ai/data/`
///   3. Call `load_real_mnist()` (requires the "real-mnist" Cargo feature and
///      the `mnist` crate — add it manually if needed).
pub struct MnistData {
    pub train_data:   Vec<f64>, // n_train × dim, row-major
    pub train_labels: Vec<f64>, // n_train binary targets
    pub test_data:    Vec<f64>,
    pub test_labels:  Vec<f64>,
    pub dim:          usize,    // 64 (8×8 resized)
    pub train_count:  usize,
    pub test_count:   usize,
}

// ── Synthetic data (always available, no file I/O) ────────────────────────────

/// Generate a synthetic binary classification dataset that mimics the structure
/// of binary MNIST (0 vs 1) resized to 8×8.
///
/// Class 0: Gaussian centred at -0.5 in all features
/// Class 1: Gaussian centred at +0.5 in all features
pub fn load_synthetic_mnist(n_train: usize, n_test: usize) -> MnistData {
    use rand::SeedableRng;
    use rand_chacha::ChaCha8Rng;
    use rand::Rng;

    const DIM: usize = 64;
    let mut rng_train = ChaCha8Rng::seed_from_u64(12345);
    let mut rng_test  = ChaCha8Rng::seed_from_u64(67890);

    let make_set = |n: usize, rng: &mut ChaCha8Rng| -> (Vec<f64>, Vec<f64>) {
        let mut data   = Vec::with_capacity(n * DIM);
        let mut labels = Vec::with_capacity(n);
        for i in 0..n {
            let label = (i % 2) as f64; // alternating 0/1
            let centre = if label == 0.0 { 0.25_f64 } else { 0.75_f64 };
            for _ in 0..DIM {
                let noise: f64 = rng.gen_range(-0.15..0.15);
                data.push((centre + noise).clamp(0.0, 1.0));
            }
            labels.push(label);
        }
        (data, labels)
    };

    let (train_data, train_labels) = make_set(n_train, &mut rng_train);
    let (test_data,  test_labels)  = make_set(n_test,  &mut rng_test);

    MnistData {
        train_count: n_train,
        test_count:  n_test,
        dim: DIM,
        train_data,
        train_labels,
        test_data,
        test_labels,
    }
}

// ── Real MNIST (compile-time gated) ──────────────────────────────────────────

/// Resize a 28×28 greyscale image to 8×8 by averaging non-overlapping 3.5×3.5 blocks.
fn resize_8x8(img_28: &[u8]) -> [f64; 64] {
    let mut small = [0.0_f64; 64];
    for y in 0..8_usize {
        for x in 0..8_usize {
            let sx0 = (x as f32 * 3.5) as usize;
            let sy0 = (y as f32 * 3.5) as usize;
            let mut sum = 0u32;
            let mut cnt = 0u32;
            for sy in sy0..(sy0 + 4).min(28) {
                for sx in sx0..(sx0 + 4).min(28) {
                    sum += img_28[sy * 28 + sx] as u32;
                    cnt += 1;
                }
            }
            small[y * 8 + x] = (sum / cnt) as f64 / 255.0;
        }
    }
    small
}

/// Load real MNIST from IDX files in `data/` (relative to the crate root).
///
/// Filters to binary digits 0 and 1 only; resizes 28×28 → 8×8.
/// Panics with a helpful message if the files cannot be found.
#[allow(dead_code)]
pub fn load_real_mnist() -> MnistData {
    // Attempt to read IDX files manually (no external crate dependency).
    // File format: magic(4) + n_items(4) [+ rows(4) + cols(4)] + data
    fn read_idx_images(path: &str) -> (Vec<Vec<u8>>, usize, usize) {
        let bytes = std::fs::read(path).unwrap_or_else(|e| {
            panic!(
                "Cannot open MNIST image file '{}': {}\n\
                 Download MNIST from http://yann.lecun.com/exdb/mnist/ \
                 and decompress into variational-ai/data/",
                path, e
            )
        });
        let n    = u32::from_be_bytes(bytes[4..8].try_into().unwrap()) as usize;
        let rows = u32::from_be_bytes(bytes[8..12].try_into().unwrap()) as usize;
        let cols = u32::from_be_bytes(bytes[12..16].try_into().unwrap()) as usize;
        let pix  = rows * cols;
        let images: Vec<Vec<u8>> = (0..n).map(|i| bytes[16 + i * pix..16 + (i + 1) * pix].to_vec()).collect();
        (images, rows, cols)
    }

    fn read_idx_labels(path: &str) -> Vec<u8> {
        let bytes = std::fs::read(path).unwrap_or_else(|e| {
            panic!(
                "Cannot open MNIST label file '{}': {}\n\
                 Download MNIST from http://yann.lecun.com/exdb/mnist/ \
                 and decompress into variational-ai/data/",
                path, e
            )
        });
        let n = u32::from_be_bytes(bytes[4..8].try_into().unwrap()) as usize;
        bytes[8..8 + n].to_vec()
    }

    let (train_imgs, _, _) = read_idx_images("data/train-images-idx3-ubyte");
    let train_lbls = read_idx_labels("data/train-labels-idx1-ubyte");
    let (test_imgs, _, _)  = read_idx_images("data/t10k-images-idx3-ubyte");
    let test_lbls  = read_idx_labels("data/t10k-labels-idx1-ubyte");

    // Filter to digits 0 and 1 only.
    let filter = |imgs: &[Vec<u8>], lbls: &[u8]| -> (Vec<f64>, Vec<f64>) {
        let mut data   = Vec::new();
        let mut labels = Vec::new();
        for (img, &lbl) in imgs.iter().zip(lbls.iter()) {
            if lbl == 0 || lbl == 1 {
                let resized = resize_8x8(img);
                data.extend_from_slice(&resized);
                labels.push(lbl as f64);
            }
        }
        (data, labels)
    };

    let (train_data, train_labels) = filter(&train_imgs, &train_lbls);
    let (test_data,  test_labels)  = filter(&test_imgs,  &test_lbls);

    let train_count = train_labels.len();
    let test_count  = test_labels.len();

    MnistData { train_data, train_labels, test_data, test_labels, dim: 64, train_count, test_count }
}
