import { BlockChain3D } from "@/components/matrix/BlockChain3D";

export default function MatrixPage() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Kinetic Block Timeline</h1>
        <p className="text-sm text-muted-foreground">
          Live 3D view of blocks as they are mined — cube size reflects transaction count, material clarity reflects
          the Proof-of-Stationarity residual.
        </p>
      </div>
      <BlockChain3D />
    </div>
  );
}
