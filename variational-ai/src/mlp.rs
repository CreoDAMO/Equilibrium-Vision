use crate::action::Action;

/// Two-layer ReLU MLP action.
///
/// Architecture: input_dim → hidden_dim (ReLU) → 1 (linear)
/// Loss: (1/N) Σ (f(x_i; θ) - y_i)² + (λ/2)‖θ‖²
///
/// Parameter layout (flat Vec<f64>):
///   [W1: hidden×input | b1: hidden | W2: hidden | b2: 1]
pub struct MlpAction {
    pub data:       Vec<f64>,
    pub labels:     Vec<f64>,
    pub input_dim:  usize,
    pub hidden_dim: usize,
    pub lambda:     f64,
    pub n:          usize,
}

impl MlpAction {
    pub fn new(
        data: Vec<f64>, labels: Vec<f64>,
        input_dim: usize, hidden_dim: usize, lambda: f64,
    ) -> Self {
        let n = if data.is_empty() { 0 } else { data.len() / input_dim };
        MlpAction { data, labels, input_dim, hidden_dim, lambda, n }
    }

    pub fn param_count(&self) -> usize {
        self.hidden_dim * self.input_dim + self.hidden_dim + self.hidden_dim + 1
    }

    /// Decompose flat parameter vector into (W1, b1, W2, b2).
    pub fn split_params<'a>(&self, theta: &'a [f64]) -> (&'a [f64], &'a [f64], &'a [f64], f64) {
        let w1s = self.hidden_dim * self.input_dim;
        let b1s = self.hidden_dim;
        let w2s = self.hidden_dim;
        let w1 = &theta[0..w1s];
        let b1 = &theta[w1s..w1s + b1s];
        let w2 = &theta[w1s + b1s..w1s + b1s + w2s];
        let b2 = theta[w1s + b1s + w2s];
        (w1, b1, w2, b2)
    }

    /// Forward pass for a single input; returns scalar output.
    pub fn forward_one(&self, x: &[f64], w1: &[f64], b1: &[f64], w2: &[f64], b2: f64) -> f64 {
        let mut hidden = vec![0.0_f64; self.hidden_dim];
        for h in 0..self.hidden_dim {
            let mut s = b1[h];
            for i in 0..self.input_dim {
                s += w1[h * self.input_dim + i] * x[i];
            }
            hidden[h] = s.max(0.0); // ReLU
        }
        let mut out = b2;
        for h in 0..self.hidden_dim {
            out += w2[h] * hidden[h];
        }
        out
    }

    /// Jacobian of scalar output w.r.t. all parameters for input x.
    /// Shape: param_count() elements.
    pub fn jacobian_output(&self, theta: &[f64], x: &[f64]) -> Vec<f64> {
        let (w1, b1, _w2, _b2) = self.split_params(theta);
        let w1s = self.hidden_dim * self.input_dim;
        let mut grad = vec![0.0_f64; self.param_count()];

        // Forward pass (cache pre-activations)
        let mut h_pre  = vec![0.0_f64; self.hidden_dim];
        let mut h_post = vec![0.0_f64; self.hidden_dim];
        for j in 0..self.hidden_dim {
            let mut s = b1[j];
            for k in 0..self.input_dim { s += w1[j * self.input_dim + k] * x[k]; }
            h_pre[j]  = s;
            h_post[j] = s.max(0.0);
        }

        // Backprop with d_output = 1
        let d_out = 1.0_f64;
        // ∂/∂b2
        grad[w1s + self.hidden_dim + self.hidden_dim] += d_out;
        // ∂/∂W2, ∂/∂hidden
        let mut d_hidden = vec![0.0_f64; self.hidden_dim];
        for j in 0..self.hidden_dim {
            grad[w1s + self.hidden_dim + j] += d_out * h_post[j];
            d_hidden[j] = d_out * {
                let (_, _, w2_slice, _) = self.split_params(theta);
                w2_slice[j]
            };
        }
        // ∂/∂b1, ∂/∂W1  (through ReLU gate)
        for j in 0..self.hidden_dim {
            if h_pre[j] > 0.0 {
                grad[w1s + j] += d_hidden[j]; // b1
                for k in 0..self.input_dim {
                    grad[j * self.input_dim + k] += d_hidden[j] * x[k]; // W1
                }
            }
        }
        grad
    }
}

impl Action for MlpAction {
    type Parameter = Vec<f64>;

    fn evaluate(&self, theta: &Self::Parameter) -> f64 {
        let (w1, b1, w2, b2) = self.split_params(theta);
        let mut loss = 0.0_f64;
        for i in 0..self.n {
            let x    = &self.data[i * self.input_dim..(i + 1) * self.input_dim];
            let pred = self.forward_one(x, w1, b1, w2, b2);
            let err  = pred - self.labels[i];
            loss += err * err;
        }
        loss /= self.n as f64;
        let reg = 0.5 * self.lambda * theta.iter().map(|&t| t * t).sum::<f64>();
        loss + reg
    }

    fn gradient(&self, theta: &Self::Parameter) -> Vec<f64> {
        let (w1_s, b1_s, w2_s, b2_s) = self.split_params(theta);
        // Clone slices to owned for forward/back
        let w1: Vec<f64> = w1_s.to_vec();
        let b1: Vec<f64> = b1_s.to_vec();
        let w2: Vec<f64> = w2_s.to_vec();
        let b2 = b2_s;

        let w1sz = self.hidden_dim * self.input_dim;
        let mut grad = vec![0.0_f64; self.param_count()];
        let n_inv = 1.0 / self.n as f64;

        for i in 0..self.n {
            let x = &self.data[i * self.input_dim..(i + 1) * self.input_dim];
            let y = self.labels[i];

            // Forward (with cached activations for backprop)
            let mut h_pre  = vec![0.0_f64; self.hidden_dim];
            let mut h_post = vec![0.0_f64; self.hidden_dim];
            for j in 0..self.hidden_dim {
                let mut s = b1[j];
                for k in 0..self.input_dim { s += w1[j * self.input_dim + k] * x[k]; }
                h_pre[j]  = s;
                h_post[j] = s.max(0.0);
            }
            let mut out = b2;
            for j in 0..self.hidden_dim { out += w2[j] * h_post[j]; }

            let err   = out - y;
            let d_out = 2.0 * err * n_inv;

            // ∂/∂b2
            grad[w1sz + self.hidden_dim + self.hidden_dim] += d_out;
            // ∂/∂W2, propagate to hidden
            let mut d_hidden = vec![0.0_f64; self.hidden_dim];
            for j in 0..self.hidden_dim {
                grad[w1sz + self.hidden_dim + j] += d_out * h_post[j];
                d_hidden[j] = d_out * w2[j];
            }
            // ∂/∂b1, ∂/∂W1
            for j in 0..self.hidden_dim {
                if h_pre[j] > 0.0 {
                    grad[w1sz + j] += d_hidden[j];
                    for k in 0..self.input_dim {
                        grad[j * self.input_dim + k] += d_hidden[j] * x[k];
                    }
                }
            }
        }
        for i in 0..theta.len() {
            grad[i] += self.lambda * theta[i];
        }
        grad
    }

    fn hessian_vec_prod(&self, _theta: &Self::Parameter, _v: &[f64]) -> Vec<f64> {
        // Not used — L-BFGS doesn't call this.
        vec![0.0; self.param_count()]
    }

    fn dim(&self) -> usize { self.param_count() }
}
