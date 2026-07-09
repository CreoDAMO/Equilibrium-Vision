#!/usr/bin/env python3
"""
convert_to_hexagon.py — Convert ONNX models to Qualcomm Hexagon NPU format.

Uses Qualcomm AI Hub SDK to quantise and compile the variational-AI solver
models (logistic regression, MLP) for the Snapdragon Hexagon DSP/NPU, producing
optimised .dlc (Deep Learning Container) files ready for on-device inference.

Prerequisites:
    pip install ai-hub

Usage:
    # After running variational-ai-export-onnx:
    python3 scripts/convert_to_hexagon.py \\
        --logistic models/onnx/logistic.onnx \\
        --mlp      models/onnx/mlp.onnx \\
        --output-dir models/hexagon

    # Then bundle the .dlc files with the APK:
    cp models/hexagon/*.dlc equilibrium/mobile/android/app/src/main/assets/

Supported quantisation modes:
    int8   — best balance of accuracy and NPU throughput (default)
    int4   — highest throughput, slight accuracy trade-off
    mixed  — mixed precision (keeps sensitive layers in int8)

The output .dlc files are used by the Android app via the Qualcomm Neural
Processing SDK (QNN SDK) for low-latency, battery-efficient inference.
"""

import argparse
import sys
from pathlib import Path


def check_onnx_valid(model_path: str) -> bool:
    """Validate an ONNX model before conversion. Returns True if valid."""
    try:
        import onnx  # type: ignore
        model = onnx.load(model_path)
        onnx.checker.check_model(model)
        return True
    except ImportError:
        # onnx package not installed — skip validation, proceed to conversion.
        return True
    except Exception as exc:
        print(f"⚠️  ONNX validation failed for {model_path}: {exc}")
        return False


def convert_solver(model_path: str, output_path: str, quantization: str = "int8") -> bool:
    """
    Convert a single ONNX model to Hexagon DLC format via Qualcomm AI Hub.

    Args:
        model_path:   Path to the source .onnx file.
        output_path:  Destination path for the .dlc output.
        quantization: Quantisation mode — "int8", "int4", or "mixed".

    Returns:
        True on success, False on any error.
    """
    print(f"  Converting: {model_path}")
    print(f"       → {output_path}  [{quantization}]")

    try:
        from ai_hub import convert, Model  # type: ignore
    except ImportError:
        print("❌  Qualcomm AI Hub SDK not installed.")
        print("    Install it with:  pip install ai-hub")
        print("    Then authenticate: ai-hub-cli login")
        return False

    # Validate the ONNX model first so conversion errors are easier to diagnose.
    if not check_onnx_valid(model_path):
        return False

    try:
        model = Model.from_onnx(model_path)
        result = convert(
            model=model,
            target="hexagon",
            quantization=quantization,
            optimize=["fusion", "sparsity"],
            input_layout="NCHW",
            output_layout="NCHW",
            compiler_options={
                "hexagon": {
                    # DDP vector extensions for Snapdragon 8 Gen series NPU.
                    "vector_extension": "ddp",
                    # Cache-blocking improves throughput for small dense layers.
                    "cache_blocking": True,
                    # Zero-copy I/O avoids redundant buffer copies on-device.
                    "zero_copy": True,
                }
            },
        )
        result.save(output_path)
        print(f"  ✅  Saved: {output_path}")
        return True

    except Exception as exc:
        print(f"  ❌  Conversion failed: {exc}")
        return False


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Convert Equilibrium variational-AI ONNX models to Qualcomm Hexagon NPU format."
    )
    parser.add_argument("--logistic",     type=str, help="Path to logistic.onnx")
    parser.add_argument("--mlp",          type=str, help="Path to mlp.onnx")
    parser.add_argument("--ntk",          type=str, help="Path to ntk.onnx (future use)")
    parser.add_argument(
        "--output-dir", type=str, default="models/hexagon",
        help="Directory for converted .dlc files (default: models/hexagon)",
    )
    parser.add_argument(
        "--quantization", type=str, default="int8",
        choices=["int8", "int4", "mixed"],
        help="Quantisation mode (default: int8)",
    )
    args = parser.parse_args()

    if not any([args.logistic, args.mlp, args.ntk]):
        parser.print_help()
        print("\n❌  At least one of --logistic, --mlp, or --ntk is required.")
        sys.exit(1)

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    results: list[bool] = []

    if args.logistic:
        results.append(
            convert_solver(
                args.logistic,
                str(output_dir / "logistic.dlc"),
                args.quantization,
            )
        )

    if args.mlp:
        results.append(
            convert_solver(
                args.mlp,
                str(output_dir / "mlp.dlc"),
                args.quantization,
            )
        )

    if args.ntk:
        results.append(
            convert_solver(
                args.ntk,
                str(output_dir / "ntk.dlc"),
                args.quantization,
            )
        )

    print()
    if all(results):
        print(f"🎉  All models converted successfully → {output_dir}/")
        print()
        print("Next step — bundle .dlc files with the APK:")
        print(f"  cp {output_dir}/*.dlc equilibrium/mobile/android/app/src/main/assets/")
    else:
        failed = results.count(False)
        print(f"⚠️   {failed}/{len(results)} conversion(s) failed.")
        sys.exit(1)


if __name__ == "__main__":
    main()
