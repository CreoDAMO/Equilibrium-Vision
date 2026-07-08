use crate::action::Action;
use crate::deterministic;

/// Binary logistic regression action.
///
/// Loss: (1/N) Σ [-y·(x·θ) + softplus(x·θ)] + (λ/2)‖θ‖²
pub struct LogisticAction {
    pub data:   Vec<f64>, // N × D, row-major
    pub labels: Vec<f64>, // N binary targets ∈ {0, 1}
    pub dim:    usize,
    pub n:      usize,
    pub lambda: f64,
}

impl LogisticAction {
    pub fn new(data: Vec<f64>, labels: Vec<f64>, dim: usize, lambda: f64) -> Self {
        let n = data.len() / dim;
        LogisticAction { data, labels, dim, n, lambda }
    }

    fn probabilities(&self, theta: &[f64]) -> Vec<f64> {
        (0..self.n)
            .map(|i| {
                let start = i * self.dim;
                deterministic::sigmoid(deterministic::dot(
                    &self.data[start..start + self.dim],
                    theta,
                ))
            })
            .collect()
    }

    /// Predict probability for a single sample.
    pub fn predict(&self, theta: &[f64], x: &[f64]) -> f64 {
        deterministic::sigmoid(deterministic::dot(x, theta))
    }
}

impl Action for LogisticAction {
    type Parameter = Vec<f64>;

    fn evaluate(&self, theta: &Self::Parameter) -> f64 {
        let mut loss = 0.0;
        for i in 0..self.n {
            let d = deterministic::dot(
                &self.data[i * self.dim..(i + 1) * self.dim],
                theta,
            );
            let y = self.labels[i];
            loss += -y * d + deterministic::softplus(d);
        }
        loss /= self.n as f64;
        let reg = 0.5 * self.lambda * theta.iter().map(|&t| t * t).sum::<f64>();
        loss + reg
    }

    fn gradient(&self, theta: &Self::Parameter) -> Vec<f64> {
        let probs = self.probabilities(theta);
        let mut grad = vec![0.0; self.dim];
        for i in 0..self.n {
            let err   = probs[i] - self.labels[i];
            let start = i * self.dim;
            for j in 0..self.dim {
                grad[j] += err * self.data[start + j];
            }
        }
        let n = self.n as f64;
        for j in 0..self.dim {
            grad[j] = grad[j] / n + self.lambda * theta[j];
        }
        grad
    }

    fn hessian_vec_prod(&self, theta: &Self::Parameter, v: &[f64]) -> Vec<f64> {
        let probs = self.probabilities(theta);
        let mut hv = vec![0.0; self.dim];
        for i in 0..self.n {
            let w   = probs[i] * (1.0 - probs[i]);
            let d   = deterministic::dot(&self.data[i * self.dim..(i + 1) * self.dim], v);
            let start = i * self.dim;
            for j in 0..self.dim {
                hv[j] += w * d * self.data[start + j];
            }
        }
        let n = self.n as f64;
        for j in 0..self.dim {
            hv[j] = hv[j] / n + self.lambda * v[j];
        }
        hv
    }

    fn dim(&self) -> usize { self.dim }
}
