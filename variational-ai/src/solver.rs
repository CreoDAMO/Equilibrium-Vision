use crate::action::Action;
use crate::deterministic;

// ── Newton-CG solver ──────────────────────────────────────────────────────────

/// Newton-CG solver for strongly-convex actions (e.g. logistic regression).
///
/// Each outer step uses the Hessian-vector product to solve the Newton system
/// via conjugate gradient; the result is backtracked to satisfy Armijo's
/// sufficient-decrease condition.
pub struct StationarySolver {
    pub tol:      f64,
    pub max_iter: usize,
}

impl StationarySolver {
    pub fn new(tol: f64, max_iter: usize) -> Self {
        StationarySolver { tol, max_iter }
    }

    /// Run Newton-CG on any `Action<Parameter = Vec<f64>>`.
    pub fn solve_newton_cg<A>(&self, action: &A, initial: &Vec<f64>) -> Vec<f64>
    where
        A: Action<Parameter = Vec<f64>>,
    {
        let mut theta = initial.clone();
        for _ in 0..self.max_iter {
            let grad      = action.gradient(&theta);
            let grad_norm = deterministic::norm2(&grad);
            if grad_norm < self.tol { break; }

            // Newton direction: solve H·p = -grad via inner CG.
            let neg_grad: Vec<f64> = grad.iter().map(|&g| -g).collect();
            let p = cg_solve(
                |v| action.hessian_vec_prod(&theta, v),
                &neg_grad,
                50,
                self.tol * 0.1,
            );

            // Armijo backtracking line search.
            let f0        = action.evaluate(&theta);
            let slope     = deterministic::dot(&grad, &p); // should be < 0
            let mut alpha = 1.0_f64;
            loop {
                let new_theta: Vec<f64> = theta.iter().zip(p.iter())
                    .map(|(&t, &pp)| t + alpha * pp)
                    .collect();
                let f_new = action.evaluate(&new_theta);
                if f_new < f0 + 0.5 * alpha * slope {
                    theta = new_theta;
                    break;
                }
                alpha *= 0.5;
                if alpha < 1e-10 {
                    // Forced step; accept anyway to make progress.
                    theta = theta.iter().zip(p.iter())
                        .map(|(&t, &pp)| t + alpha * pp)
                        .collect();
                    break;
                }
            }
        }
        theta
    }
}

/// Inner CG solve: Ax = b where A is represented as a Hessian-vector product.
fn cg_solve(
    a_mul:    impl Fn(&[f64]) -> Vec<f64>,
    b:        &[f64],
    max_iter: usize,
    tol:      f64,
) -> Vec<f64> {
    let n    = b.len();
    let mut x = vec![0.0_f64; n];
    let mut r = b.to_vec();
    let mut p = r.clone();
    let mut rsold = deterministic::dot(&r, &r);

    for _ in 0..max_iter {
        let ap   = a_mul(&p);
        let p_ap = deterministic::dot(&p, &ap);
        if p_ap <= 1e-12 { break; }
        let alpha = rsold / p_ap;
        deterministic::axpy(alpha, &p, &mut x);
        deterministic::axpy(-alpha, &ap, &mut r);
        let rsnew = deterministic::dot(&r, &r);
        if rsnew.sqrt() < tol { break; }
        let beta = rsnew / rsold;
        for i in 0..n {
            p[i] = r[i] + beta * p[i];
        }
        rsold = rsnew;
    }
    x
}

// ── L-BFGS solver ─────────────────────────────────────────────────────────────

/// Limited-memory BFGS solver for non-convex actions (e.g. MLP).
pub struct LbfgsSolver {
    pub tol:          f64,
    pub max_iter:     usize,
    pub history_size: usize,
}

impl LbfgsSolver {
    pub fn new(tol: f64, max_iter: usize, history_size: usize) -> Self {
        LbfgsSolver { tol, max_iter, history_size }
    }

    /// Two-loop L-BFGS recursion: compute Hk⁻¹·grad.
    fn two_loop(
        &self,
        s_list:   &[Vec<f64>],
        y_list:   &[Vec<f64>],
        rho_list: &[f64],
        grad:     &[f64],
    ) -> Vec<f64> {
        let m = s_list.len();
        let mut q = grad.to_vec();
        let mut alpha = vec![0.0_f64; m];

        for i in (0..m).rev() {
            alpha[i] = rho_list[i] * deterministic::dot(&s_list[i], &q);
            deterministic::axpy(-alpha[i], &y_list[i], &mut q);
        }

        // Initial Hessian scaling: γ = (sᵀy)/(yᵀy)
        let gamma = if m > 0 {
            let ys = deterministic::dot(&y_list[m - 1], &s_list[m - 1]);
            let yy = deterministic::dot(&y_list[m - 1], &y_list[m - 1]);
            if ys > 1e-12 { ys / yy } else { 1.0 }
        } else { 1.0 };

        let mut r: Vec<f64> = q.iter().map(|&x| x * gamma).collect();

        for i in 0..m {
            let beta = rho_list[i] * deterministic::dot(&y_list[i], &r);
            deterministic::axpy(alpha[i] - beta, &s_list[i], &mut r);
        }

        r.iter().map(|&x| -x).collect() // descent direction
    }

    /// Run L-BFGS on any `Action<Parameter = Vec<f64>>`.
    pub fn solve<A>(&self, action: &A, initial: &Vec<f64>) -> Vec<f64>
    where
        A: Action<Parameter = Vec<f64>>,
    {
        let mut theta     = initial.clone();
        let mut grad      = action.gradient(&theta);
        let mut grad_norm = deterministic::norm2(&grad);

        let mut s_list:   Vec<Vec<f64>> = Vec::with_capacity(self.history_size);
        let mut y_list:   Vec<Vec<f64>> = Vec::with_capacity(self.history_size);
        let mut rho_list: Vec<f64>      = Vec::with_capacity(self.history_size);

        for _ in 0..self.max_iter {
            if grad_norm < self.tol { break; }

            let mut p     = self.two_loop(&s_list, &y_list, &rho_list, &grad);
            // Guard: if two-loop produced a non-descent direction (g·p ≥ 0),
            // fall back to steepest descent (negated gradient).
            let g0_dot_p_check = deterministic::dot(&grad, &p);
            if g0_dot_p_check >= 0.0 {
                p = grad.iter().map(|&g| -g).collect();
            }
            let f0        = action.evaluate(&theta);
            let g0_dot_p  = deterministic::dot(&grad, &p);
            let mut alpha = 1.0_f64;

            // Armijo (sufficient decrease) line search.
            loop {
                let new_theta: Vec<f64> = theta.iter().zip(p.iter())
                    .map(|(&t, &pp)| t + alpha * pp)
                    .collect();
                let f_new = action.evaluate(&new_theta);
                if f_new <= f0 + 1e-4 * alpha * g0_dot_p {
                    let s: Vec<f64> = new_theta.iter().zip(theta.iter())
                        .map(|(&n, &o)| n - o)
                        .collect();
                    let new_grad = action.gradient(&new_theta);
                    let y: Vec<f64> = new_grad.iter().zip(grad.iter())
                        .map(|(&n, &o)| n - o)
                        .collect();
                    let ys = deterministic::dot(&y, &s);
                    if ys > 1e-12 {
                        if s_list.len() == self.history_size {
                            s_list.remove(0);
                            y_list.remove(0);
                            rho_list.remove(0);
                        }
                        s_list.push(s);
                        y_list.push(y);
                        rho_list.push(1.0 / ys);
                    }
                    theta = new_theta;
                    grad  = new_grad;
                    break;
                }
                alpha *= 0.5;
                if alpha < 1e-12 {
                    // Forced tiny step.
                    theta = theta.iter().zip(p.iter())
                        .map(|(&t, &pp)| t + alpha * pp)
                        .collect();
                    grad = action.gradient(&theta);
                    break;
                }
            }
            grad_norm = deterministic::norm2(&grad);
        }
        theta
    }
}
