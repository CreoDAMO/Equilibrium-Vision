/// Export trained variational-AI model weights as ONNX protobuf files.
///
/// ONNX is a standard interchange format understood by ONNX Runtime, TensorFlow,
/// PyTorch, and Qualcomm's AI Hub SDK. This binary trains the logistic and MLP
/// solvers on synthetic MNIST data, then serialises the resulting weights as valid
/// ONNX protobuf files that can be:
///
///   1. Validated with `python3 -c "import onnx; onnx.checker.check_model('model.onnx')"`
///   2. Optimised for Qualcomm Hexagon NPU via `scripts/convert_to_hexagon.py`
///   3. Deployed on-device via ONNX Runtime Mobile
///
/// Usage:
///   cargo build --release --bin variational-ai-export-onnx
///   ./target/release/variational-ai-export-onnx ./models/onnx

use std::fs;
use prost::Message;                   // .encode_to_vec()

use variational_ai::{
    logistic::LogisticAction,
    mlp::MlpAction,
    mnist::load_synthetic_mnist,
    solver::StationarySolver,
};

// ── Minimal ONNX protobuf types (field numbers from onnx/onnx.proto3) ─────────
//
// We define only the subset of ONNX messages needed for dense feed-forward
// networks. All field tags match the official onnx.proto3 spec so the output
// files are accepted by any ONNX-compliant tool.

#[derive(Clone, PartialEq, prost::Message)]
struct OperatorSetIdProto {
    /// The domain of the operator set — empty string means the default ONNX domain.
    #[prost(string, tag = "1")]
    domain: String,
    /// Opset version.
    #[prost(int64, tag = "2")]
    version: i64,
}

/// A single dimension in a tensor shape.  We only use `dim_value`; `dim_param`
/// (symbolic / dynamic dims) is omitted because our models have fixed shapes.
#[derive(Clone, PartialEq, prost::Message)]
struct Dimension {
    /// Static integer size of this dimension (oneof value field 1 in spec).
    #[prost(int64, optional, tag = "1")]
    dim_value: Option<i64>,
}

#[derive(Clone, PartialEq, prost::Message)]
struct TensorShapeProto {
    #[prost(message, repeated, tag = "1")]
    dim: Vec<Dimension>,
}

/// Tensor-type descriptor inside a ValueInfoProto.
#[derive(Clone, PartialEq, prost::Message)]
struct TypeProtoTensor {
    /// Data type enum value — 1 = FLOAT, 7 = INT64, etc.
    #[prost(int32, optional, tag = "1")]
    elem_type: Option<i32>,
    #[prost(message, optional, tag = "2")]
    shape: Option<TensorShapeProto>,
}

/// Type of a graph input/output (only the tensor_type oneof arm is used here).
#[derive(Clone, PartialEq, prost::Message)]
struct TypeProto {
    /// oneof value { Tensor tensor_type = 1; … } — wire-format is the same as
    /// an optional message field at tag 1, which is what prost emits.
    #[prost(message, optional, tag = "1")]
    tensor_type: Option<TypeProtoTensor>,
}

/// Describes one input or output of the graph.
#[derive(Clone, PartialEq, prost::Message)]
struct ValueInfoProto {
    #[prost(string, tag = "1")]
    name: String,
    #[prost(message, optional, tag = "2")]
    r#type: Option<TypeProto>,
}

/// A weight / constant tensor stored in the graph.
#[derive(Clone, PartialEq, prost::Message)]
struct TensorProto {
    /// Shape dimensions.
    #[prost(int64, repeated, tag = "1")]
    dims: Vec<i64>,
    /// Data type: 1 = FLOAT.
    #[prost(int32, optional, tag = "2")]
    data_type: Option<i32>,
    /// Raw float weights (packed repeated, tag 4 per spec).
    #[prost(float, repeated, packed = "true", tag = "4")]
    float_data: Vec<f32>,
    /// Name of the initializer — must match a graph input or node input reference.
    #[prost(string, tag = "8")]
    name: String,
}

/// A single compute node (operator) in the graph.
#[derive(Clone, PartialEq, prost::Message)]
struct NodeProto {
    #[prost(string, repeated, tag = "1")]
    input: Vec<String>,
    #[prost(string, repeated, tag = "2")]
    output: Vec<String>,
    #[prost(string, tag = "3")]
    name: String,
    /// Standard ONNX op name: "MatMul", "Sigmoid", "Gemm", "Relu", etc.
    #[prost(string, tag = "4")]
    op_type: String,
}

/// The compute graph.
#[derive(Clone, PartialEq, prost::Message)]
struct GraphProto {
    #[prost(message, repeated, tag = "1")]
    node: Vec<NodeProto>,
    #[prost(string, tag = "2")]
    name: String,
    /// Constant weight tensors baked into the model.
    #[prost(message, repeated, tag = "5")]
    initializer: Vec<TensorProto>,
    /// Graph-level inputs (the live tensors, not the initializers).
    #[prost(message, repeated, tag = "11")]
    input: Vec<ValueInfoProto>,
    /// Graph-level outputs.
    #[prost(message, repeated, tag = "12")]
    output: Vec<ValueInfoProto>,
}

/// Top-level ONNX model container.
#[derive(Clone, PartialEq, prost::Message)]
struct ModelProto {
    /// ONNX IR version — 8 is the current stable version.
    #[prost(int64, tag = "1")]
    ir_version: i64,
    /// Required: which opset(s) the model uses.
    #[prost(message, repeated, tag = "8")]
    opset_import: Vec<OperatorSetIdProto>,
    #[prost(message, optional, tag = "7")]
    graph: Option<GraphProto>,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const FLOAT: i32 = 1; // TensorProto::DataType::FLOAT

/// Build a ValueInfoProto for a 2-D float tensor [d0, d1].
fn float_tensor_2d(name: &str, d0: i64, d1: i64) -> ValueInfoProto {
    ValueInfoProto {
        name: name.into(),
        r#type: Some(TypeProto {
            tensor_type: Some(TypeProtoTensor {
                elem_type: Some(FLOAT),
                shape: Some(TensorShapeProto {
                    dim: vec![
                        Dimension { dim_value: Some(d0) },
                        Dimension { dim_value: Some(d1) },
                    ],
                }),
            }),
        }),
    }
}

/// Build a TensorProto initializer from a flat f64 slice.
fn initializer(name: &str, dims: Vec<i64>, data: &[f64]) -> TensorProto {
    TensorProto {
        dims,
        data_type: Some(FLOAT),
        float_data: data.iter().map(|&v| v as f32).collect(),
        name: name.into(),
    }
}

/// Wrap a ModelProto in the standard ONNX model envelope and serialise.
fn write_model(path: &str, graph_name: &str, graph: GraphProto) {
    let model = ModelProto {
        ir_version: 8,
        opset_import: vec![OperatorSetIdProto { domain: String::new(), version: 17 }],
        graph: Some(GraphProto { name: graph_name.into(), ..graph }),
    };
    fs::write(path, model.encode_to_vec()).unwrap_or_else(|e| {
        eprintln!("❌  Failed to write {}: {}", path, e);
        std::process::exit(1);
    });
    println!("✅  Exported: {}", path);
}

// ── Logistic regression export ────────────────────────────────────────────────
//
// Architecture: input[1, D] → MatMul(W[D,1]) → logits[1,1] → Sigmoid → output[1,1]

fn export_logistic(path: &str) {
    let data   = load_synthetic_mnist(1_000, 200);
    let dim    = data.dim;
    let action = LogisticAction::new(data.train_data.clone(), data.train_labels.clone(), dim, 0.01);
    let solver = StationarySolver::new(1e-6, 100);
    let theta  = solver.solve_newton_cg(&action, &vec![0.0f64; dim]);

    let graph = GraphProto {
        name: String::new(), // filled by write_model
        input: vec![float_tensor_2d("input", 1, dim as i64)],
        output: vec![float_tensor_2d("output", 1, 1)],
        initializer: vec![
            // W: shape [D, 1] — theta is already the weight vector
            initializer("W", vec![dim as i64, 1], &theta),
        ],
        node: vec![
            NodeProto {
                input: vec!["input".into(), "W".into()],
                output: vec!["logits".into()],
                name: "matmul".into(),
                op_type: "MatMul".into(),
            },
            NodeProto {
                input: vec!["logits".into()],
                output: vec!["output".into()],
                name: "sigmoid".into(),
                op_type: "Sigmoid".into(),
            },
        ],
    };
    write_model(path, "logistic", graph);
}

// ── MLP export ────────────────────────────────────────────────────────────────
//
// Architecture (Gemm ops, no transpositions needed):
//   input[1,D] → Gemm(W1[D,H], b1[H]) → fc1[1,H] → Relu → relu[1,H]
//               → Gemm(W2[H,1], b2[1]) → output[1,1]
//
// split_params returns W1 stored as [hidden, input_dim] row-major.
// We transpose to [input_dim, hidden] so plain Gemm (no transB) is correct.

fn export_mlp(path: &str) {
    let data    = load_synthetic_mnist(1_000, 200);
    let dim     = data.dim;
    let hidden  = 32usize;
    let action  = MlpAction::new(
        data.train_data.clone(), data.train_labels.clone(), dim, hidden, 0.01,
    );
    let solver  = StationarySolver::new(1e-5, 80);
    let theta   = solver.solve_newton_cg(&action, &vec![0.0f64; action.param_count()]);
    let (w1, b1, w2, b2) = action.split_params(&theta);

    // Transpose W1: [hidden, dim] → [dim, hidden]
    let w1_t: Vec<f64> = (0..dim)
        .flat_map(|j| (0..hidden).map(move |i| w1[i * dim + j]))
        .collect();

    // W2 is shape [hidden] (output-neuron weights); reshape to [hidden, 1]
    let b2_slice = std::slice::from_ref(&b2);

    let graph = GraphProto {
        name: String::new(),
        input: vec![float_tensor_2d("input", 1, dim as i64)],
        output: vec![float_tensor_2d("output", 1, 1)],
        initializer: vec![
            initializer("W1", vec![dim as i64, hidden as i64], &w1_t),
            initializer("b1", vec![1, hidden as i64], b1),
            initializer("W2", vec![hidden as i64, 1], w2),
            initializer("b2", vec![1, 1],              b2_slice),
        ],
        node: vec![
            // fc1 = input @ W1 + b1
            NodeProto {
                input: vec!["input".into(), "W1".into(), "b1".into()],
                output: vec!["fc1".into()],
                name: "gemm1".into(),
                op_type: "Gemm".into(),
            },
            // relu = Relu(fc1)
            NodeProto {
                input: vec!["fc1".into()],
                output: vec!["relu".into()],
                name: "relu".into(),
                op_type: "Relu".into(),
            },
            // output = relu @ W2 + b2
            NodeProto {
                input: vec!["relu".into(), "W2".into(), "b2".into()],
                output: vec!["output".into()],
                name: "gemm2".into(),
                op_type: "Gemm".into(),
            },
        ],
    };
    write_model(path, "mlp", graph);
}

// ── Entry point ───────────────────────────────────────────────────────────────

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("Usage: {} <output_dir>", args[0]);
        eprintln!("  Trains logistic + MLP solvers on synthetic MNIST and writes:");
        eprintln!("    <output_dir>/logistic.onnx");
        eprintln!("    <output_dir>/mlp.onnx");
        std::process::exit(1);
    }
    let dir = &args[1];
    fs::create_dir_all(dir).unwrap_or_else(|e| {
        eprintln!("❌  Cannot create output dir {}: {}", dir, e);
        std::process::exit(1);
    });

    println!("Training logistic solver...");
    export_logistic(&format!("{}/logistic.onnx", dir));

    println!("Training MLP solver...");
    export_mlp(&format!("{}/mlp.onnx", dir));

    println!("\n🎉  Both models exported to {}/", dir);
    println!("    Validate:  python3 -c \"import onnx; [onnx.checker.check_model(f) for f in ['logistic.onnx','mlp.onnx']]\"");
    println!("    Convert:   python3 scripts/convert_to_hexagon.py --logistic {dir}/logistic.onnx --mlp {dir}/mlp.onnx");
}
