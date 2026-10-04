//! Test-only reader of the site-owned shared surface.
//! The file is law for residual, header, and coinbase. It is not G.

use serde_json::Value;

pub fn site_contract() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../site/src/protocol/native-contract.json");
    let text = std::fs::read_to_string(path)
        .unwrap_or_else(|err| panic!("site contract missing at {path}: {err}"));
    let value: Value = serde_json::from_str(&text).expect("site contract json");
    assert_eq!(
        value["authority"].as_str(),
        Some("site"),
        "equilibrium is not the contract authority"
    );
    assert_eq!(value["headerStopsAt"].as_str(), Some("omegaRoot"));
    let outside = value["notSurface"].as_array().expect("notSurface");
    for required in ["successor", "transitionRoot", "omegaPrime"] {
        assert!(
            outside.iter().any(|item| item.as_str() == Some(required)),
            "{required} stays outside the native contract"
        );
    }
    assert!(
        !outside.iter().any(|item| item.as_str() == Some("lambda")),
        "λ is a weight of the canonical residual, not an unnamed extra"
    );
    let surface = value["surface"].as_array().expect("surface");
    assert!(
        surface.iter().any(|item| item.as_str() == Some("residual-lambda")),
        "the shared surface includes the λ-weighted residual"
    );
    value
}

pub fn f64_of(value: &Value) -> f64 {
    match value {
        Value::String(text) => text.parse().unwrap_or_else(|_| panic!("bad f64 {text}")),
        Value::Number(number) => number.as_f64().unwrap_or_else(|| panic!("bad number {number}")),
        other => panic!("expected number, got {other}"),
    }
}
