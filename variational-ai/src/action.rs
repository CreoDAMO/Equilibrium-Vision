/// Core trait for a variational action S[θ].
///
/// Every learnable model (logistic, MLP, NTK) implements this so that
/// the solvers (Newton-CG, L-BFGS) can operate on any of them generically.
pub trait Action {
    type Parameter: Clone + std::fmt::Debug + Send + Sync;

    /// S(θ) — scalar value of the action.
    fn evaluate(&self, theta: &Self::Parameter) -> f64;

    /// ∇S(θ) — gradient vector.
    fn gradient(&self, theta: &Self::Parameter) -> Vec<f64>;

    /// H(θ)·v — Hessian-vector product (used by Newton-CG inner loop).
    fn hessian_vec_prod(&self, theta: &Self::Parameter, v: &[f64]) -> Vec<f64>;

    /// Dimensionality of the parameter space.
    #[allow(dead_code)]
    fn dim(&self) -> usize;
}
