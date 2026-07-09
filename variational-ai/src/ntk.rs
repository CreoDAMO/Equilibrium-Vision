use crate::action::Action;
use crate::deterministic;
use crate::mlp::MlpAction;
use nalgebra::{DMatrix, DVector};
use rand::SeedableRng;
use rand_chacha::ChaCha8Rng;
use rand::Rng;

/// Neural Tangent Kernel (NTK) action.
///
/// Given kernel matrix K and labels y, represents the action:
///   S(α) = (1/2N) ‖K·α − y‖² + (λ/2) αᵀ·K·α
pub struct NtkAction {
    pub kernel: DMatrix<f64>,
    pub y:      DVector<f64>,
    pub lambda: f64,
}

impl NtkAction {
    pub fn new(kernel: DMatrix<f64>, y: DVector<f64>, lambda: f64) -> Self {
        NtkAction { kernel, y, lambda }
    }

    /// Predict for a new point given its kernel row k_new (length = support size).
    pub fn predict(&self, alpha: &[f64], k_new: &[f64]) -> f64 {
        deterministic::dot(k_new, alpha)
    }
}

impl Action for NtkAction {
    type Parameter = DVector<f64>;

    /// S(α) = ½ ‖Kα − y‖² + (λ/2) αᵀKα
    ///
    /// This is the standard kernel ridge regression objective.  The stationarity
    /// condition ∇S = 0 gives (K + λI)α = y (when K is invertible), which is
    /// exactly what `solve_ntk` computes — so the residual ‖∇S(α*)‖ is
    /// machine-epsilon at the exact solution.
    fn evaluate(&self, alpha: &Self::Parameter) -> f64 {
        let k_alpha  = &self.kernel * alpha;
        let residual = &k_alpha - &self.y;
        let loss     = 0.5 * residual.dot(&residual);
        let reg      = 0.5 * self.lambda * alpha.dot(&k_alpha);
        loss + reg
    }

    /// ∇S(α) = K(Kα − y) + λKα = K[(K + λI)α − y]
    fn gradient(&self, alpha: &Self::Parameter) -> Vec<f64> {
        let k_alpha  = &self.kernel * alpha;
        let residual = &k_alpha - &self.y;              // Kα − y
        let grad     = &self.kernel * &residual + self.lambda * &k_alpha;
        grad.as_slice().to_vec()
    }

    /// H·v = K²v + λKv  (second derivative of S w.r.t. α)
    fn hessian_vec_prod(&self, _alpha: &Self::Parameter, v: &[f64]) -> Vec<f64> {
        let v_vec = DVector::from_column_slice(v);
        let kv    = &self.kernel * &v_vec;
        let k2v   = &self.kernel * &kv;
        let hv    = k2v + self.lambda * kv;
        hv.as_slice().to_vec()
    }

    fn dim(&self) -> usize { self.kernel.nrows() }
}

// ── Conjugate-Gradient solver for (K + λI)α = y ─────────────────────────────

/// Solve (K + λI) α = y using conjugate gradient (deterministic).
///
/// This is the primary solver for the NTK kernel system.  It operates
/// directly on the kernel matrix (no Action trait dispatch needed).
pub fn solve_ntk(
    kernel:   &DMatrix<f64>,
    y:        &DVector<f64>,
    lambda:   f64,
    tol:      f64,
    max_iter: usize,
) -> DVector<f64> {
    let n = kernel.nrows();
    let mut alpha = DVector::zeros(n);
    let mut r = y.clone(); // r = y − (K+λI)·0 = y
    let mut p = r.clone();
    let mut rsold = r.dot(&r);

    for _ in 0..max_iter {
        let kp = kernel * &p;
        let ap = &kp + lambda * &p;       // (K + λI)·p
        let p_ap = p.dot(&ap);
        if p_ap.abs() < 1e-14 { break; }
        let step = rsold / p_ap;
        alpha.axpy(step, &p, 1.0);        // α += step·p
        r.axpy(-step, &ap, 1.0);          // r -= step·(K+λI)p
        let rsnew = r.dot(&r);
        if rsnew.sqrt() < tol { break; }
        let beta = rsnew / rsold;
        p = &r + beta * &p;
        rsold = rsnew;
    }
    alpha
}

// ── Empirical NTK construction ────────────────────────────────────────────────

/// Build the empirical NTK for a two-layer ReLU MLP on a fixed support set.
///
/// The kernel entry K[i,j] = J(x_i)ᵀ · J(x_j), where J(x) is the Jacobian
/// of the network output w.r.t. all parameters, evaluated at a random
/// (seeded) initialisation.
pub fn compute_empirical_ntk_mlp(
    support_data:   &[f64],
    support_labels: &[f64],
    input_dim:      usize,
    hidden_dim:     usize,
    lambda:         f64,
    seed:           u64,
) -> NtkAction {
    let m = support_labels.len();
    let mut rng = ChaCha8Rng::seed_from_u64(seed);

    let param_count = hidden_dim * input_dim + hidden_dim + hidden_dim + 1;
    let theta: Vec<f64> = (0..param_count)
        .map(|_| rng.gen::<f64>() * 0.1 - 0.05)
        .collect();

    // Dummy MlpAction used only to call jacobian_output; data/labels unused.
    let dummy_action = MlpAction::new(
        vec![0.0; input_dim],
        vec![0.0; 1],
        input_dim,
        hidden_dim,
        lambda,
    );

    // Compute Jacobians for each support point.
    let jacobians: Vec<Vec<f64>> = (0..m)
        .map(|i| {
            let x = &support_data[i * input_dim..(i + 1) * input_dim];
            dummy_action.jacobian_output(&theta, x)
        })
        .collect();

    // Kernel matrix K[i,j] = J_i · J_j (deterministic dot product).
    let mut kernel = DMatrix::zeros(m, m);
    for i in 0..m {
        for j in 0..m {
            kernel[(i, j)] = deterministic::dot(&jacobians[i], &jacobians[j]);
        }
    }

    NtkAction::new(kernel, DVector::from_column_slice(support_labels), lambda)
}

// ── On-chain residual verification entry point ────────────────────────────────

/// Re-run the NTK solver on the provided support set and return the
/// gradient norm of the solution (as fixed-point i64) together with
/// a boolean indicating whether it matches the claimed residual within epsilon.
///
/// This is the logic wrapped by `variational-ai-cli` and called from
/// the TypeScript bridge.
#[allow(clippy::too_many_arguments)]
pub fn verify_ntk_residual(
    support_data:    &[f64],
    support_labels:  &[f64],
    input_dim:       usize,
    hidden_dim:      usize,
    lambda:          f64,
    seed:            u64,
    tol:             f64,
    max_iter:        usize,
    claimed_residual: i64,
    epsilon:         i64,
) -> (i64, bool) {
    let ntk   = compute_empirical_ntk_mlp(support_data, support_labels, input_dim, hidden_dim, lambda, seed);
    let alpha = solve_ntk(&ntk.kernel, &ntk.y, lambda, tol, max_iter);

    // Gradient norm at the solution — this is the residual ‖∇S(α*)‖
    let grad = ntk.gradient(&alpha);
    let residual_f64 = crate::deterministic::norm2(&grad);
    let computed_fp  = crate::deterministic::to_fixed(residual_f64);

    let valid = (claimed_residual - computed_fp).abs() <= epsilon;
    (computed_fp, valid)
}
